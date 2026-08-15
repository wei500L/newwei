import {
  ItemReadModelModel,
  ProcessedItemModel,
  RawItemModel,
  type ItemReadModel,
  type MongoConnection,
} from "@modular/mongo";
import { Inject, Injectable } from "@nestjs/common";
import { Types, type PipelineStage } from "mongoose";

import { EnvService } from "../config/config.service";
import { MONGO_CONNECTION } from "../config/mongo.provider";
import { PrismaService } from "../config/prisma.service";

import {
  type ItemReadModelProcessedSnapshotInput,
  type ItemReadModelRawSnapshotInput,
  buildItemReadModelDocument,
} from "./item-read-model.utils";
import { buildBaseWhere } from "./items-search.helpers";
import {
  ITEM_READ_MODEL_HYDRATE_BATCH_SIZE,
  ITEM_READ_MODEL_META_ROW_PROJECTION,
  PROCESSED_READ_MODEL_SNAPSHOT_PROJECTION,
  type ItemMetaRow,
  type ItemReadModelHydrationRecord,
  type ItemReadModelSourceResolutionRecord,
} from "./items.shared";

@Injectable()
export class ItemsReadModelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    @Inject(MONGO_CONNECTION) private readonly _mongo: MongoConnection,
  ) {
    void this._mongo;
  }

  isReadModelEnabled() {
    return Boolean((this.env as { itemsReadModelEnabled?: boolean } | undefined)?.itemsReadModelEnabled);
  }

  isVectorHardFailEnabled() {
    return Boolean(
      (this.env as { itemsVectorHardFailEnabled?: boolean } | undefined)?.itemsVectorHardFailEnabled,
    );
  }

  itemMetaRowFromReadModel(doc: ItemReadModel): ItemMetaRow {
    return {
      id: doc.meta.id,
      orgId: doc.orgId,
      externalId: doc.meta.externalId,
      name: doc.meta.name,
      status: doc.meta.status,
      mongoRef: doc.meta.mongoRef,
      version: doc.meta.version,
      publishedAt: doc.meta.publishedAt ?? null,
      sortAt: doc.meta.sortAt ?? doc.meta.createdAt,
      createdAt: doc.meta.createdAt,
      updatedAt: doc.meta.updatedAt,
    };
  }

  private toRawReadModelSnapshot(rawDoc: unknown): ItemReadModelRawSnapshotInput | null {
    if (!rawDoc || typeof rawDoc !== "object") {
      return null;
    }
    const record = rawDoc as {
      _id?: { toString(): string };
      id?: string;
      itemMetaId?: unknown;
      source?: unknown;
      payload?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const id =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : typeof record._id?.toString === "function"
          ? record._id.toString()
          : "";
    const itemMetaId =
      typeof record.itemMetaId === "string" && record.itemMetaId.trim().length > 0
        ? record.itemMetaId.trim()
        : "";
    const createdAt = record.createdAt instanceof Date ? record.createdAt : null;
    const updatedAt = record.updatedAt instanceof Date ? record.updatedAt : createdAt;
    if (!id || !itemMetaId || !createdAt || !updatedAt) {
      return null;
    }
    return {
      id,
      itemMetaId,
      source: typeof record.source === "string" ? record.source : null,
      payload:
        record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
          ? (record.payload as Record<string, unknown>)
          : {},
      createdAt,
      updatedAt,
    };
  }

  private toProcessedReadModelSnapshot(
    processedDoc: unknown,
  ): ItemReadModelProcessedSnapshotInput | null {
    if (!processedDoc || typeof processedDoc !== "object") {
      return null;
    }
    const record = processedDoc as {
      _id?: { toString(): string };
      id?: string;
      itemMetaId?: unknown;
      rawItemId?: unknown;
      pipelineJobId?: unknown;
      sourceId?: unknown;
      status?: unknown;
      error?: unknown;
      tags?: unknown;
      result?: unknown;
      duplicateOf?: unknown;
      duplicateSimilarity?: unknown;
      summaryEmbedding?: unknown;
      summaryEmbeddingModel?: unknown;
      summaryEmbeddingDimensions?: unknown;
      llm?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const id =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : typeof record._id?.toString === "function"
          ? record._id.toString()
          : "";
    const itemMetaId =
      typeof record.itemMetaId === "string" && record.itemMetaId.trim().length > 0
        ? record.itemMetaId.trim()
        : "";
    const status = typeof record.status === "string" ? record.status : "";
    const createdAt = record.createdAt instanceof Date ? record.createdAt : null;
    const updatedAt = record.updatedAt instanceof Date ? record.updatedAt : createdAt;
    if (!id || !itemMetaId || !status || !createdAt || !updatedAt) {
      return null;
    }
    const rawItemId =
      typeof record.rawItemId === "string"
        ? record.rawItemId.trim()
        : typeof (record.rawItemId as { toString?: () => string } | undefined)?.toString === "function"
          ? (record.rawItemId as { toString(): string }).toString()
          : "";
    const duplicateOf =
      typeof record.duplicateOf === "string"
        ? record.duplicateOf.trim()
        : typeof (record.duplicateOf as { toString?: () => string } | undefined)?.toString === "function"
          ? (record.duplicateOf as { toString(): string }).toString()
          : "";
    const summaryEmbeddingDimensions =
      typeof record.summaryEmbeddingDimensions === "number" &&
      Number.isFinite(record.summaryEmbeddingDimensions)
        ? record.summaryEmbeddingDimensions
        : Array.isArray(record.summaryEmbedding)
          ? record.summaryEmbedding.length
          : null;
    const errorRaw =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as { message?: unknown; name?: unknown })
        : null;
    return {
      id,
      itemMetaId,
      rawItemId: rawItemId || null,
      pipelineJobId: typeof record.pipelineJobId === "string" ? record.pipelineJobId.trim() : null,
      sourceId: typeof record.sourceId === "string" ? record.sourceId.trim() : null,
      status,
      error: errorRaw
        ? {
            message:
              typeof errorRaw.message === "string" && errorRaw.message.trim().length > 0
                ? errorRaw.message
                : "Unknown error",
            name: typeof errorRaw.name === "string" ? errorRaw.name : null,
          }
        : null,
      tags: Array.isArray(record.tags)
        ? record.tags
            .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
            .filter((tag): tag is string => Boolean(tag))
        : [],
      result:
        typeof record.result === "string" ||
        (record.result && typeof record.result === "object" && !Array.isArray(record.result))
          ? (record.result as string | Record<string, unknown>)
          : null,
      duplicateOf: duplicateOf || null,
      duplicateSimilarity:
        typeof record.duplicateSimilarity === "number" && Number.isFinite(record.duplicateSimilarity)
          ? record.duplicateSimilarity
          : null,
      summaryEmbeddingModel:
        typeof record.summaryEmbeddingModel === "string" ? record.summaryEmbeddingModel.trim() : null,
      summaryEmbeddingDimensions,
      llm:
        record.llm && typeof record.llm === "object" && !Array.isArray(record.llm)
          ? (record.llm as ItemReadModelProcessedSnapshotInput["llm"])
          : null,
      createdAt,
      updatedAt,
    };
  }

  private extractSourceIdFromTaskConfig(config: unknown): string | undefined {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return undefined;
    }
    const record = config as Record<string, unknown>;
    const direct =
      typeof record.sourceId === "string" && record.sourceId.trim().length > 0
        ? record.sourceId.trim()
        : undefined;
    if (direct) {
      return direct;
    }
    const itemPayload =
      record.itemPayload && typeof record.itemPayload === "object" && !Array.isArray(record.itemPayload)
        ? (record.itemPayload as Record<string, unknown>)
        : null;
    const metadata =
      itemPayload?.metadata && typeof itemPayload.metadata === "object" && !Array.isArray(itemPayload.metadata)
        ? (itemPayload.metadata as Record<string, unknown>)
        : null;
    return typeof metadata?.sourceId === "string" && metadata.sourceId.trim().length > 0
      ? metadata.sourceId.trim()
      : undefined;
  }

  private extractCrawlResultIdFromExternalId(externalId: string): string | undefined {
    const raw = externalId.trim();
    if (!raw) {
      return undefined;
    }
    const prefixes = ["crawlResult:", "crawl:"];
    for (const prefix of prefixes) {
      if (raw.startsWith(prefix)) {
        const candidate = raw.slice(prefix.length).trim();
        if (candidate) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  private extractRawMetadata(payload?: Record<string, unknown> | null) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const metadata =
      payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null;
    return metadata;
  }

  private normalizeReadModelItemMetaIds(ids: string[]) {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const value of ids) {
      if (typeof value !== "string") {
        continue;
      }
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      unique.push(normalized);
    }
    return unique;
  }

  private toItemMetaRow(record: {
    id: string;
    orgId: string;
    externalId: string;
    name: string;
    status: string;
    mongoRef: string;
    version: number;
    publishedAt: Date | null;
    sortAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }): ItemMetaRow {
    return {
      id: record.id,
      orgId: record.orgId,
      externalId: record.externalId,
      name: record.name,
      status: record.status,
      mongoRef: record.mongoRef,
      version: record.version,
      publishedAt: record.publishedAt ?? null,
      sortAt: record.sortAt ?? record.createdAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private buildLatestItemSnapshotPipeline(itemMetaIds: string[]): PipelineStage[] {
    return [
      {
        $match: {
          itemMetaId: { $in: itemMetaIds },
        },
      },
      {
        $sort: {
          itemMetaId: 1,
          createdAt: -1,
          _id: -1,
        },
      },
      {
        $group: {
          _id: "$itemMetaId",
          doc: { $first: "$$ROOT" },
        },
      },
      {
        $replaceRoot: {
          newRoot: "$doc",
        },
      },
    ];
  }

  private async findItemReadModelsByIds(orgId: string, itemMetaIds: string[]) {
    if (itemMetaIds.length === 0) {
      return new Map<string, ItemReadModel>();
    }
    const docs = (await ItemReadModelModel.find(
      {
        orgId,
        itemMetaId: { $in: itemMetaIds },
      },
      ITEM_READ_MODEL_META_ROW_PROJECTION,
    ).lean()) as ItemReadModel[];
    const byId = new Map<string, ItemReadModel>();
    for (const doc of docs) {
      if (!doc?.itemMetaId || byId.has(doc.itemMetaId)) {
        continue;
      }
      byId.set(doc.itemMetaId, doc);
    }
    return byId;
  }

  private async loadRawReadModelSnapshots(metas: ItemMetaRow[]) {
    const rawByItemMetaId = new Map<string, ItemReadModelRawSnapshotInput>();
    const referencedMongoRefs = Array.from(
      new Set(
        metas
          .map((meta) => meta.mongoRef.trim())
          .filter(
            (mongoRef) => mongoRef.length > 0 && Types.ObjectId.isValid(mongoRef),
          ),
      ),
    );
    const latestRawIds = metas
      .filter((meta) => meta.mongoRef.trim().length === 0)
      .map((meta) => meta.id);

    const [referencedRawDocs, latestRawDocs] = await Promise.all([
      referencedMongoRefs.length > 0
        ? RawItemModel.find({
            _id: { $in: referencedMongoRefs },
          }).lean()
        : Promise.resolve([]),
      latestRawIds.length > 0
        ? RawItemModel.aggregate(this.buildLatestItemSnapshotPipeline(latestRawIds))
        : Promise.resolve([]),
    ]);

    for (const rawDoc of [...referencedRawDocs, ...latestRawDocs]) {
      const snapshot = this.toRawReadModelSnapshot(rawDoc);
      if (!snapshot || rawByItemMetaId.has(snapshot.itemMetaId)) {
        continue;
      }
      rawByItemMetaId.set(snapshot.itemMetaId, snapshot);
    }

    return rawByItemMetaId;
  }

  private async loadProcessedReadModelSnapshots(itemMetaIds: string[]) {
    if (itemMetaIds.length === 0) {
      return new Map<string, ItemReadModelProcessedSnapshotInput>();
    }

    const docs = await ProcessedItemModel.aggregate([
      ...this.buildLatestItemSnapshotPipeline(itemMetaIds),
      { $project: PROCESSED_READ_MODEL_SNAPSHOT_PROJECTION },
    ]);
    const processedByItemMetaId = new Map<string, ItemReadModelProcessedSnapshotInput>();
    for (const processedDoc of docs) {
      const snapshot = this.toProcessedReadModelSnapshot(processedDoc);
      if (!snapshot || processedByItemMetaId.has(snapshot.itemMetaId)) {
        continue;
      }
      processedByItemMetaId.set(snapshot.itemMetaId, snapshot);
    }

    return processedByItemMetaId;
  }

  private async resolveReadModelSourceIds(
    orgId: string,
    records: ItemReadModelHydrationRecord[],
  ) {
    const sourceIdByItemMetaId = new Map<string, string>();
    const pipelineJobIds = new Set<string>();
    const crawlResultIds = new Set<string>();
    const unresolved: ItemReadModelSourceResolutionRecord[] = [];

    for (const record of records) {
      const directProcessed =
        typeof record.processed?.sourceId === "string" && record.processed.sourceId.trim().length > 0
          ? record.processed.sourceId.trim()
          : undefined;
      if (directProcessed) {
        sourceIdByItemMetaId.set(record.meta.id, directProcessed);
        continue;
      }

      const rawMetadata = this.extractRawMetadata(record.raw?.payload ?? null);
      const rawSourceId =
        typeof rawMetadata?.sourceId === "string" && rawMetadata.sourceId.trim().length > 0
          ? rawMetadata.sourceId.trim()
          : undefined;
      if (rawSourceId) {
        sourceIdByItemMetaId.set(record.meta.id, rawSourceId);
        continue;
      }

      const pipelineJobCandidates = Array.from(
        new Set(
          [
            record.processed?.pipelineJobId,
            typeof rawMetadata?.pipelineJobId === "string" ? rawMetadata.pipelineJobId.trim() : undefined,
          ].filter((value): value is string => Boolean(value && value.trim().length > 0)),
        ),
      );
      const crawlResultCandidates = Array.from(
        new Set(
          [
            typeof rawMetadata?.crawlResultId === "string" ? rawMetadata.crawlResultId.trim() : undefined,
            this.extractCrawlResultIdFromExternalId(record.meta.externalId),
          ].filter((value): value is string => Boolean(value && value.trim().length > 0)),
        ),
      );

      if (pipelineJobCandidates.length === 0 && crawlResultCandidates.length === 0) {
        continue;
      }

      unresolved.push({
        itemMetaId: record.meta.id,
        pipelineJobIds: pipelineJobCandidates,
        crawlResultIds: crawlResultCandidates,
      });
      for (const pipelineJobId of pipelineJobCandidates) {
        pipelineJobIds.add(pipelineJobId);
      }
      for (const crawlResultId of crawlResultCandidates) {
        crawlResultIds.add(crawlResultId);
      }
    }

    const [pipelineJobs, crawlResults] = await Promise.all([
      pipelineJobIds.size > 0
        ? this.prisma.pipelineJob.findMany({
            where: {
              orgId,
              id: { in: Array.from(pipelineJobIds) },
              sourceId: { not: null },
            },
            select: {
              id: true,
              sourceId: true,
            },
          })
        : Promise.resolve([]),
      crawlResultIds.size > 0
        ? this.prisma.crawlResult.findMany({
            where: {
              id: { in: Array.from(crawlResultIds) },
              task: { orgId },
            },
            select: {
              id: true,
              task: {
                select: {
                  config: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const sourceIdByPipelineJobId = new Map<string, string>();
    for (const pipelineJob of pipelineJobs) {
      const sourceId =
        typeof pipelineJob.sourceId === "string" && pipelineJob.sourceId.trim().length > 0
          ? pipelineJob.sourceId.trim()
          : "";
      if (!sourceId || sourceIdByPipelineJobId.has(pipelineJob.id)) {
        continue;
      }
      sourceIdByPipelineJobId.set(pipelineJob.id, sourceId);
    }

    const sourceIdByCrawlResultId = new Map<string, string>();
    for (const crawlResult of crawlResults) {
      const sourceId = this.extractSourceIdFromTaskConfig(crawlResult.task.config);
      if (!sourceId || sourceIdByCrawlResultId.has(crawlResult.id)) {
        continue;
      }
      sourceIdByCrawlResultId.set(crawlResult.id, sourceId);
    }

    for (const record of unresolved) {
      const pipelineSourceId = record.pipelineJobIds
        .map((pipelineJobId) => sourceIdByPipelineJobId.get(pipelineJobId))
        .find((value): value is string => Boolean(value));
      if (pipelineSourceId) {
        sourceIdByItemMetaId.set(record.itemMetaId, pipelineSourceId);
        continue;
      }

      const crawlSourceId = record.crawlResultIds
        .map((crawlResultId) => sourceIdByCrawlResultId.get(crawlResultId))
        .find((value): value is string => Boolean(value));
      if (crawlSourceId) {
        sourceIdByItemMetaId.set(record.itemMetaId, crawlSourceId);
      }
    }

    return sourceIdByItemMetaId;
  }

  async hydrateItemReadModelsBatch(orgId: string, itemMetaIds: string[]) {
    const uniqueIds = this.normalizeReadModelItemMetaIds(itemMetaIds);
    const hydratedById = new Map<string, ItemReadModel>();

    for (let index = 0; index < uniqueIds.length; index += ITEM_READ_MODEL_HYDRATE_BATCH_SIZE) {
      const batchIds = uniqueIds.slice(index, index + ITEM_READ_MODEL_HYDRATE_BATCH_SIZE);
      const metaRows = await this.prisma.itemMeta.findMany({
        where: {
          orgId,
          id: { in: batchIds },
        },
        select: {
          id: true,
          orgId: true,
          externalId: true,
          name: true,
          status: true,
          mongoRef: true,
          version: true,
          publishedAt: true,
          sortAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const metaById = new Map<string, ItemMetaRow>(
        metaRows.map((row) => [row.id, this.toItemMetaRow(row)]),
      );
      const metas = batchIds
        .map((itemMetaId) => metaById.get(itemMetaId))
        .filter((meta): meta is ItemMetaRow => Boolean(meta));
      if (metas.length === 0) {
        continue;
      }

      const [rawByItemMetaId, processedByItemMetaId] = await Promise.all([
        this.loadRawReadModelSnapshots(metas),
        this.loadProcessedReadModelSnapshots(metas.map((meta) => meta.id)),
      ]);
      const records: ItemReadModelHydrationRecord[] = metas.map((meta) => ({
        meta,
        raw: rawByItemMetaId.get(meta.id) ?? null,
        processed: processedByItemMetaId.get(meta.id) ?? null,
      }));
      const sourceIdByItemMetaId = await this.resolveReadModelSourceIds(orgId, records);
      const docs = records.map((record) => {
        const doc = buildItemReadModelDocument({
          meta: record.meta,
          raw: record.raw ?? undefined,
          processed: record.processed ?? undefined,
          sourceId: sourceIdByItemMetaId.get(record.meta.id),
        });
        if (!record.raw) {
          delete (doc as Partial<ItemReadModel>).raw;
        }
        if (!record.processed) {
          delete (doc as Partial<ItemReadModel>).processed;
        }
        return doc;
      });

      // A missing snapshot at hydration time (raw/processed not created yet)
      // must not be persisted as an explicit null: the GraphQL resolvers
      // treat a read-model document with a null snapshot as authoritative and
      // skip the Mongo loaders, so a null placeholder would permanently mask
      // data that arrives later. Unset the field instead so resolvers fall
      // back to the loaders until the outbox delivery populates it.
      await ItemReadModelModel.bulkWrite(
        docs.map((doc) => ({
          updateOne: {
            filter: {
              orgId: doc.orgId,
              itemMetaId: doc.itemMetaId,
            },
            update: {
              $set: doc,
              $unset: {
                ...(doc.raw ? {} : { raw: 1 }),
                ...(doc.processed ? {} : { processed: 1 }),
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );

      for (const doc of docs) {
        hydratedById.set(doc.itemMetaId, doc);
      }
    }

    return hydratedById;
  }

  async loadItemReadModel(orgId: string, itemMetaId: string, hydrateMissing = true) {
    const normalizedItemMetaId = itemMetaId.trim();
    const doc = (await ItemReadModelModel.findOne({
      orgId,
      itemMetaId: normalizedItemMetaId,
    }).lean()) as ItemReadModel | null;
    if (doc || !hydrateMissing) {
      return doc;
    }
    return (await this.hydrateItemReadModelsBatch(orgId, [normalizedItemMetaId])).get(normalizedItemMetaId) ?? null;
  }

  async hydrateItemReadModel(orgId: string, itemMetaId: string) {
    const normalizedItemMetaId = itemMetaId.trim();
    return (await this.hydrateItemReadModelsBatch(orgId, [normalizedItemMetaId])).get(normalizedItemMetaId) ?? null;
  }

  async loadItemReadModelsByIds(orgId: string, ids: string[]) {
    const uniqueIds = this.normalizeReadModelItemMetaIds(ids);
    if (uniqueIds.length === 0) {
      return new Map<string, ItemReadModel>();
    }

    const byId = await this.findItemReadModelsByIds(orgId, uniqueIds);
    const missing = uniqueIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      const hydratedById = await this.hydrateItemReadModelsBatch(orgId, missing);
      for (const itemMetaId of missing) {
        const hydrated = hydratedById.get(itemMetaId);
        if (hydrated) {
          byId.set(itemMetaId, hydrated);
        }
      }
    }

    return byId;
  }

  async fetchItemMetaRowsByIds(orgId: string, ids: string[]) {
    if (ids.length === 0) {
      return new Map<string, ItemMetaRow>();
    }
    if (this.isReadModelEnabled()) {
      const docsById = await this.loadItemReadModelsByIds(orgId, ids);
      return new Map(
        ids
          .map((id) => {
            const doc = docsById.get(id);
            return doc ? ([id, this.itemMetaRowFromReadModel(doc)] as const) : null;
          })
          .filter((entry): entry is readonly [string, ItemMetaRow] => Boolean(entry)),
      );
    }
    const rows = await this.prisma.itemMeta.findMany({
      where: {
        ...buildBaseWhere(orgId),
        id: { in: ids }
      }
    });
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          orgId: row.orgId,
          externalId: row.externalId,
          name: row.name,
          status: row.status,
          mongoRef: row.mongoRef,
          version: row.version,
          publishedAt: row.publishedAt ?? null,
          sortAt: row.sortAt ?? row.createdAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } satisfies ItemMetaRow,
      ]),
    );
  }
}
