import { createLogger } from "@modular/utils";
import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Types, type PipelineStage } from "mongoose";
import { createHash } from "node:crypto";

import { ItemStatus, PipelineStageStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import { LiteLlmService } from "../news-pipeline/litellm.service";
import {
  NormalizedNewsPayload,
  NormalizedNewsPayloadSchema
} from "../news-pipeline/news-pipeline.schema";
import { QueueService } from "../queue/queue.service";
import { buildUserNewsBehaviorHashKey } from "../user-news-behavior/user-news-behavior.constants";
import { VectorClientService } from "../vector/vector-client.service";

import { CreateItemDto } from "./dto/create-item.dto";
import { UpdateItemDto } from "./dto/update-item.dto";


const MAX_CURSOR_PAGE_SIZE = 50;
const FULLTEXT_MIN_TOKEN_LENGTH = 3;
const MONGO_MIN_TOKEN_LENGTH = 2;
const MAX_SEARCH_MATCHES = 5000;
const MAX_TOPIC_GROUPS = 50;
const LATEST_PROCESSED_SNAPSHOT_BATCH_SIZE = 500;
const MAX_TOPIC_ITEMS = 8;
const DEFAULT_TOPIC_WINDOW_DAYS = 30;
const MAX_EVENT_GROUPS = 50;
const MAX_EVENT_ITEMS = 8;
const DEFAULT_EVENT_WINDOW_DAYS = 30;
const DEFAULT_EVENT_MIN_GROUP_SIZE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const ITEMS_FILTERS_SEARCH_PREFIX = "__items_filters__:";
const MAX_FACET_OPTIONS = 50;
const ITEMS_VECTOR_SEARCH_PREFIX = "__items_vector_search__:";
const ITEMS_SEARCH_SUGGESTIONS_PREFIX = "__items_search_suggestions__:";
const ITEMS_SOURCE_SUGGESTIONS_PREFIX = "__items_source_suggestions__:";
const VECTOR_SEARCH_CACHE_TTL_SECONDS = 300;
const VECTOR_SEARCH_MIN_SIMILARITY = 0.78;
const VECTOR_SEARCH_MAX_RESULTS = 300;
const VECTOR_SEARCH_MAX_CANDIDATES = 1200;
const VECTOR_SEARCH_LOOKBACK_DAYS = 30;
const SEARCH_SUGGESTIONS_CACHE_TTL_SECONDS = 60;
const SOURCE_SUGGESTIONS_CACHE_TTL_SECONDS = 180;
const SEARCH_SUGGESTIONS_MAX_SEMANTIC_IDS = 120;
const SEARCH_SUGGESTIONS_MAX_SOURCE_SCAN = 1000;
const SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS = 6;
const TOPIC_GROUPS_CACHE_TTL_SECONDS = 120;
const EVENT_GROUPS_CACHE_TTL_SECONDS = 120;
const PERSONALIZED_CANDIDATE_MIN = 180;
const PERSONALIZED_CANDIDATE_MAX = 1600;
const PERSONALIZED_CANDIDATE_MULTIPLIER = 8;
const DEFAULT_RECENCY_HALFLIFE_HOURS = 48;
const DEFAULT_WEIGHT_RERANK = 0.55;
const DEFAULT_WEIGHT_RECENCY = 0.25;
const DEFAULT_WEIGHT_SOURCE_TRUST = 0.15;
const DEFAULT_WEIGHT_QUALITY = 0.05;
const DEFAULT_SOURCE_TRUST_SCORE = 0.6;
const SOURCE_TRUST_SCORE_MAP: Record<string, number> = {
  reuters: 0.96,
  bloomberg: 0.95,
  "financial times": 0.94,
  "wall street journal": 0.94,
  wsj: 0.94,
  "associated press": 0.93,
  "ap news": 0.93,
  cnbc: 0.9,
  marketwatch: 0.86,
  nikkei: 0.9,
  xinhua: 0.9
};

type SearchStrategy =
  | { type: "none" }
  | { type: "fulltext"; query: string }
  | { type: "prefix"; term: string };

interface ItemDateRangeFilter {
  start?: Date;
  end?: Date;
}

interface ItemFilters {
  sourceIds?: string[];
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  contentTypes?: string[];
  excludeDuplicates?: boolean;
  dateRange?: ItemDateRangeFilter;
}

interface ParsedSearchPayload {
  search?: string;
  filters?: ItemFilters;
}

export type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC" | "PERSONALIZED";
export type ItemsRankingMode = "RECENCY" | "RELEVANCE";

export interface ItemsCursorPayload {
  id: string;
  createdAt?: string;
  sortAt?: string;
  offset?: number;
}

type ItemMetaRow = Prisma.ItemMetaGetPayload<Record<string, never>>;
type ItemListRow = ItemMetaRow & { relevanceScore?: number; rankOffset?: number };

interface ItemPersonalizationProfile {
  sources: Record<string, number>;
  topics: Record<string, number>;
  entities: Record<string, number>;
  items: Record<string, number>;
  events: Record<string, number>;
  domains: Record<string, number>;
}

interface PersonalizedCandidateRow {
  id: string;
  createdAt: Date;
  sortAt: Date;
}

interface RankedItem {
  id: string;
  score: number;
  rankOffset: number;
}

interface ItemCandidateFeatures {
  source: string | null;
  domain: string | null;
  topics: string[];
  entities: string[];
  eventIds: string[];
}

interface TopicGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

interface TopicGroup {
  topic: string;
  count: number;
  latestAt: Date;
  items: TopicGroupItem[];
}

interface CachedTopicGroup {
  topic: string;
  count: number;
  latestAt: string;
  items: (Omit<TopicGroupItem, "createdAt"> & { createdAt: string })[];
}

interface EventGroupItem {
  processedId: string;
  itemMetaId: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  createdAt: Date;
}

interface EventGroup {
  eventId: string;
  count: number;
  latestAt: Date;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics: string[];
  entities: string[];
  items: EventGroupItem[];
}

interface CachedEventGroup {
  eventId: string;
  count: number;
  latestAt: string;
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  topics: string[];
  entities: string[];
  items: (Omit<EventGroupItem, "createdAt"> & { createdAt: string })[];
}

interface LatestProcessedItemSnapshot {
  itemMetaId: string;
  tags?: unknown;
  result?: unknown;
  sourceId?: string | null;
  duplicateOf?: Types.ObjectId | string | null;
  sortAt?: Date | null;
}

interface LatestProcessedSnapshotRecord {
  _id: Types.ObjectId;
  itemMetaId: string;
  tags?: unknown;
  result?: unknown;
  sourceId?: string | null;
  duplicateOf?: Types.ObjectId | string | null;
  sortAt?: Date | null;
  ingestedAt?: Date | null;
  createdAt?: Date | null;
}

type SearchCandidateSource =
  | "meta"
  | "processed"
  | "processedArticle"
  | "vector";

export interface RssSourceOption {
  id: string;
  name: string;
  language?: string | null;
  siteUrl: string;
  feedUrl: string;
  latestItemAt?: string | null;
  itemCountWindow: number;
}

@Injectable()
export class ItemsService {
  private readonly logger = createLogger({ name: "items-service" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly liteLlm: LiteLlmService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
    @Optional() private readonly vectorClient?: VectorClientService
  ) {
    void this._mongo; // Ensure Mongo connection provider is instantiated.
  }

  async create(orgId: string, userId: string, dto: CreateItemDto) {
    const externalId = dto.externalId;
    const existing = await this.prisma.itemMeta.findFirst({
      where: { orgId, externalId }
    });
    if (existing) {
      const mongoRef = existing.mongoRef?.trim();
      if (mongoRef) {
        return { ...existing, rawItemId: mongoRef };
      }

      const payload = this.parsePayload(dto.payload);
      const rawItem = await RawItemModel.create({ itemMetaId: existing.id, payload, source: "api" });
      const updated = await this.prisma.itemMeta.updateMany({
        where: { id: existing.id, mongoRef: "" },
        data: { mongoRef: rawItem.id }
      });
      const rawItemId = updated.count > 0 ? rawItem.id : null;
      if (!rawItemId) {
        await RawItemModel.deleteOne({ _id: rawItem.id }).catch(() => undefined);
      } else {
        try {
          await this.queueService.enqueueItem(orgId, existing.id, rawItemId);
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("already exists"))) {
            throw error;
          }
        }
      }
      return {
        ...existing,
        mongoRef: rawItemId ?? existing.mongoRef,
        rawItemId: rawItemId ?? existing.mongoRef
      };
    }

    const payload = this.parsePayload(dto.payload);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const itemMeta = await tx.itemMeta.create({
          data: {
            orgId,
            externalId,
            name: dto.name,
            status: dto.status ?? ItemStatus.Pending,
            mongoRef: ""
          }
        });

        const rawItem = await RawItemModel.create({
          itemMetaId: itemMeta.id,
          payload,
          source: "api"
        });

        await tx.itemMeta.update({
          where: { id: itemMeta.id },
          data: { mongoRef: rawItem.id }
        });

        return { itemMeta, rawItem };
      });

      void writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId: userId,
            resource: "item",
            action: "create",
            metadata: toPrismaJsonValue({ ...dto, payload })
          }
        },
        { orgId, actorId: userId, resource: "item", action: "create" }
      ).catch(() => undefined);

      await this.queueService.enqueueItem(orgId, created.itemMeta.id, created.rawItem.id);

      return {
        ...created.itemMeta,
        rawItemId: created.rawItem.id
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.prisma.itemMeta.findFirst({
          where: { orgId, externalId }
        });
        if (raced) {
          return {
            ...raced,
            rawItemId: raced.mongoRef
          };
        }
      }
      throw error;
    }
  }

  async createFromCrawlResult(orgId: string, userId: string, crawlResultId: string) {
    const normalizedId = typeof crawlResultId === "string" ? crawlResultId.trim() : "";
    if (!normalizedId) {
      throw new BadRequestException("crawlResultId is required");
    }

    const externalId = `crawlResult:${normalizedId}`;
    const crawlResult = await this.prisma.crawlResult.findFirst({
      where: {
        id: normalizedId,
        task: { orgId }
      },
      select: {
        id: true,
        taskId: true,
        sourceUrl: true,
        fetchedAt: true,
        contentHash: true,
        metadata: true,
        task: {
          select: {
            id: true,
            displayName: true,
            targetUrl: true,
            keywords: true,
            config: true
          }
        }
      }
    });

    if (!crawlResult) {
      throw new NotFoundException("Crawl result not found");
    }

    const resolvedExternalId = `crawlResult:${crawlResult.id}`;
    const existing = await this.prisma.itemMeta.findFirst({
      where: { orgId, externalId: resolvedExternalId }
    });

    if (!existing && resolvedExternalId !== externalId) {
      throw new BadRequestException("crawlResultId mismatch");
    }

    const crawlTaskConfig =
      crawlResult.task.config && typeof crawlResult.task.config === "object" && !Array.isArray(crawlResult.task.config)
        ? (crawlResult.task.config as Record<string, unknown>)
        : null;
    const itemPayloadConfig =
      crawlTaskConfig?.itemPayload && typeof crawlTaskConfig.itemPayload === "object" && !Array.isArray(crawlTaskConfig.itemPayload)
        ? (crawlTaskConfig.itemPayload as Record<string, unknown>)
        : null;
    const itemPayloadMetadata =
      itemPayloadConfig?.metadata && typeof itemPayloadConfig.metadata === "object" && !Array.isArray(itemPayloadConfig.metadata)
        ? (itemPayloadConfig.metadata as Record<string, unknown>)
        : {};
    const crawlResultMetadata =
      crawlResult.metadata && typeof crawlResult.metadata === "object" && !Array.isArray(crawlResult.metadata)
        ? (crawlResult.metadata as Record<string, unknown>)
        : {};

    const sourceNameOverrideRaw = itemPayloadConfig?.sourceName;
    const sourceNameOverride =
      typeof sourceNameOverrideRaw === "string" && sourceNameOverrideRaw.trim().length > 0
        ? sourceNameOverrideRaw.trim()
        : undefined;
    const sourceName = sourceNameOverride ?? crawlResult.task.displayName ?? undefined;
    const languageRaw = itemPayloadConfig?.language;
    const languageFromPayload =
      typeof languageRaw === "string" && languageRaw.trim().length > 0 ? languageRaw.trim() : undefined;
    const languageFromMetadataRaw = crawlResultMetadata.language ?? crawlResultMetadata.lang;
    const languageFromMetadata =
      typeof languageFromMetadataRaw === "string" && languageFromMetadataRaw.trim().length > 0
        ? languageFromMetadataRaw.trim()
        : undefined;
    const language = languageFromPayload ?? languageFromMetadata;
    const tags = this.toStringArray(itemPayloadConfig?.tags);
    const summaryHints = this.toStringArray(itemPayloadConfig?.summaryHints);
    const forceRefresh = false;

    const pipelineJobIdRaw = crawlTaskConfig?.pipelineJobId;
    const pipelineJobId =
      typeof pipelineJobIdRaw === "string" && pipelineJobIdRaw.trim().length > 0
        ? pipelineJobIdRaw.trim()
        : undefined;
    const sourceIdRaw = itemPayloadMetadata?.sourceId;
    const sourceId =
      typeof sourceIdRaw === "string" && sourceIdRaw.trim().length > 0 ? sourceIdRaw.trim() : undefined;
    const priorityRaw = crawlTaskConfig?.pipelinePriority;
    const pipelinePriority =
      typeof priorityRaw === "number" && Number.isFinite(priorityRaw) ? Math.round(priorityRaw) : undefined;

    const crawlKeywords = this.toStringArray(crawlResult.task.keywords);
    const payload: Record<string, unknown> = {
      url: crawlResult.sourceUrl,
      ...(sourceName ? { sourceName } : {}),
      ...(language ? { language } : {}),
      keywords: crawlKeywords,
      tags,
      summaryHints,
      metadata: {
        ...itemPayloadMetadata,
        ...crawlResultMetadata,
        crawlTaskId: crawlResult.taskId,
        ...(crawlResult.task.displayName ? { crawlTaskDisplayName: crawlResult.task.displayName } : {}),
        ...(crawlResult.task.targetUrl ? { crawlTaskTargetUrl: crawlResult.task.targetUrl } : {}),
        crawlResultId: crawlResult.id,
        crawlFetchedAt: crawlResult.fetchedAt.toISOString(),
        crawlContentHash: crawlResult.contentHash
      },
      forceRefresh
    };

    const existingMongoRef = existing?.mongoRef ? existing.mongoRef.trim() : "";
    if (existing && existingMongoRef) {
      const shouldEnqueue =
        existing.status === ItemStatus.Pending ||
        existing.status === ItemStatus.Processing ||
        existing.status === ItemStatus.Failed;
      if (shouldEnqueue) {
        try {
          await this.queueService.enqueueItem(
            orgId,
            existing.id,
            existingMongoRef,
            pipelinePriority !== undefined ? { priority: pipelinePriority } : {},
            { pipelineJobId, sourceId }
          );
        } catch (error) {
          if (!(error instanceof Error && error.message.includes("already exists"))) {
            throw error;
          }
        }
      }
      return existing;
    }

    if (existing) {
      const rawItem = await RawItemModel.create({
        itemMetaId: existing.id,
        payload: this.parsePayload(payload),
        source: "crawl-task"
      });
      const updated = await this.prisma.itemMeta.updateMany({
        where: { id: existing.id, mongoRef: "" },
        data: { mongoRef: rawItem.id }
      });
      if (updated.count === 0) {
        await RawItemModel.deleteOne({ _id: rawItem.id }).catch(() => undefined);
        return existing;
      }
      try {
        await this.queueService.enqueueItem(
          orgId,
          existing.id,
          rawItem.id,
          pipelinePriority !== undefined ? { priority: pipelinePriority } : {},
          { pipelineJobId, sourceId }
        );
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already exists"))) {
          throw error;
        }
      }
      return existing;
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const baseName = sourceName
          ? `${sourceName}: ${crawlResult.sourceUrl}`
          : crawlResult.sourceUrl;

        const itemMeta = await tx.itemMeta.create({
          data: {
            orgId,
            externalId: resolvedExternalId,
            name: this.toItemMetaName(baseName),
            status: ItemStatus.Pending,
            mongoRef: ""
          }
        });

        const rawItem = await RawItemModel.create({
          itemMetaId: itemMeta.id,
          payload: this.parsePayload(payload),
          source: "crawl-task"
        });

        await tx.itemMeta.update({
          where: { id: itemMeta.id },
          data: { mongoRef: rawItem.id }
        });

        return { itemMeta, rawItem };
      });

      void writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId: userId,
            resource: "item",
            action: "createFromCrawlResult",
            metadata: toPrismaJsonValue({
              crawlTaskId: crawlResult.taskId,
              crawlResultId: crawlResult.id,
              sourceUrl: crawlResult.sourceUrl
            })
          }
        },
        { orgId, actorId: userId, resource: "item", action: "createFromCrawlResult" }
      ).catch(() => undefined);

      try {
        await this.queueService.enqueueItem(
          orgId,
          created.itemMeta.id,
          created.rawItem.id,
          pipelinePriority !== undefined ? { priority: pipelinePriority } : {},
          { pipelineJobId, sourceId }
        );
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("already exists"))) {
          throw error;
        }
      }

      return created.itemMeta;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.prisma.itemMeta.findFirst({
          where: { orgId, externalId }
        });
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
  }

  async list(
    orgId: string,
    page = 1,
    pageSize = 10,
    search?: string,
    filters?: ItemFilters,
    orderBy: ItemsOrderBy = "CREATED_DESC",
    rankingMode: ItemsRankingMode = "RECENCY",
    userId?: string,
  ) {
    const normalizedPageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 10;
    const take = Math.min(Math.max(normalizedPageSize, 1), MAX_CURSOR_PAGE_SIZE);
    const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
    const safePage = Math.max(normalizedPage, 1);
    const skip = (safePage - 1) * take;
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    const effectiveRankingMode = this.resolveRankingMode(rankingMode, normalizedSearch);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: safePage,
        pageSize: take
      };
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;

    if (effectiveRankingMode === "RELEVANCE" && normalizedSearch && scopedIds) {
      return this.listByRelevanceWithPage({
        orgId,
        search: normalizedSearch,
        scopedIds,
        page: safePage,
        pageSize: take
      });
    }

    if (orderBy === "PERSONALIZED" && userId) {
      return this.listPersonalizedWithPage({
        orgId,
        userId,
        where,
        page: safePage,
        pageSize: take,
      });
    }

    const effectiveOrderBy = orderBy === "PERSONALIZED" ? "CREATED_DESC" : orderBy;
    const orderField = effectiveOrderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";
    const orderByClause: Prisma.ItemMetaOrderByWithRelationInput[] =
      orderField === "sortAt"
        ? [{ sortAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

    const [items, total] = await Promise.all([
      this.prisma.itemMeta.findMany({
        where,
        skip,
        take,
        orderBy: orderByClause
      }),
      this.prisma.itemMeta.count({ where })
    ]);

    return {
      items,
      total,
      page: safePage,
      pageSize: take
    };
  }

  async listWithCursor(
    orgId: string,
    first = 10,
    cursor?: ItemsCursorPayload,
    search?: string,
    filters?: ItemFilters,
    orderBy: ItemsOrderBy = "CREATED_DESC",
    rankingMode: ItemsRankingMode = "RECENCY",
    userId?: string,
  ) {
    const take = Math.min(Math.max(first, 1), MAX_CURSOR_PAGE_SIZE);
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    const effectiveRankingMode = this.resolveRankingMode(rankingMode, normalizedSearch);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: 0
      };
    }

    if (effectiveRankingMode === "RELEVANCE" && normalizedSearch && scopedIds) {
      return this.listByRelevanceWithCursor({
        orgId,
        search: normalizedSearch,
        scopedIds,
        first: take,
        cursor
      });
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const whereBase = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;

    if (orderBy === "PERSONALIZED" && userId) {
      return this.listPersonalizedWithCursor({
        orgId,
        userId,
        where: whereBase,
        first: take,
        cursor,
      });
    }

    const effectiveOrderBy = orderBy === "PERSONALIZED" ? "CREATED_DESC" : orderBy;

    const cursorId = cursor?.id;
    if (scopedIds) {
      const scopedSet = new Set(scopedIds);
      if (cursorId && !scopedSet.has(cursorId)) {
        return {
          items: [],
          hasNextPage: false,
          totalCount: scopedIds.length
        };
      }
    }

    const orderField = effectiveOrderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";

    let cursorTimestamp: Date | null = null;
    if (cursorId) {
      const timestampString = orderField === "sortAt" ? cursor?.sortAt : cursor?.createdAt;
      if (timestampString) {
        const parsed = new Date(timestampString);
        if (Number.isFinite(parsed.valueOf())) {
          cursorTimestamp = parsed;
        }
      }

      if (!cursorTimestamp) {
        const cursorRow = await this.prisma.itemMeta.findFirst({
          where: { id: cursorId, orgId },
          select: { createdAt: true, sortAt: true }
        });
        if (!cursorRow) {
          return {
            items: [],
            hasNextPage: false,
            totalCount: scopedIds?.length ?? 0
          };
        }
        cursorTimestamp = orderField === "sortAt" ? cursorRow.sortAt : cursorRow.createdAt;
      }
    }

    const paginationWhere =
      cursorTimestamp && cursorId
        ? orderField === "sortAt"
          ? {
              OR: [
                { sortAt: { lt: cursorTimestamp } },
                { sortAt: cursorTimestamp, id: { lt: cursorId } }
              ]
            }
          : {
              OR: [
                { createdAt: { lt: cursorTimestamp } },
                { createdAt: cursorTimestamp, id: { lt: cursorId } }
              ]
            }
        : undefined;

    const where = paginationWhere ? { AND: [whereBase, paginationWhere] } : whereBase;

    const orderByClause: Prisma.ItemMetaOrderByWithRelationInput[] =
      orderField === "sortAt"
        ? [{ sortAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

    const items = await this.prisma.itemMeta.findMany({
      where,
      orderBy: orderByClause,
      take: take + 1
    });

    const hasNextPage = items.length > take;
    const totalCount = await this.prisma.itemMeta.count({ where: whereBase });

    return {
      items: items.slice(0, take),
      hasNextPage,
      totalCount
    };
  }

  private async listPersonalizedWithPage(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    page: number;
    pageSize: number;
  }) {
    const offset = Math.max(0, (input.page - 1) * input.pageSize);
    const { total, ranked } = await this.getPersonalizedRanking({
      orgId: input.orgId,
      userId: input.userId,
      where: input.where,
      requiredCount: offset + input.pageSize,
    });
    if (total <= 0 || ranked.length <= offset) {
      return {
        items: [],
        total,
        page: input.page,
        pageSize: input.pageSize,
      };
    }

    const picked = ranked.slice(offset, offset + input.pageSize);
    const rows = await this.prisma.itemMeta.findMany({
      where: {
        orgId: input.orgId,
        id: { in: picked.map((entry) => entry.id) },
      },
    });
    const rowById = new Map(rows.map((row) => [row.id, row] as const));

    const items: ItemListRow[] = [];
    for (const entry of picked) {
      const row = rowById.get(entry.id);
      if (!row) {
        continue;
      }
      items.push({
        ...row,
        rankOffset: entry.rankOffset,
      });
    }

    return {
      items,
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  private async listPersonalizedWithCursor(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    first: number;
    cursor?: ItemsCursorPayload;
  }) {
    let offset =
      typeof input.cursor?.offset === "number" &&
      Number.isFinite(input.cursor.offset) &&
      input.cursor.offset >= 0
        ? Math.floor(input.cursor.offset) + 1
        : 0;
    const { total, ranked } = await this.getPersonalizedRanking({
      orgId: input.orgId,
      userId: input.userId,
      where: input.where,
      requiredCount: offset + input.first + 1,
    });

    if (
      offset <= 0 &&
      input.cursor?.id &&
      typeof input.cursor.id === "string" &&
      input.cursor.id.trim().length > 0
    ) {
      const cursorIndex = ranked.findIndex((entry) => entry.id === input.cursor?.id);
      if (cursorIndex >= 0) {
        offset = cursorIndex + 1;
      }
    }

    if (total <= 0 || ranked.length <= offset) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: total,
      };
    }

    const window = ranked.slice(offset, offset + input.first + 1);
    const hasNextPage = window.length > input.first || offset + input.first < total;
    const picked = hasNextPage ? window.slice(0, input.first) : window;

    const rows = await this.prisma.itemMeta.findMany({
      where: {
        orgId: input.orgId,
        id: { in: picked.map((entry) => entry.id) },
      },
    });
    const rowById = new Map(rows.map((row) => [row.id, row] as const));

    const items: ItemListRow[] = [];
    for (const entry of picked) {
      const row = rowById.get(entry.id);
      if (!row) {
        continue;
      }
      items.push({
        ...row,
        rankOffset: entry.rankOffset,
      });
    }

    return {
      items,
      hasNextPage,
      totalCount: total,
    };
  }

  private async getPersonalizedRanking(input: {
    orgId: string;
    userId: string;
    where: Prisma.ItemMetaWhereInput;
    requiredCount: number;
  }): Promise<{ total: number; ranked: RankedItem[] }> {
    const rawTotal = await this.prisma.itemMeta.count({ where: input.where });
    if (rawTotal <= 0) {
      return { total: 0, ranked: [] };
    }
    const total = Math.min(rawTotal, PERSONALIZED_CANDIDATE_MAX);
    const targetCount = Math.min(Math.max(input.requiredCount, 1), total);

    let candidateTake = Math.min(
      PERSONALIZED_CANDIDATE_MAX,
      Math.max(
        PERSONALIZED_CANDIDATE_MIN,
        Math.floor(input.requiredCount * PERSONALIZED_CANDIDATE_MULTIPLIER),
      ),
    );
    const profile = await this.loadItemPersonalizationProfile(input.orgId, input.userId);
    let ranked: RankedItem[] = [];

    while (true) {
      const candidates = await this.prisma.itemMeta.findMany({
        where: input.where,
        select: {
          id: true,
          createdAt: true,
          sortAt: true,
        },
        orderBy: [{ sortAt: "desc" }, { id: "desc" }],
        take: candidateTake,
      });

      const normalizedCandidates: PersonalizedCandidateRow[] = candidates.map((candidate) => ({
        id: candidate.id,
        createdAt: candidate.createdAt,
        sortAt: candidate.sortAt ?? candidate.createdAt,
      }));
      ranked = await this.rankPersonalizedCandidates({
        orgId: input.orgId,
        candidates: normalizedCandidates,
        profile,
      });

      if (
        ranked.length >= targetCount ||
        candidates.length >= total ||
        candidateTake >= PERSONALIZED_CANDIDATE_MAX
      ) {
        break;
      }
      candidateTake = Math.min(PERSONALIZED_CANDIDATE_MAX, candidateTake * 2);
    }

    return { total, ranked };
  }

  private async rankPersonalizedCandidates(input: {
    orgId: string;
    candidates: PersonalizedCandidateRow[];
    profile: ItemPersonalizationProfile;
  }): Promise<RankedItem[]> {
    const profileEnabled =
      Object.keys(input.profile.sources).length > 0 ||
      Object.keys(input.profile.topics).length > 0 ||
      Object.keys(input.profile.entities).length > 0 ||
      Object.keys(input.profile.items).length > 0 ||
      Object.keys(input.profile.events).length > 0 ||
      Object.keys(input.profile.domains).length > 0;
    if (input.candidates.length === 0) {
      return [];
    }

    const candidateIds = input.candidates.map((candidate) => candidate.id);
    const featuresById = await this.loadCandidateFeatures(input.orgId, candidateIds);
    const sortAtById = new Map(
      input.candidates.map((candidate) => [candidate.id, candidate.sortAt.getTime()] as const),
    );
    const nowMs = Date.now();

    const ranked = input.candidates
      .map((candidate) => {
        const feature = featuresById.get(candidate.id);
        const ageHours = Math.max(0, (nowMs - candidate.sortAt.getTime()) / (1000 * 60 * 60));
        const recencyScore = 1 / (1 + ageHours / 36);
        if (!profileEnabled) {
          return {
            id: candidate.id,
            score: recencyScore,
          };
        }

        const sourceScore = this.resolveSourcePreferenceScore(
          feature,
          input.profile.sources,
        );
        const topicScore = this.sumPreferenceScore(
          feature?.topics ?? [],
          input.profile.topics,
          6,
        );
        const entityScore = this.sumPreferenceScore(
          feature?.entities ?? [],
          input.profile.entities,
          6,
        );
        const itemPreferenceId = this.normalizeBehaviorId(candidate.id);
        const itemScore = itemPreferenceId
          ? (input.profile.items[itemPreferenceId] ?? 0)
          : 0;
        const eventScore = this.sumPreferenceScore(
          feature?.eventIds ?? [],
          input.profile.events,
          4,
        );
        const domainScore = feature?.domain
          ? (input.profile.domains[feature.domain] ?? 0)
          : 0;
        const behaviorRaw =
          sourceScore * 1.15 +
          topicScore +
          entityScore * 0.9 +
          itemScore * 1.45 +
          eventScore * 1.2 +
          domainScore * 0.75;
        const behaviorScore = Math.log1p(Math.max(0, behaviorRaw));
        return {
          id: candidate.id,
          score: behaviorScore * 0.78 + recencyScore * 0.22,
        };
      })
      .sort((a, b) => {
        if (Math.abs(b.score - a.score) > 0.0001) {
          return b.score - a.score;
        }
        const leftSort = sortAtById.get(a.id) ?? 0;
        const rightSort = sortAtById.get(b.id) ?? 0;
        if (rightSort !== leftSort) {
          return rightSort - leftSort;
        }
        return a.id.localeCompare(b.id);
      });

    return ranked.map((entry, index) => ({
      id: entry.id,
      score: entry.score,
      rankOffset: index,
    }));
  }

  private async loadCandidateFeatures(orgId: string, itemMetaIds: string[]) {
    if (itemMetaIds.length === 0) {
      return new Map<string, ItemCandidateFeatures>();
    }

    const [docs, rawDocs] = await Promise.all([
      ProcessedItemModel.aggregate<{
        _id: string;
        itemMetaId?: string;
        sourceId?: string | null;
        source?: string | null;
        result?: unknown;
        processedItemIds?: string[];
      }>([
        {
          $match: {
            orgId,
            status: PipelineStageStatus.Completed,
            itemMetaId: { $in: itemMetaIds },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$itemMetaId",
            itemMetaId: { $first: "$itemMetaId" },
            sourceId: { $first: "$sourceId" },
            source: { $first: "$source" },
            result: { $first: "$result" },
            processedItemIds: { $push: { $toString: "$_id" } },
          },
        },
        {
          $project: {
            _id: 1,
            itemMetaId: 1,
            sourceId: 1,
            source: 1,
            result: 1,
            processedItemIds: { $slice: ["$processedItemIds", 12] },
          },
        },
      ]),
      RawItemModel.aggregate<{
        _id: string;
        itemMetaId?: string;
        url?: string | null;
      }>([
        {
          $match: {
            itemMetaId: { $in: itemMetaIds },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$itemMetaId",
            itemMetaId: { $first: "$itemMetaId" },
            url: { $first: "$payload.url" },
          },
        },
      ]),
    ]);

    const out = new Map<string, ItemCandidateFeatures>();
    const processedItemIdsByMetaId = new Map<string, string[]>();
    const processedItemIdsForEvents = new Set<string>();

    for (const doc of docs) {
      const itemMetaId =
        typeof doc.itemMetaId === "string" && doc.itemMetaId.trim().length > 0
          ? doc.itemMetaId.trim()
          : typeof doc._id === "string" && doc._id.trim().length > 0
            ? doc._id.trim()
            : "";
      if (!itemMetaId) {
        continue;
      }
      const result =
        doc.result && typeof doc.result === "object" && !Array.isArray(doc.result)
          ? (doc.result as Record<string, unknown>)
          : {};
      const sourceCandidate =
        typeof doc.sourceId === "string" && doc.sourceId.trim().length > 0
          ? doc.sourceId
          : typeof doc.source === "string" && doc.source.trim().length > 0
          ? doc.source
          : typeof result.source === "string"
            ? result.source
            : undefined;
      const processedItemIds = Array.from(
        new Set(
          (Array.isArray(doc.processedItemIds) ? doc.processedItemIds : [])
            .map((value) => this.normalizeBehaviorId(value))
            .filter((value): value is string => Boolean(value)),
        ),
      ).slice(0, 12);
      if (processedItemIds.length > 0) {
        processedItemIdsByMetaId.set(itemMetaId, processedItemIds);
        for (const processedItemId of processedItemIds) {
          processedItemIdsForEvents.add(processedItemId);
        }
      }
      out.set(itemMetaId, {
        source: this.normalizePreferenceKey(sourceCandidate),
        domain: null,
        topics: this.normalizePreferenceTerms(result.topics),
        entities: this.normalizePreferenceTerms(result.entities),
        eventIds: [],
      });
    }

    for (const rawDoc of rawDocs) {
      const itemMetaId =
        typeof rawDoc.itemMetaId === "string" && rawDoc.itemMetaId.trim().length > 0
          ? rawDoc.itemMetaId.trim()
          : typeof rawDoc._id === "string" && rawDoc._id.trim().length > 0
            ? rawDoc._id.trim()
            : "";
      if (!itemMetaId) {
        continue;
      }
      const domain = this.normalizePreferenceDomain(rawDoc.url ?? undefined);
      if (!domain) {
        continue;
      }
      const existing = out.get(itemMetaId);
      if (existing) {
        if (!existing.domain) {
          existing.domain = domain;
        }
        continue;
      }
      out.set(itemMetaId, {
        source: null,
        domain,
        topics: [],
        entities: [],
        eventIds: [],
      });
    }

    if (processedItemIdsForEvents.size > 0) {
      const eventRows = await this.prisma.newsEventItem.findMany({
        where: {
          orgId,
          processedItemId: { in: Array.from(processedItemIdsForEvents) },
        },
        select: { processedItemId: true, eventId: true },
        orderBy: { createdAt: "desc" },
      });

      const eventIdsByProcessedItemId = new Map<string, string[]>();
      for (const row of eventRows) {
        const processedItemId = this.normalizeBehaviorId(row.processedItemId);
        const eventId = this.normalizeBehaviorId(row.eventId);
        if (!processedItemId || !eventId) {
          continue;
        }
        const bucket = eventIdsByProcessedItemId.get(processedItemId) ?? [];
        if (!bucket.includes(eventId)) {
          bucket.push(eventId);
        }
        if (bucket.length > 8) {
          bucket.length = 8;
        }
        eventIdsByProcessedItemId.set(processedItemId, bucket);
      }

      for (const [itemMetaId, processedItemIds] of processedItemIdsByMetaId.entries()) {
        const eventIdSet = new Set<string>();
        for (const processedItemId of processedItemIds) {
          const eventIds = eventIdsByProcessedItemId.get(processedItemId) ?? [];
          for (const eventId of eventIds) {
            eventIdSet.add(eventId);
            if (eventIdSet.size >= 8) {
              break;
            }
          }
          if (eventIdSet.size >= 8) {
            break;
          }
        }
        const feature =
          out.get(itemMetaId) ??
          ({
            source: null,
            domain: null,
            topics: [],
            entities: [],
            eventIds: [],
          } as ItemCandidateFeatures);
        feature.eventIds = Array.from(eventIdSet);
        out.set(itemMetaId, feature);
      }
    }

    return out;
  }

  private async loadItemPersonalizationProfile(
    orgId: string,
    userId: string,
  ): Promise<ItemPersonalizationProfile> {
    const [sourcesRaw, topicsRaw, entitiesRaw, itemsRaw, eventsRaw, domainsRaw] =
      await Promise.all([
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "sources" }),
        ),
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "topics" }),
        ),
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "entities" }),
        ),
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "items" }),
        ),
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "events" }),
        ),
        this.cache.hgetall(
          buildUserNewsBehaviorHashKey({ orgId, userId, kind: "domains" }),
        ),
      ]);

    return {
      sources: this.parseBehaviorScores(sourcesRaw),
      topics: this.parseBehaviorScores(topicsRaw),
      entities: this.parseBehaviorScores(entitiesRaw),
      items: this.parseBehaviorScores(itemsRaw, (value) =>
        this.normalizeBehaviorId(value),
      ),
      events: this.parseBehaviorScores(eventsRaw, (value) =>
        this.normalizeBehaviorId(value),
      ),
      domains: this.parseBehaviorScores(domainsRaw),
    };
  }

  private parseBehaviorScores(
    raw: Record<string, string>,
    normalizeKey: (value?: string) => string | null = (value) =>
      this.normalizePreferenceKey(value),
  ): Record<string, number> {
    const entries = Object.entries(raw ?? {})
      .map(([term, value]) => {
        const normalized = normalizeKey(term);
        if (!normalized) {
          return null;
        }
        const score = Number(value);
        if (!Number.isFinite(score) || score <= 0) {
          return null;
        }
        return [normalized, score] as const;
      })
      .filter((entry): entry is readonly [string, number] => Boolean(entry))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 400);
    return Object.fromEntries(entries);
  }

  private normalizePreferenceTerms(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const terms: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      let raw: string | undefined;
      if (typeof entry === "string") {
        raw = entry;
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        raw =
          typeof record.name === "string"
            ? record.name
            : typeof record.label === "string"
              ? record.label
              : typeof record.value === "string"
                ? record.value
                : undefined;
      }
      const normalized = this.normalizePreferenceKey(raw);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      terms.push(normalized);
      if (terms.length >= 10) {
        break;
      }
    }
    return terms;
  }

  private normalizePreferenceKey(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 96);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBehaviorId(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().slice(0, 128);
    return normalized.length > 0 ? normalized : null;
  }

  private normalizePreferenceDomain(value?: string | null): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const raw = value.trim();
    if (!raw) {
      return null;
    }
    const parseCandidate = (candidate: string): string | null => {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase().replace(/^www\./, "");
        return this.normalizePreferenceKey(hostname);
      } catch {
        return null;
      }
    };

    return parseCandidate(raw) ?? parseCandidate(`https://${raw}`);
  }

  private sumPreferenceScore(
    terms: string[],
    profile: Record<string, number>,
    limit: number,
  ): number {
    if (!terms.length) {
      return 0;
    }
    let score = 0;
    let consumed = 0;
    const seen = new Set<string>();
    for (const term of terms) {
      if (seen.has(term)) {
        continue;
      }
      seen.add(term);
      const value = profile[term];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        score += value;
      }
      consumed += 1;
      if (consumed >= limit) {
        break;
      }
    }
    return score;
  }

  private resolveSourcePreferenceScore(
    feature: ItemCandidateFeatures | undefined,
    profile: Record<string, number>,
  ): number {
    let score = 0;
    if (feature?.source) {
      const sourceScore = profile[feature.source];
      if (
        typeof sourceScore === "number" &&
        Number.isFinite(sourceScore) &&
        sourceScore > score
      ) {
        score = sourceScore;
      }
    }
    if (feature?.domain) {
      const domainScore = profile[feature.domain];
      if (
        typeof domainScore === "number" &&
        Number.isFinite(domainScore) &&
        domainScore > score
      ) {
        score = domainScore;
      }
    }
    return score;
  }

  private buildProcessedSortAtExpression() {
    return {
      $ifNull: [
        "$sortAt",
        {
          $dateFromString: {
            dateString: { $ifNull: ["$result.published_at", null] },
            onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
            onNull: { $ifNull: ["$ingestedAt", "$createdAt"] },
          },
        },
      ],
    };
  }

  private resolveProcessedSortAt(record: {
    sortAt?: Date | string | null;
    ingestedAt?: Date | string | null;
    createdAt?: Date | string | null;
    result?: unknown;
  }): Date | null {
    const directSortAt = this.asDate(record.sortAt);
    if (directSortAt) {
      return directSortAt;
    }

    const result =
      record.result && typeof record.result === "object" && !Array.isArray(record.result)
        ? (record.result as Record<string, unknown>)
        : null;
    const publishedAt = this.asDate(result?.published_at ?? null);
    if (publishedAt) {
      return publishedAt;
    }

    return this.asDate(record.ingestedAt) ?? this.asDate(record.createdAt);
  }

  private asDate(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return null;
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

    while (true) {
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
        .lean()) as unknown as LatestProcessedSnapshotRecord[];

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
          sortAt: this.resolveProcessedSortAt(record),
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

  private dedupeItemMetaIds(ids: string[]): string[] {
    return Array.from(
      new Set(
        ids
          .map((id) => (typeof id === "string" ? id.trim() : ""))
          .filter((id): id is string => id.length > 0),
      ),
    );
  }

  private rankSearchCandidateIds(
    sources: Partial<Record<SearchCandidateSource, string[]>>,
  ): string[] {
    const weights: Record<SearchCandidateSource, number> = {
      meta: 1.3,
      processed: 1.15,
      processedArticle: 1.05,
      vector: 1.45,
    };
    const scoreById = new Map<
      string,
      { score: number; bestRank: number; sourceCount: number }
    >();

    (Object.entries(sources) as [SearchCandidateSource, string[] | undefined][])
      .forEach(([source, ids]) => {
        const uniqueIds = this.dedupeItemMetaIds(ids ?? []);
        uniqueIds.forEach((id, index) => {
          const rankScore = weights[source] / (1 + index / 20);
          const current = scoreById.get(id);
          if (!current) {
            scoreById.set(id, {
              score: rankScore,
              bestRank: index,
              sourceCount: 1,
            });
            return;
          }
          current.score += rankScore;
          current.sourceCount += 1;
          current.bestRank = Math.min(current.bestRank, index);
        });
      });

    return Array.from(scoreById.entries())
      .map(([id, entry]) => ({
        id,
        score: entry.score + Math.max(0, entry.sourceCount - 1) * 0.2,
        bestRank: entry.bestRank,
      }))
      .sort((left, right) => {
        if (Math.abs(right.score - left.score) > 1e-9) {
          return right.score - left.score;
        }
        if (left.bestRank !== right.bestRank) {
          return left.bestRank - right.bestRank;
        }
        return left.id.localeCompare(right.id);
      })
      .map((entry) => entry.id);
  }

  async getFacets(orgId: string, search?: string, filters?: ItemFilters) {
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    if (scopedIds && scopedIds.length === 0) {
      return { regions: [], topics: [], sentiments: [], contentTypes: [] };
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
      const result = this.normalizeResultRecord(record.result);
      const regionValue =
        this.pickResultString(result, ["location", "region"]) ?? null;
      if (regionValue) {
        this.incrementFacetCount(regionCounts, regionValue);
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
      topicSet.forEach((topic) => this.incrementFacetCount(topicCounts, topic));

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
          this.incrementFacetCount(sentimentCounts, sentiment);
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
        this.incrementFacetCount(contentTypeCounts, contentType);
      }
    }

    return {
      regions: this.buildFacetOptions(regionCounts),
      topics: this.buildFacetOptions(topicCounts),
      sentiments: this.buildFacetOptions(sentimentCounts),
      contentTypes: this.buildFacetOptions(contentTypeCounts)
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
    type SuggestionEntry = {
      type: SuggestionType;
      value: string;
      score: number;
      hits: number;
      lexicalScore: number;
      semanticScore: number;
    };

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
          this.resolveSourceSuggestionCounts(orgId, normalizedPrefix),
          this.resolveSemanticSuggestions(orgId, trimmedPrefix, semanticLimit)
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

  async get(orgId: string, id: string) {
    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id, orgId }
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }

    const rawItem = itemMeta.mongoRef ? await RawItemModel.findById(itemMeta.mongoRef).lean() : null;
    const processed = await ProcessedItemModel.findOne({ itemMetaId: itemMeta.id })
      .sort({ createdAt: -1 })
      .lean();

    return {
      itemMeta,
      rawItem,
      processed
    };
  }

  async update(orgId: string, userId: string, dto: UpdateItemDto) {
    const existing = await this.prisma.itemMeta.findFirst({
      where: { id: dto.id, orgId }
    });

    if (!existing) {
      throw new NotFoundException("Item not found");
    }

    const normalizedPayload = dto.payload ? this.parsePayload(dto.payload) : undefined;
    let enqueueRef: string | null = null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const updatedMeta = await tx.itemMeta.update({
        where: { id: existing.id },
        data: {
          name: dto.name ?? existing.name,
          status: dto.status ?? existing.status
        }
      });

      let newRawRef = existing.mongoRef;
      if (normalizedPayload) {
        const raw = await RawItemModel.create({
          itemMetaId: existing.id,
          payload: normalizedPayload,
          source: "graphql"
        });
        newRawRef = raw.id;
        await tx.itemMeta.update({
          where: { id: existing.id },
          data: { mongoRef: raw.id }
        });
        enqueueRef = raw.id;
      }

      return {
        ...updatedMeta,
        mongoRef: newRawRef
      };
    });

    if (enqueueRef) {
      await this.queueService.enqueueItem(orgId, existing.id, enqueueRef);
    }

	    void writeAuditLogBestEffort(
	      this.prisma,
	      {
	        data: {
	          orgId,
	          actorId: userId,
	          resource: "item",
	          action: "update",
	          metadata: toPrismaJsonValue(normalizedPayload ? { ...dto, payload: normalizedPayload } : dto)
	        }
	      },
	      { orgId, actorId: userId, resource: "item", action: "update" }
	    ).catch(() => undefined);

    return updated;
  }

  async listTopicGroups(
    orgId: string,
    options?: { limit?: number; itemsPerGroup?: number; windowDays?: number }
  ): Promise<TopicGroup[]> {
    const normalizedLimit = Math.min(
      Math.max(options?.limit ?? 12, 1),
      MAX_TOPIC_GROUPS
    );
    const normalizedItems = Math.min(
      Math.max(options?.itemsPerGroup ?? 5, 1),
      MAX_TOPIC_ITEMS
    );
    const windowDays = Math.min(
      Math.max(options?.windowDays ?? DEFAULT_TOPIC_WINDOW_DAYS, 1),
      DEFAULT_TOPIC_WINDOW_DAYS * 6
    );
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const cacheKey = `items:topic-groups:${orgId}:${normalizedLimit}:${normalizedItems}:${windowDays}`;
    const cached = await this.cache.get<CachedTopicGroup[]>(cacheKey);
    if (cached && Array.isArray(cached)) {
      if (cached.length === 0) {
        return [];
      }
      const parsed = cached
        .map((group) => {
          const latestAt = new Date(group.latestAt);
          if (!Number.isFinite(latestAt.valueOf())) {
            return null;
          }
          return {
            topic: group.topic,
            count: group.count,
            latestAt,
            items: group.items.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt)
            }))
          };
        })
        .filter((group): group is TopicGroup => Boolean(group));
      if (parsed.length > 0) {
        return parsed;
      }
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: 'completed',
          'result.topics.0': { $exists: true }
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
          result: 1
        }
      },
      {
        $addFields: {
          ingestedAt: {
            $ifNull: ["$ingestedAt", "$createdAt"]
          },
          sortAt: {
            $ifNull: [
              "$sortAt",
              {
                $convert: {
                  input: "$result.published_at",
                  to: "date",
                  onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
                  onNull: { $ifNull: ["$ingestedAt", "$createdAt"] }
                }
              }
            ]
          }
        }
      },
      {
        $match: {
          sortAt: { $gte: since }
        }
      },
      {
        $unwind: '$result.topics'
      },
      {
        $match: {
          'result.topics': { $nin: [null, ''] }
        }
      },
      {
        $sort: { sortAt: -1 }
      },
      {
        $group: {
          _id: '$result.topics',
          count: { $sum: 1 },
          latestAt: { $first: '$sortAt' },
          items: {
            $push: {
              processedId: '$_id',
              itemMetaId: '$itemMetaId',
              title: '$result.title',
              summary: '$result.summary',
              source: '$result.source',
              publishedAt: '$result.published_at',
              createdAt: '$ingestedAt'
            }
          }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          latestAt: 1,
          items: { $slice: ['$items', normalizedItems] }
        }
      },
      {
        $sort: { latestAt: -1, count: -1 }
      },
      {
        $limit: normalizedLimit
      }
    ];

    const groups = await ProcessedItemModel.aggregate<{
      _id: string;
      count: number;
      latestAt: Date;
      items: {
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }[];
    }>(pipeline);

    const mapped = groups.map((group) => ({
      topic: group._id,
      count: group.count,
      latestAt: group.latestAt,
      items: group.items.map((item) => ({
        processedId: item.processedId.toString(),
        itemMetaId: item.itemMetaId,
        title: item.title ?? undefined,
        summary: item.summary ?? undefined,
        source: item.source ?? undefined,
        publishedAt: item.publishedAt ?? undefined,
        createdAt: item.createdAt
      }))
    }));

    const cachePayload: CachedTopicGroup[] = mapped.map((group) => ({
      topic: group.topic,
      count: group.count,
      latestAt: group.latestAt.toISOString(),
      items: group.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString()
      }))
    }));
    await this.cache.set(cacheKey, cachePayload, TOPIC_GROUPS_CACHE_TTL_SECONDS);

    return mapped;
  }

  async listEventGroups(
    orgId: string,
    options?: { limit?: number; itemsPerGroup?: number; windowDays?: number; minGroupSize?: number }
  ): Promise<EventGroup[]> {
    const normalizedLimit = Math.min(
      Math.max(options?.limit ?? 12, 1),
      MAX_EVENT_GROUPS
    );
    const normalizedItems = Math.min(
      Math.max(options?.itemsPerGroup ?? 5, 1),
      MAX_EVENT_ITEMS
    );
    const windowDays = Math.min(
      Math.max(options?.windowDays ?? DEFAULT_EVENT_WINDOW_DAYS, 1),
      DEFAULT_EVENT_WINDOW_DAYS * 6
    );
    const minGroupSize = Math.min(
      Math.max(options?.minGroupSize ?? DEFAULT_EVENT_MIN_GROUP_SIZE, 1),
      50
    );
    const since = new Date(Date.now() - windowDays * DAY_MS);

    const cacheKey = `items:event-groups:${orgId}:${normalizedLimit}:${normalizedItems}:${windowDays}:${minGroupSize}`;
    const cached = await this.cache.get<CachedEventGroup[]>(cacheKey);
    if (cached && Array.isArray(cached)) {
      if (cached.length === 0) {
        return [];
      }
      const parsed = cached
        .map((group) => {
          const latestAt = new Date(group.latestAt);
          if (!Number.isFinite(latestAt.valueOf())) {
            return null;
          }
          return {
            ...group,
            latestAt,
            items: group.items.map((item) => ({
              ...item,
              createdAt: new Date(item.createdAt)
            }))
          };
        })
        .filter((group): group is EventGroup => Boolean(group));
      if (parsed.length > 0) {
        return parsed;
      }
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
        }
      },
      {
        $project: {
          itemMetaId: 1,
          createdAt: 1,
          ingestedAt: 1,
          sortAt: 1,
          duplicateOf: 1,
          result: 1
        }
      },
      {
        $addFields: {
          primaryTopic: {
            $arrayElemAt: [{ $ifNull: ["$result.topics", []] }, 0]
          },
          primaryEntity: {
            $arrayElemAt: [
              {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$result.entities", []] },
                      as: "entity",
                      cond: {
                        $and: [
                          { $ne: ["$$entity.name", null] },
                          { $ne: ["$$entity.name", ""] }
                        ]
                      }
                    }
                  },
                  as: "entity",
                  in: "$$entity.name"
                }
              },
              0
            ]
          },
          ingestedAt: {
            $ifNull: ["$ingestedAt", "$createdAt"]
          },
          sortAt: {
            $ifNull: [
              "$sortAt",
              {
                $convert: {
                  input: "$result.published_at",
                  to: "date",
                  onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
                  onNull: { $ifNull: ["$ingestedAt", "$createdAt"] }
                }
              }
            ]
          }
        }
      },
      {
        $match: {
          sortAt: { $gte: since }
        }
      },
      {
        $addFields: {
          entityKey: {
            $cond: [
              {
                $and: [
                  { $ne: ["$primaryEntity", null] },
                  { $ne: ["$primaryEntity", ""] }
                ]
              },
              { $concat: ["entity:", "$primaryEntity"] },
              null
            ]
          },
          topicKey: {
            $cond: [
              {
                $and: [
                  { $ne: ["$primaryTopic", null] },
                  { $ne: ["$primaryTopic", ""] }
                ]
              },
              { $concat: ["topic:", "$primaryTopic"] },
              null
            ]
          }
        }
      },
      {
        $addFields: {
          groupId: {
            $ifNull: [
              "$duplicateOf",
              {
                $ifNull: ["$entityKey", { $ifNull: ["$topicKey", "$_id"] }]
              }
            ]
          }
        }
      },
      {
        $sort: { sortAt: -1 }
      },
      {
        $group: {
          _id: "$groupId",
          count: { $sum: 1 },
          latestAt: { $first: "$sortAt" },
          title: { $first: "$result.title" },
          summary: { $first: "$result.summary" },
          source: { $first: "$result.source" },
          publishedAt: { $first: "$result.published_at" },
          topics: { $first: "$result.topics" },
          entities: { $first: "$result.entities" },
          items: {
            $push: {
              processedId: "$_id",
              itemMetaId: "$itemMetaId",
              title: "$result.title",
              summary: "$result.summary",
              source: "$result.source",
              publishedAt: "$result.published_at",
              createdAt: "$ingestedAt"
            }
          }
        }
      },
      {
        $match: {
          count: { $gte: minGroupSize }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          latestAt: 1,
          title: 1,
          summary: 1,
          source: 1,
          publishedAt: 1,
          topics: 1,
          entities: 1,
          items: { $slice: ["$items", normalizedItems] }
        }
      },
      {
        $sort: { latestAt: -1, count: -1 }
      },
      {
        $limit: normalizedLimit
      }
    ];

    const groups = await ProcessedItemModel.aggregate<{
      _id: { toString: () => string };
      count: number;
      latestAt: Date;
      title?: string | null;
      summary?: string | null;
      source?: string | null;
      publishedAt?: string | null;
      topics?: string[] | null;
      entities?: ({ name?: string | null } | null)[] | null;
      items: {
        processedId: { toString: () => string };
        itemMetaId: string;
        title?: string | null;
        summary?: string | null;
        source?: string | null;
        publishedAt?: string | null;
        createdAt: Date;
      }[];
    }>(pipeline);

    const mapped = groups.map((group) => {
      const topics = Array.isArray(group.topics)
        ? group.topics.filter((topic): topic is string => Boolean(topic))
        : [];
      const rawEntities = Array.isArray(group.entities) ? group.entities : [];
      const entityNames = Array.from(
        new Set(
          rawEntities
            .map((entity) =>
              entity && typeof entity.name === "string" ? entity.name : null
            )
            .filter((name): name is string => Boolean(name))
        )
      );

      return {
        eventId: group._id.toString(),
        count: group.count,
        latestAt: group.latestAt,
        title: group.title ?? undefined,
        summary: group.summary ?? undefined,
        source: group.source ?? undefined,
        publishedAt: group.publishedAt ?? undefined,
        topics,
        entities: entityNames,
        items: group.items.map((item) => ({
          processedId: item.processedId.toString(),
          itemMetaId: item.itemMetaId,
          title: item.title ?? undefined,
          summary: item.summary ?? undefined,
          source: item.source ?? undefined,
          publishedAt: item.publishedAt ?? undefined,
          createdAt: item.createdAt
        }))
      };
    });

    const cachePayload: CachedEventGroup[] = mapped.map((group) => ({
      ...group,
      latestAt: group.latestAt.toISOString(),
      items: group.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString()
      }))
    }));
    await this.cache.set(cacheKey, cachePayload, EVENT_GROUPS_CACHE_TTL_SECONDS);

    return mapped;
  }

  private parseSearchPayload(search?: string): ParsedSearchPayload {
    const normalized = search?.trim();
    if (!normalized) {
      return {};
    }
    if (!normalized.startsWith(ITEMS_FILTERS_SEARCH_PREFIX)) {
      return { search: normalized };
    }
    const payload = normalized.slice(ITEMS_FILTERS_SEARCH_PREFIX.length);
    if (!payload) {
      return {};
    }
    try {
      const decoded = decodeURIComponent(payload);
      const parsed = JSON.parse(decoded) as { q?: unknown; filters?: unknown };
      const searchValue = typeof parsed.q === "string" ? parsed.q.trim() : undefined;
      return {
        search: searchValue || undefined,
        filters: this.normalizeFilters(parsed.filters)
      };
    } catch {
      return { search: normalized };
    }
  }

  private normalizeFilters(raw: unknown): ItemFilters | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const input = raw as Record<string, unknown>;
    const sourceIds = this.normalizeFilterList(input.sourceIds);
    const regions = this.normalizeFilterList(input.regions);
    const topics = this.normalizeFilterList(input.topics);
    const sentiments = this.normalizeFilterList(input.sentiments, { lowerCase: true });
    const contentTypes = this.normalizeFilterList(input.contentTypes, {
      lowerCase: true,
    });
    const excludeDuplicates = input.excludeDuplicates === true;
    const dateRange = this.normalizeDateRange(input.dateRange);
    if (
      !sourceIds &&
      !regions &&
      !topics &&
      !sentiments &&
      !contentTypes &&
      !excludeDuplicates &&
      !dateRange
    ) {
      return undefined;
    }
    return {
      sourceIds,
      regions,
      topics,
      sentiments,
      contentTypes,
      ...(excludeDuplicates ? { excludeDuplicates: true } : {}),
      dateRange
    };
  }

  private normalizeFilterList(
    value: unknown,
    options?: { lowerCase?: boolean }
  ): string[] | undefined {
    const values = Array.isArray(value) ? value : [];
    const normalized = values
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .map((entry) => (options?.lowerCase ? entry.toLowerCase() : entry));
    if (normalized.length === 0) {
      return undefined;
    }
    return Array.from(new Set(normalized));
  }

  private normalizeDateRange(raw: unknown): ItemDateRangeFilter | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const input = raw as Record<string, unknown>;
    const start = this.parseDateValue(input.start);
    const end = this.parseDateValue(input.end);
    if (!start && !end) {
      return undefined;
    }
    return { start, end };
  }

  private parseDateValue(value: unknown): Date | undefined {
    if (value instanceof Date && Number.isFinite(value.valueOf())) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.valueOf())) {
        return parsed;
      }
    }
    return undefined;
  }

  private hasActiveFilters(filters?: ItemFilters): boolean {
    if (!filters) {
      return false;
    }
    return Boolean(
      (filters.sourceIds && filters.sourceIds.length > 0) ||
      (filters.regions && filters.regions.length > 0) ||
      (filters.topics && filters.topics.length > 0) ||
      (filters.sentiments && filters.sentiments.length > 0) ||
      (filters.contentTypes && filters.contentTypes.length > 0) ||
      filters.excludeDuplicates === true ||
      filters.dateRange?.start ||
      filters.dateRange?.end
    );
  }

  private combineSearchAndFilterIds(
    searchIds?: string[],
    filterIds?: string[]
  ): string[] | null {
    if (searchIds && filterIds) {
      const filterSet = new Set(filterIds);
      const intersection = searchIds.filter((id) => filterSet.has(id));
      return Array.from(new Set(intersection));
    }
    if (searchIds) {
      return Array.from(new Set(searchIds));
    }
    if (filterIds) {
      return Array.from(new Set(filterIds));
    }
    return null;
  }

  private async resolveScopedIds(orgId: string, search?: string, filters?: ItemFilters) {
    const normalizedSearch = search?.trim();
    const normalizedFilters = filters ? this.normalizeFilters(filters) ?? filters : undefined;
    const hasFilters = this.hasActiveFilters(normalizedFilters);
    if (!normalizedSearch && !hasFilters) {
      return null;
    }
    const [searchIds, filterIds] = await Promise.all([
      normalizedSearch ? this.resolveSearchIds(orgId, normalizedSearch) : undefined,
      hasFilters && normalizedFilters ? this.resolveFilterIds(orgId, normalizedFilters) : undefined
    ]);
    return this.combineSearchAndFilterIds(searchIds, filterIds);
  }

  private resolveSearchStrategy(search?: string): SearchStrategy {
    const normalized = search?.trim();
    if (!normalized) {
      return { type: "none" };
    }

    const fullTextQuery = this.buildFullTextQuery(normalized);
    if (fullTextQuery) {
      return { type: "fulltext", query: fullTextQuery };
    }

    return { type: "prefix", term: normalized };
  }

  private incrementFacetCount(target: Map<string, number>, value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    target.set(trimmed, (target.get(trimmed) ?? 0) + 1);
  }

  private buildFacetOptions(target: Map<string, number>) {
    return Array.from(target.entries())
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }
        return a[0].localeCompare(b[0]);
      })
      .slice(0, MAX_FACET_OPTIONS)
      .map(([value, count]) => ({ value, count }));
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
      .map((token) => token.replace(/[+-><()~"*@]+/g, ""))
      .filter((token) => token.length >= minLength);
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private cosineSimilarity(a: number[], b: number[]) {
    if (a.length !== b.length || a.length === 0) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      const ai = a[i];
      const bi = b[i];
      if (ai === undefined || bi === undefined || !Number.isFinite(ai) || !Number.isFinite(bi)) {
        return 0;
      }
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private vectorSearchCacheKey(orgId: string, query: string) {
    const hash = createHash("sha256").update(query).digest("hex");
    return `${ITEMS_VECTOR_SEARCH_PREFIX}${orgId}:${hash}`;
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

    const tokens = this.tokenizeSearch(normalized, MONGO_MIN_TOKEN_LENGTH);
    if (tokens.length < 2 && normalized.length < 16) {
      return [];
    }

    const cacheKey = this.vectorSearchCacheKey(orgId, normalized.toLowerCase());

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
        } else if (!(await vectorClient.fallbackToMongoEnabled())) {
          return [];
        }
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
        const similarity = this.cosineSimilarity(
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
    } catch {
      try {
        return await loader();
      } catch {
        return [];
      }
    }
  }

  private async resolveSearchIds(orgId: string, search: string) {
    const strategy = this.resolveSearchStrategy(search);
    if (strategy.type === "none") {
      return [];
    }

    const [metaIds, processedIds, processedArticleIds, vectorIds] = await Promise.all([
      this.resolveMetaSearchIds(orgId, strategy),
      this.resolveProcessedSearchIds(orgId, search),
      this.resolveProcessedArticleSearchIds(orgId, strategy),
      this.resolveVectorSearchIds(orgId, search),
    ]);

    return this.rankSearchCandidateIds({
      meta: metaIds,
      processed: processedIds,
      processedArticle: processedArticleIds,
      vector: vectorIds,
    });
  }

  private async resolveFilterIds(orgId: string, filters: ItemFilters) {
    const pipeline: PipelineStage[] = [
      {
        $match: {
          orgId,
          status: PipelineStageStatus.Completed,
        },
      },
      {
        $addFields: {
          normalizedSortAt: this.buildProcessedSortAtExpression(),
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
        (value) => new RegExp(`^${this.escapeRegex(value)}$`, "i"),
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
        (value) => new RegExp(`^${this.escapeRegex(value)}$`, "i"),
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
    const primaryIds = this.dedupeItemMetaIds(
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
    return this.dedupeItemMetaIds([...primaryIds, ...fallbackIds]);
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

    return this.dedupeItemMetaIds(
      matched.map((row) =>
        typeof row.itemMetaId === "string" ? row.itemMetaId.trim() : "",
      ),
    );
  }

  private shouldUseSemanticSuggestions(prefix: string) {
    const tokens = this.tokenizeSearch(prefix, MONGO_MIN_TOKEN_LENGTH);
    return tokens.length >= 2 || prefix.length >= SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS;
  }

  private async resolveSourceSuggestionCounts(orgId: string, normalizedPrefix: string) {
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
          const resultRecord = this.normalizeResultRecord(
            (record as { result?: unknown }).result
          );
          const source = this.pickResultString(resultRecord, [
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

  private async resolveSemanticSuggestions(
    orgId: string,
    query: string,
    limit: number
  ): Promise<{ type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }[]> {
    const trimmedQuery = query.trim();
    const normalizedQuery = trimmedQuery.toLowerCase();
    if (!this.shouldUseSemanticSuggestions(normalizedQuery)) {
      return [];
    }

    const vectorIds = await this.resolveVectorSearchIds(orgId, trimmedQuery);
    if (vectorIds.length === 0) {
      return [];
    }

    const topIds = vectorIds.slice(0, SEARCH_SUGGESTIONS_MAX_SEMANTIC_IDS);
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

    const tokens = this.tokenizeSearch(normalizedQuery, MONGO_MIN_TOKEN_LENGTH);
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
      const fields = this.collectSuggestionValuesFromProcessed({
        tags: doc.tags,
        result: doc.result
      });

      this.pushSemanticSuggestions(scored, fields.topics, "TOPIC", normalizedQuery, tokens, rankScore);
      this.pushSemanticSuggestions(scored, fields.regions, "REGION", normalizedQuery, tokens, rankScore * 0.92);
      this.pushSemanticSuggestions(scored, fields.sources, "SOURCE", normalizedQuery, tokens, rankScore * 0.88);
      this.pushSemanticSuggestions(
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

  private collectSuggestionValuesFromProcessed(input: { tags?: unknown; result?: unknown }) {
    const resultRecord = this.normalizeResultRecord(input.result);
    const topicSet = new Set<string>();
    this.pickResultStringArray(resultRecord, ["topics"]).forEach((value) => topicSet.add(value));
    this.pickResultStringArray(resultRecord, ["entities"]).forEach((value) => topicSet.add(value));
    if (Array.isArray(input.tags)) {
      for (const tag of input.tags) {
        if (typeof tag !== "string") {
          continue;
        }
        const normalized = tag.trim();
        if (normalized) {
          topicSet.add(normalized);
        }
      }
    }

    const region = this.pickResultString(resultRecord, ["location", "region"]);
    const source = this.pickResultString(resultRecord, [
      "source",
      "sourceName",
      "source_name",
      "publisher"
    ]);

    const sentiments = new Set<string>();
    const sentiment = this.pickResultString(resultRecord, ["sentiment", "sentiment_label"]);
    if (sentiment) {
      const normalized = sentiment.toLowerCase();
      if (normalized === "positive" || normalized === "neutral" || normalized === "negative") {
        sentiments.add(normalized);
      }
    }
    if (Array.isArray(input.tags)) {
      for (const tag of input.tags) {
        if (typeof tag !== "string") {
          continue;
        }
        const normalized = tag.trim().toLowerCase();
        if (normalized === "positive" || normalized === "neutral" || normalized === "negative") {
          sentiments.add(normalized);
        }
      }
    }

    return {
      topics: Array.from(topicSet).slice(0, 10),
      regions: region ? [region] : [],
      sources: source ? [source] : [],
      sentiments: Array.from(sentiments)
    };
  }

  private pushSemanticSuggestions(
    bucket: Map<
      string,
      { type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT"; value: string; score: number }
    >,
    values: string[],
    type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT",
    normalizedPrefix: string,
    tokens: string[],
    baseScore: number
  ) {
    for (const value of values) {
      const normalizedValue = value.trim().toLowerCase();
      if (!normalizedValue) {
        continue;
      }
      const startsWithPrefix = normalizedValue.startsWith(normalizedPrefix);
      const containsPrefix = normalizedValue.includes(normalizedPrefix);
      const tokenHits = tokens.filter((token) => normalizedValue.includes(token)).length;
      if (
        !startsWithPrefix &&
        !containsPrefix &&
        tokenHits === 0 &&
        tokens.length < 2 &&
        normalizedPrefix.length < SEARCH_SUGGESTIONS_MIN_SEMANTIC_CHARS
      ) {
        continue;
      }

      const score =
        baseScore +
        (startsWithPrefix ? 48 : 0) +
        (containsPrefix ? 24 : 0) +
        tokenHits * 10;

      const key = `${type}:${normalizedValue}`;
      const current = bucket.get(key);
      if (!current) {
        bucket.set(key, { type, value: value.trim(), score });
        continue;
      }
      current.score += score;
    }
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
      return this.dedupeItemMetaIds(rows.map((row) => row.id));
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where = this.buildPrefixWhere(baseWhere, strategy.term);
    const items = await this.prisma.itemMeta.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_SEARCH_MATCHES
    });
    return this.dedupeItemMetaIds(items.map((item) => item.id));
  }

  private async resolveProcessedSearchIds(orgId: string, search: string) {
    const tokens = this.tokenizeSearch(search, MONGO_MIN_TOKEN_LENGTH);
    if (tokens.length === 0) {
      return [];
    }

    const regexes = tokens.map((token) => new RegExp(this.escapeRegex(token), "i"));
    const tokenFilters = regexes.map((regex) => ({
      $or: [
        { "result.title": regex },
        { "result.subtitle": regex },
        { "result.summary": regex },
        { "result.topics": regex },
        { "result.key_points": regex },
        { "result.entities.name": regex },
        { "result.location": regex },
        { tags: regex }
      ]
    }));

    const match = {
      orgId,
      status: PipelineStageStatus.Completed,
      ...(tokenFilters.length ? { $and: tokenFilters } : {})
    };

    const records = await ProcessedItemModel.find(match, { itemMetaId: 1 })
      .sort({ createdAt: -1 })
      .limit(MAX_SEARCH_MATCHES)
      .lean();

    return this.dedupeItemMetaIds(
      records.map((record) => record.itemMetaId),
    );
  }

  private async resolveProcessedArticleSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type === "none") {
      return [];
    }

    let refs: string[] = [];
    if (strategy.type === "fulltext") {
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
      refs = rows.map((row) => row.cleanedMarkdownRef ?? "").filter(Boolean);
    } else {
      const rows = await this.prisma.processedArticle.findMany({
        where: {
          article: { orgId },
          cleanedMarkdownRef: { not: null },
          OR: [
            { title: { contains: strategy.term } },
            { summary: { contains: strategy.term } }
          ]
        },
        select: { cleanedMarkdownRef: true },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: MAX_SEARCH_MATCHES
      });
      refs = rows.map((row) => row.cleanedMarkdownRef ?? "").filter(Boolean);
    }

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

    return this.dedupeItemMetaIds(
      records.map((record) => record.itemMetaId),
    );
  }

  private resolveRankingMode(mode: ItemsRankingMode, search?: string) {
    if (mode === "RELEVANCE" && typeof search === "string" && search.trim().length > 0) {
      return "RELEVANCE" as const;
    }
    return "RECENCY" as const;
  }

  private async listByRelevanceWithPage(options: {
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
    const rowsById = await this.fetchItemMetaRowsByIds(options.orgId, pageIds);
    const scoreById = new Map(pageRows.map((row) => [row.id, row.score]));

    const items: ItemListRow[] = [];
    for (const id of pageIds) {
      const row = rowsById.get(id);
      if (!row) {
        continue;
      }
      const score = scoreById.get(id);
      items.push({
        ...row,
        ...(typeof score === "number" ? { relevanceScore: score } : {})
      });
    }

    return {
      items,
      total: ranked.length,
      page: options.page,
      pageSize: options.pageSize
    };
  }

  private async listByRelevanceWithCursor(options: {
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
    const rowsById = await this.fetchItemMetaRowsByIds(options.orgId, pageIds);

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
        rankOffset: startOffset + idx
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

    const rowsById = await this.fetchItemMetaRowsByIds(orgId, limitedIds);
    if (rowsById.size === 0) {
      return [];
    }

    const existingIds = limitedIds.filter((id) => rowsById.has(id));
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
      const resultRecord = this.normalizeResultRecord(processedByMetaId.get(id)?.result);
      const title =
        this.pickResultString(resultRecord, ["title", "headline", "title_zh", "titleZh"]) ?? row.name;
      const summary = this.pickResultString(resultRecord, ["summary", "abstract", "subtitle"]);
      const topics = this.pickResultStringArray(resultRecord, ["topics"]).slice(0, 5);
      const entities = this.pickResultStringArray(resultRecord, ["entities"]).slice(0, 5);
      const source = this.pickResultString(resultRecord, ["source", "sourceName", "source_name"]);
      const qualityRaw = this.pickResultNumber(resultRecord, ["quality_score", "qualityScore"]);
      const qualityScore = qualityRaw === null ? 0.5 : this.clamp01(qualityRaw);
      const document = [
        title,
        summary,
        topics.length > 0 ? `Topics: ${topics.join(", ")}` : null,
        entities.length > 0 ? `Entities: ${entities.join(", ")}` : null
      ]
        .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0))
        .join("\n");
      const lexicalScore = this.computeLexicalScore(search, document);
      const recencyScore = this.computeRecencyScore(row.sortAt, rankingCfg.recencyHalfLifeHours);
      const sourceTrustScore = this.computeSourceTrustScore(source);
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
          DEFAULT_WEIGHT_RERANK * this.clamp01(baseRelevance) +
          DEFAULT_WEIGHT_RECENCY * candidate.recencyScore +
          DEFAULT_WEIGHT_SOURCE_TRUST * candidate.sourceTrustScore +
          DEFAULT_WEIGHT_QUALITY * candidate.qualityScore;
        return { id: candidate.id, score: this.clamp01(finalScore), sortAt: candidate.sortAt };
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
        scoreById.set(candidate.id, this.clamp01(normalized));
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

  private async fetchItemMetaRowsByIds(orgId: string, ids: string[]) {
    if (ids.length === 0) {
      return new Map<string, ItemMetaRow>();
    }
    const rows = await this.prisma.itemMeta.findMany({
      where: {
        ...this.buildBaseWhere(orgId),
        id: { in: ids }
      }
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private normalizeResultRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    return {};
  }

  private pickResultString(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
    return null;
  }

  private pickResultNumber(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return null;
  }

  private pickResultStringArray(record: Record<string, unknown>, keys: string[]) {
    const values: string[] = [];
    for (const key of keys) {
      const value = record[key];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const entry of value) {
        if (typeof entry === "string") {
          const trimmed = entry.trim();
          if (trimmed.length > 0) {
            values.push(trimmed);
          }
          continue;
        }
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const name = (entry as { name?: unknown }).name;
          if (typeof name === "string" && name.trim().length > 0) {
            values.push(name.trim());
          }
        }
      }
    }
    return Array.from(new Set(values));
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
    const tokens = this.tokenizeSearch(normalizedQuery, MONGO_MIN_TOKEN_LENGTH);
    if (tokens.length === 0) {
      return 0;
    }
    const matched = tokens.filter((token) => normalizedDoc.includes(token.toLowerCase())).length;
    return this.clamp01(matched / tokens.length);
  }

  private computeRecencyScore(timestamp: Date, halfLifeHours = DEFAULT_RECENCY_HALFLIFE_HOURS) {
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.valueOf())) {
      return 0;
    }
    const halfLifeMs = Math.max(1, halfLifeHours) * 60 * 60 * 1000;
    const ageMs = Math.max(0, Date.now() - timestamp.getTime());
    const decay = Math.exp((-Math.log(2) * ageMs) / halfLifeMs);
    return this.clamp01(decay);
  }

  private computeSourceTrustScore(source?: string | null) {
    const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
    if (!normalized) {
      return DEFAULT_SOURCE_TRUST_SCORE;
    }
    for (const [needle, score] of Object.entries(SOURCE_TRUST_SCORE_MAP)) {
      if (normalized.includes(needle)) {
        return score;
      }
    }
    return DEFAULT_SOURCE_TRUST_SCORE;
  }

  private clamp01(value: number) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value <= 0) {
      return 0;
    }
    if (value >= 1) {
      return 1;
    }
    return value;
  }

  private buildBaseWhere(orgId: string) {
    return { orgId, status: { not: ItemStatus.Duplicate } };
  }

  private buildPrefixWhere(baseWhere: { orgId: string; status: { not: string } }, term: string) {
    return {
      ...baseWhere,
      OR: [
        { name: { startsWith: term } },
        { externalId: { startsWith: term } }
      ]
    };
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        if (typeof entry === "number") {
          return entry.toString();
        }
        return null;
      })
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .map((entry) => entry.trim());
  }

  private parsePayload(payload: Record<string, unknown>): NormalizedNewsPayload {
    const parsed = NormalizedNewsPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const [firstError] = parsed.error.errors;
      const message = firstError?.message ?? "payload is invalid";
      throw new BadRequestException(`Invalid payload: ${message}`);
    }
    return parsed.data;
  }

  private toItemMetaName(value: string) {
    const trimmed = value.trim();
    if (trimmed.length <= 191) {
      return trimmed;
    }
    return `${trimmed.slice(0, 190).trimEnd()}…`;
  }
}
