import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { RealtimeSignalsService } from "../realtime-signals/realtime-signals.service";

import {
  analyzeCorrelations,
  getCorrelationSummary,
  type CorrelationLearningOverride,
} from "./analysis/correlation";
import { calculateMainCharacter, getMainCharacterSummary } from "./analysis/main-character";
import { analyzeNarratives, getNarrativeSummary, type NarrativeLearningOverride } from "./analysis/narrative";
import { CORRELATION_TOPICS, NARRATIVE_PATTERNS } from "./analysis/patterns";
import type { SituationNewsItem } from "./analysis/types";
import {
  classifySituationMonitorCategory,
  SituationMonitorCategoryClassificationSource,
} from "./classification/category-classifier";
import { SITUATION_PANELS } from "./config/situations";
import { WORLD_LEADERS } from "./config/world-leaders";
import { FinancialMainlineSnapshotService } from "./external/financial-mainline-snapshot.service";
import { SituationMonitorExternalService } from "./external/situation-monitor-external.service";
import { SituationMonitorFeedbackService } from "./situation-monitor-feedback.service";
import {
  ALERT_KEYWORDS,
  CATEGORY_TAG_PREFIX,
  SOURCE_TAG,
  SITUATION_MONITOR_CATEGORIES,
} from "./situation-monitor.constants";
import type {
  SituationMonitorAlertHeadline,
  SituationMonitorCryptoItem,
  SituationMonitorFedSnapshot,
  SituationMonitorHeadline,
  SituationMonitorMarketsSnapshot,
  SituationMonitorPizzintSnapshot,
  SituationMonitorSituationPanel,
  SituationMonitorTensionPair,
  SituationMonitorWorldLeader,
} from "./situation-monitor.types";

const HISTORY_RETENTION_MINUTES = 30;
const MOMENTUM_WINDOW_MINUTES = 10;
const CORRELATION_COUNTS_KEY_PREFIX = "situation-monitor:correlation:counts";
const INSIGHTS_CACHE_KEY_PREFIX = "situation-monitor:insights:v2";
const INSIGHTS_CACHE_TTL_SECONDS_CORE = 45;
const INSIGHTS_CACHE_TTL_SECONDS_EXTERNAL = 300;
const INSIGHTS_LEARNING_REV_KEY_PREFIX = "situation-monitor:insights:learning-rev:v1";
const PLACEHOLDER_HEADLINE_TITLE_PATTERN =
  /^(?:no\s*title|untitled|title\s*unavailable|headline\s*unavailable|n\/a|na|null|undefined|\u6682\u65e0\u6807\u9898|\u65e0\u6807\u9898|\u672a\u547d\u540d(?:\u6807\u9898)?)$/i;

type SituationMonitorCategory = (typeof SITUATION_MONITOR_CATEGORIES)[number];

export interface SituationMonitorInsightsCategoryDiagnostics {
  internalCount: number;
  gdeltFallbackCount: number;
  totalCount: number;
}

export interface SituationMonitorInsightsDiagnostics {
  requestedScope: "tagged" | "all";
  effectiveScope: "tagged" | "all";
  categories: Record<SituationMonitorCategory, SituationMonitorInsightsCategoryDiagnostics>;
}

export interface SituationMonitorInsightsResponse {
  generatedAt: string;
  windowHours: number;
  maxItems: number;
  analyzedItems: number;
  diagnostics?: SituationMonitorInsightsDiagnostics;
  translation?: { target: "zh-CN"; applied: boolean; error?: string };
  headlines?: Record<SituationMonitorCategory, SituationMonitorHeadline[]>;
  alerts?: SituationMonitorAlertHeadline[];
  leaders?: SituationMonitorWorldLeader[];
  situations?: SituationMonitorSituationPanel[];
  markets?: SituationMonitorMarketsSnapshot;
  crypto?: SituationMonitorCryptoItem[];
  fed?: SituationMonitorFedSnapshot;
  pizzint?: SituationMonitorPizzintSnapshot;
  tensions?: SituationMonitorTensionPair[];
  correlation?: ReturnType<typeof analyzeCorrelations>["results"];
  correlationSummary?: ReturnType<typeof getCorrelationSummary>;
  narrative?: ReturnType<typeof analyzeNarratives>;
  narrativeSummary?: ReturnType<typeof getNarrativeSummary>;
  mainCharacter?: ReturnType<typeof calculateMainCharacter>;
  mainCharacterSummary?: ReturnType<typeof getMainCharacterSummary>;
}

