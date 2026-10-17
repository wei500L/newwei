import {
  ItemReadModelModel,
  ProcessedItemModel,
  RawItemModel,
  asLeanRecords,
  isRecord,
  leanId,
  type ItemReadModel,
} from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import type { ItemMeta } from "@prisma/client";
import DataLoader from "dataloader";
import { Types } from "mongoose";

import { EnvService } from "../../modules/config/config.service";
import { PrismaService } from "../../modules/config/prisma.service";

import type { ProcessedItemPreviewDoc } from "./processed-item-preview.loader";
import type { ProcessedItemDoc } from "./processed-item.loader";
import type { RawItemPreviewDoc } from "./raw-item-preview.loader";
import type { RawItemDoc } from "./raw-item.loader";

/**
 * Request-scoped, organization-bound reader for the nested fields of the
 * GraphQL `ItemModel` and for the raw/processed/read-model snapshots the read
 * model hydration chain needs.
 *
 * Background (IR1): the pre-existing `ItemMetaLoader`, `RawItemLoader`,
 * `RawItemPreviewLoader`, `ProcessedItem*Loader`, and `ItemReadModel*Loader`
 * batch queries only ever filtered on `itemMetaId`/`id`. MySQL `ItemMeta.id` is
 * unique per organization, but Mongo documents are not: a `ProcessedItem`,
 * `ItemReadModel`, or `RawItem` document owned by organization B can carry the
 * same `itemMetaId` string as organization A's item. Without an `orgId`
 * predicate (or, for `RawItem`, which has no `orgId` column, without binding
 * the document `_id` back to A's trusted `ItemMeta.mongoRef`) that document
 * would be returned to A.
 *
 * Every loader produced here is therefore bound to exactly one `orgId` taken
 * from the authenticated request, and every batch query carries that `orgId`
 * (or the verified `mongoRef` + `itemMetaId` pair). Cache maps are keyed by
 * `orgId` as well, so two organizations inside one request can never share a
 * DataLoader instance.
 *
 * The class intentionally mirrors the projection split of the legacy loaders
 * (`full` / `scalar` / `preview` for processed items, `raw` / `rawPreview` for
 * raw items, and the five read-model projections) so the resolver keeps its
 * existing fallback order and only the tenant binding changes.
 */

/** Read-model projections reused by the five read-model loaders. */
type ScopedReadModelProjection = Record<string, 1>;

const READ_MODEL_META_PROJECTION: ScopedReadModelProjection = {
  orgId: 1,
  itemMetaId: 1,
  publishedAt: 1,
  "meta.id": 1,
  "meta.externalId": 1,
  "meta.name": 1,
  "meta.status": 1,
  "meta.mongoRef": 1,
  "meta.version": 1,
  "meta.publishedAt": 1,
  "meta.sortAt": 1,
  "meta.createdAt": 1,
  "meta.updatedAt": 1,
};

const READ_MODEL_RAW_PROJECTION: ScopedReadModelProjection = {
  orgId: 1,
  itemMetaId: 1,
  raw: 1,
};

