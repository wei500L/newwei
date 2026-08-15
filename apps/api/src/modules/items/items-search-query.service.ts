import {
  ItemReadModelModel,
  ProcessedItemModel,
  type MongoConnection,
  type ProcessedItem,
} from "@modular/mongo";
import { createLogger } from "@modular/utils";
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Types, type PipelineStage, type ProjectionType } from "mongoose";

import { ItemStatus, PipelineStageStatus } from "../../common/pipeline-status";
import { CacheService } from "../cache/cache.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import { recordIntegrationEvent } from "../observability/prometheus-metrics";
import { VectorClientService } from "../vector/vector-client.service";

import { ItemsElasticsearchService } from "./items-elasticsearch.service";
import { ItemsReadModelService } from "./items-read-model.service";
import {
  buildBaseWhere,
  buildMongoTextSearchQuery,
  buildPrefixWhere,
  buildProcessedSortAtExpression,
  buildReadModelBaseMatch,
  buildReadModelMatch,
  collectSuggestionValuesFromProcessed,
  cosineSimilarity,
  dedupeItemMetaIds,
  escapeRegex,
  normalizeResultRecord,
  pickResultString,
  pushSemanticSuggestions,
  rankSearchCandidateIds,
  resolveSearchStrategy,
  shouldUseSemanticSuggestions,
  tokenizeSearch,
  vectorSearchCacheKey,
} from "./items-search.helpers";
import {
  DAY_MS,
  ITEMS_SOURCE_SUGGESTIONS_PREFIX,
  MAX_SEARCH_MATCHES,
  MONGO_MIN_TOKEN_LENGTH,
  SEARCH_SUGGESTIONS_MAX_SEMANTIC_IDS,
  SEARCH_SUGGESTIONS_MAX_SOURCE_SCAN,
  SOURCE_SUGGESTIONS_CACHE_TTL_SECONDS,
  VECTOR_SEARCH_CACHE_TTL_SECONDS,
  VECTOR_SEARCH_LOOKBACK_DAYS,
  VECTOR_SEARCH_MAX_CANDIDATES,
  VECTOR_SEARCH_MAX_RESULTS,
  VECTOR_SEARCH_MIN_SIMILARITY,
  type ItemDateRangeFilter,
  type ItemFilters,
  type SearchStrategy,
} from "./items.shared";

@Injectable()
export class ItemsSearchQueryService {
  private readonly logger = createLogger({ name: "items-service" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly liteLlm: LiteLlmService,
    private readonly readModel: ItemsReadModelService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
    @Optional() private readonly elasticsearch?: ItemsElasticsearchService,
    @Optional() private readonly vectorClient?: VectorClientService,
  ) {
    void this._mongo;
  }

  private async resolveReadModelSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type === "none") {
      return [];
    }

    if (strategy.type === "fulltext") {
      const docs = (await ItemReadModelModel.find(
        {
          $and: [buildReadModelBaseMatch(orgId), { $text: { $search: strategy.query } }],
        },
        {
          itemMetaId: 1,
          score: { $meta: "textScore" },
        },
      )
        .sort({ score: { $meta: "textScore" }, sortAt: -1, itemMetaId: -1 })
        .limit(MAX_SEARCH_MATCHES)
        .lean()) as { itemMetaId?: string }[];
      return dedupeItemMetaIds(
        docs.map((doc) => (typeof doc.itemMetaId === "string" ? doc.itemMetaId : "")),
      );
    }

    const regex = new RegExp(`^${escapeRegex(strategy.term.trim().toLowerCase())}`);
    const docs = (await ItemReadModelModel.find(
      {
        $and: [
          buildReadModelBaseMatch(orgId),
          {
            $or: [
              { titleLower: regex },
              { externalIdLower: regex },
              { sourceNameLower: regex },
              { topicKeys: regex },
              { entityKeys: regex },
              { regionKey: regex },
              { locationKey: regex },
            ],
          },
        ],
      },
      { itemMetaId: 1 },
    )
      .sort({ sortAt: -1, itemMetaId: -1 })
      .limit(MAX_SEARCH_MATCHES)
      .lean()) as { itemMetaId?: string }[];

