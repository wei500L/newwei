import { ProcessedItemModel } from "@modular/mongo";
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

type ProcessedItemRecord = Omit<ProcessedItemDoc, "id"> & {
  _id: { toString(): string };
  duplicateOf?: { toString(): string } | string | null;
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

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemLoader implements NestDataLoader<string, ProcessedItemDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = (await ProcessedItemModel.find({ itemMetaId: { $in: keys as string[] } })
        .sort({ createdAt: -1 })
        .lean()) as unknown as ProcessedItemRecord[];
      const map = new Map<string, ProcessedItemDoc>();
      docs.forEach((doc) => {
        const summaryEmbeddingModel =
          typeof (doc as { summaryEmbeddingModel?: unknown }).summaryEmbeddingModel === "string"
            ? String((doc as { summaryEmbeddingModel?: unknown }).summaryEmbeddingModel)
            : null;
        const summaryEmbeddingRaw = (doc as { summaryEmbedding?: unknown }).summaryEmbedding;
        const summaryEmbeddingDimensions = Array.isArray(summaryEmbeddingRaw)
          ? summaryEmbeddingRaw.length
          : null;

        const errorRaw = (doc as { error?: unknown }).error;
        const error =
          errorRaw && typeof errorRaw === "object" && !Array.isArray(errorRaw)
            ? {
                message:
                  typeof (errorRaw as { message?: unknown }).message === "string"
                    ? String((errorRaw as { message?: unknown }).message)
                    : "Unknown error",
                name:
                  typeof (errorRaw as { name?: unknown }).name === "string"
                    ? String((errorRaw as { name?: unknown }).name)
                    : null,
              }
            : null;

        const candidate: ProcessedItemDoc = {
          id: doc._id.toString(),
          itemMetaId: doc.itemMetaId,
          status: doc.status,
          error,
          tags: doc.tags ?? [],
          result: doc.result ?? undefined,
          duplicateOf: doc.duplicateOf ? doc.duplicateOf.toString() : null,
          duplicateSimilarity:
            typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null,
          summaryEmbeddingModel,
          summaryEmbeddingDimensions,
          llm: doc.llm ?? undefined,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt
        };

        const existing = map.get(doc.itemMetaId);
        if (!existing || statusPriority(candidate.status) > statusPriority(existing.status)) {
          map.set(doc.itemMetaId, candidate);
        }
      });
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
