import { asLeanRecords, leanId, ProcessedItemModel } from "@modular/mongo";
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
  "result.region": 1
};

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemPreviewLoader implements NestDataLoader<string, ProcessedItemPreviewDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemPreviewDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = asLeanRecords(
        await ProcessedItemModel.find(
          { itemMetaId: { $in: keys as string[] } },
          PROCESSED_ITEM_PREVIEW_PROJECTION
        )
          .sort({ createdAt: -1 })
          .lean()
      );

      const map = new Map<string, ProcessedItemPreviewDoc>();
      docs.forEach((doc) => {
        const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId : "";
        const id = leanId(doc._id);
        if (!itemMetaId || !id) {
          return;
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
          updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0)
        };

        const existing = map.get(itemMetaId);
        if (!existing || statusPriority(candidate.status) > statusPriority(existing.status)) {
          map.set(itemMetaId, candidate);
        }
      });

      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
