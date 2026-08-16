import { asLeanRecords, isRecord, leanId, RawItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

export interface RawItemDoc {
  id: string;
  itemMetaId: string;
  payload: Record<string, unknown>;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable({ scope: Scope.REQUEST })
export class RawItemLoader implements NestDataLoader<string, RawItemDoc | null> {
  generateDataLoader(): DataLoader<string, RawItemDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = asLeanRecords(
        await RawItemModel.find({ itemMetaId: { $in: keys as string[] } })
          .sort({ createdAt: -1 })
          .lean(),
      );
      const map = new Map<string, RawItemDoc>();
      docs.forEach((doc) => {
        const itemMetaId = typeof doc.itemMetaId === "string" ? doc.itemMetaId : "";
        const id = leanId(doc._id);
        if (!itemMetaId || !id || map.has(itemMetaId)) {
          return;
        }
        map.set(itemMetaId, {
          id,
          itemMetaId,
          payload: isRecord(doc.payload) ? doc.payload : {},
          source: typeof doc.source === "string" ? doc.source : undefined,
          createdAt: doc.createdAt instanceof Date ? doc.createdAt : new Date(0),
          updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
        });
      });
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
