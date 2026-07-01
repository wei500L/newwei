import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface ActiveOrgEntry {
  id: string;
}

const ACTIVE_ORGS_CACHE_KEY = "org:active:list:v1";
const ACTIVE_ORGS_CACHE_TTL_SECONDS = 15;
const ACTIVE_ORGS_CACHE_LOCK_TTL_MS = 2_000;

@Injectable()
export class ActiveOrgRegistryService {
  private readonly logger = createLogger({ name: "active-org-registry" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async listActiveOrgs(): Promise<ActiveOrgEntry[]> {
    try {
      return await this.cache.wrap(
        ACTIVE_ORGS_CACHE_KEY,
        ACTIVE_ORGS_CACHE_TTL_SECONDS,
        async () => await this.loadActiveOrgs(),
        {
          lockTtlMs: ACTIVE_ORGS_CACHE_LOCK_TTL_MS,
          retryDelayMs: 50,
          maxWaitMs: 500,
        },
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read cached active org list; falling back to database",
      );
      return await this.loadActiveOrgs();
    }
  }

  async listActiveOrgIds(): Promise<string[]> {
    return (await this.listActiveOrgs()).map((org) => org.id);
  }

  async invalidate(): Promise<void> {
    await this.cache.del(ACTIVE_ORGS_CACHE_KEY);
  }

  private async loadActiveOrgs(): Promise<ActiveOrgEntry[]> {
    return await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
      orderBy: { id: "asc" },
    });
  }
}