const READ_MODEL_RAW_PREVIEW_PROJECTION: ScopedReadModelProjection = {
  orgId: 1,
  itemMetaId: 1,
  "raw.payload.url": 1,
  "raw.payload.link": 1,
  "raw.payload.sourceUrl": 1,
  "raw.payload.sourceName": 1,
  "raw.payload.source_name": 1,
  "raw.payload.source": 1,
  "raw.payload.publisher": 1,
  "raw.payload.siteName": 1,
  "raw.payload.site_name": 1,
  "raw.payload.thumbnail": 1,
  "raw.payload.thumbnailUrl": 1,
  "raw.payload.image": 1,
  "raw.payload.imageUrl": 1,
  "raw.payload.image_url": 1,
  "raw.payload.summary": 1,
  "raw.payload.abstract": 1,
  "raw.payload.description": 1,
  "raw.payload.sentiment_label": 1,
  "raw.payload.sentimentLabel": 1,
  "raw.payload.sentiment": 1,
  "raw.payload.region": 1,
  "raw.payload.country": 1,
  "raw.payload.area": 1,
  "raw.payload.location": 1,
  "raw.payload.ticker": 1,
  "raw.payload.symbol": 1,
  "raw.payload.price": 1,
  "raw.payload.changePercent": 1,
  "raw.payload.change_percent": 1,
  "raw.payload.change": 1,
  "raw.payload.history": 1,
  "raw.payload.metadata.thumbnail": 1,
  "raw.payload.metadata.thumbnailUrl": 1,
  "raw.payload.metadata.image": 1,
  "raw.payload.metadata.imageUrl": 1,
  "raw.payload.metadata.image_url": 1,
  "raw.payload.metadata.summary": 1,
  "raw.payload.metadata.abstract": 1,
  "raw.payload.metadata.description": 1,
  "raw.payload.metadata.sentiment_label": 1,
  "raw.payload.metadata.sentimentLabel": 1,
  "raw.payload.metadata.sentiment": 1,
  "raw.payload.metadata.region": 1,
  "raw.payload.metadata.country": 1,
  "raw.payload.metadata.area": 1,
  "raw.payload.metadata.location": 1,
  "raw.payload.metadata.ticker": 1,
  "raw.payload.metadata.symbol": 1,
  "raw.payload.metadata.price": 1,
  "raw.payload.metadata.changePercent": 1,
  "raw.payload.metadata.change_percent": 1,
  "raw.payload.metadata.change": 1,
  "raw.payload.metadata.history": 1,
};

const READ_MODEL_PROCESSED_PROJECTION: ScopedReadModelProjection = {
  orgId: 1,
  itemMetaId: 1,
  processed: 1,
};

const READ_MODEL_PROCESSED_PREVIEW_PROJECTION: ScopedReadModelProjection = {
  orgId: 1,
  itemMetaId: 1,
  publishedAt: 1,
  sourceName: 1,
  title: 1,
  language: 1,
  summary: 1,
  sentiment: 1,
  contentType: 1,
  topics: 1,
  entities: 1,
  qualityScore: 1,
  location: 1,
  region: 1,
  "processed.id": 1,
  "processed.itemMetaId": 1,
  "processed.status": 1,
  "processed.error": 1,
  "processed.tags": 1,
  "processed.duplicateOf": 1,
  "processed.duplicateSimilarity": 1,
  "processed.summaryEmbeddingModel": 1,
  "processed.summaryEmbeddingDimensions": 1,
  "processed.llm": 1,
  "processed.createdAt": 1,
};

const PROCESSED_ITEM_SCALAR_PROJECTION: Record<string, 1> = {
  itemMetaId: 1,
  status: 1,
  error: 1,
  tags: 1,
  duplicateOf: 1,
  duplicateSimilarity: 1,
  summaryEmbeddingModel: 1,
  summaryEmbeddingDimensions: 1,
  llm: 1,
  createdAt: 1,
  updatedAt: 1,
};

const PROCESSED_ITEM_FULL_PROJECTION: Record<string, 1> = {
  ...PROCESSED_ITEM_SCALAR_PROJECTION,
  result: 1,
};

const PROCESSED_ITEM_PREVIEW_PROJECTION: Record<string, 1> = {
  itemMetaId: 1,
  status: 1,
  tags: 1,
  duplicateOf: 1,
  duplicateSimilarity: 1,
  llm: 1,
  createdAt: 1,
  updatedAt: 1,
  "result.published_at": 1,
  "result.publishedAt": 1,
  "result.source": 1,
  "result.sourceName": 1,
  "result.source_name": 1,
  "result.title": 1,
  "result.headline": 1,
  "result.title_zh": 1,
  "result.titleZh": 1,
  "result.language": 1,
  "result.lang": 1,
  "result.summary": 1,
  "result.abstract": 1,
  "result.content_type": 1,
  "result.contentType": 1,
  "result.sentiment": 1,
  "result.sentiment_label": 1,
  "result.sentimentLabel": 1,
  "result.topics": 1,
  "result.entities": 1,
  "result.quality_score": 1,
  "result.qualityScore": 1,
  "result.location": 1,
  "result.region": 1,
};

