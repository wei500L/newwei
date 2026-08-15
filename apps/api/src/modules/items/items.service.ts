import {
  ProcessedItemModel,
  RawItemModel,
  type MongoConnection,
} from "@modular/mongo";
import {
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { Types } from "mongoose";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";

import { CreateItemDto } from "./dto/create-item.dto";
import { UpdateItemDto } from "./dto/update-item.dto";
import { ItemsGroupingService } from "./items-grouping.service";
import { ItemsIngestService } from "./items-ingest.service";
import { ItemsListService } from "./items-list.service";
import { ItemsReadModelService } from "./items-read-model.service";
import { ItemsSearchService } from "./items-search.service";
import {
  type CreateFromCrawlResultsBatchInput,
  type CreateFromCrawlResultsBatchResult,
  type ItemFilters,
  type ItemMetaRow,
  type ItemsCursorPayload,
  type ItemsOrderBy,
  type ItemsRankingMode,
  type RssSourceOption,
} from "./items.shared";
import { RawItemOutboxService } from "./raw-item-outbox.service";

export type {
  ItemMetaRow,
  ItemsCursorPayload,
  ItemsOrderBy,
  ItemsRankingMode,
  RssSourceOption,
} from "./items.shared";

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => RawItemOutboxService))
    private readonly rawItemOutbox: RawItemOutboxService,
    private readonly readModel: ItemsReadModelService,
    @Inject(forwardRef(() => ItemsIngestService))
    private readonly ingest: ItemsIngestService,
    private readonly itemsList: ItemsListService,
    private readonly search: ItemsSearchService,
    private readonly grouping: ItemsGroupingService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  async backfillReadModels(
    orgId: string,
    options?: { take?: number; afterId?: string },
  ): Promise<{ processed: number; nextAfterId: string | null }> {
    return this.ingest.backfillReadModels(orgId, options);
  }

  async applyRawItemPersisted(
    orgId: string,
    itemMetaId: string,
    rawItemId: string,
    enqueue?: {
      pipelineJobId?: string;
      sourceId?: string;
      priority?: number;
    },
  ): Promise<void> {
    return this.ingest.applyRawItemPersisted(orgId, itemMetaId, rawItemId, enqueue);
  }

  async create(orgId: string, userId: string, dto: CreateItemDto) {
    return this.ingest.create(orgId, userId, dto);
  }

  async createFromCrawlResult(orgId: string, userId: string, crawlResultId: string) {
    return this.ingest.createFromCrawlResult(orgId, userId, crawlResultId);
  }

  async createFromCrawlResultsBatch(
    orgId: string,
    userId: string,
    input: CreateFromCrawlResultsBatchInput,
  ): Promise<CreateFromCrawlResultsBatchResult[]> {
    return this.ingest.createFromCrawlResultsBatch(orgId, userId, input);
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
    options?: { maxPageSize?: number },
  ) {
    return this.itemsList.list(
      orgId,
      page,
      pageSize,
      search,
      filters,
      orderBy,
      rankingMode,
      userId,
      options,
    );
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
    includeTotalCount = true,
  ) {
    return this.itemsList.listWithCursor(
      orgId,
      first,
      cursor,
      search,
      filters,
      orderBy,
      rankingMode,
      userId,
      includeTotalCount,
    );
  }

  async getFacets(orgId: string, search?: string, filters?: ItemFilters) {
    return this.search.getFacets(orgId, search, filters);
  }

  async listRssSourcesForReading(
    orgId: string,
    options?: { windowDays?: number; onlyWithItems?: boolean },
  ): Promise<RssSourceOption[]> {
    return this.search.listRssSourcesForReading(orgId, options);
  }

  async searchSuggestions(
    orgId: string,
    prefix: string,
    limit = 10,
  ): Promise<
    {
      type: "TOPIC" | "REGION" | "SOURCE" | "SENTIMENT";
      value: string;
      origin: "LEXICAL" | "SEMANTIC" | "HYBRID";
    }[]
  > {
    return this.search.searchSuggestions(orgId, prefix, limit);
  }

  async get(orgId: string, id: string) {
    if (this.readModel.isReadModelEnabled()) {
      const readModel = await this.readModel.loadItemReadModel(orgId, id);
      if (!readModel) {
        throw new NotFoundException("Item not found");
      }

      return {
        itemMeta: this.readModel.itemMetaRowFromReadModel(readModel),
        rawItem: readModel.raw
          ? {
              id: readModel.raw.id,
              itemMetaId: readModel.raw.itemMetaId,
              payload: readModel.raw.payload,
              source: readModel.raw.source,
              createdAt: readModel.raw.createdAt,
              updatedAt: readModel.raw.updatedAt,
            }
          : null,
        processed: readModel.processed
          ? {
              id: readModel.processed.id,
              itemMetaId: readModel.processed.itemMetaId,
              rawItemId: readModel.processed.rawItemId,
              pipelineJobId: readModel.processed.pipelineJobId,
              sourceId: readModel.processed.sourceId,
              status: readModel.processed.status,
              error: readModel.processed.error,
              tags: readModel.processed.tags ?? [],
              result: readModel.processed.result,
              duplicateOf: readModel.processed.duplicateOf,
              duplicateSimilarity: readModel.processed.duplicateSimilarity,
              llm: readModel.processed.llm,
              summaryEmbeddingModel: readModel.processed.summaryEmbeddingModel,
              summaryEmbeddingDimensions: readModel.processed.summaryEmbeddingDimensions,
              createdAt: readModel.processed.createdAt,
              updatedAt: readModel.processed.updatedAt,
            }
          : null,
      };
    }

    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id, orgId }
    });
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }

    const rawItem =
      itemMeta.mongoRef && Types.ObjectId.isValid(itemMeta.mongoRef)
        ? await RawItemModel.findById(itemMeta.mongoRef).lean()
        : null;
    const processed = await ProcessedItemModel.findOne({ itemMetaId: itemMeta.id })
      .sort({ createdAt: -1 })
      .lean();

    return {
      itemMeta,
      rawItem,
      processed
    };
  }

  /**
   * Org-scoped item lookup that returns null on miss (deleted / stale / cross-org id),
   * for callers whose contract is nullable (e.g. the GraphQL `item(id)` query). Use
   * {@link getItemMeta} when a missing item should be a hard NotFound error.
   */
  async getItemMetaOrNull(orgId: string, id: string): Promise<ItemMetaRow | null> {
    if (this.readModel.isReadModelEnabled()) {
      const readModel = await this.readModel.loadItemReadModel(orgId, id);
      if (!readModel) {
        return null;
      }
      return this.readModel.itemMetaRowFromReadModel(readModel);
    }

    const itemMeta = await this.prisma.itemMeta.findFirst({
      where: { id, orgId },
    });
    if (!itemMeta) {
      return null;
    }
    return {
      id: itemMeta.id,
      orgId: itemMeta.orgId,
      externalId: itemMeta.externalId,
      name: itemMeta.name,
      status: itemMeta.status,
      mongoRef: itemMeta.mongoRef,
      version: itemMeta.version,
      publishedAt: itemMeta.publishedAt ?? null,
      sortAt: itemMeta.sortAt ?? itemMeta.createdAt,
      createdAt: itemMeta.createdAt,
      updatedAt: itemMeta.updatedAt,
    };
  }

  async getItemMeta(orgId: string, id: string): Promise<ItemMetaRow> {
    const itemMeta = await this.getItemMetaOrNull(orgId, id);
    if (!itemMeta) {
      throw new NotFoundException("Item not found");
    }
    return itemMeta;
  }

  async update(orgId: string, userId: string, dto: UpdateItemDto) {
    const existing = await this.prisma.itemMeta.findFirst({
      where: { id: dto.id, orgId }
    });

    if (!existing) {
      throw new NotFoundException("Item not found");
    }

    const normalizedPayload = dto.payload ? this.ingest.parsePayload(dto.payload) : undefined;
    let outboxId: string | null = null;

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
        const rawItemId = new Types.ObjectId().toHexString();
        await tx.itemMeta.update({
          where: { id: existing.id },
          data: { mongoRef: rawItemId }
        });
        newRawRef = rawItemId;
        outboxId = await this.rawItemOutbox.enqueueWrite(tx, {
          orgId,
          itemMetaId: existing.id,
          rawItemId,
          source: "graphql",
          payload: normalizedPayload
        });
      }

      return {
        ...updatedMeta,
        mongoRef: newRawRef
      };
    });

    if (outboxId) {
      await this.rawItemOutbox.deliverNow(outboxId);
    }
    await this.readModel.hydrateItemReadModel(orgId, existing.id);

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
    options?: { limit?: number; itemsPerGroup?: number; windowDays?: number },
  ) {
    return this.grouping.listTopicGroups(orgId, options);
  }

  async listEventGroups(
    orgId: string,
    options?: {
      limit?: number;
      itemsPerGroup?: number;
      windowDays?: number;
      minGroupSize?: number;
    },
  ) {
    return this.grouping.listEventGroups(orgId, options);
  }
}
