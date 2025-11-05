import DataLoader from "dataloader";
import { Injectable, Scope } from "@nestjs/common";
import { NestDataLoader } from "nestjs-dataloader";
import { RawItemModel } from "@modular/mongo";

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
      const docs = await RawItemModel.find({ itemMetaId: { $in: keys as string[] } })
        .sort({ createdAt: -1 })
        .lean();
      const map = new Map<string, RawItemDoc>();
      docs.forEach((doc: any) => {
        if (!map.has(doc.itemMetaId)) {
          map.set(doc.itemMetaId, {
            id: doc._id.toString(),
            itemMetaId: doc.itemMetaId,
            payload: doc.payload,
            source: doc.source,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt
          });
        }
      });
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
