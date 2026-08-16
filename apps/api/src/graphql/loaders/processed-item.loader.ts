import { asLeanRecords, leanId, ProcessedItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

export interface ProcessedItemDoc {
  id: string;
  itemMetaId: string;
  status: string;
  error?: { message: string; name?: string | null } | null;
  tags: string[];
  result?: Record<string, unknown> | string | null;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
  summaryEmbeddingModel?: string | null;
  summaryEmbeddingDimensions?: number | null;
  llm?: {
    model?: string | null;
    promptVersion?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    latencyMs?: number | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

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
  return {
    id,
    itemMetaId,
    status: typeof doc.status === "string" ? doc.status : "pending",
    error,
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    result: isResult(doc.result) ? doc.result : undefined,
    duplicateOf: duplicateOf ? String(duplicateOf) : null,
    duplicateSimilarity:
      typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null,
    summaryEmbeddingModel,
    summaryEmbeddingDimensions,
    llm: isLlm(doc.llm) ? doc.llm : undefined,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
  };
}

function isResult(
  value: unknown,
): value is Record<string, unknown> | string | null {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
  );
}

function isLlm(value: unknown): value is ProcessedItemDoc["llm"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProcessedItems(
  keys: readonly string[],
  projection: Record<string, 1>,
): Promise<(ProcessedItemDoc | null)[]> {
  const docs = asLeanRecords(
    await ProcessedItemModel.find(
      { itemMetaId: { $in: keys as string[] } },
      projection,
    )
      .sort({ createdAt: -1 })
      .lean(),
  );
  const map = new Map<string, ProcessedItemDoc>();
  docs.forEach((doc) => {
    const candidate = mapProcessedItemRecord(doc);
    if (!candidate) {
      return;
    }

    const existing = map.get(candidate.itemMetaId);
    if (!existing || statusPriority(candidate.status) > statusPriority(existing.status)) {
      map.set(candidate.itemMetaId, candidate);
    }
  });
  return keys.map((key) => map.get(key as string) ?? null);
}

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemLoader implements NestDataLoader<string, ProcessedItemDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemDoc | null> {
    return new DataLoader(async (keys) => {
      return loadProcessedItems(keys as readonly string[], PROCESSED_ITEM_FULL_PROJECTION);
    });
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemScalarLoader implements NestDataLoader<string, ProcessedItemDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemDoc | null> {
    return new DataLoader(async (keys) => {
      return loadProcessedItems(keys as readonly string[], PROCESSED_ITEM_SCALAR_PROJECTION);
    });
  }
}