const RAW_ITEM_PREVIEW_PROJECTION: Record<string, 1> = {
  itemMetaId: 1,
  source: 1,
  createdAt: 1,
  updatedAt: 1,
  "payload.url": 1,
  "payload.link": 1,
  "payload.sourceUrl": 1,
  "payload.sourceName": 1,
  "payload.source_name": 1,
  "payload.source": 1,
  "payload.publisher": 1,
  "payload.siteName": 1,
  "payload.site_name": 1,
  "payload.publishedAt": 1,
  "payload.published_at": 1,
  "payload.thumbnail": 1,
  "payload.thumbnailUrl": 1,
  "payload.image": 1,
  "payload.imageUrl": 1,
  "payload.image_url": 1,
  "payload.summary": 1,
  "payload.abstract": 1,
  "payload.description": 1,
  "payload.sentiment_label": 1,
  "payload.sentimentLabel": 1,
  "payload.sentiment": 1,
  "payload.region": 1,
  "payload.country": 1,
  "payload.area": 1,
  "payload.location": 1,
  "payload.ticker": 1,
  "payload.symbol": 1,
  "payload.price": 1,
  "payload.changePercent": 1,
  "payload.change_percent": 1,
  "payload.change": 1,
  "payload.history": 1,
  "payload.metadata.thumbnail": 1,
  "payload.metadata.thumbnailUrl": 1,
  "payload.metadata.image": 1,
  "payload.metadata.imageUrl": 1,
  "payload.metadata.image_url": 1,
  "payload.metadata.summary": 1,
  "payload.metadata.abstract": 1,
  "payload.metadata.description": 1,
  "payload.metadata.sentiment_label": 1,
  "payload.metadata.sentimentLabel": 1,
  "payload.metadata.sentiment": 1,
  "payload.metadata.region": 1,
  "payload.metadata.country": 1,
  "payload.metadata.area": 1,
  "payload.metadata.location": 1,
  "payload.metadata.ticker": 1,
  "payload.metadata.symbol": 1,
  "payload.metadata.price": 1,
  "payload.metadata.changePercent": 1,
  "payload.metadata.change_percent": 1,
  "payload.metadata.change": 1,
  "payload.metadata.history": 1,
};

function statusPriority(status: string): number {
  switch (status) {
    case "completed":
      return 3;
    case "failed":
      return 2;
    case "processing":
      return 1;
    case "pending":
    default:
      return 0;
  }
}

function mapProcessedItemRecord(doc: Record<string, unknown>): ProcessedItemDoc | null {
  const id = leanId(doc._id);
  const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId : "";
  if (!id || !itemMetaId) {
    return null;
  }
  const summaryEmbeddingModel =
    typeof doc.summaryEmbeddingModel === "string" ? doc.summaryEmbeddingModel : null;
  const summaryEmbeddingDimensions =
    typeof doc.summaryEmbeddingDimensions === "number" &&
    Number.isFinite(doc.summaryEmbeddingDimensions)
      ? doc.summaryEmbeddingDimensions
      : null;

  const errorRaw = doc.error;
  const error =
    errorRaw && typeof errorRaw === "object" && !Array.isArray(errorRaw)
      ? {
          message:
            typeof Reflect.get(errorRaw, "message") === "string"
              ? String(Reflect.get(errorRaw, "message"))
              : "Unknown error",
          name:
            typeof Reflect.get(errorRaw, "name") === "string"
              ? String(Reflect.get(errorRaw, "name"))
              : null,
        }
      : null;

  const duplicateOf = doc.duplicateOf;
  const result = doc.result;

  return {
    id,
    itemMetaId,
    status: typeof doc.status === "string" ? doc.status : "pending",
    error,
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    result:
      result === null ||
      typeof result === "string" ||
      (typeof result === "object" && !Array.isArray(result))
        ? (result as ProcessedItemDoc["result"])
        : undefined,
    duplicateOf: duplicateOf ? String(duplicateOf) : null,
    duplicateSimilarity:
      typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null,
    summaryEmbeddingModel,
    summaryEmbeddingDimensions,
    llm:
      typeof doc.llm === "object" && doc.llm !== null && !Array.isArray(doc.llm)
        ? (doc.llm as ProcessedItemDoc["llm"])
        : undefined,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
  };
}

