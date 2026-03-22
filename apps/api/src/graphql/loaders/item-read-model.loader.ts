import { ItemReadModelModel, type ItemReadModel } from "@modular/mongo";
import { Injectable, Scope } from "@nestjs/common";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

import { EnvService } from "../../modules/config/config.service";

@Injectable({ scope: Scope.REQUEST })
export class ItemReadModelLoader implements NestDataLoader<string, ItemReadModel | null> {
  constructor(private readonly env: EnvService) {}

  generateDataLoader(): DataLoader<string, ItemReadModel | null> {
    return new DataLoader(async (keys) => {
      if (!this.env.itemsReadModelEnabled) {
        return keys.map(() => null);
      }
      const docs = (await ItemReadModelModel.find({
        itemMetaId: { $in: keys as string[] },
      }).lean()) as ItemReadModel[];
      const byId = new Map<string, ItemReadModel>();
      for (const doc of docs) {
        if (!doc?.itemMetaId || byId.has(doc.itemMetaId)) {
          continue;
        }
        byId.set(doc.itemMetaId, doc);
      }
      return keys.map((key) => byId.get(key as string) ?? null);
    });
  }
}
