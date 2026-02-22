import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { VectorClientService } from "../vector/vector-client.service";

import { ArchiveClassifier } from "./archive.classifier";
import {
  ARCHIVE_VERTICAL_DISPLAY_NAME,
  ARCHIVE_VERTICAL_ORDER,
  ARCHIVE_WEIGHT_TO_VALUE,
  type ArchiveCalendarDayResult,
  type ArchiveCalendarQueryInput,
  type ArchiveDetailResult,
  type ArchiveDigestItem,
  type ArchiveDigestQueryInput,
  type ArchiveDigestResult,
  ArchiveRegion,
  ArchiveVertical,
  ArchiveWeight,
  type ArchiveWeightValue,
} from "./archive.types";

const MAX_BASE_SCAN = 12000;
const DIGEST_SCAN_BATCH = 400;
const MAX_SEARCH_SCAN = 500;
const MAX_RERANK_DOCUMENTS = 180;
const CALENDAR_SCAN_BATCH = 600;
const MIN_VECTOR_SCORE = 0.55;

interface ArchiveProcessedRow {
  id: string;
  title: string | null;
  summary: string | null;
  source: string | null;
  publishedAt: Date | null;
  topics: unknown;
  entities: unknown;
  qualityScore: number | null;
  location: string | null;
  processedAt: Date;
  cleanedMarkdownRef: string | null;
  article: {
    id: string;
    orgId: string;
    url: string;
    sourceLabel: string | null;
    crawlAt: Date;
  };
  newsEventItems: Array<{
    eventId: string;
  }>;
}

@Injectable()
export class ArchiveService {
  private readonly logger = createLogger({ name: "archive-service" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly liteLlm: LiteLlmService,
    private readonly vectorClient: VectorClientService,
    private readonly classifier: ArchiveClassifier,
  ) {}

  async getDigest(
    orgId: string,
    input: ArchiveDigestQueryInput,
  ): Promise<ArchiveDigestResult> {
    const anchorDate = this.toUtcDayEnd(input.anchorDate);
    const search = this.normalizeOptionalString(input.search);
    const allowedWeights = this.resolveAllowedWeights(input.weights);
    const limitPerVertical = this.resolveLimitPerVertical(
      input.limitPerVertical,
    );
    const targetRows = Math.min(
      MAX_BASE_SCAN,
      Math.max(limitPerVertical * ARCHIVE_VERTICAL_ORDER.length * 6, 1200),
    );

    const searchResult = search
      ? await this.loadSearchCandidates(orgId, anchorDate, search)
      : {
          rows: await this.loadRecentCandidates(orgId, anchorDate, targetRows),
          rerankScoreByArticleId: new Map<string, number>(),
        };
    if (!search && searchResult.rows.length >= MAX_BASE_SCAN) {
      this.logger.error(
        { orgId, anchorDate: anchorDate.toISOString(), maxScan: MAX_BASE_SCAN },
        "Archive digest scan limit exceeded.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_SCAN_LIMIT_EXCEEDED",
        message:
          "Archive digest scan limit exceeded. Please narrow filters and retry.",
      });
    }

    const grouped = new Map<ArchiveVertical, ArchiveDigestItem[]>(
      ARCHIVE_VERTICAL_ORDER.map((vertical) => [vertical, []]),
    );

    for (const row of searchResult.rows) {
      const sortAt = this.resolveSortAt(row);
      if (sortAt.getTime() > anchorDate.getTime()) {
        continue;
      }

      const weight = this.qualityScoreToWeight(row.qualityScore);
      if (!allowedWeights.has(weight)) {
        continue;
      }

      const classification = this.classifier.classify({
        title: row.title,
        summary: row.summary,
        topics: row.topics,
        entities: row.entities,
        location: row.location,
      });
      if (classification.region !== input.region) {
        continue;
      }

      const rerankScore =
        searchResult.rerankScoreByArticleId.get(row.id) ?? null;
      const list = grouped.get(classification.vertical);
      if (!list) {
        continue;
      }

      list.push({
        processedArticleId: row.id,
        eventId: row.newsEventItems[0]?.eventId ?? null,
        title: this.normalizeOptionalString(row.title),
        summary: this.normalizeOptionalString(row.summary),
        countryLabel: classification.countryLabel,
        region: classification.region,
        vertical: classification.vertical,
        weight,
        qualityScore: this.normalizeQualityScore(row.qualityScore),
        publishedAt: row.publishedAt ?? row.article.crawlAt ?? row.processedAt,
        sortAt,
        sourceLabel:
          this.normalizeOptionalString(row.source) ??
          this.normalizeOptionalString(row.article.sourceLabel),
        sourceUrl: this.normalizeOptionalString(row.article.url),
        entityTags: classification.entityTags,
        keywordHighlights: this.extractKeywordHighlights(
          search,
          row,
          classification.entityTags,
        ),
        rerankScore,
      });
    }

    const useRerank = Boolean(search);
    let totalCount = 0;
    const groups = ARCHIVE_VERTICAL_ORDER.map((vertical) => {
      const allItems = grouped.get(vertical) ?? [];
      const sorted = allItems.sort((a, b) =>
        this.compareDigestItems(a, b, useRerank),
      );
      totalCount += sorted.length;
      return {
        vertical,
        displayName: ARCHIVE_VERTICAL_DISPLAY_NAME[vertical],
        totalCount: sorted.length,
        items: sorted.slice(0, limitPerVertical),
      };
    });

    return {
      anchorDate,
      region: input.region,
      totalCount,
      groups,
    };
  }