    return dedupeItemMetaIds(
      docs.map((doc) => (typeof doc.itemMetaId === "string" ? doc.itemMetaId : "")),
    );
  }

  private async resolveVectorSearchIds(orgId: string, search: string): Promise<string[]> {
    const embeddingModel = await this.liteLlm.getEmbeddingModel();
    if (!embeddingModel) {
      return [];
    }

    const normalized = search.trim();
    if (!normalized) {
      return [];
    }

    const tokens = tokenizeSearch(normalized, MONGO_MIN_TOKEN_LENGTH);
    if (tokens.length < 2 && normalized.length < 16) {
      return [];
    }

    const cacheKey = vectorSearchCacheKey(orgId, normalized.toLowerCase());

    const loader = async () => {
      const response = await this.liteLlm.embedding({
        orgId,
        model: embeddingModel,
        input: normalized,
        metadata: {
          orgId,
          source: "items-search",
        },
      });
      const embedding = response.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) {
        return [];
      }
      const model = response.model ?? embeddingModel;
      const lookbackMs = VECTOR_SEARCH_LOOKBACK_DAYS * DAY_MS;

      const vectorClient = this.vectorClient;
      if (vectorClient) {
        const matches = await vectorClient.searchBestEffort({
          orgId,
          embeddingModel: model,
          vector: embedding,
          limit: VECTOR_SEARCH_MAX_RESULTS,
          minScore: VECTOR_SEARCH_MIN_SIMILARITY,
          lookbackMs,
        });
        if (matches) {
          if (matches.length === 0 && !(await vectorClient.fallbackToMongoEnabled())) {
            return [];
          }
          if (matches.length > 0) {
            const ids: string[] = [];
            const seen = new Set<string>();
            for (const match of matches) {
              if (seen.has(match.itemMetaId)) {
                continue;
              }
              ids.push(match.itemMetaId);
              seen.add(match.itemMetaId);
              if (ids.length >= VECTOR_SEARCH_MAX_RESULTS) {
                break;
              }
            }
            return ids;
          }
        } else if (this.readModel.isVectorHardFailEnabled()) {
          throw new ServiceUnavailableException({
            code: "VECTOR_SEARCH_UNAVAILABLE",
            message: "Vector search unavailable: failed to query vector index.",
          });
        } else if (!(await vectorClient.fallbackToMongoEnabled())) {
          return [];
        }
      }

      if (this.readModel.isVectorHardFailEnabled()) {
        throw new ServiceUnavailableException({
          code: "VECTOR_SEARCH_UNAVAILABLE",
          message: "Vector search unavailable: local fallback disabled.",
        });
      }

      const cutoff = new Date(Date.now() - lookbackMs);

      const candidates = await ProcessedItemModel.find(
        {
          orgId,
          status: PipelineStageStatus.Completed,
          summaryEmbeddingModel: model,
          summaryEmbedding: { $exists: true, $ne: [] },
          duplicateOf: null,
          createdAt: { $gte: cutoff },
        },
        { itemMetaId: 1, summaryEmbedding: 1 },
      )
        .sort({ createdAt: -1 })
        .limit(VECTOR_SEARCH_MAX_CANDIDATES)
        .lean();

      const scored: { itemMetaId: string; score: number }[] = [];
      for (const candidate of candidates) {
        const itemMetaId = (candidate as { itemMetaId?: unknown }).itemMetaId;
        if (typeof itemMetaId !== "string" || itemMetaId.length === 0) {
          continue;
        }
        const vector = (candidate as { summaryEmbedding?: unknown }).summaryEmbedding;
        if (!Array.isArray(vector) || vector.length !== embedding.length) {
          continue;
        }
        const similarity = cosineSimilarity(
          embedding,
          vector as number[],
        );
        if (!Number.isFinite(similarity) || similarity < VECTOR_SEARCH_MIN_SIMILARITY) {
          continue;
        }
        scored.push({ itemMetaId, score: similarity });
      }

      scored.sort((a, b) => b.score - a.score);
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const entry of scored) {
        if (seen.has(entry.itemMetaId)) {
          continue;
        }
        ids.push(entry.itemMetaId);
        seen.add(entry.itemMetaId);
        if (ids.length >= VECTOR_SEARCH_MAX_RESULTS) {
          break;
        }
      }
      return ids;
    };

    try {
      return await this.cache.wrap(cacheKey, VECTOR_SEARCH_CACHE_TTL_SECONDS, loader, {
        lockTtlMs: 5_000,
        retryDelayMs: 50,
        maxWaitMs: 2_000,
      });
    } catch (cacheError) {
      this.logger.warn(
        { err: cacheError, orgId },
        "Vector search cache wrap failed; retrying loader",
      );
      try {
        return await loader();
      } catch (loaderError) {
        this.logger.warn(
          { err: loaderError, orgId },
          "Vector search degraded to empty results",
        );
        recordIntegrationEvent({
          integration: "vector",
          operation: "items_vector_search",
          status: "failure",
        });
        return [];
      }
    }
  }

  async resolveSearchIds(orgId: string, search: string) {
    if (this.readModel.isReadModelEnabled()) {
      const strategy = resolveSearchStrategy(search);
      if (strategy.type === "none") {
        return [];
      }
      const [elasticHits, lexicalIds, vectorIds] = await Promise.all([
        this.elasticsearch
          ?.search(orgId, search, MAX_SEARCH_MATCHES)
          .catch((err: unknown) => {
            this.logger.warn(
              { err, orgId },
              "Elasticsearch search rejected; degrading",
            );
            return null;
          }) ?? Promise.resolve(null),
        this.resolveReadModelSearchIds(orgId, strategy),
        this.resolveVectorSearchIds(orgId, search),
      ]);
      return rankSearchCandidateIds({
        elasticsearch: elasticHits?.map((hit) => hit.id),
        meta: lexicalIds,
        vector: vectorIds,
      });
    }

    const strategy = resolveSearchStrategy(search);
    if (strategy.type === "none") {
      return [];
    }

    const [elasticHits, metaIds, processedIds, processedArticleIds, vectorIds] = await Promise.all([
      this.elasticsearch
        ?.search(orgId, search, MAX_SEARCH_MATCHES)
        .catch((err: unknown) => {
          this.logger.warn(
            { err, orgId },
            "Elasticsearch search rejected; degrading",
          );
          return null;
        }) ?? Promise.resolve(null),
      this.resolveMetaSearchIds(orgId, strategy),
      this.resolveProcessedSearchIds(orgId, strategy),
      this.resolveProcessedArticleSearchIds(orgId, strategy),
      this.resolveVectorSearchIds(orgId, search),
    ]);

    return rankSearchCandidateIds({
      elasticsearch: elasticHits?.map((hit) => hit.id),
      meta: metaIds,
      processed: processedIds,
      processedArticle: processedArticleIds,
      vector: vectorIds,
    });
  }

  async resolveFilterIds(orgId: string, filters: ItemFilters) {
    if (this.readModel.isReadModelEnabled()) {
      const match = buildReadModelMatch(orgId, filters);
      const docs = (await ItemReadModelModel.find(match, { itemMetaId: 1 })
        .sort({ sortAt: -1, itemMetaId: -1 })
        .limit(MAX_SEARCH_MATCHES)
        .lean()) as { itemMetaId?: string }[];
      return dedupeItemMetaIds(
        docs.map((doc) => (typeof doc.itemMetaId === "string" ? doc.itemMetaId : "")),
      );
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
        },
      },
      {
        $addFields: {
          normalizedSortAt: buildProcessedSortAtExpression(),
        },
      },
      { $sort: { itemMetaId: 1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: "$itemMetaId",
          itemMetaId: { $first: "$itemMetaId" },
          tags: { $first: "$tags" },
          result: { $first: "$result" },
          sourceId: { $first: "$sourceId" },
          duplicateOf: { $first: "$duplicateOf" },
          sortAt: { $first: "$normalizedSortAt" },
        },
      },
    ];

    const matchFilters: Record<string, unknown>[] = [];
    if (filters.sourceIds?.length) {
      matchFilters.push({
        sourceId: { $in: filters.sourceIds },
      });
    }
    if (filters.regions?.length) {
      matchFilters.push({
        $or: [
          { "result.location": { $in: filters.regions } },
          { "result.region": { $in: filters.regions } },
        ],
      });
    }
    if (filters.topics?.length) {
      matchFilters.push({
        $or: [
          { "result.topics": { $in: filters.topics } },
          { tags: { $in: filters.topics } },
          { "result.entities.name": { $in: filters.topics } },
        ],
      });
    }
    if (filters.sentiments?.length) {
      const sentimentMatchers = filters.sentiments.map(
        (value) => new RegExp(`^${escapeRegex(value)}$`, "i"),
      );
      matchFilters.push({
        $or: [
          { "result.sentiment": { $in: sentimentMatchers } },
          { "result.sentiment_label": { $in: sentimentMatchers } },
          { tags: { $in: sentimentMatchers } },
        ],
      });
    }
    if (filters.contentTypes?.length) {
      const contentTypeMatchers = filters.contentTypes.map(
        (value) => new RegExp(`^${escapeRegex(value)}$`, "i"),
      );
      matchFilters.push({
        $or: [
          { "result.content_type": { $in: contentTypeMatchers } },
          { "result.contentType": { $in: contentTypeMatchers } },
        ],
      });
    }
    if (filters.excludeDuplicates) {
      matchFilters.push({
        $or: [{ duplicateOf: null }, { duplicateOf: { $exists: false } }],
      });
    }
    if (filters.dateRange?.start || filters.dateRange?.end) {
      const dateMatch: Record<string, Date> = {};
      if (filters.dateRange.start) {
        dateMatch.$gte = filters.dateRange.start;
      }
      if (filters.dateRange.end) {
        dateMatch.$lte = filters.dateRange.end;
      }
      matchFilters.push({ sortAt: dateMatch });
    }
    if (matchFilters.length > 0) {
      pipeline.push({ $match: { $and: matchFilters } });
    }
    pipeline.push({ $project: { _id: 0, itemMetaId: 1 } });

    const records = await ProcessedItemModel.aggregate<{ itemMetaId: string }>(pipeline);
    const primaryIds = dedupeItemMetaIds(
      records.map((record) => record.itemMetaId),
    );
    if (!filters.sourceIds?.length) {
      return primaryIds;
    }

    const fallbackIds = await this.resolveSourceFilterFallbackItemMetaIds(
      orgId,
      filters.sourceIds,
      filters.dateRange
    );
    if (fallbackIds.length === 0) {
      return primaryIds;
    }
    return dedupeItemMetaIds([...primaryIds, ...fallbackIds]);
  }

  /**
   * Fallback path when ProcessedItem.sourceId is missing:
   * use ProcessedArticle -> Article(sourceId) -> cleanedMarkdownRef -> ProcessedItem.itemMetaId.
   */

  private async resolveSourceFilterFallbackItemMetaIds(
    orgId: string,
    sourceIds: string[],
    dateRange?: ItemDateRangeFilter
  ): Promise<string[]> {
    if (!sourceIds.length) {
      return [];
    }

    const articleWhere: Prisma.ArticleWhereInput = {
      orgId,
      sourceId: { in: sourceIds }
    };
    if (dateRange?.start || dateRange?.end) {
      const crawlAt: Prisma.DateTimeFilter = {};
      if (dateRange.start) {
        crawlAt.gte = dateRange.start;
      }
      if (dateRange.end) {
        crawlAt.lte = dateRange.end;
      }
      articleWhere.crawlAt = crawlAt;
    }

    const processedRows = await this.prisma.processedArticle.findMany({
      where: {
        status: "completed",
        cleanedMarkdownRef: { not: null },
        article: articleWhere
      },
      select: { cleanedMarkdownRef: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }]
    });

    const processedIds = processedRows
      .map((row) => (typeof row.cleanedMarkdownRef === "string" ? row.cleanedMarkdownRef.trim() : ""))
      .filter((value): value is string => Boolean(value && Types.ObjectId.isValid(value)))
      .map((value) => new Types.ObjectId(value));
    if (processedIds.length === 0) {
      return [];
    }

    const matched = await ProcessedItemModel.find(
      {
        _id: { $in: processedIds },
        orgId,
        status: PipelineStageStatus.Completed
      },
      { itemMetaId: 1 }
    )
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    return dedupeItemMetaIds(
      matched.map((row) =>
        typeof row.itemMetaId === "string" ? row.itemMetaId.trim() : "",
      ),
    );
  }

  async resolveSourceSuggestionCounts(orgId: string, normalizedPrefix: string) {
    if (this.readModel.isReadModelEnabled()) {
      const regex = new RegExp(escapeRegex(normalizedPrefix), "i");
      const rows = (await ItemReadModelModel.aggregate<{
        _id: string;
        sourceName: string;
        count: number;
      }>([
        {
          $match: {
            orgId,
            status: { $ne: ItemStatus.Duplicate },
            sourceNameLower: regex,
          },
        },
        {
          $group: {
            _id: "$sourceNameLower",
            sourceName: { $first: "$sourceName" },
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1, sourceName: 1 } },
        { $limit: SEARCH_SUGGESTIONS_MAX_SOURCE_SCAN },
      ])) as { sourceName?: string; count?: number }[];
      return new Map(
        rows
          .map((row) => {
            const source = typeof row.sourceName === "string" ? row.sourceName.trim() : "";
            const count = typeof row.count === "number" ? row.count : 0;
            return source ? ([source, count] as const) : null;
          })
          .filter((entry): entry is readonly [string, number] => Boolean(entry)),
      );
    }

    const snapshot = await this.cache.wrap(
      `${ITEMS_SOURCE_SUGGESTIONS_PREFIX}${orgId}:v1`,
      SOURCE_SUGGESTIONS_CACHE_TTL_SECONDS,
      async () => {
        const records = await ProcessedItemModel.find(
          {
            orgId,
            status: PipelineStageStatus.Completed
          },
          {
            result: 1
          }
        )
          .sort({ createdAt: -1 })
          .limit(SEARCH_SUGGESTIONS_MAX_SOURCE_SCAN)
          .lean();

        const counts = new Map<string, number>();
        for (const record of records) {
          const resultRecord = normalizeResultRecord(
            (record as { result?: unknown }).result
          );
          const source = pickResultString(resultRecord, [
            "source",
            "sourceName",
            "source_name",
            "publisher"
          ]);
          if (!source) {
            continue;
          }
          counts.set(source, (counts.get(source) ?? 0) + 1);
        }

        return Array.from(counts.entries()).map(([source, count]) => ({
          source,
          normalizedSource: source.toLowerCase(),
          count
        }));
      },
      {
        lockTtlMs: 5_000,
        retryDelayMs: 50,
        maxWaitMs: 2_000
      }
    );

    const counts = new Map<string, number>();
    for (const entry of snapshot) {
      if (
        !entry.normalizedSource.startsWith(normalizedPrefix) &&
        !entry.normalizedSource.includes(normalizedPrefix)
      ) {
        continue;
      }
      counts.set(entry.source, entry.count);
    }
    return counts;
  }

  async resolveSemanticSuggestions(
    orgId: string,
    query: string,
    limit: number
  ): Promise<{ type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }[]> {
    const trimmedQuery = query.trim();
    const normalizedQuery = trimmedQuery.toLowerCase();
    if (!shouldUseSemanticSuggestions(normalizedQuery)) {
      return [];
    }

    const vectorIds = await this.resolveVectorSearchIds(orgId, trimmedQuery);
    if (vectorIds.length === 0) {
      return [];
    }

    const topIds = vectorIds.slice(0, SEARCH_SUGGESTIONS_MAX_SEMANTIC_IDS);
    if (this.readModel.isReadModelEnabled()) {
      const docsById = await this.readModel.loadItemReadModelsByIds(orgId, topIds);
      const tokens = tokenizeSearch(normalizedQuery, MONGO_MIN_TOKEN_LENGTH);
      const scored = new Map<
        string,
        { type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }
      >();

      for (let index = 0; index < topIds.length; index += 1) {
        const itemMetaId = topIds[index];
        if (!itemMetaId) {
          continue;
        }
        const doc = docsById.get(itemMetaId);
        if (!doc) {
          continue;
        }
        const rankScore = 140 - (index / Math.max(1, topIds.length)) * 80;
        pushSemanticSuggestions(
          scored,
          Array.isArray(doc.topics) ? doc.topics.slice(0, 10) : [],
          "TOPIC",
          normalizedQuery,
          tokens,
          rankScore,
        );
        const regions = [
          typeof doc.location === "string" && doc.location.trim().length > 0 ? doc.location : null,
          typeof doc.region === "string" && doc.region.trim().length > 0 ? doc.region : null,
        ].filter((value): value is string => Boolean(value));
        pushSemanticSuggestions(
          scored,
          regions,
          "REGION",
          normalizedQuery,
          tokens,
          rankScore * 0.92,
        );
        const sources = [
          typeof doc.sourceName === "string" && doc.sourceName.trim().length > 0 ? doc.sourceName : null,
          typeof doc.sourceId === "string" && doc.sourceId.trim().length > 0 ? doc.sourceId : null,
        ].filter((value): value is string => Boolean(value));
        pushSemanticSuggestions(
          scored,
          sources,
          "SOURCE",
          normalizedQuery,
          tokens,
          rankScore * 0.88,
        );
        const sentiments =
          typeof doc.sentiment === "string" && doc.sentiment.trim().length > 0 ? [doc.sentiment] : [];
        pushSemanticSuggestions(
          scored,
          sentiments,
          "SENTIMENT",
          normalizedQuery,
          tokens,
          rankScore * 0.8,
        );
      }

      return Array.from(scored.values())
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          if (left.type !== right.type) {
            return left.type.localeCompare(right.type);
          }
          return left.value.localeCompare(right.value);
        })
        .slice(0, limit);
    }

    const processedDocs = await ProcessedItemModel.find(
      {
        orgId,
        status: PipelineStageStatus.Completed,
        itemMetaId: { $in: topIds }
      },
      {
        itemMetaId: 1,
        tags: 1,
        result: 1,
        createdAt: 1
      }
    )
      .sort({ createdAt: -1 })
      .limit(topIds.length * 3)
      .lean();

    const latestByMetaId = new Map<string, { tags?: unknown; result?: unknown }>();
    for (const doc of processedDocs) {
      const itemMetaId =
        typeof (doc as { itemMetaId?: unknown }).itemMetaId === "string"
          ? ((doc as { itemMetaId: string }).itemMetaId ?? "").trim()
          : "";
      if (!itemMetaId || latestByMetaId.has(itemMetaId)) {
        continue;
      }
      latestByMetaId.set(itemMetaId, {
        tags: (doc as { tags?: unknown }).tags,
        result: (doc as { result?: unknown }).result
      });
    }

    const tokens = tokenizeSearch(normalizedQuery, MONGO_MIN_TOKEN_LENGTH);
    const scored = new Map<
      string,
      { type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }
    >();

    for (let index = 0; index < topIds.length; index += 1) {
      const itemMetaId = topIds[index];
      if (!itemMetaId) {
        continue;
      }
      const doc = latestByMetaId.get(itemMetaId);
      if (!doc) {
        continue;
      }
      const rankScore = 140 - (index / Math.max(1, topIds.length)) * 80;
      const fields = collectSuggestionValuesFromProcessed({
        tags: doc.tags,
        result: doc.result
      });

      pushSemanticSuggestions(scored, fields.topics, "TOPIC", normalizedQuery, tokens, rankScore);
      pushSemanticSuggestions(scored, fields.regions, "REGION", normalizedQuery, tokens, rankScore * 0.92);
      pushSemanticSuggestions(scored, fields.sources, "SOURCE", normalizedQuery, tokens, rankScore * 0.88);
      pushSemanticSuggestions(
        scored,
        fields.sentiments,
        "SENTIMENT",
        normalizedQuery,
        tokens,
        rankScore * 0.8
      );
    }

    return Array.from(scored.values())
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.type !== right.type) {
          return left.type.localeCompare(right.type);
        }
        return left.value.localeCompare(right.value);
      })
      .slice(0, limit);
  }

  private async resolveMetaSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type === "none") {
      return [];
    }

    if (strategy.type === "fulltext") {
      const rows = await this.prisma.$queryRaw<{ id: string; score: number }[]>`
        SELECT
          \`id\`,
          MATCH(\`name\`, \`externalId\`) AGAINST (${strategy.query} IN BOOLEAN MODE) AS \`score\`
        FROM \`ItemMeta\`
        WHERE \`orgId\` = ${orgId}
          AND \`status\` <> ${ItemStatus.Duplicate}
          AND MATCH(\`name\`, \`externalId\`) AGAINST (${strategy.query} IN BOOLEAN MODE)
        ORDER BY \`score\` DESC, \`createdAt\` DESC, \`id\` DESC
        LIMIT ${MAX_SEARCH_MATCHES}
      `;
      return dedupeItemMetaIds(rows.map((row) => row.id));
    }

    const baseWhere = buildBaseWhere(orgId);
    const where = buildPrefixWhere(baseWhere, strategy.term);
    const items = await this.prisma.itemMeta.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_SEARCH_MATCHES
    });
    return dedupeItemMetaIds(items.map((item) => item.id));
  }

  private async resolveProcessedSearchIds(orgId: string, strategy: SearchStrategy) {
    const textQuery = buildMongoTextSearchQuery(strategy);
    if (!textQuery) {
      return [];
    }

    const records = await ProcessedItemModel.find(
      {
        orgId,
        status: PipelineStageStatus.Completed,
        $text: { $search: textQuery },
      },
      {
        itemMetaId: 1,
        score: { $meta: "textScore" },
      } as unknown as ProjectionType<ProcessedItem>,
    )
      .sort({ score: { $meta: "textScore" }, createdAt: -1 })
      .limit(MAX_SEARCH_MATCHES)
      .lean();

    return dedupeItemMetaIds(
      records.map((record) => record.itemMetaId),
    );
  }

  private async resolveProcessedArticleSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type !== "fulltext") {
      return [];
    }

    // ProcessedArticle only has a fulltext index on title/summary, so prefix fallback
    // must not degrade into contains/LIKE scans here.
    const rows = await this.prisma.$queryRaw<
      { cleanedMarkdownRef: string | null; score: number }[]
    >`
      SELECT
        pa.cleanedMarkdownRef,
        MATCH(pa.title, pa.summary) AGAINST (${strategy.query} IN BOOLEAN MODE) AS \`score\`
      FROM \`ProcessedArticle\` pa
      INNER JOIN \`Article\` a ON a.id = pa.articleId
      WHERE a.orgId = ${orgId}
        AND pa.cleanedMarkdownRef IS NOT NULL
        AND MATCH(pa.title, pa.summary) AGAINST (${strategy.query} IN BOOLEAN MODE)
      ORDER BY \`score\` DESC, pa.updatedAt DESC, pa.id DESC
      LIMIT ${MAX_SEARCH_MATCHES}
    `;
    const refs = rows.map((row) => row.cleanedMarkdownRef ?? "").filter(Boolean);

    const objectIds = refs
      .filter((ref) => Types.ObjectId.isValid(ref))
      .map((ref) => new Types.ObjectId(ref));
    if (objectIds.length === 0) {
      return [];
    }

    const records = await ProcessedItemModel.find(
      { _id: { $in: objectIds } },
      { itemMetaId: 1 }
    )
      .sort({ createdAt: -1, _id: -1 })
      .limit(MAX_SEARCH_MATCHES)
      .lean();

    return dedupeItemMetaIds(
      records.map((record) => record.itemMetaId),
    );
  }
}
