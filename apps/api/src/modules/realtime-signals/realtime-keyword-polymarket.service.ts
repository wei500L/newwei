import { Injectable } from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import {
  extractProcessedArticleTerms,
  normalizeProcessedArticleSource,
} from "../../common/processed-article-indexing";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { REALTIME_SIGNAL_METRIC_SLUGS } from "./realtime-signals.constants";
import {
  fetchJsonWithRetry,
  normalizeString,
  normalizeUrl,
  readArray,
  toFiniteNumber,
} from "./realtime-signals.helpers";
import type {
  RealtimeSignalFetchResult,
  RealtimeSignalsRuntimeConfig,
} from "./realtime-signals.types";

const SIMPLE_STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "will",
  "have",
  "about",
  "their",
  "there",
  "after",
  "before",
  "where",
  "which",
  "while",
  "into",
  "within",
  "across",
  "against",
  "under",
  "between",
  "said",
  "says",
  "report",
  "reports",
  "update",
  "latest",
  "breaking",
  "market",
  "global",
  "world",
  "news",
  "analysis",
  "today",
  "live",
]);

const PROCESSED_ARTICLE_TERM_COVERAGE_TTL_SECONDS = 300;

@Injectable()
export class RealtimeKeywordPolymarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async fetchKeywordSpikeSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const recentStart = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const baselineStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    const coverageStart =
      await this.getProcessedArticleTermCoverageStart(orgId);
    const hasCoverage =
      coverageStart !== null &&
      coverageStart.getTime() <= baselineStart.getTime();

    const [recentTermRows, baselineTermRows, fallbackCounts] = hasCoverage
      ? await Promise.all([
          this.prisma.processedArticleTermHourly.groupBy({
            where: {
              orgId,
              bucketStart: { gte: recentStart },
            },
            by: ["term", "source"],
            _sum: {
              articleCount: true,
            },
          }),
          this.prisma.processedArticleTermHourly.groupBy({
            where: {
              orgId,
              bucketStart: { gte: baselineStart, lt: recentStart },
            },
            by: ["term"],
            _sum: {
              articleCount: true,
            },
          }),
          Promise.resolve(null),
        ])
      : await Promise.all([
          Promise.resolve([]),
          Promise.resolve([]),
          this.loadKeywordSpikeFallbackCounts(
            orgId,
            recentStart,
            baselineStart,
          ),
        ]);

    const resolvedFallbackCounts =
      !fallbackCounts &&
      recentTermRows.length === 0 &&
      baselineTermRows.length === 0
        ? await this.loadKeywordSpikeFallbackCounts(
            orgId,
            recentStart,
            baselineStart,
          )
        : fallbackCounts;
    const recentCounts =
      resolvedFallbackCounts?.recentCounts ??
      this.buildRecentTermCountsFromBuckets(recentTermRows);
    const baselineCounts =
      resolvedFallbackCounts?.baselineCounts ??
      this.buildBaselineTermCountsFromBuckets(baselineTermRows);

    const spikes: {
      id: string;
      term: string;
      count: number;
      baseline: number;
      multiplier: number;
      sourceCount: number;
      confidence: number;
    }[] = [];

    const minCount = Math.max(1, runtime.thresholds.keywordSpikeMinCount);
    const requiredMultiplier = Math.max(
      1,
      runtime.thresholds.keywordSpikeMultiplier,
    );
    const recentHours = 2;
    const baselineHours = 7 * 24;

    for (const [term, entry] of recentCounts.entries()) {
      if (entry.count < minCount || entry.sources.size < 2) {
        continue;
      }
      const baselineCount = baselineCounts.get(term) ?? 0;
      const baselineExpected = (baselineCount / baselineHours) * recentHours;
      const safeBaseline = baselineExpected > 0 ? baselineExpected : 1;
      const multiplier = entry.count / safeBaseline;
      if (multiplier < requiredMultiplier) {
        continue;
      }
      const confidence = Math.min(0.95, 0.4 + multiplier / 10);
      spikes.push({
        id: `keyword:${term}`,
        term,
        count: entry.count,
        baseline: Number(baselineExpected.toFixed(3)),
        multiplier: Number(multiplier.toFixed(3)),
        sourceCount: entry.sources.size,
        confidence: Number(confidence.toFixed(3)),
      });
    }

    spikes.sort((a, b) => b.multiplier - a.multiplier);
    const topSpikes = spikes.slice(0, 10);

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.keywordSpike,
        value: topSpikes.length,
        context: {
          source: "internal",
          recentArticleCount:
            resolvedFallbackCounts?.recentArticleCount ??
            recentTermRows.reduce(
              (total, row) => total + (row._sum.articleCount ?? 0),
              0,
            ),
          baselineArticleCount:
            resolvedFallbackCounts?.baselineArticleCount ??
            baselineTermRows.reduce(
              (total, row) => total + (row._sum.articleCount ?? 0),
              0,
            ),
          spikes: topSpikes,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  async fetchPolymarketLeadsSignal(
    orgId: string,
    runtime: RealtimeSignalsRuntimeConfig,
  ) {
    const proxyUrl = normalizeUrl(runtime.polymarket.proxyUrl);
    const baseUrl = proxyUrl ?? "https://gamma-api.polymarket.com";
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "60");

    const payload = await fetchJsonWithRetry(url.toString(), runtime);
    const events = readArray(payload);
    const previousPrices =
      (await this.cache.get<Record<string, number>>(
        `realtime-signals:polymarket:prices:${orgId}`,
      )) ?? {};
    const nextPrices: Record<string, number> = {};

    const leads: {
      id: string;
      title: string;
      shift: number;
      newsActivity: number;
      confidence: number;
    }[] = [];

    for (const entry of events.slice(0, 60)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const title = normalizeString(record.title ?? record.name);
      if (!title) {
        continue;
      }
      const eventId = normalizeString(record.id) ?? title;
      const active = record.active !== false && record.closed !== true;
      if (!active) {
        continue;
      }
      const volume = toFiniteNumber(
        record.volume ?? record.volumeNum ?? record.liquidity,
      );
      if (volume !== null && volume < 1_000) {
        continue;
      }

      const probability = this.resolvePolymarketYesPrice(record);
      if (probability === null) {
        continue;
      }
      nextPrices[eventId] = probability;
      const previous = previousPrices[eventId];
      const shift =
        typeof previous === "number" && Number.isFinite(previous)
          ? Math.abs(probability - previous)
          : 0;
      if (shift < runtime.thresholds.predictionShiftThreshold) {
        continue;
      }

      const topicTokens = this.extractTopicTokens(title);
      const newsActivity = await this.countNewsActivity(orgId, topicTokens);
      if (newsActivity >= runtime.thresholds.predictionNewsActivityThreshold) {
        continue;
      }

      const confidence = Math.min(0.9, 0.5 + shift / 20);
      leads.push({
        id: eventId,
        title,
        shift: Number(shift.toFixed(3)),
        newsActivity,
        confidence: Number(confidence.toFixed(3)),
      });
    }

    leads.sort((a, b) => b.shift - a.shift);
    const topLeads = leads.slice(0, 20);
    await this.cache.set(
      `realtime-signals:polymarket:prices:${orgId}`,
      nextPrices,
      60 * 60 * 24,
    );

    return [
      {
        metricSlug: REALTIME_SIGNAL_METRIC_SLUGS.polymarketLeads,
        value: topLeads.length,
        context: {
          source: proxyUrl ? "proxy" : "gamma-api",
          leads: topLeads,
        },
      },
    ] satisfies RealtimeSignalFetchResult[];
  }

  private async countNewsActivity(orgId: string, tokens: string[]) {
    if (tokens.length === 0) {
      return 0;
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const searchTokens = tokens.slice(0, 3);
    const coverageStart =
      await this.getProcessedArticleTermCoverageStart(orgId);
    const hasCoverage =
      coverageStart !== null && coverageStart.getTime() <= since.getTime();

    if (!hasCoverage) {
      return this.countNewsActivityFallback(orgId, searchTokens, since);
    }

    const rows = await this.prisma.processedArticleTermHourly.groupBy({
      where: {
        orgId,
        bucketStart: { gte: since },
        term: { in: searchTokens },
      },
      by: ["term"],
      _sum: {
        articleCount: true,
      },
    });

    const groupedCount = rows.reduce(
      (maxCount, row) => Math.max(maxCount, row._sum.articleCount ?? 0),
      0,
    );
    if (groupedCount > 0) {
      return groupedCount;
    }

    return this.countNewsActivityFallback(orgId, searchTokens, since);
  }

  private async getProcessedArticleTermCoverageStart(orgId: string) {
    const cached = await this.cache.wrap<{ bucketStart: string | null } | null>(
      `realtime-signals:processed-article-term-coverage:${orgId}`,
      PROCESSED_ARTICLE_TERM_COVERAGE_TTL_SECONDS,
      async () => {
        const row = await this.prisma.processedArticleTermHourly.findFirst({
          where: { orgId },
          orderBy: { bucketStart: "asc" },
          select: { bucketStart: true },
        });
        return row ? { bucketStart: row.bucketStart.toISOString() } : null;
      },
    );

    if (!cached?.bucketStart) {
      return null;
    }
    const parsed = new Date(cached.bucketStart);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private async countNewsActivityFallback(
    orgId: string,
    searchTokens: string[],
    since: Date,
  ) {
    let total = 0;
    for (const token of searchTokens) {
      const count = await this.prisma.processedArticle.count({
        where: {
          status: ProcessedArticleStatus.completed,
          orgId,
          processedAt: { gte: since },
          OR: [
            { title: { contains: token } },
            { summary: { contains: token } },
          ],
        },
      });
      total = Math.max(total, count);
    }
    return total;
  }

  private buildRecentTermCountsFromBuckets(
    rows: {
      term: string;
      source: string;
      _sum: { articleCount: number | null };
    }[],
  ) {
    const recentCounts = new Map<
      string,
      { count: number; sources: Set<string> }
    >();
    for (const row of rows) {
      const term = row.term.trim();
      if (!term) {
        continue;
      }
      const source = row.source.trim() || "unknown";
      const count = row._sum.articleCount ?? 0;
      const entry = recentCounts.get(term) ?? {
        count: 0,
        sources: new Set(),
      };
      entry.count += count;
      entry.sources.add(source);
      recentCounts.set(term, entry);
    }
    return recentCounts;
  }

  private buildBaselineTermCountsFromBuckets(
    rows: {
      term: string;
      _sum: { articleCount: number | null };
    }[],
  ) {
    const baselineCounts = new Map<string, number>();
    for (const row of rows) {
      const term = row.term.trim();
      if (!term) {
        continue;
      }
      baselineCounts.set(
        term,
        (baselineCounts.get(term) ?? 0) + (row._sum.articleCount ?? 0),
      );
    }
    return baselineCounts;
  }

  private async loadKeywordSpikeFallbackCounts(
    orgId: string,
    recentStart: Date,
    baselineStart: Date,
  ) {
    const [recentArticles, baselineArticles] = await Promise.all([
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          orgId,
          processedAt: { gte: recentStart },
        },
        select: {
          title: true,
          summary: true,
          source: true,
          topics: true,
        },
        orderBy: { processedAt: "desc" },
        take: 1_500,
      }),
      this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          orgId,
          processedAt: { gte: baselineStart, lt: recentStart },
        },
        select: {
          title: true,
          summary: true,
          source: true,
          topics: true,
        },
        orderBy: { processedAt: "desc" },
        take: 5_000,
      }),
    ]);

    const recentCounts = new Map<
      string,
      { count: number; sources: Set<string> }
    >();
    const baselineCounts = new Map<string, number>();

    for (const article of recentArticles) {
      const source = normalizeProcessedArticleSource(article.source);
      for (const term of extractProcessedArticleTerms(article)) {
        const entry = recentCounts.get(term) ?? {
          count: 0,
          sources: new Set(),
        };
        entry.count += 1;
        entry.sources.add(source);
        recentCounts.set(term, entry);
      }
    }

    for (const article of baselineArticles) {
      for (const term of extractProcessedArticleTerms(article)) {
        baselineCounts.set(term, (baselineCounts.get(term) ?? 0) + 1);
      }
    }

    return {
      recentCounts,
      baselineCounts,
      recentArticleCount: recentArticles.length,
      baselineArticleCount: baselineArticles.length,
    };
  }

  private extractTopicTokens(title: string) {
    return title
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 4 && !SIMPLE_STOPWORDS.has(entry))
      .slice(0, 8);
  }

  private resolvePolymarketYesPrice(eventRecord: Record<string, unknown>) {
    const markets = readArray(eventRecord.markets);
    for (const market of markets) {
      if (!market || typeof market !== "object") {
        continue;
      }
      const record = market as Record<string, unknown>;
      const yesPriceRaw =
        record.yesPrice ?? record.outcomePrice ?? record.lastTradePrice;
      const yesPrice = toFiniteNumber(yesPriceRaw);
      if (yesPrice === null) {
        continue;
      }
      if (yesPrice <= 1) {
        return yesPrice * 100;
      }
      return yesPrice;
    }

    const direct = toFiniteNumber(
      eventRecord.yesPrice ??
        eventRecord.price ??
        eventRecord.lastTradePrice ??
        eventRecord.probability,
    );
    if (direct === null) {
      return null;
    }
    return direct <= 1 ? direct * 100 : direct;
  }
}