  async getCalendar(
    orgId: string,
    input: ArchiveCalendarQueryInput,
  ): Promise<ArchiveCalendarDayResult[]> {
    const { start, end } = this.resolveMonthRange(input.month);
    const rows = await this.loadRangeCandidates(orgId, start, end);
    const buckets = new Map<string, number>();

    for (const row of rows) {
      const sortAt = this.resolveSortAt(row);
      if (
        sortAt.getTime() < start.getTime() ||
        sortAt.getTime() > end.getTime()
      ) {
        continue;
      }

      const classification = this.classifier.classify({
        title: row.title,
        summary: row.summary,
        topics: row.topics,
        entities: row.entities,
        location: row.location,
      });
      if (input.region && classification.region !== input.region) {
        continue;
      }
      if (input.vertical && classification.vertical !== input.vertical) {
        continue;
      }

      const dateKey = this.toDateKey(sortAt);
      buckets.set(dateKey, (buckets.get(dateKey) ?? 0) + 1);
    }

    return Array.from(buckets.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getDetail(
    orgId: string,
    processedArticleId: string,
  ): Promise<ArchiveDetailResult | null> {
    const article = await this.prisma.processedArticle.findFirst({
      where: {
        id: processedArticleId,
        status: ProcessedArticleStatus.completed,
        article: { orgId },
      },
      include: {
        article: {
          select: {
            url: true,
            sourceLabel: true,
            crawlAt: true,
          },
        },
        newsEventItems: {
          where: { orgId },
          select: { eventId: true },
          take: 1,
        },
      },
    });

    if (!article) {
      return null;
    }

    const eventId = article.newsEventItems[0]?.eventId ?? null;
    let timeline: ArchiveDetailResult["timeline"] = [];
    let relatedArticles: ArchiveDetailResult["relatedArticles"] = [];

    if (eventId) {
      const event = await this.prisma.newsEvent.findFirst({
        where: { id: eventId, orgId },
        include: {
          timeline: {
            orderBy: [{ bucketStart: "asc" }],
            take: 160,
          },
          items: {
            orderBy: [{ createdAt: "desc" }],
            take: 12,
            include: {
              processedArticle: {
                include: {
                  article: {
                    select: {
                      url: true,
                      sourceLabel: true,
                      crawlAt: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (event) {
        timeline = event.timeline.map((entry) => ({
          id: entry.id,
          bucketStart: entry.bucketStart,
          title: this.normalizeOptionalString(entry.title),
          summary: this.normalizeOptionalString(entry.summary),
        }));

        relatedArticles = event.items.map((item) => ({
          processedArticleId: item.processedArticleId,
          title: this.normalizeOptionalString(item.processedArticle.title),
          summary: this.normalizeOptionalString(item.processedArticle.summary),
          publishedAt:
            item.processedArticle.publishedAt ??
            item.processedArticle.article.crawlAt,
          sourceLabel:
            this.normalizeOptionalString(item.processedArticle.source) ??
            this.normalizeOptionalString(
              item.processedArticle.article.sourceLabel,
            ),
          sourceUrl: this.normalizeOptionalString(
            item.processedArticle.article.url,
          ),
        }));
      }
    }

    return {
      processedArticleId: article.id,
      eventId,
      title: this.normalizeOptionalString(article.title),
      summary: this.normalizeOptionalString(article.summary),
      fullEntities: this.extractEntityNames(article.entities),
      sourceUrl: this.normalizeOptionalString(article.article.url),
      sourceLabel:
        this.normalizeOptionalString(article.source) ??
        this.normalizeOptionalString(article.article.sourceLabel),
      timeline,
      relatedArticles,
    };
  }

  private async loadSearchCandidates(
    orgId: string,
    anchorDate: Date,
    query: string,
  ): Promise<{
    rows: ArchiveProcessedRow[];
    rerankScoreByArticleId: Map<string, number>;
  }> {
    const embeddingModel = await this.liteLlm.getEmbeddingModel();
    if (!embeddingModel) {
      this.logger.error(
        { orgId, query },
        "Archive semantic search unavailable: embedding model is not configured.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_EMBEDDING_UNAVAILABLE",
        message:
          "Archive semantic search is unavailable because embedding is not configured.",
      });
    }

    const vectorScoreByProcessedRef = new Map<string, number>();
    let rows: ArchiveProcessedRow[] = [];

    let vector: number[] | null = null;
    let vectorModel = embeddingModel;
    try {
      const embeddingResponse = await this.liteLlm.embedding({
        orgId,
        model: embeddingModel,
        input: query,
        metadata: {
          orgId,
          source: "archive-search",
        },
      });
      vectorModel = embeddingResponse.model ?? embeddingModel;
      const candidate = embeddingResponse.data?.[0]?.embedding;
      if (Array.isArray(candidate) && candidate.length > 0) {
        vector = candidate;
      }
    } catch (error) {
      this.logger.error(
        {
          orgId,
          query,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive embedding generation failed.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_EMBEDDING_FAILED",
        message: "Archive semantic search failed to generate embedding.",
      });
    }

    if (!vector) {
      this.logger.error(
        { orgId, query, embeddingModel: vectorModel },
        "Archive embedding response did not include a usable vector.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_EMBEDDING_INVALID_RESPONSE",
        message:
          "Archive semantic search failed because embedding response is invalid.",
      });
    }

    const matches = await this.vectorClient.searchBestEffort({
      orgId,
      embeddingModel: vectorModel,
      vector,
      limit: MAX_SEARCH_SCAN,
      minScore: MIN_VECTOR_SCORE,
    });
    if (matches === null) {
      this.logger.error(
        { orgId, query, embeddingModel: vectorModel },
        "Archive vector recall failed because vector service is unavailable.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_VECTOR_UNAVAILABLE",
        message:
          "Archive semantic search failed because vector retrieval is unavailable.",
      });
    }
    for (const match of matches) {
      vectorScoreByProcessedRef.set(match.processedItemId, match.score);
    }

    const matchedRefs = Array.from(vectorScoreByProcessedRef.keys()).filter(
      (ref) => ref.trim().length > 0,
    );
    if (matchedRefs.length > 0) {
      rows = (await this.prisma.processedArticle.findMany({
        where: {
          status: ProcessedArticleStatus.completed,
          article: { orgId },
          cleanedMarkdownRef: { in: matchedRefs },
        },
        include: {
          article: {
            select: {
              id: true,
              orgId: true,
              url: true,
              sourceLabel: true,
              crawlAt: true,
            },
          },
          newsEventItems: {
            where: { orgId },
            select: { eventId: true },
            take: 1,
          },
        },
        take: MAX_SEARCH_SCAN,
      })) as ArchiveProcessedRow[];
    }

    const uniqueRows = this.dedupeByProcessedArticle(rows);
    const preRanked = uniqueRows
      .filter(
        (row) => this.resolveSortAt(row).getTime() <= anchorDate.getTime(),
      )
      .sort((a, b) => {
        const aScore =
          vectorScoreByProcessedRef.get(a.cleanedMarkdownRef ?? "") ?? 0;
        const bScore =
          vectorScoreByProcessedRef.get(b.cleanedMarkdownRef ?? "") ?? 0;
        if (bScore !== aScore) {
          return bScore - aScore;
        }
        return (
          this.resolveSortAt(b).getTime() - this.resolveSortAt(a).getTime()
        );
      });

    const rerankCandidates = preRanked.slice(0, MAX_RERANK_DOCUMENTS);
    if (rerankCandidates.length === 0) {
      return { rows: preRanked, rerankScoreByArticleId: new Map() };
    }

    const rerankScoreByArticleId = new Map<string, number>();
    try {
      const rerankResponse = await this.liteLlm.rerank({
        orgId,
        query,
        documents: rerankCandidates.map((row) => this.buildRerankDocument(row)),
        topN: rerankCandidates.length,
        maxRetries: 1,
        metadata: {
          orgId,
          source: "archive-search-rerank",
        },
      });
      const numericScores = rerankResponse.results
        .map((result) => result.score)
        .filter((score): score is number => Number.isFinite(score));
      const min = numericScores.length > 0 ? Math.min(...numericScores) : 0;
      const max = numericScores.length > 0 ? Math.max(...numericScores) : 0;
      const span = max - min;
      for (const result of rerankResponse.results) {
        const candidate = rerankCandidates[result.index];
        if (!candidate) {
          continue;
        }
        const normalized =
          span > 1e-9 ? (result.score - min) / span : max > 0 ? 1 : 0;
        rerankScoreByArticleId.set(candidate.id, this.clamp01(normalized));
      }
    } catch (error) {
      this.logger.error(
        {
          orgId,
          query,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive rerank failed.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_RERANK_FAILED",
        message: "Archive semantic search failed during reranking.",
      });
    }

    if (rerankCandidates.length > 0 && rerankScoreByArticleId.size === 0) {
      this.logger.error(
        { orgId, query, candidateCount: rerankCandidates.length },
        "Archive rerank response did not provide usable scores.",
      );
      throw new ServiceUnavailableException({
        code: "ARCHIVE_RERANK_INVALID_RESPONSE",
        message:
          "Archive semantic search failed because rerank response is invalid.",
      });
    }

    return {
      rows: preRanked,
      rerankScoreByArticleId,
    };
  }

  private async loadRecentCandidates(
    orgId: string,
    anchorDate: Date,
    targetRows: number,
  ) {
    const rows: ArchiveProcessedRow[] = [];
    let cursor: { processedAt: Date; id: string } | null = null;

    while (rows.length < MAX_BASE_SCAN) {
      const remaining = MAX_BASE_SCAN - rows.length;
      const take = Math.min(DIGEST_SCAN_BATCH, remaining);
      const batch = (await this.prisma.processedArticle.findMany({
        where: this.buildRecentCandidatesWhere(orgId, anchorDate, cursor),
        include: this.buildArchiveRowInclude(orgId),
        orderBy: [{ processedAt: "desc" }, { id: "desc" }],
        take,
      })) as ArchiveProcessedRow[];
      if (batch.length === 0) {
        break;
      }

      rows.push(...batch);
      const last = batch[batch.length - 1];
      if (!last) {
        break;
      }
      cursor = { processedAt: last.processedAt, id: last.id };

      if (rows.length >= targetRows) {
        break;
      }
    }

    return rows;
  }

  private async loadRangeCandidates(
    orgId: string,
    start: Date,
    end: Date,
  ) {
    const rows: ArchiveProcessedRow[] = [];
    let cursor: { processedAt: Date; id: string } | null = null;

    while (true) {
      const batch = (await this.prisma.processedArticle.findMany({
        where: this.buildRangeCandidatesWhere(orgId, start, end, cursor),
        include: this.buildArchiveRowInclude(orgId),
        orderBy: [{ processedAt: "desc" }, { id: "desc" }],
        take: CALENDAR_SCAN_BATCH,
      })) as ArchiveProcessedRow[];
      if (batch.length === 0) {
        break;
      }

      rows.push(...batch);
      const last = batch[batch.length - 1];
      if (!last) {
        break;
      }

      const nextCursor = { processedAt: last.processedAt, id: last.id };
      if (
        cursor &&
        cursor.id === nextCursor.id &&
        cursor.processedAt.getTime() === nextCursor.processedAt.getTime()
      ) {
        break;
      }
      cursor = nextCursor;

      if (batch.length < CALENDAR_SCAN_BATCH) {
        break;
      }
    }

    return rows;
  }

  private buildArchiveRowInclude(orgId: string) {
    return {
      article: {
        select: {
          id: true,
          orgId: true,
          url: true,
          sourceLabel: true,
          crawlAt: true,
        },
      },
      newsEventItems: {
        where: { orgId },
        select: { eventId: true },
        take: 1,
      },
    } as const;
  }

  private buildRecentCandidatesWhere(
    orgId: string,
    anchorDate: Date,
    cursor: { processedAt: Date; id: string } | null,
  ) {
    const conditions: Record<string, unknown>[] = [
      {
        OR: [
          { publishedAt: { lte: anchorDate } },
          { article: { crawlAt: { lte: anchorDate } } },
          { processedAt: { lte: anchorDate } },
        ],
      },
    ];
    const cursorFilter = this.buildProcessedAtCursorFilter(cursor);
    if (cursorFilter) {
      conditions.push(cursorFilter);
    }

    return {
      status: ProcessedArticleStatus.completed,
      article: { orgId },
      AND: conditions,
    };
  }

  private buildRangeCandidatesWhere(
    orgId: string,
    start: Date,
    end: Date,
    cursor: { processedAt: Date; id: string } | null,
  ) {
    const conditions: Record<string, unknown>[] = [
      {
        OR: [
          { publishedAt: { gte: start, lte: end } },
          {
            AND: [
              { publishedAt: null },
              { article: { crawlAt: { gte: start, lte: end } } },
            ],
          },
          {
            AND: [
              { publishedAt: null },
              { processedAt: { gte: start, lte: end } },
            ],
          },
        ],
      },
    ];
    const cursorFilter = this.buildProcessedAtCursorFilter(cursor);
    if (cursorFilter) {
      conditions.push(cursorFilter);
    }

    return {
      status: ProcessedArticleStatus.completed,
      article: { orgId },
      AND: conditions,
    };
  }

  private buildProcessedAtCursorFilter(
    cursor: { processedAt: Date; id: string } | null,
  ) {
    if (!cursor) {
      return null;
    }
    return {
      OR: [
        { processedAt: { lt: cursor.processedAt } },
        {
          AND: [{ processedAt: cursor.processedAt }, { id: { lt: cursor.id } }],
        },
      ],
    };
  }

  private dedupeByProcessedArticle(rows: ArchiveProcessedRow[]) {
    const map = new Map<string, ArchiveProcessedRow>();
    for (const row of rows) {
      if (!map.has(row.id)) {
        map.set(row.id, row);
      }
    }
    return Array.from(map.values());
  }

  private buildRerankDocument(row: ArchiveProcessedRow) {
    const title = this.normalizeOptionalString(row.title);
    const summary = this.normalizeOptionalString(row.summary);
    const source =
      this.normalizeOptionalString(row.source) ??
      this.normalizeOptionalString(row.article.sourceLabel);
    return [title, summary, source ? `Source: ${source}` : null]
      .filter((value): value is string => Boolean(value))
      .join("\n");
  }

  private resolveAllowedWeights(weights?: ArchiveWeight[]) {
    if (!weights || weights.length === 0) {
      return new Set<ArchiveWeightValue>([1, 2, 3, 4, 5]);
    }
    return new Set(weights.map((weight) => ARCHIVE_WEIGHT_TO_VALUE[weight]));
  }

  private resolveLimitPerVertical(limitPerVertical?: number) {
    const normalized = Number.isFinite(limitPerVertical)
      ? Math.floor(limitPerVertical ?? 0)
      : 0;
    if (normalized < 1) {
      return 24;
    }
    return Math.min(normalized, 100);
  }

  private compareDigestItems(
    a: ArchiveDigestItem,
    b: ArchiveDigestItem,
    useRerank: boolean,
  ) {
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
    }
    if (useRerank) {
      const aScore = a.rerankScore ?? -1;
      const bScore = b.rerankScore ?? -1;
      if (bScore !== aScore) {
        return bScore - aScore;
      }
    }
    const timeDiff = b.sortAt.getTime() - a.sortAt.getTime();
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.processedArticleId.localeCompare(b.processedArticleId);
  }

  private qualityScoreToWeight(score: number | null): ArchiveWeightValue {
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return 1;
    }
    const clamped = this.clamp01(score);
    if (clamped < 0.2) {
      return 1;
    }
    if (clamped < 0.4) {
      return 2;
    }
    if (clamped < 0.6) {
      return 3;
    }
    if (clamped < 0.8) {
      return 4;
    }
    return 5;
  }

  private normalizeQualityScore(value: number | null) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return this.clamp01(value);
  }

  private resolveSortAt(
    row: Pick<ArchiveProcessedRow, "publishedAt" | "processedAt" | "article">,
  ) {
    return row.publishedAt ?? row.article.crawlAt ?? row.processedAt;
  }

  private extractEntityNames(value: unknown) {
    if (!Array.isArray(value)) {
      return [];
    }
    const names: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        const normalized = this.normalizeOptionalString(entry);
        if (normalized) {
          names.push(normalized);
        }
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const name = this.normalizeOptionalString(
        (entry as { name?: unknown }).name,
      );
      if (name) {
        names.push(name);
      }
    }
    return Array.from(new Set(names));
  }

  private extractKeywordHighlights(
    search: string | null,
    row: ArchiveProcessedRow,
    entityTags: string[],
  ) {
    const normalized = this.normalizeOptionalString(search);
    if (!normalized) {
      return [];
    }
    const tokens = normalized
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);
    if (tokens.length === 0) {
      return [];
    }

    const haystack = [row.title, row.summary, ...entityTags]
      .map((value) => this.normalizeOptionalString(value))
      .filter((value): value is string => Boolean(value))
      .join("\n")
      .toLowerCase();

    const highlights = tokens.filter((token) =>
      haystack.includes(token.toLowerCase()),
    );
    return Array.from(new Set(highlights)).slice(0, 8);
  }

  private resolveMonthRange(month: string) {
    const normalized = month.trim();
    const match = /^(\d{4})-(\d{2})$/.exec(normalized);
    if (!match) {
      throw new BadRequestException({
        code: "ARCHIVE_MONTH_INVALID",
        message: "archiveCalendar month must be in YYYY-MM format.",
      });
    }

    const year = Number.parseInt(match[1] ?? "", 10);
    const monthNumber = Number.parseInt(match[2] ?? "", 10);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(monthNumber) ||
      monthNumber < 1 ||
      monthNumber > 12
    ) {
      throw new BadRequestException({
        code: "ARCHIVE_MONTH_INVALID",
        message: "archiveCalendar month must be in YYYY-MM format.",
      });
    }

    const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
    return { start, end };
  }

  private toDateKey(value: Date) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private toUtcDayEnd(value: Date) {
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );
  }

  private normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
  }
}
