import { ItemReadModelModel, type ItemReadModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

import { EnvService } from "../../modules/config/config.service";

export const ITEM_READ_MODEL_META_PROJECTION: Record<string, 1> = {
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

const ITEM_READ_MODEL_RAW_PROJECTION: Record<string, 1> = {
  itemMetaId: 1,
  raw: 1,
};

const ITEM_READ_MODEL_RAW_PREVIEW_PROJECTION: Record<string, 1> = {
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

const ITEM_READ_MODEL_PROCESSED_PROJECTION: Record<string, 1> = {
  itemMetaId: 1,
  processed: 1,
};

const ITEM_READ_MODEL_PROCESSED_PREVIEW_PROJECTION: Record<string, 1> = {
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

async function loadReadModels(
  keys: readonly string[],
  projection: Record<string, 1>,
): Promise<(ItemReadModel | null)[]> {
  const docs = (await ItemReadModelModel.find(
    {
      itemMetaId: { $in: keys as string[] },
    },
    projection,
  ).lean()) as ItemReadModel[];
  const byId = new Map<string, ItemReadModel>();
  for (const doc of docs) {
    if (!doc?.itemMetaId || byId.has(doc.itemMetaId)) {
      continue;
    }
    byId.set(doc.itemMetaId, doc);
  }
  return keys.map((key) => byId.get(key as string) ?? null);
}

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelLoader implements NestDataLoader<string, ItemReadModel | null> {
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      return loadReadModels(keys as readonly string[], ITEM_READ_MODEL_META_PROJECTION);
    });
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelRawLoader implements NestDataLoader<string, ItemReadModel | null> {
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      return loadReadModels(keys as readonly string[], ITEM_READ_MODEL_RAW_PROJECTION);
    });
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelRawPreviewLoader implements NestDataLoader<string, ItemReadModel | null> {
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      return loadReadModels(keys as readonly string[], ITEM_READ_MODEL_RAW_PREVIEW_PROJECTION);
    });
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelProcessedLoader implements NestDataLoader<string, ItemReadModel | null> {
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      return loadReadModels(keys as readonly string[], ITEM_READ_MODEL_PROCESSED_PROJECTION);
    });
  }
}

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelProcessedPreviewLoader
  implements NestDataLoader<string, ItemReadModel | null>
{
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      return loadReadModels(keys as readonly string[], ITEM_READ_MODEL_PROCESSED_PREVIEW_PROJECTION);
    });
  }
}
