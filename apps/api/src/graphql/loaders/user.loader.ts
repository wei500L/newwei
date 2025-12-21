import { Injectable, Scope } from "@nestjs/common";
import type { User } from "@prisma/client";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

import { PrismaService } from "../../modules/config/prisma.service";


@Injectable({ scope: Scope.REQUEST })
export class UserLoader implements NestDataLoader<string, User | null> {
  constructor(private readonly prisma: PrismaService) {}

  generateDataLoader(): DataLoader<string, User | null> {
    return new DataLoader<string, User | null>(async (keys) => {
      const users = await this.prisma.user.findMany({
        where: { id: { in: keys as string[] } }
      });
      const map = new Map(users.map((user) => [user.id, user]));
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