@Injectable({ scope: Scope.REQUEST })
export class ScopedItemsReadingLoader {
  private readonly itemMetaByOrg = new Map<string, DataLoader<string, ItemMeta | null>>();
  private readonly readModelByOrgAndProjection = new Map<
    string,
    DataLoader<string, ItemReadModel | null>
  >();
  private readonly rawItemByOrg = new Map<string, DataLoader<string, RawItemDoc | null>>();
  private readonly rawItemPreviewByOrg = new Map<
    string,
    DataLoader<string, RawItemPreviewDoc | null>
  >();
  private readonly processedByOrgAndProjection = new Map<
    string,
    DataLoader<string, ProcessedItemDoc | null>
  >();
  private readonly processedPreviewByOrg = new Map<
    string,
    DataLoader<string, ProcessedItemPreviewDoc | null>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  /**
   * Organization-scoped MySQL `ItemMeta` loader. The tenant predicate is the
   * whole point: the legacy `ItemMetaLoader` looked ids up without `orgId`, so
   * a foreign id would resolve to another organization's row.
   */
  itemMeta(orgId: string): DataLoader<string, ItemMeta | null> {
    const existing = this.itemMetaByOrg.get(orgId);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, ItemMeta | null>(async (keys) => {
      const ids = [...new Set((keys as string[]).map((key) => key.trim()).filter(Boolean))];
      if (ids.length === 0) {
        return (keys as string[]).map(() => null);
      }
      const rows = await this.prisma.itemMeta.findMany({
        where: { orgId, id: { in: ids } },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return (keys as string[]).map((key) => byId.get(key.trim()) ?? null);
    });
    this.itemMetaByOrg.set(orgId, loader);
    return loader;
  }

  readModelMeta(orgId: string): DataLoader<string, ItemReadModel | null> {
    return this.readModelLoader(orgId, "meta", READ_MODEL_META_PROJECTION);
  }

  readModelRaw(orgId: string): DataLoader<string, ItemReadModel | null> {
    return this.readModelLoader(orgId, "raw", READ_MODEL_RAW_PROJECTION);
  }

  readModelRawPreview(orgId: string): DataLoader<string, ItemReadModel | null> {
    return this.readModelLoader(orgId, "rawPreview", READ_MODEL_RAW_PREVIEW_PROJECTION);
  }

  readModelProcessed(orgId: string): DataLoader<string, ItemReadModel | null> {
    return this.readModelLoader(orgId, "processed", READ_MODEL_PROCESSED_PROJECTION);
  }

  readModelProcessedPreview(orgId: string): DataLoader<string, ItemReadModel | null> {
    return this.readModelLoader(
      orgId,
      "processedPreview",
      READ_MODEL_PROCESSED_PREVIEW_PROJECTION,
    );
  }

  rawItem(orgId: string): DataLoader<string, RawItemDoc | null> {
    const existing = this.rawItemByOrg.get(orgId);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, RawItemDoc | null>((keys) =>
      this.loadRawItems(orgId, keys as string[], null),
    );
    this.rawItemByOrg.set(orgId, loader);
    return loader;
  }

  rawItemPreview(orgId: string): DataLoader<string, RawItemPreviewDoc | null> {
    const existing = this.rawItemPreviewByOrg.get(orgId);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, RawItemPreviewDoc | null>((keys) =>
      this.loadRawItems(orgId, keys as string[], RAW_ITEM_PREVIEW_PROJECTION),
    );
    this.rawItemPreviewByOrg.set(orgId, loader);
    return loader;
  }

  processedItemFull(orgId: string): DataLoader<string, ProcessedItemDoc | null> {
    return this.processedLoader(orgId, "full", PROCESSED_ITEM_FULL_PROJECTION);
  }

  processedItemScalar(orgId: string): DataLoader<string, ProcessedItemDoc | null> {
    return this.processedLoader(orgId, "scalar", PROCESSED_ITEM_SCALAR_PROJECTION);
  }

  processedItemPreview(orgId: string): DataLoader<string, ProcessedItemPreviewDoc | null> {
    const existing = this.processedPreviewByOrg.get(orgId);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, ProcessedItemPreviewDoc | null>(async (keys) => {
      const itemMetaIds = this.normalizeKeys(keys as string[]);
      if (itemMetaIds.length === 0) {
        return (keys as string[]).map(() => null);
      }
      const docs = asLeanRecords(
        await ProcessedItemModel.find(
          { orgId, itemMetaId: { $in: itemMetaIds } },
          PROCESSED_ITEM_PREVIEW_PROJECTION,
        )
          .sort({ createdAt: -1 })
          .lean(),
      );
      const byItemMetaId = new Map<string, ProcessedItemPreviewDoc>();
      for (const doc of docs) {
        const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId : "";
        const id = leanId(doc._id);
        if (!itemMetaId || !id) {
          continue;
        }
        const candidate: ProcessedItemPreviewDoc = {
          id,
          itemMetaId,
          status: typeof doc.status === "string" ? doc.status : "pending",
          tags: Array.isArray(doc.tags)
            ? doc.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          result: doc.result as ProcessedItemPreviewDoc["result"],
          duplicateOf: doc.duplicateOf ? String(doc.duplicateOf) : null,
          duplicateSimilarity:
            typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null,
          llm: doc.llm as ProcessedItemPreviewDoc["llm"],
          createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
          updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
        };
        const existingCandidate = byItemMetaId.get(itemMetaId);
        if (
          !existingCandidate ||
          statusPriority(candidate.status) > statusPriority(existingCandidate.status)
        ) {
          byItemMetaId.set(itemMetaId, candidate);
        }
      }
      return (keys as string[]).map((key) => byItemMetaId.get(key.trim()) ?? null);
    });
    this.processedPreviewByOrg.set(orgId, loader);
    return loader;
  }

  private readModelLoader(
    orgId: string,
    projectionKey: string,
    projection: ScopedReadModelProjection,
  ): DataLoader<string, ItemReadModel | null> {
    const cacheKey = `${orgId}|${projectionKey}`;
    const existing = this.readModelByOrgAndProjection.get(cacheKey);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, ItemReadModel | null>(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return (keys as string[]).map(() => null);
      }
      const itemMetaIds = this.normalizeKeys(keys as string[]);
      if (itemMetaIds.length === 0) {
        return (keys as string[]).map(() => null);
      }
      const docs = asLeanRecords(
        await ItemReadModelModel.find(
          { orgId, itemMetaId: { $in: itemMetaIds } },
          projection,
        ).lean(),
      );
      const byItemMetaId = new Map<string, ItemReadModel>();
      for (const doc of docs) {
        const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId : "";
        if (!itemMetaId || byItemMetaId.has(itemMetaId)) {
          continue;
        }
        byItemMetaId.set(itemMetaId, doc as ItemReadModel);
      }
      return (keys as string[]).map((key) => byItemMetaId.get(key.trim()) ?? null);
    });
    this.readModelByOrgAndProjection.set(cacheKey, loader);
    return loader;
  }

