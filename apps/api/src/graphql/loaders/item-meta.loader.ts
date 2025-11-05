import DataLoader from "dataloader";
import { Injectable, Scope } from "@nestjs/common";
import { NestDataLoader } from "nestjs-dataloader";
import { PrismaService } from "../../modules/config/prisma.service";
import type { ItemMeta } from "@prisma/client";

@Injectable({ scope: Scope.REQUEST })
export class ItemMetaLoader implements NestDataLoader<string, ItemMeta | null> {
  constructor(private readonly prisma: PrismaService) {}

  generateDataLoader(): DataLoader<string, ItemMeta | null> {
    return new DataLoader(async (keys) => {
      const items = await this.prisma.itemMeta.findMany({
        where: { id: { in: keys as string[] } }
      });
      const map = new Map(items.map((item) => [item.id, item]));
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
