import { RawItemModel, ProcessedItemModel } from "@modular/mongo";
import type { MongoConnection } from "@modular/mongo";
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
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
import { VectorClientService } from "../vector/vector-client.service";

import { CreateItemDto } from "./dto/create-item.dto";
import { UpdateItemDto } from "./dto/update-item.dto";


const MAX_CURSOR_PAGE_SIZE = 50;
const FULLTEXT_MIN_TOKEN_LENGTH = 3;
const MONGO_MIN_TOKEN_LENGTH = 2;
const MAX_SEARCH_MATCHES = 5000;
const MAX_TOPIC_GROUPS = 50;
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
const VECTOR_SEARCH_CACHE_TTL_SECONDS = 300;
const VECTOR_SEARCH_MIN_SIMILARITY = 0.78;
const VECTOR_SEARCH_MAX_RESULTS = 300;
const VECTOR_SEARCH_MAX_CANDIDATES = 1200;
const VECTOR_SEARCH_LOOKBACK_DAYS = 30;
const TOPIC_GROUPS_CACHE_TTL_SECONDS = 120;
const EVENT_GROUPS_CACHE_TTL_SECONDS = 120;

type SearchStrategy =
  | { type: "none" }
  | { type: "fulltext"; query: string }
  | { type: "prefix"; term: string };

interface ItemDateRangeFilter {
  start?: Date;
  end?: Date;
}

interface ItemFilters {
  regions?: string[];
  topics?: string[];
  sentiments?: string[];
  dateRange?: ItemDateRangeFilter;
}

interface ParsedSearchPayload {
  search?: string;
  filters?: ItemFilters;
}

export type ItemsOrderBy = "CREATED_DESC" | "PUBLISHED_DESC";

export interface ItemsCursorPayload {
  id: string;
  createdAt?: string;
  sortAt?: string;
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

@Injectable()
export class ItemsService {
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

    const sourceNameOverrideRaw = itemPayloadConfig?.sourceName;
    const sourceNameOverride =
      typeof sourceNameOverrideRaw === "string" && sourceNameOverrideRaw.trim().length > 0
        ? sourceNameOverrideRaw.trim()
        : undefined;
    const sourceName = sourceNameOverride ?? crawlResult.task.displayName ?? undefined;
    const languageRaw = itemPayloadConfig?.language;
    const language =
      typeof languageRaw === "string" && languageRaw.trim().length > 0 ? languageRaw.trim() : undefined;
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

