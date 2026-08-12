import { RawItemModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

export interface RawItemPreviewDoc {
  id: string;
  itemMetaId: string;
  payload: Record<string, unknown>;
  source?: string;
  createdAt: Date;
  updatedAt: Date;
}

type RawItemPreviewRecord = Omit<RawItemPreviewDoc, "id"> & { _id: { toString(): string } };

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
  "payload.metadata.history": 1
};

@Injectable({ scope: Scope.REQUEST })
export class RawItemPreviewLoader implements NestDataLoader<string, RawItemPreviewDoc | null> {
  generateDataLoader(): DataLoader<string, RawItemPreviewDoc | null> {
    return new DataLoader(async (keys) => {
      const docs = (await RawItemModel.find(
        { itemMetaId: { $in: keys as string[] } },
        RAW_ITEM_PREVIEW_PROJECTION
      )
        .sort({ createdAt: -1 })
        .lean()) as unknown as RawItemPreviewRecord[];

      const map = new Map<string, RawItemPreviewDoc>();
      docs.forEach((doc) => {
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