@Injectable()
export class SituationMonitorService {
  constructor(
    private readonly cache: CacheService,
    private readonly external: SituationMonitorExternalService,
    private readonly financialMainlineSnapshots: FinancialMainlineSnapshotService,
    private readonly feedback: SituationMonitorFeedbackService,
    private readonly realtimeSignals: RealtimeSignalsService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  async getInsights(
    orgId: string,
    options?: {
      windowHours?: number;
      maxItems?: number;
      sections?: string[];
      gdelt?: boolean;
      scope?: "tagged" | "all";
      debug?: boolean;
    }
  ): Promise<SituationMonitorInsightsResponse> {
    const windowHours = this.clampInt(options?.windowHours, 1, 168, 24);
    const maxItems = this.clampInt(options?.maxItems, 50, 1000, 400);
    const maxHeadlinesPerCategory = 12;
    const analysisPerCategory = Math.max(
      maxHeadlinesPerCategory,
      Math.min(60, Math.ceil(maxItems / SITUATION_MONITOR_CATEGORIES.length))
    );

    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    const requestedSections = this.normalizeSections(options?.sections);
    const includeCore = requestedSections.size === 0 || requestedSections.has("core");
    const includeExternal = requestedSections.size === 0 || requestedSections.has("external");

    const response: SituationMonitorInsightsResponse = {
      generatedAt: new Date().toISOString(),
      windowHours,
      maxItems,
      analyzedItems: 0,
    };

    const allowGdeltFallback = options?.gdelt ?? this.external.isGdeltEnabled();
    const scope = options?.scope === "all" ? ("all" as const) : ("tagged" as const);
    const debug = Boolean(options?.debug);
    const learningRevRaw = await this.cache.get<number>(`${INSIGHTS_LEARNING_REV_KEY_PREFIX}:${orgId}`);
    const learningRevision = typeof learningRevRaw === "number" && Number.isFinite(learningRevRaw) ? learningRevRaw : 0;

    if (includeCore) {
      const cacheKey = this.insightsCacheKey({
        orgId,
        section: "core",
        windowHours,
        maxItems,
        scope,
        allowGdeltFallback,
        debug,
        learningRevision,
      });

      const core = await this.cache.wrap(cacheKey, INSIGHTS_CACHE_TTL_SECONDS_CORE, async () => {
        const headlines = await this.buildHeadlinesByCategory({
          orgId,
          since,
          maxItems,
          maxPerCategory: analysisPerCategory,
          allowGdeltFallback,
          scope,
          debug,
        });

        const displayHeadlines = this.toDisplayHeadlines(headlines, maxHeadlinesPerCategory);
        const analysisNews = this.flattenHeadlinesForAnalysis(headlines);
        const analyzedItems = analysisNews.length;

        const nowMinute = Math.floor(Date.now() / 60_000);
        const previousMinute = nowMinute - MOMENTUM_WINDOW_MINUTES;
        const ttlSeconds = (HISTORY_RETENTION_MINUTES + MOMENTUM_WINDOW_MINUTES + 5) * 60;

        const previousCountsKey = `${CORRELATION_COUNTS_KEY_PREFIX}:${orgId}:${previousMinute}`;
        const currentCountsKey = `${CORRELATION_COUNTS_KEY_PREFIX}:${orgId}:${nowMinute}`;

        const previousCounts = await this.cache.get<Record<string, number>>(previousCountsKey);

        const [correlationLearning, narrativeLearning] = await Promise.all([
          this.feedback.getLearningState(
            orgId,
            "correlation",
            CORRELATION_TOPICS.map((entry) => entry.id),
          ),
          this.feedback.getLearningState(
            orgId,
            "narrative",
            NARRATIVE_PATTERNS.map((entry) => entry.id),
          ),
        ]);

        const correlationOverrides = new Map<string, CorrelationLearningOverride>();
        for (const [signalId, snapshot] of correlationLearning.entries()) {
          correlationOverrides.set(signalId, {
            boostedTokens: snapshot.boostedTokens,
            blockedTokens: snapshot.blockedTokens,
            suppressedItemMetaIds: snapshot.suppressedItemMetaIds,
            falsePositiveCount: snapshot.falsePositiveCount,
            falseNegativeCount: snapshot.falseNegativeCount,
          });
        }

        const narrativeOverrides = new Map<string, NarrativeLearningOverride>();
        for (const [signalId, snapshot] of narrativeLearning.entries()) {
          narrativeOverrides.set(signalId, {
            boostedTokens: snapshot.boostedTokens,
            blockedTokens: snapshot.blockedTokens,
            suppressedItemMetaIds: snapshot.suppressedItemMetaIds,
            falsePositiveCount: snapshot.falsePositiveCount,
            falseNegativeCount: snapshot.falseNegativeCount,
          });
        }

        const { results: correlation, topicCounts } = analyzeCorrelations(analysisNews, {
          previousCounts: previousCounts ?? undefined,
          learning: correlationOverrides,
        });
        await this.cache.set(currentCountsKey, topicCounts, ttlSeconds);
        const realtimeSnapshot =
          await this.realtimeSignals.getSituationMonitorInsightSnapshot(orgId);
        const realtimePredictiveSignals =
          this.buildRealtimePredictiveSignals(realtimeSnapshot);
        const mergedCorrelation = correlation
          ? {
              ...correlation,
              predictiveSignals: [
                ...(correlation.predictiveSignals ?? []),
                ...realtimePredictiveSignals,
              ],
            }
          : realtimePredictiveSignals.length > 0
            ? {
                emergingPatterns: [],
                momentumSignals: [],
                crossSourceCorrelations: [],
                predictiveSignals: realtimePredictiveSignals,
              }
            : correlation;

        const narrative = analyzeNarratives(analysisNews, { learning: narrativeOverrides });
        const mainCharacter = calculateMainCharacter(analysisNews);

        return {
          diagnostics: this.buildDiagnostics(displayHeadlines, scope),
          headlines: displayHeadlines,
          analyzedItems,
          alerts: this.buildAlerts(displayHeadlines),
          leaders: this.buildWorldLeaders(analysisNews),
          situations: this.buildSituations(analysisNews),
          correlation: mergedCorrelation,
          correlationSummary: getCorrelationSummary(mergedCorrelation),
          pizzint: realtimeSnapshot.pizzint,
          tensions: realtimeSnapshot.tensions,
          narrative,
          narrativeSummary: getNarrativeSummary(narrative),
          mainCharacter,
          mainCharacterSummary: getMainCharacterSummary(mainCharacter),
        } satisfies Partial<SituationMonitorInsightsResponse>;
      });

      Object.assign(response, core);
    }

    if (includeExternal) {
      const cacheKey = this.insightsCacheKey({
        orgId,
        section: "external",
        windowHours,
        maxItems,
        scope,
        allowGdeltFallback,
        debug,
      });

      const external = await this.cache.wrap(cacheKey, INSIGHTS_CACHE_TTL_SECONDS_EXTERNAL, async () => {
        const [cryptoResult, marketsResult, fedResult, fedNewsResult] = await Promise.allSettled([
          this.external.getCryptoSnapshot(),
          this.financialMainlineSnapshots.getMarketsSnapshot(),
          this.financialMainlineSnapshots.getFedSnapshot(),
          this.external.getFedNews(),
        ]);

        const payload: Partial<SituationMonitorInsightsResponse> = {};

        if (cryptoResult.status === "fulfilled") {
          payload.crypto = cryptoResult.value;
        }
        if (marketsResult.status === "fulfilled") {
          payload.markets = marketsResult.value;
        }
        if (fedResult.status === "fulfilled" || fedNewsResult.status === "fulfilled") {
          const fedSnapshot =
            fedResult.status === "fulfilled"
              ? fedResult.value
              : {
                  hasFredApiKey: false,
                  indicators: [],
                  moneyPrinter: null,
                  news: [],
                };
          payload.fed = {
            ...fedSnapshot,
            news: fedNewsResult.status === "fulfilled" ? fedNewsResult.value : [],
            error:
              fedSnapshot.error ??
              (fedResult.status === "rejected" ? this.safeErrorMessage(fedResult.reason) : undefined) ??
              (fedNewsResult.status === "rejected" ? this.safeErrorMessage(fedNewsResult.reason) : undefined),
          };
        }

        return payload;
      });

      Object.assign(response, external);
    }

    return response;
  }

  private insightsCacheKey(options: {
    orgId: string;
    section: "core" | "external";
    windowHours: number;
    maxItems: number;
    scope: "tagged" | "all";
    allowGdeltFallback: boolean;
    debug: boolean;
    learningRevision?: number;
  }) {
    if (options.section === "external") {
      return `${INSIGHTS_CACHE_KEY_PREFIX}:external:${options.orgId}`;
    }

    const flags = [
      options.orgId,
      `wh${options.windowHours}`,
      `mi${options.maxItems}`,
      `sc${options.scope}`,
      `gd${options.allowGdeltFallback ? 1 : 0}`,
      `dbg${options.debug ? 1 : 0}`,
      `lr${Math.max(0, Math.trunc(options.learningRevision ?? 0))}`,
    ].join(":");

    return `${INSIGHTS_CACHE_KEY_PREFIX}:core:${flags}`;
  }

  private buildDiagnostics(
    headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>,
    scope: "tagged" | "all",
  ): SituationMonitorInsightsDiagnostics {
    const categories = {} as Record<SituationMonitorCategory, SituationMonitorInsightsCategoryDiagnostics>;

    for (const category of SITUATION_MONITOR_CATEGORIES) {
      const entries = headlines[category] ?? [];
      const internalCount = entries.filter((entry) => entry.origin === "items").length;
      const gdeltFallbackCount = entries.filter((entry) => entry.origin === "gdelt").length;
      categories[category] = {
        internalCount,
        gdeltFallbackCount,
        totalCount: entries.length,
      };
    }

    return {
      requestedScope: scope,
      effectiveScope: scope,
      categories,
    };
  }

  private normalizeSections(sections: string[] | undefined) {
    if (!sections) {
      return new Set<string>();
    }
    const normalized = sections
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry === "core" || entry === "external");
    return new Set(normalized.length > 0 ? normalized : []);
  }