    const metadata =
      crawlResult.metadata && typeof crawlResult.metadata === "object" && !Array.isArray(crawlResult.metadata)
        ? (crawlResult.metadata as Record<string, unknown>)
        : {};

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
        ...metadata,
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
    orderBy: ItemsOrderBy = "CREATED_DESC"
  ) {
    const normalizedPageSize = Number.isFinite(pageSize) ? Math.floor(pageSize) : 10;
    const take = Math.min(Math.max(normalizedPageSize, 1), MAX_CURSOR_PAGE_SIZE);
    const normalizedPage = Number.isFinite(page) ? Math.floor(page) : 1;
    const safePage = Math.max(normalizedPage, 1);
    const skip = (safePage - 1) * take;
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        total: 0,
        page: safePage,
        pageSize: take
      };
    }

    const orderField = orderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";
    const orderByClause: Prisma.ItemMetaOrderByWithRelationInput[] =
      orderField === "sortAt"
        ? [{ sortAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }];

    if (!normalizedSearch && !scopedIds) {
      const baseWhere = this.buildBaseWhere(orgId);
      const [items, total] = await Promise.all([
        this.prisma.itemMeta.findMany({
          where: baseWhere,
          skip,
          take,
          orderBy: orderByClause
        }),
        this.prisma.itemMeta.count({ where: baseWhere })
      ]);

      return {
        items,
        total,
        page: safePage,
        pageSize: take
      };
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;

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
    orderBy: ItemsOrderBy = "CREATED_DESC"
  ) {
    const take = Math.min(Math.max(first, 1), MAX_CURSOR_PAGE_SIZE);
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    if (scopedIds && scopedIds.length === 0) {
      return {
        items: [],
        hasNextPage: false,
        totalCount: 0
      };
    }

    const baseWhere = this.buildBaseWhere(orgId);
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

    const whereBase = scopedIds ? { ...baseWhere, id: { in: scopedIds } } : baseWhere;
    const orderField = orderBy === "PUBLISHED_DESC" ? "sortAt" : "createdAt";

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

  async getFacets(orgId: string, search?: string, filters?: ItemFilters) {
    const { search: normalizedSearch, filters: legacyFilters } = this.parseSearchPayload(search);
    const effectiveFilters = filters ?? legacyFilters;
    const scopedIds = await this.resolveScopedIds(orgId, normalizedSearch, effectiveFilters);
    if (scopedIds && scopedIds.length === 0) {
      return { regions: [], topics: [], sentiments: [] };
    }

    const match: Record<string, unknown> = {
      orgId,
      status: PipelineStageStatus.Completed,
      ...(scopedIds ? { itemMetaId: { $in: scopedIds } } : {})
    };

    const records = await ProcessedItemModel.find(
      match,
      {
        tags: 1,
        result: 1
      }
    )
      .sort({ createdAt: -1 })
      .limit(MAX_SEARCH_MATCHES)
      .lean();

    const regionCounts = new Map<string, number>();
    const topicCounts = new Map<string, number>();
    const sentimentCounts = new Map<string, number>();
    const allowedSentiments = new Set(["positive", "neutral", "negative"]);

    for (const record of records) {
      const result = record.result as
        | {
            location?: string | null;
            region?: string | null;
            topics?: ({ name?: string | null } | string)[] | null;
            entities?: ({ name?: string | null } | string)[] | null;
            sentiment?: string | null;
            sentiment_label?: string | null;
          }
        | undefined;

      const regionValue = result?.location ?? result?.region ?? null;
      if (regionValue) {
        this.incrementFacetCount(regionCounts, regionValue);
      }

      const topicSet = new Set<string>();
      if (Array.isArray(result?.topics)) {
        result.topics.forEach((topic) => {
          if (typeof topic === "string") {
            const normalized = topic.trim();
            if (normalized) {
              topicSet.add(normalized);
            }
            return;
          }
          if (topic && typeof topic.name === "string") {
            const normalized = topic.name.trim();
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
      if (Array.isArray(result?.entities)) {
        result.entities.forEach((entity) => {
          if (typeof entity === "string" && entity.trim()) {
            topicSet.add(entity.trim());
            return;
          }
          if (entity && typeof entity !== "string" && typeof entity.name === "string" && entity.name.trim()) {
            topicSet.add(entity.name.trim());
          }
        });
      }
      topicSet.forEach((topic) => this.incrementFacetCount(topicCounts, topic));

      const sentimentSet = new Set<string>();
      if (typeof result?.sentiment === "string" && result.sentiment.trim()) {
        sentimentSet.add(result.sentiment.trim().toLowerCase());
      }
      if (typeof result?.sentiment_label === "string" && result.sentiment_label.trim()) {
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
    }

    return {
      regions: this.buildFacetOptions(regionCounts),
      topics: this.buildFacetOptions(topicCounts),
      sentiments: this.buildFacetOptions(sentimentCounts)
    };
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
    const regions = this.normalizeFilterList(input.regions);
    const topics = this.normalizeFilterList(input.topics);
    const sentiments = this.normalizeFilterList(input.sentiments, { lowerCase: true });
    const dateRange = this.normalizeDateRange(input.dateRange);
    if (!regions && !topics && !sentiments && !dateRange) {
      return undefined;
    }
    return {
      regions,
      topics,
      sentiments,
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
      (filters.regions && filters.regions.length > 0) ||
        (filters.topics && filters.topics.length > 0) ||
        (filters.sentiments && filters.sentiments.length > 0) ||
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

    const combined = new Set<string>();
    metaIds.forEach((id) => combined.add(id));
    processedIds.forEach((id) => combined.add(id));
    processedArticleIds.forEach((id) => combined.add(id));
    vectorIds.forEach((id) => combined.add(id));
    return Array.from(combined);
  }

  private async resolveFilterIds(orgId: string, filters: ItemFilters) {
    const matchFilters: Record<string, unknown>[] = [];
    if (filters.regions?.length) {
      matchFilters.push({
        $or: [
          { "result.location": { $in: filters.regions } },
          { "result.region": { $in: filters.regions } }
        ]
      });
    }
    if (filters.topics?.length) {
      matchFilters.push({
        $or: [
          { "result.topics": { $in: filters.topics } },
          { tags: { $in: filters.topics } },
          { "result.entities.name": { $in: filters.topics } }
        ]
      });
    }
    if (filters.sentiments?.length) {
      const sentimentMatchers = filters.sentiments.map(
        (value) => new RegExp(`^${this.escapeRegex(value)}$`, "i")
      );
      matchFilters.push({
        $or: [
          { "result.sentiment": { $in: sentimentMatchers } },
          { "result.sentiment_label": { $in: sentimentMatchers } },
          { tags: { $in: sentimentMatchers } }
        ]
      });
    }

    const match: Record<string, unknown> = {
      orgId,
      status: PipelineStageStatus.Completed,
      ...(matchFilters.length ? { $and: matchFilters } : {})
    };

    const pipeline: PipelineStage[] = [{ $match: match }];
    if (filters.dateRange?.start || filters.dateRange?.end) {
      pipeline.push({
        $addFields: {
          sortAt: {
            $ifNull: [
              "$sortAt",
              {
                $dateFromString: {
                  dateString: { $ifNull: ["$result.published_at", null] },
                  onError: { $ifNull: ["$ingestedAt", "$createdAt"] },
                  onNull: { $ifNull: ["$ingestedAt", "$createdAt"] }
                }
              }
            ]
          }
        }
      });
      const dateMatch: Record<string, Date> = {};
      if (filters.dateRange.start) {
        dateMatch.$gte = filters.dateRange.start;
      }
      if (filters.dateRange.end) {
        dateMatch.$lte = filters.dateRange.end;
      }
      pipeline.push({ $match: { sortAt: dateMatch } });
    }

    pipeline.push(
      { $sort: { createdAt: -1 } },
      { $limit: MAX_SEARCH_MATCHES },
      { $project: { itemMetaId: 1 } }
    );

    const records = await ProcessedItemModel.aggregate<{ itemMetaId: string }>(pipeline);
    return records.map((record) => record.itemMetaId).filter(Boolean);
  }

  private async resolveMetaSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type === "none") {
      return [];
    }

    if (strategy.type === "fulltext") {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT \`id\`
        FROM \`ItemMeta\`
        WHERE \`orgId\` = ${orgId}
          AND \`status\` <> ${ItemStatus.Duplicate}
          AND MATCH(\`name\`, \`externalId\`) AGAINST (${strategy.query} IN BOOLEAN MODE)
        ORDER BY \`createdAt\` DESC, \`id\` DESC
        LIMIT ${MAX_SEARCH_MATCHES}
      `;
      return rows.map((row) => row.id);
    }

    const baseWhere = this.buildBaseWhere(orgId);
    const where = this.buildPrefixWhere(baseWhere, strategy.term);
    const items = await this.prisma.itemMeta.findMany({
      where,
      select: { id: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_SEARCH_MATCHES
    });
    return items.map((item) => item.id);
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

    return records.map((record) => record.itemMetaId).filter(Boolean);
  }

  private async resolveProcessedArticleSearchIds(orgId: string, strategy: SearchStrategy) {
    if (strategy.type === "none") {
      return [];
    }

    let refs: string[] = [];
    if (strategy.type === "fulltext") {
      const rows = await this.prisma.$queryRaw<{ cleanedMarkdownRef: string | null }[]>`
        SELECT pa.cleanedMarkdownRef
        FROM \`ProcessedArticle\` pa
        INNER JOIN \`Article\` a ON a.id = pa.articleId
        WHERE a.orgId = ${orgId}
          AND pa.cleanedMarkdownRef IS NOT NULL
          AND MATCH(pa.title, pa.summary) AGAINST (${strategy.query} IN BOOLEAN MODE)
        ORDER BY pa.updatedAt DESC, pa.id DESC
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
      .limit(MAX_SEARCH_MATCHES)
      .lean();

    return records.map((record) => record.itemMetaId).filter(Boolean);
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
