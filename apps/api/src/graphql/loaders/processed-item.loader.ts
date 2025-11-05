import DataLoader from "dataloader";
import { Injectable, Scope } from "@nestjs/common";
import { NestDataLoader } from "nestjs-dataloader";
import { ProcessedItemModel } from "@modular/mongo";

export interface ProcessedItemDoc {
  id: string;
  itemMetaId: string;
  status: string;
  tags: string[];
  result?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable({ scope: Scope.REQUEST })
export class ProcessedItemLoader implements NestDataLoader<string, ProcessedItemDoc | null> {
  generateDataLoader(): DataLoader<string, ProcessedItemDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = await ProcessedItemModel.find({ itemMetaId: { $in: keys as string[] } })
        .sort({ createdAt: -1 })
        .lean();
      const map = new Map<string, ProcessedItemDoc>();
      docs.forEach((doc: any) => {
        if (!map.has(doc.itemMetaId)) {
          map.set(doc.itemMetaId, {
            id: doc._id.toString(),
            itemMetaId: doc.itemMetaId,
            status: doc.status,
            tags: doc.tags ?? [],
            result: doc.result ?? undefined,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt
          });
        }
      });
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