  private safeErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    return undefined;
  }

  private buildRealtimePredictiveSignals(snapshot: {
    keywordSpikes: Array<{
      id: string;
      term: string;
      count: number;
      baseline: number;
      multiplier: number;
      sourceCount: number;
      confidence: number;
    }>;
    predictionLeads: Array<{
      id: string;
      title: string;
      shift: number;
      newsActivity: number;
      confidence: number;
    }>;
  }) {
    const predictiveSignals: NonNullable<
      ReturnType<typeof analyzeCorrelations>["results"]
    >["predictiveSignals"] = [];

    for (const spike of snapshot.keywordSpikes) {
      const confidenceScore = Math.max(
        0,
        Math.min(100, Math.round(spike.confidence * 100)),
      );
      const level: "high" | "medium" | "low" =
        confidenceScore >= 70
          ? "high"
          : confidenceScore >= 50
            ? "medium"
            : "low";
      predictiveSignals.push({
        id: `keyword_spike:${spike.id}`,
        name: `Keyword Spike · ${spike.term}`,
        category: "Realtime",
        score: Number((spike.multiplier * 10 + spike.count).toFixed(3)),
        confidence: confidenceScore,
        prediction:
          "Cross-source headline velocity indicates emerging narrative pressure.",
        level,
        headlines: [],
      });
    }

    for (const lead of snapshot.predictionLeads) {
      const confidenceScore = Math.max(
        0,
        Math.min(100, Math.round(lead.confidence * 100)),
      );
      const level: "high" | "medium" | "low" =
        confidenceScore >= 70
          ? "high"
          : confidenceScore >= 50
            ? "medium"
            : "low";
      predictiveSignals.push({
        id: `prediction_leads_news:${lead.id}`,
        name: `Prediction Leads · ${lead.title}`,
        category: "Realtime",
        score: Number((lead.shift * 10 + (3 - Math.min(3, lead.newsActivity))).toFixed(3)),
        confidence: confidenceScore,
        prediction:
          "Market pricing moved ahead of mainstream coverage; watch for delayed narrative pickup.",
        level,
        headlines: [],
      });
    }

    predictiveSignals.sort((a, b) => b.score - a.score);
    return predictiveSignals;
  }

  private async buildHeadlinesByCategory(options: {
    orgId: string;
    since: Date;
    maxItems: number;
    maxPerCategory: number;
    allowGdeltFallback: boolean;
    scope: "tagged" | "all";
    debug: boolean;
  }): Promise<Record<SituationMonitorCategory, SituationMonitorHeadline[]>> {
    const byCategory: Record<SituationMonitorCategory, SituationMonitorHeadline[]> = {
      politics: [],
      tech: [],
      finance: [],
      gov: [],
      ai: [],
      intel: [],
    };

    const maxCandidates = Math.min(
      2_000,
      Math.max(options.maxItems, options.maxPerCategory * SITUATION_MONITOR_CATEGORIES.length * 4)
    );

    const processedMatch: Record<string, unknown> = {
      orgId: options.orgId,
      status: "completed",
      duplicateOf: null,
      $or: [
        { sortAt: { $gte: options.since } },
        { sortAt: { $exists: false }, ingestedAt: { $gte: options.since } },
        { sortAt: null, ingestedAt: { $gte: options.since } },
        { sortAt: { $exists: false }, ingestedAt: { $exists: false }, createdAt: { $gte: options.since } },
        { sortAt: null, ingestedAt: { $exists: false }, createdAt: { $gte: options.since } }
      ],
      ...(options.scope === "tagged" ? { tags: SOURCE_TAG } : {}),
    };

    const processed = await ProcessedItemModel.find(processedMatch)
      .sort({ sortAt: -1, ingestedAt: -1, createdAt: -1 })
      .limit(maxCandidates)
      .select({
        _id: 1,
        rawItemId: 1,
        itemMetaId: 1,
        tags: 1,
        sortAt: 1,
        ingestedAt: 1,
        createdAt: 1,
        "result.title": 1,
        "result.subtitle": 1,
        "result.source": 1,
        "result.summary": 1,
        "result.key_points": 1,
        "result.topics": 1,
        "result.category": 1,
      })
      .lean()
      .exec();

    const rawItemIds: string[] = processed
      .map((item) => item.rawItemId)
      .filter((id) => Boolean(id))
      .map((id) => String(id));

    const rawItems = rawItemIds.length
      ? await RawItemModel.find({ _id: { $in: rawItemIds } })
          .select({
            _id: 1,
            "payload.url": 1,
            "payload.sourceName": 1,
            "payload.tags": 1,
          })
          .lean()
          .exec()
      : [];

    const rawById = new Map<string, (typeof rawItems)[number]>();
    for (const raw of rawItems) {
      rawById.set(String(raw._id), raw);
    }

    for (const item of processed) {
      const raw = rawById.get(String(item.rawItemId));
      const url =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).url
          : undefined;
      const link = typeof url === "string" ? url.trim() : "";

      const title =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? ((item.result as Record<string, unknown>).title as string | null | undefined) ?? ""
          : "";
      const trimmedTitle = typeof title === "string" ? title.trim() : "";

      if (!trimmedTitle || this.isPlaceholderTitle(trimmedTitle) || !link) {
        continue;
      }

      const result =
        item.result && typeof item.result === "object" && !Array.isArray(item.result)
          ? (item.result as Record<string, unknown>)
          : null;

      const subtitle = typeof result?.subtitle === "string" ? result.subtitle.trim() : "";
      const rawSummary = typeof result?.summary === "string" ? result.summary.trim() : subtitle;
      const summary = this.normalizeSummary(rawSummary);
      const keyPoints = this.normalizeKeyPoints(result?.key_points);
      const topics = this.normalizeTopics(result?.topics);

      const rawSourceName =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>).sourceName
          : undefined;
      const extractedSource =
        typeof result?.source === "string" ? result.source : undefined;

      const source =
        (typeof extractedSource === "string" && extractedSource.trim()) ||
        (typeof rawSourceName === "string" && rawSourceName.trim()) ||
        this.tryDomain(link) ||
        "Unknown";

      const classification =
        options.scope === "tagged"
          ? {
              category: this.extractCategory(item.tags),
              source: SituationMonitorCategoryClassificationSource.Tag,
            }
          : classifySituationMonitorCategory({
              tags: item.tags,
              result,
              rawTags:
                raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
                  ? (raw.payload as Record<string, unknown>).tags
                  : undefined,
              title: trimmedTitle,
              summary,
              source,
            });

      if (!classification.category) {
        continue;
      }
      if (byCategory[classification.category].length >= options.maxPerCategory) {
        continue;
      }

      const sortAt = this.toDate(item.sortAt);
      const ingestedAt = this.toDate((item as { ingestedAt?: unknown }).ingestedAt);
      const createdAt = this.toDate(item.createdAt);
      const timestamp = (sortAt ?? ingestedAt ?? createdAt ?? new Date()).getTime();

      const alertKeyword = this.findAlertKeyword(`${trimmedTitle} ${summary ?? ""}`.trim());

      const itemMetaId =
        typeof (item as { itemMetaId?: unknown }).itemMetaId === "string"
          ? (item as { itemMetaId?: string }).itemMetaId?.trim()
          : "";

      byCategory[classification.category].push({
        id: String((item as { _id?: unknown })._id ?? link),
        itemMetaId: itemMetaId || undefined,
        title: trimmedTitle,
        link,
        source,
        timestamp,
        category: classification.category,
        origin: "items",
        isAlert: Boolean(alertKeyword),
        alertKeyword: alertKeyword ?? undefined,
        summary: summary ?? undefined,
        keyPoints: keyPoints.length > 0 ? keyPoints : undefined,
        topics: topics.length > 0 ? topics : undefined,
        classificationSource: options.debug ? classification.source ?? undefined : undefined,
        classificationConfidence:
          options.debug && typeof classification.confidence === "number"
            ? classification.confidence
            : undefined,
        classificationReason:
          options.debug && classification.reason
            ? classification.reason
            : undefined,
      });
    }

    if (options.allowGdeltFallback) {
      const fills = SITUATION_MONITOR_CATEGORIES.flatMap((category) => {
        const remaining = options.maxPerCategory - byCategory[category].length;
        if (remaining <= 0) {
          return [];
        }
        return [{ category, remaining }];
      });

      if (fills.length > 0) {
        const fillResults = await Promise.allSettled(
          fills.map(async ({ category, remaining }) => ({
            category,
            headlines: await this.external.fetchGdeltCategoryHeadlines(category, remaining),
          })),
        );

        for (const entry of fillResults) {
          if (entry.status !== "fulfilled") {
            continue;
          }
          const existingLinks = new Set(byCategory[entry.value.category].map((headline) => headline.link));
          for (const headline of entry.value.headlines) {
            if (byCategory[entry.value.category].length >= options.maxPerCategory) {
              break;
            }
            const normalizedTitle = typeof headline.title === "string" ? headline.title.trim() : "";
            const normalizedLink = typeof headline.link === "string" ? headline.link.trim() : "";
            if (!normalizedTitle || this.isPlaceholderTitle(normalizedTitle) || !normalizedLink) {
              continue;
            }
            if (existingLinks.has(normalizedLink)) {
              continue;
            }
            existingLinks.add(normalizedLink);
            byCategory[entry.value.category].push({
              ...headline,
              title: normalizedTitle,
              link: normalizedLink,
            });
          }
        }
      }
    }

    return byCategory;
  }

  private extractCategory(tags: unknown): SituationMonitorCategory | null {
    if (!Array.isArray(tags)) {
      return null;
    }
    for (const tag of tags) {
      if (typeof tag !== "string") {
        continue;
      }
      if (!tag.startsWith(CATEGORY_TAG_PREFIX)) {
        continue;
      }
      const category = tag.slice(CATEGORY_TAG_PREFIX.length).trim().toLowerCase();
      if ((SITUATION_MONITOR_CATEGORIES as readonly string[]).includes(category)) {
        return category as SituationMonitorCategory;
      }
    }
    return null;
  }

  private findAlertKeyword(title: string): string | null {
    const haystack = title.toLowerCase();
    for (const keyword of ALERT_KEYWORDS) {
      if (haystack.includes(keyword)) {
        return keyword;
      }
    }
    return null;
  }

  private isPlaceholderTitle(title: string): boolean {
    const normalized = title.trim().replace(/[。.!?！？]+$/gu, "").trim();
    if (!normalized) {
      return true;
    }
    return PLACEHOLDER_HEADLINE_TITLE_PATTERN.test(normalized);
  }

  private toDisplayHeadlines(
    headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>,
    maxPerCategory: number,
  ): Record<SituationMonitorCategory, SituationMonitorHeadline[]> {
    const result: Record<SituationMonitorCategory, SituationMonitorHeadline[]> = {
      politics: headlines.politics.slice(0, maxPerCategory),
      tech: headlines.tech.slice(0, maxPerCategory),
      finance: headlines.finance.slice(0, maxPerCategory),
      gov: headlines.gov.slice(0, maxPerCategory),
      ai: headlines.ai.slice(0, maxPerCategory),
      intel: headlines.intel.slice(0, maxPerCategory),
    };
    return result;
  }

  private flattenHeadlinesForAnalysis(
    headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>,
  ): SituationNewsItem[] {
    return SITUATION_MONITOR_CATEGORIES.flatMap((category) =>
      headlines[category].map((headline) => ({
        title: headline.title,
        titleZh: headline.titleZh,
        link: headline.link,
        source: headline.source,
        timestamp: headline.timestamp,
        itemMetaId: headline.itemMetaId,
        summary: headline.summary,
        keyPoints: headline.keyPoints,
        topics: headline.topics,
      })),
    );
  }

  private buildAlerts(
    headlines: Record<SituationMonitorCategory, SituationMonitorHeadline[]>,
  ): SituationMonitorAlertHeadline[] {
    const critical = new Set([
      "nuclear",
      "invasion",
      "missile",
      "attack",
      "assassination",
      "terrorist",
      "hostage",
      "martial law",
    ]);

    const flattened = SITUATION_MONITOR_CATEGORIES.flatMap((category) => headlines[category])
      .filter((headline) => headline.isAlert)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((headline) => ({
        ...headline,
        severity: critical.has((headline.alertKeyword ?? "").toLowerCase())
          ? ("critical" as const)
          : ("elevated" as const),
      }));

    return flattened;
  }

  private buildWorldLeaders(news: SituationNewsItem[]): SituationMonitorWorldLeader[] {
    const items = news
      .filter((item) => Boolean(item.title))
      .sort((a, b) => b.timestamp - a.timestamp);

    const results: SituationMonitorWorldLeader[] = WORLD_LEADERS.map((leader) => {
      const matched = items.filter((item) => this.matchesLeader(item.title, leader.keywords));
      return {
        id: leader.id,
        name: leader.name,
        title: leader.title,
        country: leader.country,
        flag: leader.flag,
        since: leader.since,
        party: leader.party,
        focus: leader.focus,
        matchCount: matched.length,
        headlines: matched.slice(0, 2).map((entry) => ({
          title: entry.title,
          link: entry.link,
          source: entry.source,
          timestamp: entry.timestamp,
        })),
      };
    });

    return results.sort((a, b) => b.matchCount - a.matchCount);
  }

  private matchesLeader(title: string, keywords: string[]) {
    const lower = title.toLowerCase();
    for (const keyword of keywords) {
      const normalized = keyword.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.length <= 3 && /^[a-z0-9]+$/i.test(normalized)) {
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`\\b${escaped}\\b`, "i");
        if (regex.test(title)) {
          return true;
        }
        continue;
      }
      if (lower.includes(normalized)) {
        return true;
      }
    }
    return false;
  }

  private buildSituations(news: SituationNewsItem[]): SituationMonitorSituationPanel[] {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    return SITUATION_PANELS.map((panel) => {
      const matchKeywords = panel.matchKeywords.map((kw) => kw.toLowerCase());
      const criticalKeywords = panel.criticalKeywords.map((kw) => kw.toLowerCase());
      const matched = news
        .filter((item) => matchKeywords.some((kw) => item.title.toLowerCase().includes(kw)))
        .sort((a, b) => b.timestamp - a.timestamp);

      const recentCount = matched.filter((item) => item.timestamp >= dayAgo).length;
      const hasCritical = matched.some((item) =>
        criticalKeywords.some((kw) => item.title.toLowerCase().includes(kw)),
      );

      const level: SituationMonitorSituationPanel["level"] =
        hasCritical || recentCount >= 3 ? "critical" : recentCount >= 1 ? "elevated" : "monitoring";
      const status: SituationMonitorSituationPanel["status"] =
        level === "critical" ? "CRITICAL" : level === "elevated" ? "ELEVATED" : "MONITORING";

      return {
        id: panel.id,
        title: panel.title,
        subtitle: panel.subtitle,
        level,
        status,
        headlines: matched.slice(0, 8).map((item) => ({
          title: item.title,
          link: item.link,
          source: item.source,
          timestamp: item.timestamp,
        })),
      };
    });
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const rounded = Math.round(value);
    return Math.max(min, Math.min(max, rounded));
  }

  private normalizeSummary(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return null;
    }
    const maxLength = 240;
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
  }

  private normalizeKeyPoints(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim().replace(/\s+/g, " ");
      if (!normalized) {
        continue;
      }
      if (!out.includes(normalized)) {
        out.push(normalized.length > 180 ? `${normalized.slice(0, 179).trimEnd()}…` : normalized);
      }
      if (out.length >= 3) {
        break;
      }
    }
    return out;
  }

  private normalizeTopics(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim();
      if (!normalized) {
        continue;
      }
      if (!out.includes(normalized)) {
        out.push(normalized);
      }
      if (out.length >= 6) {
        break;
      }
    }
    return out;
  }

  private tryDomain(url: string) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }

  private toDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }
    if (value instanceof Date && Number.isFinite(value.valueOf())) {
      return value;
    }
    if (typeof value === "number" || typeof value === "string") {
      const candidate = new Date(value);
      if (Number.isFinite(candidate.valueOf())) {
        return candidate;
      }
    }
    return null;
  }
}
