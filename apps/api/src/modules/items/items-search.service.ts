import {
  ItemReadModelModel,
  ProcessedItemModel,
  type MongoConnection,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { createHash } from "node:crypto";

import { PipelineStageStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";

import { ItemsElasticsearchService } from "./items-elasticsearch.service";
import { ItemsReadModelService } from "./items-read-model.service";
import { ItemsSearchQueryService } from "./items-search-query.service";
import {
  buildFacetOptions,
  buildReadModelBaseMatch,
  clamp01,
  combineSearchAndFilterIds,
  computeLexicalScore,
  computeRecencyScore,
  computeSourceTrustScore,
  hasActiveFilters,
  incrementFacetCount,
  normalizeFilters,
  normalizeResultRecord,
  parseSearchPayload,
  pickResultNumber,
  pickResultString,
  pickResultStringArray,
  resolveProcessedSortAt,
} from "./items-search.helpers";
import {
  DAY_MS,
  DEFAULT_WEIGHT_QUALITY,
  DEFAULT_WEIGHT_RECENCY,
  DEFAULT_WEIGHT_RERANK,
  DEFAULT_WEIGHT_SOURCE_TRUST,
  ITEMS_SEARCH_SUGGESTIONS_PREFIX,
  LATEST_PROCESSED_SNAPSHOT_BATCH_SIZE,
  SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS,
  type ItemFilters,
  type ItemListRow,
  type ItemsCursorPayload,
  type LatestProcessedItemSnapshot,
  type RssSourceOption,
  type ItemSearchHighlights,
} from "./items.shared";

@Injectable()
export class ItemsSearchService {
  private readonly logger = createLogger({ name: "items-service" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly liteLlm: LiteLlmService,
    private readonly readModel: ItemsReadModelService,
    private readonly query: ItemsSearchQueryService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
    @Optional() private readonly elasticsearch?: ItemsElasticsearchService,
  ) {
    void this._mongo;
  }

  private async listLatestProcessedSnapshots(
    orgId: string,
    itemMetaIds?: string[],
  ): Promise<LatestProcessedItemSnapshot[]> {
    const match: Record<string, unknown> = {
      orgId,
      status: PipelineStageStatus.Completed,
    };

    if (Array.isArray(itemMetaIds) && itemMetaIds.length > 0) {
      match.itemMetaId = { $in: itemMetaIds };
    }
    const seen = new Set<string>();
    const snapshots: LatestProcessedItemSnapshot[] = [];
    const pendingIds = itemMetaIds ? new Set(itemMetaIds) : null;
    let cursor:
      | {
          createdAt: Date;
          id: Types.ObjectId;
        }
      | undefined;

    for (;;) {
      const pageMatch: Record<string, unknown> = { ...match };
      if (cursor) {
        pageMatch.$or = [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
        ];
      }

      const batch = (await ProcessedItemModel.find(
        pageMatch,
        {
          itemMetaId: 1,
          tags: 1,
          result: 1,
          sourceId: 1,
          duplicateOf: 1,
          sortAt: 1,
          ingestedAt: 1,
          createdAt: 1,
        },
      )
        .sort({ createdAt: -1, _id: -1 })
        .limit(LATEST_PROCESSED_SNAPSHOT_BATCH_SIZE)
        .lean());

      if (batch.length === 0) {
        break;
      }

      for (const record of batch) {
        if (!record.itemMetaId || seen.has(record.itemMetaId)) {
          continue;
        }
        seen.add(record.itemMetaId);
        pendingIds?.delete(record.itemMetaId);
        snapshots.push({
          itemMetaId: record.itemMetaId,
          tags: record.tags,
          result: record.result,
          sourceId: record.sourceId ?? null,
          duplicateOf: record.duplicateOf ?? null,
          sortAt: resolveProcessedSortAt(record),
        });
      }

      if (pendingIds && pendingIds.size === 0) {
        break;
      }

      const last = batch[batch.length - 1];
      if (!last?.createdAt || !last?._id) {
        break;
      }
      cursor = {
        createdAt: last.createdAt,
        id: last._id,
      };

      if (batch.length < LATEST_PROCESSED_SNAPSHOT_BATCH_SIZE) {
        break;
      }
    }

    return snapshots;
  }

  async getFacets(orgId: string, search?: string, filters?: ItemFilters) {
    const { search: normalizedSearch, filters: legacyFilters } = parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    if (scopedIds && scopedIds.length === 0) {
      return { regions: [], topics: [], sentiments: [], contentTypes: [] };
    }

    if (this.readModel.isReadModelEnabled()) {
      const match = scopedIds
        ? {
            $and: [buildReadModelBaseMatch(orgId), { itemMetaId: { $in: scopedIds } }],
          }
        : buildReadModelBaseMatch(orgId);
      const docs = (await ItemReadModelModel.find(
        match,
        {
          region: 1,
          location: 1,
          topics: 1,
          entities: 1,
          sentiment: 1,
          contentType: 1,
          tags: 1,
        },
      ).lean()) as {
        region?: string | null;
        location?: string | null;
        topics?: string[];
        entities?: string[];
        sentiment?: string | null;
        contentType?: string | null;
        tags?: string[];
      }[];

      const regionCounts = new Map<string, number>();
      const topicCounts = new Map<string, number>();
      const sentimentCounts = new Map<string, number>();
      const contentTypeCounts = new Map<string, number>();
      const allowedSentiments = new Set(["positive", "neutral", "negative"]);
      const allowedContentTypes = new Set(["news_fact", "opinion", "analysis", "mixed"]);

      for (const doc of docs) {
        const regionValue =
          typeof doc.location === "string" && doc.location.trim().length > 0
            ? doc.location.trim()
            : typeof doc.region === "string" && doc.region.trim().length > 0
              ? doc.region.trim()
              : null;
        if (regionValue) {
          incrementFacetCount(regionCounts, regionValue);
        }

        const topicSet = new Set<string>();
        (Array.isArray(doc.topics) ? doc.topics : []).forEach((topic) => {
          if (typeof topic === "string" && topic.trim()) {
            topicSet.add(topic.trim());
          }
        });
        (Array.isArray(doc.entities) ? doc.entities : []).forEach((entity) => {
          if (typeof entity === "string" && entity.trim()) {
            topicSet.add(entity.trim());
          }
        });
        (Array.isArray(doc.tags) ? doc.tags : []).forEach((tag) => {
          if (typeof tag === "string" && tag.trim()) {
            topicSet.add(tag.trim());
          }
        });
        topicSet.forEach((topic) => incrementFacetCount(topicCounts, topic));

        const sentiment = typeof doc.sentiment === "string" ? doc.sentiment.trim().toLowerCase() : "";
        if (allowedSentiments.has(sentiment)) {
          incrementFacetCount(sentimentCounts, sentiment);
        }

        const contentType =
          typeof doc.contentType === "string" ? doc.contentType.trim().toLowerCase() : "";
        if (allowedContentTypes.has(contentType)) {
          incrementFacetCount(contentTypeCounts, contentType);
        }
      }

      return {
        regions: buildFacetOptions(regionCounts),
        topics: buildFacetOptions(topicCounts),
        sentiments: buildFacetOptions(sentimentCounts),
        contentTypes: buildFacetOptions(contentTypeCounts),
      };
    }

    const records = await this.listLatestProcessedSnapshots(
      orgId,
      scopedIds ?? undefined,
    );

    const regionCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();
    const sentimentCounts = new Map<string, number>();
    const contentTypeCounts = new Map<string, number>();
    const allowedSentiments = new Set(["positive", "neutral", "negative"]);
    const allowedContentTypes = new Set(["news_fact", "opinion", "analysis", "mixed"]);

    for (const record of records) {
      const result = normalizeResultRecord(record.result);
      const regionValue =
        pickResultString(result, ["location", "region"]) ?? null;
      if (regionValue) {
        incrementFacetCount(regionCounts, regionValue);
      }

      const topicSet = new Set<string>();
      const topics = result.topics;
      if (Array.isArray(topics)) {
        topics.forEach((topic) => {
          if (typeof topic === "string") {
            const normalized = topic.trim();
            if (normalized) {
              topicSet.add(normalized);
            }
            return;
          }
          if (
            topic &&
            typeof topic === "object" &&
            !Array.isArray(topic) &&
            typeof (topic as { name?: unknown }).name === "string"
          ) {
            const normalized = ((topic as { name: string }).name ?? "").trim();
            if (normalized) {
              topicSet.add(normalized);
            }
          }
        });
      }
      if (Array.isArray(record.tags)) {
        record.tags.forEach((tag) => {
          if (typeof tag === "string" && tag.trim()) {
            topicSet.add(tag.trim());
          }
        });
      }
      const entities = result.entities;
      if (Array.isArray(entities)) {
        entities.forEach((entity) => {
          if (typeof entity === "string" && entity.trim()) {
            topicSet.add(entity.trim());
            return;
          }
          if (
            entity &&
            typeof entity === "object" &&
            !Array.isArray(entity) &&
            typeof (entity as { name?: unknown }).name === "string" &&
            (entity as { name: string }).name.trim()
          ) {
            topicSet.add((entity as { name: string }).name.trim());
          }
        });
      }
      topicSet.forEach((topic) => incrementFacetCount(topicCounts, topic));

      const sentimentSet = new Set<string>();
      if (typeof result.sentiment === "string" && result.sentiment.trim()) {
        sentimentSet.add(result.sentiment.trim().toLowerCase());
      }
      if (
        typeof result.sentiment_label === "string" &&
        result.sentiment_label.trim()
      ) {
        sentimentSet.add(result.sentiment_label.trim().toLowerCase());
      }
      if (Array.isArray(record.tags)) {
        record.tags.forEach((tag) => {
          if (typeof tag !== "string") {
            return;
          }
          const normalized = tag.trim().toLowerCase();
          if (allowedSentiments.has(normalized)) {
            sentimentSet.add(normalized);
          }
        });
      }
      sentimentSet.forEach((sentiment) => {
        if (allowedSentiments.has(sentiment)) {
          incrementFacetCount(sentimentCounts, sentiment);
        }
      });

      const contentTypeRaw =
        typeof result.content_type === "string"
          ? result.content_type
          : typeof result.contentType === "string"
            ? result.contentType
            : null;
      const contentType =
        typeof contentTypeRaw === "string"
          ? contentTypeRaw.trim().toLowerCase()
          : "";
      if (contentType && allowedContentTypes.has(contentType)) {
        incrementFacetCount(contentTypeCounts, contentType);
      }
    }

    return {
      regions: buildFacetOptions(regionCounts),
      topics: buildFacetOptions(topicCounts),
      sentiments: buildFacetOptions(sentimentCounts),
      contentTypes: buildFacetOptions(contentTypeCounts)
    };
  }

  async listRssSourcesForReading(
    orgId: string,
    options?: { windowDays?: number; onlyWithItems?: boolean }
  ): Promise<RssSourceOption[]> {
    const windowDaysRaw = options?.windowDays;
    const windowDays =
      typeof windowDaysRaw === "number" && Number.isFinite(windowDaysRaw)
        ? Math.min(Math.max(Math.floor(windowDaysRaw), 1), 30)
        : 7;
    const onlyWithItems = options?.onlyWithItems ?? true;
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const sources = await this.prisma.newsSource.findMany({
      where: { orgId, isActive: true },
      select: {
        id: true,
        name: true,
        language: true,
        url: true,
        config: true
      },
      orderBy: [{ priority: "desc" }, { updatedAt: "desc" }, { createdAt: "desc" }]
    });

    const rssSources = sources
      .map((source) => {
        const seed =
          source.config && typeof source.config === "object" && !Array.isArray(source.config)
            ? (source.config as { seed?: unknown }).seed
            : null;
        if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
          return null;
        }
        const rawMode = (seed as { mode?: unknown }).mode;
        const mode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : "";
        if (mode !== "rss") {
          return null;
        }
        const feedUrlRaw = (seed as { feedUrl?: unknown }).feedUrl;
        const feedUrl =
          typeof feedUrlRaw === "string" && feedUrlRaw.trim().length > 0
            ? feedUrlRaw.trim()
            : source.url.trim();
        if (!feedUrl || !source.url.trim()) {
          return null;
        }
        return {
          id: source.id,
          name: source.name,
          language: source.language,
          siteUrl: source.url.trim(),
          feedUrl
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (rssSources.length === 0) {
      return [];
    }

    const sourceIds = rssSources.map((source) => source.id);
    const stats = await ProcessedItemModel.aggregate<{
      _id: string;
      itemCountWindow: number;
      latestItemAt: Date | null;
    }>([
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
          sourceId: { $in: sourceIds },
          createdAt: { $gte: since }
        }
      },
      {
        $group: {
          _id: "$sourceId",
          itemCountWindow: { $sum: 1 },
          latestItemAt: { $max: "$createdAt" }
        }
      }
    ]);
    const articleStats =
      sourceIds.length > 0
        ? await this.prisma.article.groupBy({
            by: ["sourceId"],
            where: {
              orgId,
              sourceId: { in: sourceIds },
              crawlAt: { gte: since }
            },
            _count: { _all: true },
            _max: { crawlAt: true }
          })
        : [];

    const statsBySourceId = new Map<string, { itemCountWindow: number; latestItemAt: Date | null }>();
    for (const row of stats) {
      if (!row?._id) {
        continue;
      }
      statsBySourceId.set(row._id, {
        itemCountWindow: Math.max(0, Number(row.itemCountWindow ?? 0)),
        latestItemAt: row.latestItemAt ?? null
      });
    }
    const articleStatsBySourceId = new Map<string, { itemCountWindow: number; latestItemAt: Date | null }>();
    for (const row of articleStats) {
      const sourceId = typeof row.sourceId === "string" ? row.sourceId.trim() : "";
      if (!sourceId) {
        continue;
      }
      const count = Math.max(0, Number(row._count?._all ?? 0));
      const latest = row._max?.crawlAt ?? null;
      articleStatsBySourceId.set(sourceId, {
        itemCountWindow: count,
        latestItemAt: latest ?? null
      });
    }

    const mapped = rssSources
      .map<RssSourceOption>((source) => {
        const processedStats = statsBySourceId.get(source.id);
        const articleStatsEntry = articleStatsBySourceId.get(source.id);
        const itemCountWindow = Math.max(
          processedStats?.itemCountWindow ?? 0,
          articleStatsEntry?.itemCountWindow ?? 0
        );
        const latestItemAt = [processedStats?.latestItemAt ?? null, articleStatsEntry?.latestItemAt ?? null]
          .filter((value): value is Date => value instanceof Date)
          .sort((left, right) => right.getTime() - left.getTime())[0];
        return {
          id: source.id,
          name: source.name,
          language: source.language,
          siteUrl: source.siteUrl,
          feedUrl: source.feedUrl,
          latestItemAt: latestItemAt ? latestItemAt.toISOString() : null,
          itemCountWindow
        };
      })
      .filter((source) => (onlyWithItems ? source.itemCountWindow > 0 : true))
      .sort((a, b) => {
        if (b.itemCountWindow !== a.itemCountWindow) {
          return b.itemCountWindow - a.itemCountWindow;
        }
        if (a.latestItemAt && b.latestItemAt) {
          const delta = new Date(b.latestItemAt).getTime() - new Date(a.latestItemAt).getTime();
          if (delta !== 0) {
            return delta;
          }
        } else if (a.latestItemAt) {
          return -1;
        } else if (b.latestItemAt) {
          return 1;
        }
        return a.name.localeCompare(b.name);
      });

    return mapped;
  }

  /**
   * Search suggestions for auto-complete.
   * Mixes lexical facet suggestions with semantic vector-recalled suggestions.
   */

  async searchSuggestions(
    orgId: string,
    prefix: string,
    limit = 10
  ): Promise<
    {
      type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT";
      value: string;
      origin: "LEXICAL" | "SEMANTIC" | "HYBRID";
    }[]
  > {
    const trimmedPrefix = prefix.trim();
    const normalizedPrefix = trimmedPrefix.toLowerCase();
    if (!normalizedPrefix) {
      return [];
    }

    type SuggestionType = "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT";
    type SuggestionOrigin = "LEXICAL" | "SEMANTIC" | "HYBRID";
    interface SuggestionEntry {
      type: SuggestionType;
      value: string;
      score: number;
      hits: number;
      lexicalScore: number;
      semanticScore: number;
    }

    const clampedLimit = Math.min(Math.max(limit, 1), 25);
    const semanticLimit = Math.min(80, clampedLimit * 6);
    const cacheKey = `${ITEMS_SEARCH_SUGGESTIONS_PREFIX}${orgId}:${normalizedPrefix}:${clampedLimit}:v3`;

    const addScoredSuggestion = (
      bucket: Map<string, SuggestionEntry>,
      type: SuggestionType,
      rawValue: string,
      score: number,
      origin: "LEXICAL" | "SEMANTIC"
    ) => {
      const value = rawValue.trim();
      if (!value) {
        return;
      }
      const key = `${type}:${value.toLowerCase()}`;
      const current = bucket.get(key);
      const lexicalScore = origin === "LEXICAL" ? score : 0;
      const semanticScore = origin === "SEMANTIC" ? score : 0;
      if (!current) {
        bucket.set(key, {
          type,
          value,
          score,
          hits: 1,
          lexicalScore,
          semanticScore
        });
        return;
      }
      current.score += score;
      current.hits += 1;
      current.lexicalScore += lexicalScore;
      current.semanticScore += semanticScore;
    };

    const resolveOrigin = (entry: SuggestionEntry): SuggestionOrigin => {
      if (entry.lexicalScore > 0 && entry.semanticScore > 0) {
        return "HYBRID";
      }
      if (entry.semanticScore > 0) {
        return "SEMANTIC";
      }
      return "LEXICAL";
    };

    return this.cache.wrap(
      cacheKey,
      SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS,
      async () => {
        const [facets, sourceCounts, semanticSuggestions] = await Promise.all([
          this.getFacets(orgId),
          this.query.resolveSourceSuggestionCounts(orgId, normalizedPrefix),
          this.query.resolveSemanticSuggestions(orgId, trimmedPrefix, semanticLimit)
        ]);

        const suggestionByKey = new Map<string, SuggestionEntry>();

        for (const topic of facets.topics) {
          const value = topic.value.trim();
          if (!value) {
            continue;
          }
          const normalized = value.toLowerCase();
          if (normalized.startsWith(normalizedPrefix)) {
            addScoredSuggestion(
              suggestionByKey,
              "TOPIC",
              value,
              360 + topic.count * 2.5,
              "LEXICAL"
            );
          } else if (normalized.includes(normalizedPrefix)) {
            addScoredSuggestion(
              suggestionByKey,
              "TOPIC",
              value,
              180 + topic.count * 1.2,
              "LEXICAL"
            );
          }
        }

        for (const region of facets.regions) {
          const value = region.value.trim();
          if (!value) {
            continue;
          }
          const normalized = value.toLowerCase();
          if (normalized.startsWith(normalizedPrefix)) {
            addScoredSuggestion(
              suggestionByKey,
              "REGION",
              value,
              320 + region.count * 2,
              "LEXICAL"
            );
          } else if (normalized.includes(normalizedPrefix)) {
            addScoredSuggestion(
              suggestionByKey,
              "REGION",
              value,
              160 + region.count,
              "LEXICAL"
            );
          }
        }

        const allowedSentiments = new Set(["positive", "neutral", "negative"]);
        const sentimentCounts = new Map(
          facets.sentiments.map((entry) => [entry.value.trim().toLowerCase(), entry.count] as const)
        );
        for (const sentiment of allowedSentiments) {
          if (!sentiment.includes(normalizedPrefix)) {
            continue;
          }
          const scoreBoost = sentiment.startsWith(normalizedPrefix) ? 300 : 150;
          addScoredSuggestion(
            suggestionByKey,
            "SENTIMENT",
            sentiment,
            scoreBoost + (sentimentCounts.get(sentiment) ?? 0) * 2,
            "LEXICAL"
          );
        }

        sourceCounts.forEach((count, source) => {
          const normalized = source.toLowerCase();
          const scoreBoost = normalized.startsWith(normalizedPrefix) ? 330 : 165;
          addScoredSuggestion(
            suggestionByKey,
            "SOURCE",
            source,
            scoreBoost + count * 2.2,
            "LEXICAL"
          );
        });

        for (const semantic of semanticSuggestions) {
          addScoredSuggestion(
            suggestionByKey,
            semantic.type,
            semantic.value,
            semantic.score,
            "SEMANTIC"
          );
        }

        return Array.from(suggestionByKey.values())
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            if (right.hits !== left.hits) {
              return right.hits - left.hits;
            }
            if (left.type !== right.type) {
              return left.type.localeCompare(right.type);
            }
            return left.value.localeCompare(right.value);
          })
          .slice(0, clampedLimit)
          .map((entry) => ({
            type: entry.type,
            value: entry.value,
            origin: resolveOrigin(entry)
          }));
      },
      {
        lockTtlMs: 5_000,
        retryDelayMs: 50,
        maxWaitMs: 2_000
      }
    );
  }

  async resolveScopedIds(orgId: string, search?: string, filters?: ItemFilters) {
    const normalizedSearch = search?.trim();
    const normalizedFilters = filters ? normalizeFilters(filters) ?? filters : undefined;
    const hasFilters = hasActiveFilters(normalizedFilters);
    if (!normalizedSearch && !hasFilters) {
      return null;
    }
    const [searchIds, filterIds] = await Promise.all([
      normalizedSearch ? this.query.resolveSearchIds(orgId, normalizedSearch) : undefined,
      hasFilters && normalizedFilters ? this.query.resolveFilterIds(orgId, normalizedFilters) : undefined
    ]);
    return combineSearchAndFilterIds(searchIds, filterIds);
  }

  async listByRelevanceWithPage(options: {
    orgId: string;
    search: string;
    scopedIds: string[];
    page: number;
    pageSize: number;
  }) {
    const ranked = await this.rankScopedIdsByRelevance(
      options.orgId,
      options.search,
      options.scopedIds
    );
    if (ranked.length === 0) {
      return {
        items: [],
        total: 0,
        page: options.page,
        pageSize: options.pageSize
      };
    }

    const skip = (options.page - 1) * options.pageSize;
    if (skip >= ranked.length) {
      return {
        items: [],
        total: ranked.length,
        page: options.page,
        pageSize: options.pageSize
      };
    }

    const pageRows = ranked.slice(skip, skip + options.pageSize);
    const pageIds = pageRows.map((row) => row.id);
    const rowsById = await this.readModel.fetchItemMetaRowsByIds(options.orgId, pageIds);
    const scoreById = new Map(pageRows.map((row) => [row.id, row.score]));
    const highlightsById = await this.loadSearchHighlights(
      options.orgId,
      options.search,
      pageIds,
    );

    const items: ItemListRow[] = [];
    for (const id of pageIds) {
      const row = rowsById.get(id);
      if (!row) {
        continue;
      }
      const score = scoreById.get(id);
      items.push({
        ...row,
        ...(typeof score === "number" ? { relevanceScore: score } : {}),
        searchHighlights: highlightsById.get(id) ?? null,
      });
    }

    return {
      items,
      total: ranked.length,
      page: options.page,
      pageSize: options.pageSize
    };
  }

  async listByRelevanceWithCursor(options: {
    orgId: string;
    search: string;
    scopedIds: string[];
    first: number;
    cursor?: ItemsCursorPayload;
  }) {
    const ranked = await this.rankScopedIdsByRelevance(
      options.orgId,
      options.search,
      options.scopedIds
    );
    if (ranked.length === 0) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: 0
      };
    }

    const cursorOffset =
      typeof options.cursor?.offset === "number" && Number.isFinite(options.cursor.offset)
        ? Math.floor(options.cursor.offset)
        : null;
    const cursorId = typeof options.cursor?.id === "string" ? options.cursor.id.trim() : "";
    const cursorIdOffset =
      cursorId.length > 0 ? ranked.findIndex((entry) => entry.id === cursorId) : -1;
    const startOffset =
      cursorIdOffset >= 0
        ? cursorIdOffset + 1
        : cursorOffset !== null
          ? Math.max(0, cursorOffset + 1)
          : 0;
    const pageRows = ranked.slice(startOffset, startOffset + options.first + 1);
    const hasNextPage = pageRows.length > options.first;
    const slicedRows = hasNextPage ? pageRows.slice(0, options.first) : pageRows;
    const pageIds = slicedRows.map((row) => row.id);
    const rowsById = await this.readModel.fetchItemMetaRowsByIds(options.orgId, pageIds);
    const highlightsById = await this.loadSearchHighlights(
      options.orgId,
      options.search,
      pageIds,
    );

    const items: ItemListRow[] = [];
    for (let idx = 0; idx < pageIds.length; idx += 1) {
      const id = pageIds[idx];
      if (!id) {
        continue;
      }
      const row = rowsById.get(id);
      const rankedRow = slicedRows[idx];
      if (!row || !rankedRow) {
        continue;
      }
      items.push({
        ...row,
        relevanceScore: rankedRow.score,
        rankOffset: startOffset + idx,
        searchHighlights: highlightsById.get(id) ?? null,
      });
    }

    return {
      items,
      hasNextPage,
      totalCount: ranked.length
    };
  }

  private async rankScopedIdsByRelevance(orgId: string, search: string, scopedIds: string[]) {
    const rankingCfg = this.env.itemsSearchRankingConfig;
    const recallMax = Math.max(1, rankingCfg.recallMaxCandidates);
    const rerankMax = Math.max(1, Math.min(recallMax, rankingCfg.rerankMaxCandidates));
    const limitedIds = scopedIds.slice(0, recallMax);
    if (limitedIds.length === 0) {
      return [] as { id: string; score: number }[];
    }

    const rowsById = await this.readModel.fetchItemMetaRowsByIds(orgId, limitedIds);
    if (rowsById.size === 0) {
      return [];
    }

    const existingIds = limitedIds.filter((id) => rowsById.has(id));
    if (this.readModel.isReadModelEnabled()) {
      const docsById = await this.readModel.loadItemReadModelsByIds(orgId, existingIds);
      const candidates: {
        id: string;
        document: string;
        lexicalScore: number;
        recencyScore: number;
        sourceTrustScore: number;
        qualityScore: number;
        sortAt: Date;
      }[] = [];
      for (const id of existingIds) {
        const row = rowsById.get(id);
        const doc = docsById.get(id);
        if (!row || !doc) {
          continue;
        }
        const title = doc.title || row.name;
        const summary = typeof doc.summary === "string" ? doc.summary : null;
        const topics = Array.isArray(doc.topics) ? doc.topics.slice(0, 5) : [];
        const entities = Array.isArray(doc.entities) ? doc.entities.slice(0, 5) : [];
        const source =
          typeof doc.sourceName === "string" && doc.sourceName.trim().length > 0
            ? doc.sourceName
            : typeof doc.sourceId === "string" && doc.sourceId.trim().length > 0
              ? doc.sourceId
              : null;
        const qualityScore =
          typeof doc.qualityScore === "number" && Number.isFinite(doc.qualityScore)
            ? clamp01(doc.qualityScore)
            : 0.5;
        const document = [
          title,
          summary,
          topics.length > 0 ? `Topics: ${topics.join(", ")}` : null,
          entities.length > 0 ? `Entities: ${entities.join(", ")}` : null,
        ]
          .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
          .join("\n");
        const lexicalScore = computeLexicalScore(search, document);
        const recencyScore = computeRecencyScore(row.sortAt, rankingCfg.recencyHalfLifeHours);
        const sourceTrustScore = computeSourceTrustScore(source);
        candidates.push({
          id,
          document,
          lexicalScore,
          recencyScore,
          sourceTrustScore,
          qualityScore,
          sortAt: row.sortAt,
        });
      }
      if (candidates.length === 0) {
        return [];
      }

      const preRanked = [...candidates].sort((a, b) => {
        const scoreA = a.lexicalScore * 0.7 + a.recencyScore * 0.3;
        const scoreB = b.lexicalScore * 0.7 + b.recencyScore * 0.3;
        if (scoreB !== scoreA) {
          return scoreB - scoreA;
        }
        return b.sortAt.getTime() - a.sortAt.getTime();
      });
      const rerankCandidates = preRanked.slice(0, rerankMax);
      const rerankScoreById = await this.tryRerankCandidates({
        orgId,
        query: search,
        candidates: rerankCandidates,
        timeoutMs: rankingCfg.rerankTimeoutMs,
      });

      return candidates
        .map((candidate) => {
          const baseRelevance = rerankScoreById?.get(candidate.id) ?? candidate.lexicalScore;
          const finalScore =
            DEFAULT_WEIGHT_RERANK * clamp01(baseRelevance) +
            DEFAULT_WEIGHT_RECENCY * candidate.recencyScore +
            DEFAULT_WEIGHT_SOURCE_TRUST * candidate.sourceTrustScore +
            DEFAULT_WEIGHT_QUALITY * candidate.qualityScore;
          return { id: candidate.id, score: clamp01(finalScore), sortAt: candidate.sortAt };
        })
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          const timeDiff = b.sortAt.getTime() - a.sortAt.getTime();
          if (timeDiff !== 0) {
            return timeDiff;
          }
          return a.id.localeCompare(b.id);
        })
        .map((entry) => ({ id: entry.id, score: entry.score }));
    }

    const processedDocs = await ProcessedItemModel.find(
      {
        orgId,
        status: PipelineStageStatus.Completed,
        itemMetaId: { $in: existingIds }
      },
      { itemMetaId: 1, result: 1, createdAt: 1 }
    )
      .sort({ createdAt: -1 })
      .limit(existingIds.length * 3)
      .lean();
    const processedByMetaId = new Map<string, { result?: unknown }>();
    for (const doc of processedDocs) {
      const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId.trim() : "";
      if (!itemMetaId || processedByMetaId.has(itemMetaId)) {
        continue;
      }
      processedByMetaId.set(itemMetaId, { result: doc.result });
    }

    const candidates: {
      id: string;
      document: string;
      lexicalScore: number;
      recencyScore: number;
      sourceTrustScore: number;
      qualityScore: number;
      sortAt: Date;
    }[] = [];
    for (const id of existingIds) {
      const row = rowsById.get(id);
      if (!row) {
        continue;
      }
      const resultRecord = normalizeResultRecord(processedByMetaId.get(id)?.result);
      const title =
        pickResultString(resultRecord, ["title", "headline", "title_zh", "titleZh"]) ?? row.name;
      const summary = pickResultString(resultRecord, ["summary", "abstract", "subtitle"]);
      const topics = pickResultStringArray(resultRecord, ["topics"]).slice(0, 5);
      const entities = pickResultStringArray(resultRecord, ["entities"]).slice(0, 5);
      const source = pickResultString(resultRecord, ["source", "sourceName", "source_name"]);
      const qualityRaw = pickResultNumber(resultRecord, ["quality_score", "qualityScore"]);
      const qualityScore = qualityRaw === null ? 0.5 : clamp01(qualityRaw);
      const document = [
        title,
        summary,
        topics.length > 0 ? `Topics: ${topics.join(", ")}` : null,
        entities.length > 0 ? `Entities: ${entities.join(", ")}` : null
      ]
        .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
        .join("\n");
      const lexicalScore = computeLexicalScore(search, document);
      const recencyScore = computeRecencyScore(row.sortAt, rankingCfg.recencyHalfLifeHours);
      const sourceTrustScore = computeSourceTrustScore(source);
      candidates.push({
        id,
        document,
        lexicalScore,
        recencyScore,
        sourceTrustScore,
        qualityScore,
        sortAt: row.sortAt
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    const preRanked = [...candidates].sort((a, b) => {
      const scoreA = a.lexicalScore * 0.7 + a.recencyScore * 0.3;
      const scoreB = b.lexicalScore * 0.7 + b.recencyScore * 0.3;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return b.sortAt.getTime() - a.sortAt.getTime();
    });
    const rerankCandidates = preRanked.slice(0, rerankMax);
    const rerankScoreById = await this.tryRerankCandidates({
      orgId,
      query: search,
      candidates: rerankCandidates,
      timeoutMs: rankingCfg.rerankTimeoutMs
    });

    const ranked = candidates
      .map((candidate) => {
        const baseRelevance = rerankScoreById?.get(candidate.id) ?? candidate.lexicalScore;
        const finalScore =
          DEFAULT_WEIGHT_RERANK * clamp01(baseRelevance) +
          DEFAULT_WEIGHT_RECENCY * candidate.recencyScore +
          DEFAULT_WEIGHT_SOURCE_TRUST * candidate.sourceTrustScore +
          DEFAULT_WEIGHT_QUALITY * candidate.qualityScore;
        return { id: candidate.id, score: clamp01(finalScore), sortAt: candidate.sortAt };
      })
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const timeDiff = b.sortAt.getTime() - a.sortAt.getTime();
        if (timeDiff !== 0) {
          return timeDiff;
        }
        return a.id.localeCompare(b.id);
      });

    return ranked.map((entry) => ({ id: entry.id, score: entry.score }));
  }

  private async loadSearchHighlights(
    orgId: string,
    search: string,
    ids: string[],
  ): Promise<Map<string, ItemSearchHighlights>> {
    if (!this.elasticsearch || ids.length === 0 || !search.trim()) {
      return new Map();
    }
    try {
      return await this.elasticsearch.getHighlights(orgId, search, ids);
    } catch {
      return new Map();
    }
  }

  private async tryRerankCandidates(options: {
    orgId: string;
    query: string;
    candidates: { id: string; document: string }[];
    timeoutMs: number;
  }): Promise<Map<string, number> | null> {
    if (options.candidates.length === 0 || !this.env.itemsSearchRankingConfig.rerankEnabled) {
      return null;
    }
    const documents = options.candidates.map((candidate) => candidate.document);
    if (documents.every((entry) => entry.length === 0)) {
      return null;
    }

    try {
      const response = await this.liteLlm.rerank({
        orgId: options.orgId,
        query: options.query,
        documents,
        topN: documents.length,
        timeoutMs: Math.max(100, Math.floor(options.timeoutMs)),
        maxRetries: 1,
        metadata: {
          orgId: options.orgId,
          source: "items-search-rerank"
        }
      });
      if (!Array.isArray(response.results) || response.results.length === 0) {
        throw new Error("Rerank response did not include scored results");
      }
      const rawScores = response.results.map((entry) => entry.score).filter((score) => Number.isFinite(score));
      if (rawScores.length === 0) {
        throw new Error("Rerank response did not include usable scores");
      }
      const minScore = Math.min(...rawScores);
      const maxScore = Math.max(...rawScores);
      const scoreSpan = maxScore - minScore;
      const scoreById = new Map<string, number>();
      for (const result of response.results) {
        const candidate = options.candidates[result.index];
        if (!candidate) {
          continue;
        }
        const normalized =
          scoreSpan > 1e-9
            ? (result.score - minScore) / scoreSpan
            : maxScore > 0
              ? 1
              : 0;
        scoreById.set(candidate.id, clamp01(normalized));
      }
      if (scoreById.size === 0) {
        throw new Error("Rerank response did not map to any candidate documents");
      }
      return scoreById;
    } catch (error) {
      const detail = error instanceof Error ? error.message : undefined;
      this.logger.error(
        {
          orgId: options.orgId,
          candidateCount: options.candidates.length,
          queryHash: createHash("sha256").update(options.query).digest("hex").slice(0, 16),
          message: detail ?? "unknown error",
          code: "RERANK_UNAVAILABLE",
        },
        "Items rerank request failed",
      );
      throw new ServiceUnavailableException(
        {
          code: "RERANK_UNAVAILABLE",
          message: "Reranker unavailable: failed to rank relevance results.",
          ...(detail ? { detail } : {}),
        },
      );
    }
  }
}
