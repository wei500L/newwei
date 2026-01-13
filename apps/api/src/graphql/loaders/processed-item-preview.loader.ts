import { ProcessedItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

export interface ProcessedItemPreviewDoc {
  id: string;
  itemMetaId: string;
  status: string;
  tags: string[];
  result?: Record<string, unknown> | string | null;
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

type ProcessedItemPreviewRecord = Omit<ProcessedItemPreviewDoc, "id"> & {
  _id: { toString(): string };
  duplicateOf?: { toString(): string } | string | null;
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
  "result.source": 1,
  "result.summary": 1,
  "result.sentiment": 1,
  "result.sentiment_label": 1,
  "result.topics": 1,
  "result.entities": 1,
  "result.quality_score": 1,
  "result.location": 1,
  "result.region": 1
};

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemPreviewLoader implements NestDataLoader<string, ProcessedItemPreviewDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemPreviewDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = (await ProcessedItemModel.find(
        { itemMetaId: { $in: keys as string[] } },
        PROCESSED_ITEM_PREVIEW_PROJECTION
      )
        .sort({ createdAt: -1 })
        .lean()) as unknown as ProcessedItemPreviewRecord[];

      const map = new Map<string, ProcessedItemPreviewDoc>();
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
              typeof doc.duplicateSimilarity === "number" ? doc.duplicateSimilarity : null,
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
