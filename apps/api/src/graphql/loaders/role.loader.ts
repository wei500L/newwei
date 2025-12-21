import { Injectable, Scope } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import DataLoader from "dataloader";
import { NestDataLoader } from "nestjs-dataloader";

import { PrismaService } from "../../modules/config/prisma.service";


@Injectable({ scope: Scope.REQUEST })
export class RoleLoader
  implements NestDataLoader<string, Prisma.RoleGetPayload<{ include: { permissions: { include: { permission: true } } } }> | null>
{
  constructor(private readonly prisma: PrismaService) {}

  generateDataLoader(): DataLoader<
    string,
    Prisma.RoleGetPayload<{ include: { permissions: { include: { permission: true } } } }> | null
  > {
    return new DataLoader(async (keys) => {
      const roles = await this.prisma.role.findMany({
        where: { id: { in: keys as string[] } },
        include: {
          permissions: {
            include: { permission: true }
          }
        }
      });
      const map = new Map<string, Prisma.RoleGetPayload<{ include: { permissions: { include: { permission: true } } } }>>(
        roles.map((role) => [role.id, role])
      );
      return keys.map((key) => map.get(key as string) ?? null);
    });
  }
}
