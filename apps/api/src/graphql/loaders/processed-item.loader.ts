import { ProcessedItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

export interface ProcessedItemDoc {
  id: string;
  itemMetaId: string;
  status: string;
  tags: string[];
  result?: Record<string, unknown>;
  duplicateOf?: string | null;
  duplicateSimilarity?: number | null;
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

type ProcessedItemRecord = ProcessedItemDoc & {
  _id: { toString(): string };
  duplicateOf?: { toString(): string } | string | null;
};

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemLoader implements NestDataLoader<string, ProcessedItemDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = (await ProcessedItemModel.find({ itemMetaId: { $in: keys as string[] } })
        .sort({ createdAt: -1 })
        .lean()) as ProcessedItemRecord[];
      const map = new Map<string, ProcessedItemDoc>();
      docs.forEach((doc) => {
        if (!map.has(doc.itemMetaId)) {
          map.set(doc.itemMetaId, {
            id: doc._id.toString(),
            itemMetaId: doc.itemMetaId,
            status: doc.status,
            tags: doc.tags ?? [],
            result: doc.result ?? undefined,
            duplicateOf: doc.duplicateOf ? doc.duplicateOf.toString() : null,
            duplicateSimilarity:
              typeof doc.duplicateSimilarity === "number"
                ? doc.duplicateSimilarity
                : null,
            llm: doc.llm ?? undefined,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt
          });
        }
      });
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
