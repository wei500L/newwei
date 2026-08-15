import { RawItemModel, type MongoConnection } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  forwardRef,
} from "@nestjs/common";
import { Prisma, type ItemMeta } from "@prisma/client";
import { Types } from "mongoose";
import { randomUUID } from "node:crypto";

import { settleWithConcurrency } from "../../common/multi-tenant-scheduler";
import { ItemStatus } from "../../common/pipeline-status";
import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";
import {
  type NormalizedNewsPayload,
  NormalizedNewsPayloadSchema,
} from "../news-pipeline/news-pipeline.schema";
import { QueueService } from "../queue/queue.service";

import { CreateItemDto } from "./dto/create-item.dto";
import { ItemsReadModelService } from "./items-read-model.service";
import {
  CRAWL_RESULT_INGEST_CONCURRENCY,
  CRAWL_RESULT_ITEM_INGEST_SELECT,
  type CrawlResultItemIngestRow,
  type CreateFromCrawlResultsBatchInput,
  type CreateFromCrawlResultsBatchResult,
  type PreparedCrawlResultItemIngestInput,
} from "./items.shared";
import { RawItemOutboxService } from "./raw-item-outbox.service";

@Injectable()
export class ItemsIngestService {
  private readonly logger = createLogger({ name: "items-service" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    @Inject(forwardRef(() => RawItemOutboxService))
    private readonly rawItemOutbox: RawItemOutboxService,
    private readonly readModel: ItemsReadModelService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  async backfillReadModels(
    orgId: string,
    options?: { take?: number; afterId?: string },
  ): Promise<{ processed: number; nextAfterId: string | null }> {
    const take = Math.min(Math.max(options?.take ?? 200, 1), 1000);
    const afterId = typeof options?.afterId === "string" ? options.afterId.trim() : "";
    const rows = await this.prisma.itemMeta.findMany({
      where: {
        orgId,
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
      take,
    });

    if (rows.length > 0) {
      await this.readModel.hydrateItemReadModelsBatch(
        orgId,
        rows.map((row) => row.id),
      );
    }

    return {
      processed: rows.length,
      nextAfterId: rows.at(-1)?.id ?? null,
    };
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
    try {
      await this.queueService.enqueueItem(
        orgId,
        itemMetaId,
        rawItemId,
        typeof enqueue?.priority === "number" ? { priority: enqueue.priority } : {},
        {
          ...(enqueue?.pipelineJobId
            ? { pipelineJobId: enqueue.pipelineJobId }
            : {}),
          ...(enqueue?.sourceId ? { sourceId: enqueue.sourceId } : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("already exists"))) {
        throw error;
      }
    }
    await this.readModel.hydrateItemReadModel(orgId, itemMetaId);
  }

  async create(orgId: string, userId: string, dto: CreateItemDto) {
    const externalId = dto.externalId;
    const existing = await this.prisma.itemMeta.findFirst({
      where: { orgId, externalId }
    });
    if (existing) {
      const mongoRef = existing.mongoRef?.trim();
      if (mongoRef) {
        await this.rawItemOutbox.deliverPendingForItemMeta(orgId, existing.id);
        return { ...existing, rawItemId: mongoRef };
      }

      const payload = this.parsePayload(dto.payload);
      const rawItemId = new Types.ObjectId().toHexString();
      const outboxId = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.itemMeta.updateMany({
          where: { id: existing.id, orgId, mongoRef: "" },
          data: { mongoRef: rawItemId }
        });
        if (claimed.count === 0) {
          return null;
        }
        return this.rawItemOutbox.enqueueWrite(tx, {
          orgId,
          itemMetaId: existing.id,
          rawItemId,
          source: "api",
          payload
        });
      });
      if (!outboxId) {
        const raced = await this.prisma.itemMeta.findFirst({
          where: { id: existing.id, orgId }
        });
        if (raced?.mongoRef?.trim()) {
          await this.rawItemOutbox.deliverPendingForItemMeta(orgId, raced.id);
        }
        return {
          ...existing,
          mongoRef: raced?.mongoRef ?? existing.mongoRef,
          rawItemId: raced?.mongoRef ?? existing.mongoRef
        };
      }
      await this.rawItemOutbox.deliverNow(outboxId);
      return {
        ...existing,
        mongoRef: rawItemId,
        rawItemId
      };
    }

    const payload = this.parsePayload(dto.payload);
    try {
      const rawItemId = new Types.ObjectId().toHexString();
      const created = await this.prisma.$transaction(async (tx) => {
        const itemMeta = await tx.itemMeta.create({
          data: {
            orgId,
            externalId,
            name: dto.name,
            status: dto.status ?? ItemStatus.Pending,
            mongoRef: rawItemId
          }
        });

        const outboxId = await this.rawItemOutbox.enqueueWrite(tx, {
          orgId,
          itemMetaId: itemMeta.id,
          rawItemId,
          source: "api",
          payload
        });

        return { itemMeta, outboxId };
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

      await this.rawItemOutbox.deliverNow(created.outboxId);

      return {
        ...created.itemMeta,
        rawItemId
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const raced = await this.prisma.itemMeta.findFirst({
          where: { orgId, externalId }
        });
        if (raced) {
          if (raced.mongoRef?.trim()) {
            await this.rawItemOutbox.deliverPendingForItemMeta(orgId, raced.id);
          }
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

    const [result] = await this.createFromCrawlResultsBatch(orgId, userId, {
      crawlResultIds: [normalizedId]
    });

    if (!result || result.status === "rejected" || !result.itemMeta) {
      throw (result?.reason ?? new NotFoundException("Crawl result not found"));
    }

    return result.itemMeta;
  }

  async createFromCrawlResultsBatch(
    orgId: string,
    userId: string,
    input: CreateFromCrawlResultsBatchInput
  ): Promise<CreateFromCrawlResultsBatchResult[]> {
    const preloadedResults = Array.isArray(input.crawlResults) ? input.crawlResults : [];
    const requestedIds =
      preloadedResults.length > 0
        ? Array.from(
            new Set(
              preloadedResults
                .map((crawlResult) => (typeof crawlResult.id === "string" ? crawlResult.id.trim() : ""))
                .filter((crawlResultId) => crawlResultId.length > 0)
            )
          )
        : Array.from(
            new Set(
              (Array.isArray(input.crawlResultIds) ? input.crawlResultIds : [])
                .map((crawlResultId) => (typeof crawlResultId === "string" ? crawlResultId.trim() : ""))
                .filter((crawlResultId) => crawlResultId.length > 0)
            )
          );

    if (requestedIds.length === 0) {
      return [];
    }

    const resultsById = new Map<string, CreateFromCrawlResultsBatchResult>();
    const crawlResultById = new Map<string, CrawlResultItemIngestRow>();

    if (preloadedResults.length > 0) {
      for (const crawlResult of preloadedResults) {
        if (requestedIds.includes(crawlResult.id)) {
          crawlResultById.set(crawlResult.id, crawlResult);
        }
      }
    } else {
      const crawlResults = await this.prisma.crawlResult.findMany({
        where: {
          id: { in: requestedIds },
          task: { orgId }
        },
        select: CRAWL_RESULT_ITEM_INGEST_SELECT
      });
      for (const crawlResult of crawlResults) {
        crawlResultById.set(crawlResult.id, crawlResult);
      }
      for (const crawlResultId of requestedIds) {
        if (!crawlResultById.has(crawlResultId)) {
          resultsById.set(crawlResultId, {
            crawlResultId,
            reason: new NotFoundException("Crawl result not found"),
            status: "rejected"
          });
        }
      }
    }

    const crawlResults = requestedIds
      .map((crawlResultId) => crawlResultById.get(crawlResultId))
      .filter((crawlResult): crawlResult is CrawlResultItemIngestRow => Boolean(crawlResult));

    if (crawlResults.length === 0) {
      return requestedIds.map((crawlResultId) => (
        resultsById.get(crawlResultId) ?? {
          crawlResultId,
          reason: new NotFoundException("Crawl result not found"),
          status: "rejected"
        }
      ));
    }

    const preparedInputs = crawlResults.map((crawlResult) =>
      this.prepareCrawlResultItemIngestInput(crawlResult)
    );
    const externalIds = preparedInputs.map((entry) => entry.externalId);
    const existingMetas = await this.prisma.itemMeta.findMany({
      where: {
        orgId,
        externalId: { in: externalIds }
      }
    });
    const existingMetaByExternalId = new Map(existingMetas.map((meta) => [meta.externalId, meta]));
    const plannedMetaIdByExternalId = new Map<string, string>();
    const missingMetaRows = preparedInputs
      .filter((entry) => !existingMetaByExternalId.has(entry.externalId))
      .map((entry) => {
        const id = randomUUID();
        plannedMetaIdByExternalId.set(entry.externalId, id);
        return {
          id,
          orgId,
          externalId: entry.externalId,
          name: entry.itemMetaName,
          status: ItemStatus.Pending,
          mongoRef: ""
        };
      });

    if (missingMetaRows.length > 0) {
      await this.prisma.itemMeta.createMany({
        data: missingMetaRows,
        skipDuplicates: true
      });
    }

    const resolvedMetas =
      missingMetaRows.length > 0
        ? await this.prisma.itemMeta.findMany({
            where: {
              orgId,
              externalId: { in: externalIds }
            }
          })
        : existingMetas;
    const metaByExternalId = new Map(resolvedMetas.map((meta) => [meta.externalId, meta]));

    const metasWithMongoRef: { prepared: PreparedCrawlResultItemIngestInput; meta: ItemMeta }[] = [];
    const metasMissingMongoRef: {
      createdByThisProcess: boolean;
      meta: ItemMeta;
      prepared: PreparedCrawlResultItemIngestInput;
    }[] = [];

    for (const prepared of preparedInputs) {
      const meta = metaByExternalId.get(prepared.externalId);
      if (!meta) {
        resultsById.set(prepared.crawlResult.id, {
          crawlResultId: prepared.crawlResult.id,
          reason: new ServiceUnavailableException("Failed to resolve item meta for crawl result"),
          status: "rejected"
        });
        continue;
      }

      if (meta.mongoRef.trim().length > 0) {
        metasWithMongoRef.push({ prepared, meta });
        continue;
      }

      metasMissingMongoRef.push({
        createdByThisProcess: plannedMetaIdByExternalId.get(prepared.externalId) === meta.id,
        meta,
        prepared
      });
    }

    const existingRefResults = await settleWithConcurrency(
      metasWithMongoRef,
      CRAWL_RESULT_INGEST_CONCURRENCY,
      async ({ prepared, meta }) => {
        await this.enqueueCrawlResultItem(orgId, meta, prepared);
        return meta;
      }
    );
    for (const result of existingRefResults) {
      const crawlResultId = result.item.prepared.crawlResult.id;
      if (result.status === "fulfilled") {
        resultsById.set(crawlResultId, {
          crawlResultId,
          itemMeta: result.value,
          status: "fulfilled"
        });
      } else {
        resultsById.set(crawlResultId, {
          crawlResultId,
          reason: result.reason,
          status: "rejected"
        });
      }
    }

    const rawValidationResults = await settleWithConcurrency(
      metasMissingMongoRef,
      CRAWL_RESULT_INGEST_CONCURRENCY,
      async ({ createdByThisProcess, meta, prepared }) => {
        const rawId = new Types.ObjectId();
        const rawDoc = new RawItemModel({
          _id: rawId,
          itemMetaId: meta.id,
          payload: prepared.payload,
          source: "crawl-task"
        });
        await rawDoc.validate();
        return {
          createdByThisProcess,
          meta,
          prepared,
          rawDoc,
          rawId: rawId.toHexString()
        };
      }
    );

    const validatedRawPlans = rawValidationResults
      .filter((result): result is Extract<(typeof rawValidationResults)[number], { status: "fulfilled" }> =>
        result.status === "fulfilled"
      )
      .map((result) => result.value);
    const cleanupItemMetaIds = new Set<string>();
    for (const result of rawValidationResults) {
      if (result.status === "rejected") {
        if (result.item.createdByThisProcess) {
          cleanupItemMetaIds.add(result.item.meta.id);
        }
        resultsById.set(result.item.prepared.crawlResult.id, {
          crawlResultId: result.item.prepared.crawlResult.id,
          reason: result.reason,
          status: "rejected"
        });
      }
    }

    if (validatedRawPlans.length > 0) {
      try {
        await RawItemModel.insertMany(
          validatedRawPlans.map((plan) => plan.rawDoc),
          { ordered: false }
        );
      } catch (error) {
        this.logger.warn(
          {
            err: error,
            crawlResultIds: validatedRawPlans.map((plan) => plan.prepared.crawlResult.id),
            orgId
          },
          "Failed to batch insert raw items for crawl results"
        );
      }

      const insertedRawDocs = await RawItemModel.find({
        _id: {
          $in: validatedRawPlans.map((plan) => plan.rawDoc._id)
        }
      })
        .select({ _id: 1 })
        .lean();
      const insertedRawIdSet = new Set(
        insertedRawDocs.map((doc) => {
          const id = doc?._id;
          if (typeof id === "string") {
            return id;
          }
          return id && typeof (id as { toString?: unknown }).toString === "function"
            ? (id as { toString: () => string }).toString()
            : "";
        })
      );

      const missingMongoRefResults = await settleWithConcurrency(
        validatedRawPlans,
        CRAWL_RESULT_INGEST_CONCURRENCY,
        async (plan) => {
          if (!insertedRawIdSet.has(plan.rawId)) {
            throw new ServiceUnavailableException("Failed to persist raw crawl result item");
          }

          const updated = await this.prisma.itemMeta.updateMany({
            where: {
              id: plan.meta.id,
              mongoRef: ""
            },
            data: { mongoRef: plan.rawId }
          });
          if (updated.count === 0) {
            await RawItemModel.deleteOne({ _id: plan.rawDoc._id }).catch(() => undefined);
            const latest = await this.prisma.itemMeta.findUnique({
              where: { id: plan.meta.id }
            });
            return latest ?? plan.meta;
          }

          const itemMeta: ItemMeta = {
            ...plan.meta,
            mongoRef: plan.rawId
          };

          if (plan.createdByThisProcess) {
            this.writeCreateFromCrawlResultAuditLog(orgId, userId, plan.prepared.crawlResult);
          }

          await this.enqueueCrawlResultItem(orgId, itemMeta, plan.prepared);
          await this.readModel.hydrateItemReadModel(orgId, itemMeta.id);
          return itemMeta;
        }
      );

      for (const result of missingMongoRefResults) {
        const crawlResultId = result.item.prepared.crawlResult.id;
        if (result.status === "fulfilled") {
          resultsById.set(crawlResultId, {
            crawlResultId,
            itemMeta: result.value,
            status: "fulfilled"
          });
        } else {
          if (result.item.createdByThisProcess) {
            cleanupItemMetaIds.add(result.item.meta.id);
          }
          resultsById.set(crawlResultId, {
            crawlResultId,
            reason: result.reason,
            status: "rejected"
          });
        }
      }
    }

    await this.cleanupEmptyCrawlResultItemMetas(Array.from(cleanupItemMetaIds));

    return requestedIds.map((crawlResultId) => (
      resultsById.get(crawlResultId) ?? {
        crawlResultId,
        reason: new ServiceUnavailableException("Failed to ingest crawl result"),
        status: "rejected"
      }
    ));
  }

  private async cleanupEmptyCrawlResultItemMetas(itemMetaIds: string[]) {
    const uniqueIds = Array.from(
      new Set(
        itemMetaIds.filter((itemMetaId): itemMetaId is string => (
          typeof itemMetaId === "string" && itemMetaId.trim().length > 0
        ))
      )
    );
    if (uniqueIds.length === 0) {
      return;
    }

    try {
      await this.prisma.itemMeta.deleteMany({
        where: {
          id: { in: uniqueIds },
          mongoRef: ""
        }
      });
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          itemMetaIds: uniqueIds
        },
        "Failed to cleanup empty crawl-result item metas after rejected ingest"
      );
    }
  }

  private prepareCrawlResultItemIngestInput(
    crawlResult: CrawlResultItemIngestRow
  ): PreparedCrawlResultItemIngestInput {
    const crawlTaskConfig =
      crawlResult.task.config &&
      typeof crawlResult.task.config === "object" &&
      !Array.isArray(crawlResult.task.config)
        ? (crawlResult.task.config as Record<string, unknown>)
        : null;
    const itemPayloadConfig =
      crawlTaskConfig?.itemPayload &&
      typeof crawlTaskConfig.itemPayload === "object" &&
      !Array.isArray(crawlTaskConfig.itemPayload)
        ? (crawlTaskConfig.itemPayload as Record<string, unknown>)
        : null;
    const itemPayloadMetadata =
      itemPayloadConfig?.metadata &&
      typeof itemPayloadConfig.metadata === "object" &&
      !Array.isArray(itemPayloadConfig.metadata)
        ? (itemPayloadConfig.metadata as Record<string, unknown>)
        : {};
    const crawlResultMetadata =
      crawlResult.metadata &&
      typeof crawlResult.metadata === "object" &&
      !Array.isArray(crawlResult.metadata)
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
    const payload = this.parsePayload({
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
      forceRefresh: false
    });
    const itemMetaName = this.toItemMetaName(
      sourceName ? `${sourceName}: ${crawlResult.sourceUrl}` : crawlResult.sourceUrl
    );

    return {
      crawlResult,
      externalId: `crawlResult:${crawlResult.id}`,
      itemMetaName,
      payload,
      ...(pipelineJobId ? { pipelineJobId } : {}),
      ...(pipelinePriority !== undefined ? { pipelinePriority } : {}),
      ...(sourceId ? { sourceId } : {})
    };
  }

  private async enqueueCrawlResultItem(
    orgId: string,
    itemMeta: Pick<ItemMeta, "id" | "mongoRef" | "status">,
    prepared: Pick<
      PreparedCrawlResultItemIngestInput,
      "pipelineJobId" | "pipelinePriority" | "sourceId"
    >
  ) {
    const mongoRef = itemMeta.mongoRef.trim();
    const shouldEnqueue =
      mongoRef.length > 0 &&
      (itemMeta.status === ItemStatus.Pending ||
        itemMeta.status === ItemStatus.Processing ||
        itemMeta.status === ItemStatus.Failed);
    if (!shouldEnqueue) {
      return;
    }

    try {
      await this.queueService.enqueueItem(
        orgId,
        itemMeta.id,
        mongoRef,
        prepared.pipelinePriority !== undefined ? { priority: prepared.pipelinePriority } : {},
        {
          pipelineJobId: prepared.pipelineJobId,
          sourceId: prepared.sourceId
        }
      );
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("already exists"))) {
        throw error;
      }
    }
  }

  private writeCreateFromCrawlResultAuditLog(
    orgId: string,
    userId: string,
    crawlResult: Pick<CrawlResultItemIngestRow, "id" | "sourceUrl" | "taskId">
  ) {
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

  parsePayload(payload: Record<string, unknown>): NormalizedNewsPayload {
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