  private processedLoader(
    orgId: string,
    projectionKey: string,
    projection: Record<string, 1>,
  ): DataLoader<string, ProcessedItemDoc | null> {
    const cacheKey = `${orgId}|${projectionKey}`;
    const existing = this.processedByOrgAndProjection.get(cacheKey);
    if (existing) {
      return existing;
    }
    const loader = new DataLoader<string, ProcessedItemDoc | null>(async (keys) => {
      const itemMetaIds = this.normalizeKeys(keys as string[]);
      if (itemMetaIds.length === 0) {
        return (keys as string[]).map(() => null);
      }
      const docs = asLeanRecords(
        await ProcessedItemModel.find({ orgId, itemMetaId: { $in: itemMetaIds } }, projection)
          .sort({ createdAt: -1 })
          .lean(),
      );
      const byItemMetaId = new Map<string, ProcessedItemDoc>();
      for (const doc of docs) {
        const candidate = mapProcessedItemRecord(doc);
        if (!candidate) {
          continue;
        }
        const existingCandidate = byItemMetaId.get(candidate.itemMetaId);
        if (
          !existingCandidate ||
          statusPriority(candidate.status) > statusPriority(existingCandidate.status)
        ) {
          byItemMetaId.set(candidate.itemMetaId, candidate);
        }
      }
      return (keys as string[]).map((key) => byItemMetaId.get(key.trim()) ?? null);
    });
    this.processedByOrgAndProjection.set(cacheKey, loader);
    return loader;
  }

