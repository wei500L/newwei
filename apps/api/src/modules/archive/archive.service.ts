import { createHash } from "node:crypto";
import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ProcessedArticleStatus } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { VectorClientService } from "../vector/vector-client.service";

import {
  ArchiveClassificationService,
  type ArchiveClassificationRuntimeOptions,
  type ArchiveHybridClassificationResult,
} from "./archive-classification.service";
import { ArchiveClassifier } from "./archive.classifier";
import { ArchivePreparationQueueService } from "./archive-preparation-queue.service";
import {
  ArchivePreparationState,
  type ArchivePreparationStatus,
  ARCHIVE_VERTICAL_DISPLAY_NAME,
  ARCHIVE_VERTICAL_ORDER,
  ARCHIVE_WEIGHT_TO_VALUE,
  ArchiveMatchOrigin,
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
const FULLTEXT_MIN_TOKEN_LENGTH = 2;
const LEXICAL_CONTAINS_LIMIT = 240;
const SEARCH_RELEVANCE_RERANK_WEIGHT = 0.75;
const SEARCH_RELEVANCE_BASE_WEIGHT = 0.25;
const SEARCH_CACHE_MAX_ENTRIES = 200;
const EMBEDDING_CACHE_TTL_MS = 5 * 60 * 1000;
const VECTOR_RECALL_CACHE_TTL_MS = 60 * 1000;
const RERANK_CACHE_TTL_MS = 90 * 1000;
const ARCHIVE_CACHE_KEY_PREFIX = "archive:search";
const ARCHIVE_METRIC_KEY_PREFIX = "archive:metrics";
const ARCHIVE_METRIC_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DIGEST_PAGE_SIZE = 12;
const MIN_DIGEST_PAGE_SIZE = 1;
const MAX_DIGEST_PAGE_SIZE = 100;

interface SharedEmbeddingCachePayload {
  vector: number[];
  model: string;
}

interface SharedVectorRecallPayload {
  processedItemId: string;
  score: number;
}

export interface ArchiveProcessedRow {
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

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class ArchiveService {
  private readonly logger = createLogger({ name: "archive-service" });
  private readonly embeddingCache = new Map<
    string,
    TimedCacheEntry<{ vector: number[]; model: string }>
  >();
  private readonly vectorRecallCache = new Map<
    string,
    TimedCacheEntry<Array<{ processedItemId: string; score: number }>>
  >();
  private readonly rerankCache = new Map<
    string,
    TimedCacheEntry<Map<string, number>>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly liteLlm: LiteLlmService,
    private readonly vectorClient: VectorClientService,
    private readonly classifier: ArchiveClassifier,
    private readonly archiveClassification: ArchiveClassificationService,
    private readonly archivePreparationQueue: ArchivePreparationQueueService,
  ) {}

  async getDigest(
    orgId: string,
    input: ArchiveDigestQueryInput,
  ): Promise<ArchiveDigestResult> {
    const anchorDate = this.toUtcDayEnd(input.anchorDate);
    const search = this.normalizeOptionalString(input.search);
    const allowedWeights = this.resolveAllowedWeights(input.weights);
    const pageSize = this.resolveDigestPageSize(
      input.pageSize ?? input.limitPerVertical,
    );
    const cursorOffsetByVertical = this.resolveCursorOffsetMap(input.cursors);
    const maxCursorOffset = Math.min(
      MAX_BASE_SCAN,
      Array.from(cursorOffsetByVertical.values()).reduce(
        (maxOffset, offset) => Math.max(maxOffset, offset),
        0,
      ),
    );
    const targetRows = Math.min(
      MAX_BASE_SCAN,
      Math.max(
        pageSize * ARCHIVE_VERTICAL_ORDER.length * 6,
        maxCursorOffset + pageSize,
        1200,
      ),
    );

    const searchResult = search
      ? await this.loadSearchCandidates(orgId, anchorDate, search)
      : {
          rows: await this.loadRecentCandidates(orgId, anchorDate, targetRows),
          rerankScoreByArticleId: new Map<string, number>(),
          relevanceScoreByArticleId: new Map<string, number>(),
          matchOriginByArticleId: new Map<string, ArchiveMatchOrigin>(),
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
    const classificationById = await this.getCachedClassifications(
      orgId,
      searchResult.rows,
    );
    const readyCount = classificationById.size;
    const missingCount = Math.max(0, searchResult.rows.length - readyCount);
    if (missingCount > 0) {
      try {
        await this.archivePreparationQueue.ensureDigestCoverage(
          orgId,
          this.toDateKey(anchorDate),
        );
      } catch (error) {
        this.logger.warn(
          { orgId, anchorDate: this.toDateKey(anchorDate), error },
          "Failed to enqueue archive digest preparation job.",
        );
      }
    }

    for (const row of searchResult.rows) {
      const classification = classificationById.get(row.id);
      if (!classification) {
        continue;
      }
      const sortAt = this.resolveSortAt(row);
      if (sortAt.getTime() > anchorDate.getTime()) {
        continue;
      }

      const weight = this.qualityScoreToWeight(row.qualityScore);
      if (!allowedWeights.has(weight)) {
        continue;
      }
      if (classification.region !== input.region) {
        continue;
      }

      const rerankScore =
        searchResult.rerankScoreByArticleId.get(row.id) ?? null;
      const relevanceScore =
        searchResult.relevanceScoreByArticleId.get(row.id) ?? null;
      const matchOrigin =
        searchResult.matchOriginByArticleId.get(row.id) ?? null;
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
        matchOrigin,
        relevanceScore,
        rerankScore,
      });
    }

    const useRelevanceRanking = Boolean(search);
    let totalCount = 0;
    const groups = ARCHIVE_VERTICAL_ORDER.map((vertical) => {
      const allItems = grouped.get(vertical) ?? [];
      const sorted = allItems.sort((a, b) =>
        this.compareDigestItems(a, b, useRelevanceRanking),
      );
      totalCount += sorted.length;
      const offset = this.clampCursorOffset(
        cursorOffsetByVertical.get(vertical) ?? 0,
        sorted.length,
      );
      const pageEnd = Math.min(sorted.length, offset + pageSize);
      const hasMore = pageEnd < sorted.length;
      return {
        vertical,
        displayName: ARCHIVE_VERTICAL_DISPLAY_NAME[vertical],
        totalCount: sorted.length,
        items: sorted.slice(offset, pageEnd),
        pageInfo: {
          hasMore,
          nextCursor: hasMore
            ? this.encodeVerticalCursor(vertical, pageEnd)
            : null,
        },
      };
    });

    return {
      anchorDate,
      region: input.region,
      totalCount,
      groups,
      preparation: await this.buildDigestPreparationStatus(
        orgId,
        anchorDate,
        readyCount,
        missingCount,
      ),
    };
  }

  async getCalendar(
    orgId: string,
    input: ArchiveCalendarQueryInput,
  ): Promise<ArchiveCalendarDayResult[]> {
    const { start, end } = this.resolveMonthRange(input.month);
    const buckets = new Map<string, number>();
    let cursor: { processedAt: Date; id: string } | null = null;
    let hasMissing = false;

    for (;;) {
      const rows = await this.findRangeCandidateBatch(
        orgId,
        start,
        end,
        cursor,
        CALENDAR_SCAN_BATCH,
      );
      if (rows.length === 0) {
        break;
      }

      const classificationById = await this.getCachedClassifications(orgId, rows);
      for (const row of rows) {
        const classification = classificationById.get(row.id);
        if (!classification) {
          hasMissing = true;
          continue;
        }

        const sortAt = this.resolveSortAt(row);
        if (
          sortAt.getTime() < start.getTime() ||
          sortAt.getTime() > end.getTime()
        ) {
          continue;
        }

        if (input.region && classification.region !== input.region) {
          continue;
        }
        if (input.vertical && classification.vertical !== input.vertical) {
          continue;
        }

        const dateKey = this.toDateKey(sortAt);
        buckets.set(dateKey, (buckets.get(dateKey) ?? 0) + 1);
      }

      const last = rows[rows.length - 1];
      if (!last) {
        break;
      }
      cursor = { processedAt: last.processedAt, id: last.id };
      if (rows.length < CALENDAR_SCAN_BATCH) {
        break;
      }
    }

    if (hasMissing) {
      try {
        await this.archivePreparationQueue.ensureCalendarCoverage(orgId, input.month);
      } catch (error) {
        this.logger.warn(
          { orgId, month: input.month, error },
          "Failed to enqueue archive calendar preparation job.",
        );
      }
    }

    return Array.from(buckets.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async classifyRowsBatch(
    orgId: string,
    rows: ArchiveProcessedRow[],
    options?: Partial<ArchiveClassificationRuntimeOptions>,
  ): Promise<Map<string, ArchiveHybridClassificationResult>> {
    if (rows.length === 0) {
      return new Map();
    }

    const results = await this.archiveClassification.classifyHybridBatch(
      orgId,
      this.buildClassificationInputs(rows),
      options,
    );

    return new Map(results.map((result) => [result.processedArticleId, result]));
  }

  async getMissingRecentClassificationBatch(
    orgId: string,
    anchorDate: Date,
    limit: number,
  ): Promise<{ rows: ArchiveProcessedRow[]; hasMoreMissing: boolean }> {
    let cursor: { processedAt: Date; id: string } | null = null;
    let scanned = 0;
    const missingRows: ArchiveProcessedRow[] = [];

    while (scanned < MAX_BASE_SCAN) {
      const remaining = MAX_BASE_SCAN - scanned;
      const take = Math.min(DIGEST_SCAN_BATCH, remaining);
      const batch = await this.findRecentCandidateBatch(
        orgId,
        anchorDate,
        cursor,
        take,
      );
      if (batch.length === 0) {
        return { rows: missingRows, hasMoreMissing: false };
      }

      const cached = await this.getCachedClassifications(orgId, batch);
      for (const row of batch) {
        if (!cached.has(row.id)) {
          missingRows.push(row);
          if (missingRows.length > limit) {
            return { rows: missingRows.slice(0, limit), hasMoreMissing: true };
          }
        }
      }

      scanned += batch.length;
      const last = batch[batch.length - 1];
      if (!last) {
        break;
      }
      cursor = { processedAt: last.processedAt, id: last.id };
      if (batch.length < take) {
        break;
      }
    }

    return { rows: missingRows, hasMoreMissing: false };
  }

  async getMissingMonthClassificationBatch(
    orgId: string,
    month: string,
    limit: number,
  ): Promise<{ rows: ArchiveProcessedRow[]; hasMoreMissing: boolean }> {
    const { start, end } = this.resolveMonthRange(month);
    let cursor: { processedAt: Date; id: string } | null = null;
    const missingRows: ArchiveProcessedRow[] = [];

    for (;;) {
      const batch = await this.findRangeCandidateBatch(
        orgId,
        start,
        end,
        cursor,
        CALENDAR_SCAN_BATCH,
      );
      if (batch.length === 0) {
        return { rows: missingRows, hasMoreMissing: false };
      }

      const cached = await this.getCachedClassifications(orgId, batch);
      for (const row of batch) {
        if (!cached.has(row.id)) {
          missingRows.push(row);
          if (missingRows.length > limit) {
            return { rows: missingRows.slice(0, limit), hasMoreMissing: true };
          }
        }
      }

      const last = batch[batch.length - 1];
      if (!last) {
        break;
      }
      cursor = { processedAt: last.processedAt, id: last.id };
      if (batch.length < CALENDAR_SCAN_BATCH) {
        break;
      }
    }

    return { rows: missingRows, hasMoreMissing: false };
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
    relevanceScoreByArticleId: Map<string, number>;
    matchOriginByArticleId: Map<string, ArchiveMatchOrigin>;
  }> {
    const startedAt = Date.now();
    const normalizedQuery = query.trim();
    const queryHash = this.hashForCacheKey(normalizedQuery.toLowerCase());

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
    let embeddingMemoryCacheHit = false;
    let embeddingRedisCacheHit = false;
    let vectorRecallMemoryCacheHit = false;
    let vectorRecallRedisCacheHit = false;
    let rerankMemoryCacheHit = false;
    let rerankRedisCacheHit = false;

    let vector: number[] | null = null;
    let vectorModel = embeddingModel;
    const embeddingCacheKey = this.buildArchiveCacheKey(
      "embedding:v1",
      orgId,
      embeddingModel,
      queryHash,
    );
    const cachedEmbedding = this.getCacheValue(
      this.embeddingCache,
      embeddingCacheKey,
    );
    if (cachedEmbedding) {
      embeddingMemoryCacheHit = true;
      vectorModel = cachedEmbedding.model;
      vector = [...cachedEmbedding.vector];
    } else {
      const sharedEmbedding =
        await this.getSharedCacheValue<SharedEmbeddingCachePayload>(
          embeddingCacheKey,
        );
      if (
        sharedEmbedding &&
        Array.isArray(sharedEmbedding.vector) &&
        sharedEmbedding.vector.length > 0
      ) {
        embeddingRedisCacheHit = true;
        vectorModel =
          this.normalizeOptionalString(sharedEmbedding.model) ?? embeddingModel;
        vector = [...sharedEmbedding.vector];
        this.setCacheValue(
          this.embeddingCache,
          embeddingCacheKey,
          {
            vector: [...sharedEmbedding.vector],
            model: vectorModel,
          },
          EMBEDDING_CACHE_TTL_MS,
        );
      }
    }

    if (!vector) {
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
          const cachePayload: SharedEmbeddingCachePayload = {
            vector: [...candidate],
            model: vectorModel,
          };
          this.setCacheValue(
            this.embeddingCache,
            embeddingCacheKey,
            cachePayload,
            EMBEDDING_CACHE_TTL_MS,
          );
          await this.setSharedCacheValue(
            embeddingCacheKey,
            cachePayload,
            EMBEDDING_CACHE_TTL_MS,
          );
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

    const vectorRecallCacheKey = this.buildArchiveCacheKey(
      "vector:v1",
      orgId,
      vectorModel,
      queryHash,
    );
    const cachedVectorRecall = this.getCacheValue(
      this.vectorRecallCache,
      vectorRecallCacheKey,
    );
    let matches: Array<{ processedItemId: string; score: number }> | null =
      null;
    if (cachedVectorRecall) {
      vectorRecallMemoryCacheHit = true;
      matches = cachedVectorRecall.map((entry) => ({
        processedItemId: entry.processedItemId,
        score: entry.score,
      }));
    } else {
      const sharedVectorRecall =
        await this.getSharedCacheValue<SharedVectorRecallPayload[]>(
          vectorRecallCacheKey,
        );
      if (Array.isArray(sharedVectorRecall) && sharedVectorRecall.length > 0) {
        vectorRecallRedisCacheHit = true;
        const normalizedShared = sharedVectorRecall
          .map((entry) => ({
            processedItemId:
              this.normalizeOptionalString(entry?.processedItemId) ?? "",
            score: Number(entry?.score ?? 0),
          }))
          .filter(
            (entry) =>
              entry.processedItemId.length > 0 && Number.isFinite(entry.score),
          );
        if (normalizedShared.length > 0) {
          matches = normalizedShared;
          this.setCacheValue(
            this.vectorRecallCache,
            vectorRecallCacheKey,
            normalizedShared,
            VECTOR_RECALL_CACHE_TTL_MS,
          );
        }
      }
    }
    if (!matches) {
      matches = await this.vectorClient.searchBestEffort({
        orgId,
        embeddingModel: vectorModel,
        vector,
        limit: MAX_SEARCH_SCAN,
        minScore: MIN_VECTOR_SCORE,
      });
      if (Array.isArray(matches)) {
        const cachePayload = matches.map((entry) => ({
          processedItemId: entry.processedItemId,
          score: entry.score,
        }));
        this.setCacheValue(
          this.vectorRecallCache,
          vectorRecallCacheKey,
          cachePayload,
          VECTOR_RECALL_CACHE_TTL_MS,
        );
        await this.setSharedCacheValue(
          vectorRecallCacheKey,
          cachePayload,
          VECTOR_RECALL_CACHE_TTL_MS,
        );
      }
    }
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
    const semanticRows =
      matchedRefs.length > 0
        ? ((await this.prisma.processedArticle.findMany({
            where: {
              status: ProcessedArticleStatus.completed,
              article: { orgId },
              cleanedMarkdownRef: { in: matchedRefs },
            },
            include: this.buildArchiveRowInclude(orgId),
            take: MAX_SEARCH_SCAN,
          })) as ArchiveProcessedRow[])
        : [];

    const lexicalRows = await this.loadLexicalSearchRows(
      orgId,
      anchorDate,
      query,
    );
    const semanticIdSet = new Set(semanticRows.map((row) => row.id));
    const lexicalIdSet = new Set(lexicalRows.map((row) => row.id));

    const uniqueRows = this.dedupeByProcessedArticle([
      ...semanticRows,
      ...lexicalRows,
    ]);
    const matchOriginByArticleId = new Map<string, ArchiveMatchOrigin>();
    const baseRelevanceScoreByArticleId = new Map<string, number>();
    const preRanked = uniqueRows
      .filter(
        (row) => this.resolveSortAt(row).getTime() <= anchorDate.getTime(),
      )
      .map((row) => {
        const semanticScore =
          vectorScoreByProcessedRef.get(row.cleanedMarkdownRef ?? "") ?? 0;
        const lexicalScore = this.computeLexicalScore(
          query,
          this.buildLexicalDocument(row),
        );
        const baseScore = this.computeBaseRelevanceScore(
          semanticScore,
          lexicalScore,
        );
        const origin = this.resolveMatchOrigin(
          semanticIdSet.has(row.id),
          lexicalIdSet.has(row.id),
        );
        baseRelevanceScoreByArticleId.set(row.id, baseScore);
        if (origin) {
          matchOriginByArticleId.set(row.id, origin);
        }
        return {
          row,
          baseScore,
          sortAt: this.resolveSortAt(row),
        };
      })
      .sort((a, b) => {
        if (b.baseScore !== a.baseScore) {
          return b.baseScore - a.baseScore;
        }
        return b.sortAt.getTime() - a.sortAt.getTime();
      })
      .map((entry) => entry.row);

    const rerankCandidates = preRanked.slice(0, MAX_RERANK_DOCUMENTS);
    const matchOriginStats = this.countMatchOrigins(matchOriginByArticleId);
    if (rerankCandidates.length === 0) {
      await this.recordArchiveSearchMetrics(orgId, {
        queryLength: normalizedQuery.length,
        semanticRowCount: semanticRows.length,
        lexicalRowCount: lexicalRows.length,
        mergedRowCount: preRanked.length,
        semanticOnlyCount: matchOriginStats.semanticOnlyCount,
        lexicalOnlyCount: matchOriginStats.lexicalOnlyCount,
        hybridCount: matchOriginStats.hybridCount,
        rerankCandidateCount: 0,
        rerankScoredCount: 0,
        embeddingMemoryCacheHit,
        embeddingRedisCacheHit,
        vectorRecallMemoryCacheHit,
        vectorRecallRedisCacheHit,
        rerankMemoryCacheHit,
        rerankRedisCacheHit,
      });
      this.logger.info(
        {
          orgId,
          anchorDate: anchorDate.toISOString(),
          queryLength: normalizedQuery.length,
          semanticRowCount: semanticRows.length,
          lexicalRowCount: lexicalRows.length,
          mergedRowCount: preRanked.length,
          semanticOnlyCount: matchOriginStats.semanticOnlyCount,
          lexicalOnlyCount: matchOriginStats.lexicalOnlyCount,
          hybridCount: matchOriginStats.hybridCount,
          embeddingMemoryCacheHit,
          embeddingRedisCacheHit,
          vectorRecallMemoryCacheHit,
          vectorRecallRedisCacheHit,
          rerankMemoryCacheHit,
          rerankRedisCacheHit,
          elapsedMs: Date.now() - startedAt,
        },
        "Archive search completed with no rerank candidates.",
      );
      return {
        rows: preRanked,
        rerankScoreByArticleId: new Map(),
        relevanceScoreByArticleId: baseRelevanceScoreByArticleId,
        matchOriginByArticleId,
      };
    }

    const rerankScoreByArticleId = new Map<string, number>();
    const rerankCacheKey = this.buildArchiveCacheKey(
      "rerank:v1",
      orgId,
      queryHash,
      this.hashForCacheKey(
        rerankCandidates.map((candidate) => candidate.id).join(","),
      ),
    );
    const cachedRerank = this.getCacheValue(this.rerankCache, rerankCacheKey);
    if (cachedRerank) {
      rerankMemoryCacheHit = true;
      cachedRerank.forEach((score, articleId) => {
        rerankScoreByArticleId.set(articleId, score);
      });
    } else {
      const sharedRerankScoreRecord =
        await this.getSharedCacheValue<Record<string, number>>(rerankCacheKey);
      if (
        sharedRerankScoreRecord &&
        typeof sharedRerankScoreRecord === "object" &&
        !Array.isArray(sharedRerankScoreRecord)
      ) {
        rerankRedisCacheHit = true;
        for (const [articleId, rawScore] of Object.entries(
          sharedRerankScoreRecord,
        )) {
          if (!Number.isFinite(rawScore)) {
            continue;
          }
          rerankScoreByArticleId.set(articleId, this.clamp01(rawScore));
        }
        if (rerankScoreByArticleId.size > 0) {
          this.setCacheValue(
            this.rerankCache,
            rerankCacheKey,
            new Map(rerankScoreByArticleId),
            RERANK_CACHE_TTL_MS,
          );
        }
      }
      if (rerankScoreByArticleId.size === 0) {
        try {
          const rerankResponse = await this.liteLlm.rerank({
            orgId,
            query,
            documents: rerankCandidates.map((row) =>
              this.buildRerankDocument(row),
            ),
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
      }
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
    if (!cachedRerank && rerankScoreByArticleId.size > 0) {
      this.setCacheValue(
        this.rerankCache,
        rerankCacheKey,
        new Map(rerankScoreByArticleId),
        RERANK_CACHE_TTL_MS,
      );
      await this.setSharedCacheValue(
        rerankCacheKey,
        Object.fromEntries(rerankScoreByArticleId.entries()),
        RERANK_CACHE_TTL_MS,
      );
    }

    const relevanceScoreByArticleId = new Map(baseRelevanceScoreByArticleId);
    for (const row of preRanked) {
      const baseScore = baseRelevanceScoreByArticleId.get(row.id) ?? 0;
      const rerankScore = rerankScoreByArticleId.get(row.id);
      const finalScore =
        typeof rerankScore === "number"
          ? this.clamp01(
              rerankScore * SEARCH_RELEVANCE_RERANK_WEIGHT +
                baseScore * SEARCH_RELEVANCE_BASE_WEIGHT,
            )
          : baseScore;
      relevanceScoreByArticleId.set(row.id, finalScore);
    }

    await this.recordArchiveSearchMetrics(orgId, {
      queryLength: normalizedQuery.length,
      semanticRowCount: semanticRows.length,
      lexicalRowCount: lexicalRows.length,
      mergedRowCount: preRanked.length,
      semanticOnlyCount: matchOriginStats.semanticOnlyCount,
      lexicalOnlyCount: matchOriginStats.lexicalOnlyCount,
      hybridCount: matchOriginStats.hybridCount,
      rerankCandidateCount: rerankCandidates.length,
      rerankScoredCount: rerankScoreByArticleId.size,
      embeddingMemoryCacheHit,
      embeddingRedisCacheHit,
      vectorRecallMemoryCacheHit,
      vectorRecallRedisCacheHit,
      rerankMemoryCacheHit,
      rerankRedisCacheHit,
    });
    this.logger.info(
      {
        orgId,
        anchorDate: anchorDate.toISOString(),
        queryLength: normalizedQuery.length,
        semanticRowCount: semanticRows.length,
        lexicalRowCount: lexicalRows.length,
        mergedRowCount: preRanked.length,
        semanticOnlyCount: matchOriginStats.semanticOnlyCount,
        lexicalOnlyCount: matchOriginStats.lexicalOnlyCount,
        hybridCount: matchOriginStats.hybridCount,
        rerankCandidateCount: rerankCandidates.length,
        rerankScoredCount: rerankScoreByArticleId.size,
        embeddingMemoryCacheHit,
        embeddingRedisCacheHit,
        vectorRecallMemoryCacheHit,
        vectorRecallRedisCacheHit,
        rerankMemoryCacheHit,
        rerankRedisCacheHit,
        elapsedMs: Date.now() - startedAt,
      },
      "Archive search completed.",
    );

    return {
      rows: preRanked,
      rerankScoreByArticleId,
      relevanceScoreByArticleId,
      matchOriginByArticleId,
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

  async findRecentCandidateBatch(
    orgId: string,
    anchorDate: Date,
    cursor: { processedAt: Date; id: string } | null,
    take: number,
  ): Promise<ArchiveProcessedRow[]> {
    return (await this.prisma.processedArticle.findMany({
      where: this.buildRecentCandidatesWhere(orgId, anchorDate, cursor),
      include: this.buildArchiveRowInclude(orgId),
      orderBy: [{ processedAt: "desc" }, { id: "desc" }],
      take,
    })) as ArchiveProcessedRow[];
  }

  private async loadRangeCandidates(orgId: string, start: Date, end: Date) {
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

  async findRangeCandidateBatch(
    orgId: string,
    start: Date,
    end: Date,
    cursor: { processedAt: Date; id: string } | null,
    take: number,
  ): Promise<ArchiveProcessedRow[]> {
    return (await this.prisma.processedArticle.findMany({
      where: this.buildRangeCandidatesWhere(orgId, start, end, cursor),
      include: this.buildArchiveRowInclude(orgId),
      orderBy: [{ processedAt: "desc" }, { id: "desc" }],
      take,
    })) as ArchiveProcessedRow[];
  }

  private buildClassificationInputs(rows: ArchiveProcessedRow[]) {
    return rows.map((row) => ({
      processedArticleId: row.id,
      articleId: row.article.id,
      title: row.title,
      summary: row.summary,
      topics: row.topics,
      entities: row.entities,
      location: row.location,
      ruleContext: this.classifier.classifyRuleSignals({
        title: row.title,
        summary: row.summary,
        topics: row.topics,
        entities: row.entities,
        location: row.location,
      }),
    }));
  }

  private async getCachedClassifications(
    orgId: string,
    rows: ArchiveProcessedRow[],
  ): Promise<Map<string, ArchiveHybridClassificationResult>> {
    if (rows.length === 0) {
      return new Map();
    }
    return this.archiveClassification.getCachedHybridBatch(
      orgId,
      this.buildClassificationInputs(rows),
    );
  }

  private async buildDigestPreparationStatus(
    orgId: string,
    anchorDate: Date,
    readyCount: number,
    missingCount: number,
  ): Promise<ArchivePreparationStatus> {
    if (missingCount <= 0) {
      return {
        state: ArchivePreparationState.READY,
        readyCount,
        missingCount: 0,
        updatedAt: new Date(),
        errorMessage: null,
      };
    }

    let queuedStatus: ArchivePreparationStatus | null = null;
    try {
      queuedStatus = await this.archivePreparationQueue.getDigestStatus(
        orgId,
        this.toDateKey(anchorDate),
      );
    } catch (error) {
      this.logger.warn(
        { orgId, anchorDate: this.toDateKey(anchorDate), error },
        "Failed to read archive digest preparation status.",
      );
    }
    if (readyCount > 0) {
      return {
        state: ArchivePreparationState.PARTIAL,
        readyCount,
        missingCount,
        updatedAt: queuedStatus?.updatedAt ?? new Date(),
        errorMessage: queuedStatus?.errorMessage ?? null,
      };
    }

    return {
      state: queuedStatus?.state ?? ArchivePreparationState.QUEUED,
      readyCount,
      missingCount,
      updatedAt: queuedStatus?.updatedAt ?? new Date(),
      errorMessage: queuedStatus?.errorMessage ?? null,
    };
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

  private async loadLexicalSearchRows(
    orgId: string,
    anchorDate: Date,
    query: string,
  ) {
    const fullTextIds = await this.loadLexicalFullTextIds(
      orgId,
      anchorDate,
      query,
    );
    const normalizedQuery = this.normalizeOptionalString(query);
    if (!normalizedQuery) {
      return [];
    }

    const terms = Array.from(
      new Set([
        normalizedQuery,
        ...this.tokenizeSearch(normalizedQuery, FULLTEXT_MIN_TOKEN_LENGTH),
      ]),
    ).slice(0, 8);
    if (terms.length === 0 && fullTextIds.length === 0) {
      return [];
    }

    const containsClauses = terms.flatMap((term) => [
      { title: { contains: term } },
      { summary: { contains: term } },
      { source: { contains: term } },
      { location: { contains: term } },
    ]);

    const fallbackRows =
      containsClauses.length > 0
        ? ((await this.prisma.processedArticle.findMany({
            where: {
              status: ProcessedArticleStatus.completed,
              article: { orgId },
              AND: [
                {
                  OR: [
                    { publishedAt: { lte: anchorDate } },
                    { article: { crawlAt: { lte: anchorDate } } },
                    { processedAt: { lte: anchorDate } },
                  ],
                },
                {
                  OR: containsClauses,
                },
              ],
            },
            include: this.buildArchiveRowInclude(orgId),
            orderBy: [{ processedAt: "desc" }, { id: "desc" }],
            take: LEXICAL_CONTAINS_LIMIT,
          })) as ArchiveProcessedRow[])
        : [];

    if (fullTextIds.length === 0) {
      return fallbackRows;
    }

    const fallbackIdSet = new Set(fallbackRows.map((row) => row.id));
    const missingIds = fullTextIds
      .filter((id) => !fallbackIdSet.has(id))
      .slice(0, MAX_SEARCH_SCAN);
    if (missingIds.length === 0) {
      return this.dedupeByProcessedArticle(fallbackRows);
    }

    const fullTextRows = (await this.prisma.processedArticle.findMany({
      where: {
        id: { in: missingIds },
        status: ProcessedArticleStatus.completed,
        article: { orgId },
      },
      include: this.buildArchiveRowInclude(orgId),
      take: MAX_SEARCH_SCAN,
    })) as ArchiveProcessedRow[];

    return this.dedupeByProcessedArticle([...fallbackRows, ...fullTextRows]);
  }

  private async loadLexicalFullTextIds(
    orgId: string,
    anchorDate: Date,
    query: string,
  ) {
    const fullTextQuery = this.buildFullTextQuery(query);
    if (!fullTextQuery) {
      return [];
    }
    try {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT pa.id
        FROM \`ProcessedArticle\` pa
        INNER JOIN \`Article\` a ON a.id = pa.articleId
        WHERE a.orgId = ${orgId}
          AND pa.status = ${ProcessedArticleStatus.completed}
          AND (
            pa.publishedAt <= ${anchorDate}
            OR a.crawlAt <= ${anchorDate}
            OR pa.processedAt <= ${anchorDate}
          )
          AND MATCH(pa.title, pa.summary) AGAINST (${fullTextQuery} IN BOOLEAN MODE)
        ORDER BY pa.processedAt DESC, pa.id DESC
        LIMIT ${MAX_SEARCH_SCAN}
      `;
      return rows
        .map((row) => this.normalizeOptionalString(row.id))
        .filter((id): id is string => Boolean(id));
    } catch (error) {
      this.logger.warn(
        {
          orgId,
          query,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive lexical fulltext recall failed; falling back to contains matching.",
      );
      return [];
    }
  }

  private buildFullTextQuery(search: string): string | null {
    const tokens = this.tokenizeSearch(search, FULLTEXT_MIN_TOKEN_LENGTH);
    if (tokens.length === 0) {
      return null;
    }
    return tokens.map((token) => `${token}*`).join(" ");
  }

  private tokenizeSearch(search: string, minLength: number) {
    return search
      .split(/\s+/)
      .map((token) => token.replace(/[+\-><()~"*@]+/g, "").trim())
      .filter((token) => token.length >= minLength);
  }

  private buildLexicalDocument(row: ArchiveProcessedRow) {
    const source =
      this.normalizeOptionalString(row.source) ??
      this.normalizeOptionalString(row.article.sourceLabel);
    const location = this.normalizeOptionalString(row.location);
    const entities = this.extractEntityNames(row.entities)
      .slice(0, 8)
      .join(", ");
    return [row.title, row.summary, source, location, entities]
      .map((entry) => this.normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }

  private computeLexicalScore(query: string, document: string) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return 0;
    }
    const normalizedDoc = document.trim().toLowerCase();
    if (!normalizedDoc) {
      return 0;
    }
    if (normalizedDoc.includes(normalizedQuery)) {
      return 1;
    }
    const tokens = this.tokenizeSearch(
      normalizedQuery,
      FULLTEXT_MIN_TOKEN_LENGTH,
    );
    if (tokens.length === 0) {
      return 0;
    }
    const matched = tokens.filter((token) =>
      normalizedDoc.includes(token),
    ).length;
    return this.clamp01(matched / tokens.length);
  }

  private computeBaseRelevanceScore(
    semanticScore: number,
    lexicalScore: number,
  ) {
    const safeSemantic = this.clamp01(semanticScore);
    const safeLexical = this.clamp01(lexicalScore);
    if (safeSemantic > 0 && safeLexical > 0) {
      return this.clamp01(safeSemantic * 0.6 + safeLexical * 0.4 + 0.05);
    }
    return Math.max(safeSemantic, safeLexical);
  }

  private resolveMatchOrigin(hasSemantic: boolean, hasLexical: boolean) {
    if (hasSemantic && hasLexical) {
      return ArchiveMatchOrigin.HYBRID;
    }
    if (hasSemantic) {
      return ArchiveMatchOrigin.SEMANTIC;
    }
    if (hasLexical) {
      return ArchiveMatchOrigin.LEXICAL;
    }
    return null;
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

  private resolveDigestPageSize(pageSize?: number) {
    const normalized = Number.isFinite(pageSize)
      ? Math.floor(pageSize ?? 0)
      : 0;
    if (normalized < MIN_DIGEST_PAGE_SIZE) {
      return DEFAULT_DIGEST_PAGE_SIZE;
    }
    return Math.min(normalized, MAX_DIGEST_PAGE_SIZE);
  }

  private resolveCursorOffsetMap(
    cursors?: ArchiveDigestQueryInput["cursors"],
  ): Map<ArchiveVertical, number> {
    const map = new Map<ArchiveVertical, number>();
    if (!Array.isArray(cursors) || cursors.length === 0) {
      return map;
    }
    for (const entry of cursors) {
      const vertical = entry?.vertical;
      if (!vertical || !ARCHIVE_VERTICAL_ORDER.includes(vertical)) {
        continue;
      }
      const offset = this.decodeVerticalCursor(vertical, entry.cursor);
      if (offset === null) {
        continue;
      }
      map.set(vertical, Math.max(0, offset));
    }
    return map;
  }

  private encodeVerticalCursor(vertical: ArchiveVertical, offset: number) {
    const payload = JSON.stringify({
      v: vertical,
      o: Math.max(0, Math.floor(offset)),
    });
    return Buffer.from(payload, "utf8").toString("base64url");
  }

  private decodeVerticalCursor(vertical: ArchiveVertical, cursor?: string) {
    const normalized = this.normalizeOptionalString(cursor);
    if (!normalized) {
      return null;
    }
    try {
      const decoded = Buffer.from(normalized, "base64url").toString("utf8");
      const parsed = JSON.parse(decoded) as { v?: unknown; o?: unknown };
      if (parsed.v !== vertical) {
        return null;
      }
      const offset = Number(parsed.o);
      if (!Number.isFinite(offset) || offset < 0) {
        return null;
      }
      return Math.floor(offset);
    } catch {
      return null;
    }
  }

  private clampCursorOffset(offset: number, total: number) {
    return Math.max(0, Math.min(Math.floor(offset), Math.max(0, total)));
  }

  private compareDigestItems(
    a: ArchiveDigestItem,
    b: ArchiveDigestItem,
    useRelevanceRanking: boolean,
  ) {
    if (useRelevanceRanking) {
      const aRelevance = a.relevanceScore ?? -1;
      const bRelevance = b.relevanceScore ?? -1;
      if (bRelevance !== aRelevance) {
        return bRelevance - aRelevance;
      }
    }
    if (b.weight !== a.weight) {
      return b.weight - a.weight;
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

  private buildArchiveCacheKey(...parts: string[]) {
    return [ARCHIVE_CACHE_KEY_PREFIX, ...parts].join(":");
  }

  private buildArchiveMetricKey(orgId: string) {
    return `${ARCHIVE_METRIC_KEY_PREFIX}:${orgId}:${this.toDateKey(new Date())}`;
  }

  private countMatchOrigins(
    originByArticleId: Map<string, ArchiveMatchOrigin>,
  ): {
    semanticOnlyCount: number;
    lexicalOnlyCount: number;
    hybridCount: number;
  } {
    let semanticOnlyCount = 0;
    let lexicalOnlyCount = 0;
    let hybridCount = 0;
    for (const origin of originByArticleId.values()) {
      if (origin === ArchiveMatchOrigin.SEMANTIC) {
        semanticOnlyCount += 1;
      } else if (origin === ArchiveMatchOrigin.LEXICAL) {
        lexicalOnlyCount += 1;
      } else if (origin === ArchiveMatchOrigin.HYBRID) {
        hybridCount += 1;
      }
    }
    return {
      semanticOnlyCount,
      lexicalOnlyCount,
      hybridCount,
    };
  }

  private async getSharedCacheValue<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (error) {
      this.logger.warn(
        {
          key,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive shared cache read failed.",
      );
      return null;
    }
  }

  private async setSharedCacheValue<T>(key: string, value: T, ttlMs: number) {
    try {
      await this.cache.set(
        key,
        value,
        Math.max(1, Math.ceil(Math.max(1_000, ttlMs) / 1_000)),
      );
    } catch (error) {
      this.logger.warn(
        {
          key,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive shared cache write failed.",
      );
    }
  }

  private resolveQueryLengthBucket(length: number) {
    if (length <= 1) {
      return "len_00_01";
    }
    if (length <= 3) {
      return "len_02_03";
    }
    if (length <= 7) {
      return "len_04_07";
    }
    if (length <= 15) {
      return "len_08_15";
    }
    if (length <= 31) {
      return "len_16_31";
    }
    return "len_32_plus";
  }

  private async recordArchiveSearchMetrics(
    orgId: string,
    payload: {
      queryLength: number;
      semanticRowCount: number;
      lexicalRowCount: number;
      mergedRowCount: number;
      semanticOnlyCount: number;
      lexicalOnlyCount: number;
      hybridCount: number;
      rerankCandidateCount: number;
      rerankScoredCount: number;
      embeddingMemoryCacheHit: boolean;
      embeddingRedisCacheHit: boolean;
      vectorRecallMemoryCacheHit: boolean;
      vectorRecallRedisCacheHit: boolean;
      rerankMemoryCacheHit: boolean;
      rerankRedisCacheHit: boolean;
    },
  ) {
    const metricKey = this.buildArchiveMetricKey(orgId);
    const fields: Array<[string, number]> = [
      ["requests.total", 1],
      ["rows.semantic_total", payload.semanticRowCount],
      ["rows.lexical_total", payload.lexicalRowCount],
      ["rows.merged_total", payload.mergedRowCount],
      ["origins.semantic_only_total", payload.semanticOnlyCount],
      ["origins.lexical_only_total", payload.lexicalOnlyCount],
      ["origins.hybrid_total", payload.hybridCount],
      ["rerank.candidate_total", payload.rerankCandidateCount],
      ["rerank.scored_total", payload.rerankScoredCount],
      [`query_length.${this.resolveQueryLengthBucket(payload.queryLength)}`, 1],
      ["cache.embedding.memory.hit", payload.embeddingMemoryCacheHit ? 1 : 0],
      ["cache.embedding.memory.miss", payload.embeddingMemoryCacheHit ? 0 : 1],
      ["cache.embedding.redis.hit", payload.embeddingRedisCacheHit ? 1 : 0],
      ["cache.embedding.redis.miss", payload.embeddingRedisCacheHit ? 0 : 1],
      ["cache.vector.memory.hit", payload.vectorRecallMemoryCacheHit ? 1 : 0],
      ["cache.vector.memory.miss", payload.vectorRecallMemoryCacheHit ? 0 : 1],
      ["cache.vector.redis.hit", payload.vectorRecallRedisCacheHit ? 1 : 0],
      ["cache.vector.redis.miss", payload.vectorRecallRedisCacheHit ? 0 : 1],
      ["cache.rerank.memory.hit", payload.rerankMemoryCacheHit ? 1 : 0],
      ["cache.rerank.memory.miss", payload.rerankMemoryCacheHit ? 0 : 1],
      ["cache.rerank.redis.hit", payload.rerankRedisCacheHit ? 1 : 0],
      ["cache.rerank.redis.miss", payload.rerankRedisCacheHit ? 0 : 1],
    ];
    try {
      await Promise.all(
        fields
          .filter(([, value]) => Number.isFinite(value))
          .map(([field, value]) =>
            this.cache.hincrby(metricKey, field, Math.floor(value)),
          ),
      );
      await this.cache.expire(metricKey, ARCHIVE_METRIC_RETENTION_SECONDS);
    } catch (error) {
      this.logger.warn(
        {
          orgId,
          metricKey,
          message: error instanceof Error ? error.message : "unknown error",
        },
        "Archive search metric aggregation failed.",
      );
    }
  }

  private hashForCacheKey(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }

  private getCacheValue<T>(
    cache: Map<string, TimedCacheEntry<T>>,
    key: string,
  ): T | null {
    const now = Date.now();
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= now) {
      cache.delete(key);
      return null;
    }
    return entry.value;
  }

  private setCacheValue<T>(
    cache: Map<string, TimedCacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
  ) {
    const expiresAt = Date.now() + Math.max(1000, Math.floor(ttlMs));
    cache.set(key, { value, expiresAt });
    if (cache.size > SEARCH_CACHE_MAX_ENTRIES) {
      this.pruneCache(cache);
    }
  }

  private pruneCache<T>(cache: Map<string, TimedCacheEntry<T>>) {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
    if (cache.size <= SEARCH_CACHE_MAX_ENTRIES) {
      return;
    }
    const entries = Array.from(cache.entries()).sort(
      (a, b) => a[1].expiresAt - b[1].expiresAt,
    );
    const removeCount = cache.size - SEARCH_CACHE_MAX_ENTRIES;
    for (let index = 0; index < removeCount; index += 1) {
      const candidate = entries[index];
      if (!candidate) {
        break;
      }
      cache.delete(candidate[0]);
    }
  }

  private clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
  }
}