  /**
   * Loads raw items for organization-bound `itemMetaId` keys.
   *
   * `RawItem` has no `orgId` column, so the tenant binding is reconstructed:
   * first read the caller's own `ItemMeta` rows for the requested keys, then
   * fetch `RawItem` documents by `_id = mongoRef` and accept a document only
   * when its own `itemMetaId` equals the id of the meta that referenced it.
   * A raw document that merely claims a foreign `itemMetaId` can never satisfy
   * both conditions, and a meta with a missing or malformed `mongoRef` yields
   * `null` instead of falling back to "latest raw for this itemMetaId".
   */
  private async loadRawItems(
    orgId: string,
    keys: readonly string[],
    projection: Record<string, 1> | null,
  ): Promise<(RawItemDoc | null)[]> {
    const itemMetaIds = this.normalizeKeys(keys as string[]);
    const empty = () => keys.map(() => null);
    if (itemMetaIds.length === 0) {
      return empty();
    }
    const metas = await this.prisma.itemMeta.findMany({
      where: { orgId, id: { in: itemMetaIds } },
      select: { id: true, mongoRef: true },
    });
    const itemMetaIdByMongoRef = new Map<string, string>();
    for (const meta of metas) {
      const mongoRef = typeof meta.mongoRef === "string" ? meta.mongoRef.trim() : "";
      if (!mongoRef || !Types.ObjectId.isValid(mongoRef)) {
        continue;
      }
      itemMetaIdByMongoRef.set(mongoRef, meta.id);
    }
    if (itemMetaIdByMongoRef.size === 0) {
      return empty();
    }
    const mongoRefs = [...itemMetaIdByMongoRef.keys()];
    const docs = asLeanRecords(
      await RawItemModel.find(
        { _id: { $in: mongoRefs } },
        projection ?? undefined,
      ).lean(),
    );
    const byItemMetaId = new Map<string, RawItemDoc>();
    for (const doc of docs) {
      const id = leanId(doc._id);
      if (!id) {
        continue;
      }
      const expectedItemMetaId = itemMetaIdByMongoRef.get(id);
      if (!expectedItemMetaId) {
        continue;
      }
      // The referenced document must belong to the meta that pointed at it.
      if (doc.itemMetaId !== expectedItemMetaId) {
        continue;
      }
      if (byItemMetaId.has(expectedItemMetaId)) {
        continue;
      }
      byItemMetaId.set(expectedItemMetaId, {
        id,
        itemMetaId: expectedItemMetaId,
        payload: isRecord(doc.payload) ? doc.payload : {},
        source: typeof doc.source === "string" ? doc.source : undefined,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
        updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
      });
    }
    return keys.map((key) => byItemMetaId.get(key.trim()) ?? null);
  }

  private normalizeKeys(keys: readonly string[]): string[] {
    const seen = new Set<string>();
    for (const key of keys) {
      const normalized = typeof key === "string" ? key.trim() : "";
      if (normalized) {
        seen.add(normalized);
      }
    }
    return [...seen];
  }
}
