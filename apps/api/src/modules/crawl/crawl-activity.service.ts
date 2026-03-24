import { Injectable } from "@nestjs/common";
import { CrawlTaskStatus } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

const CRAWL_ACTIVITY_HASH_KEY = "crawl:activity";
const ACTIVE_TASK_COUNT_FIELD = "activeTaskCount";
const LAST_ENQUEUED_AT_FIELD = "lastEnqueuedAt";
const LAST_TERMINAL_AT_FIELD = "lastTerminalAt";
const LAST_LOADED_AT_FIELD = "lastLoadedAt";

export interface CrawlActivityState {
  activeTaskCount: number | null;
  lastEnqueuedAt: string | null;
  lastTerminalAt: string | null;
  lastLoadedAt: string | null;
}

@Injectable()
export class CrawlActivityService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {}

  async getState(): Promise<CrawlActivityState> {
    const record = await this.cache.hgetall(CRAWL_ACTIVITY_HASH_KEY);
    return {
      activeTaskCount: this.toOptionalInt(record[ACTIVE_TASK_COUNT_FIELD]),
      lastEnqueuedAt: this.toOptionalString(record[LAST_ENQUEUED_AT_FIELD]),
      lastTerminalAt: this.toOptionalString(record[LAST_TERMINAL_AT_FIELD]),
      lastLoadedAt: this.toOptionalString(record[LAST_LOADED_AT_FIELD]),
    };
  }

  async ensureActiveTaskCount(): Promise<number> {
    const state = await this.getState();
    if (typeof state.activeTaskCount === "number") {
      return Math.max(0, state.activeTaskCount);
    }

    const activeTaskCount = await this.prisma.crawlTask.count({
      where: {
        status: {
          in: [CrawlTaskStatus.queued, CrawlTaskStatus.running],
        },
      },
    });
    await this.cache.hset(CRAWL_ACTIVITY_HASH_KEY, {
      [ACTIVE_TASK_COUNT_FIELD]: Math.max(0, activeTaskCount),
      [LAST_LOADED_AT_FIELD]: new Date().toISOString(),
    });
    return Math.max(0, activeTaskCount);
  }

  async markTaskQueued(now = new Date()) {
    await Promise.all([
      this.cache.hincrby(CRAWL_ACTIVITY_HASH_KEY, ACTIVE_TASK_COUNT_FIELD, 1),
      this.cache.hset(CRAWL_ACTIVITY_HASH_KEY, {
        [LAST_ENQUEUED_AT_FIELD]: now.toISOString(),
      }),
    ]);
  }

  async markTasksTerminal(count: number, now = new Date()) {
    const normalized = Math.max(0, Math.round(count));
    if (normalized === 0) {
      await this.cache.hset(CRAWL_ACTIVITY_HASH_KEY, {
        [LAST_TERMINAL_AT_FIELD]: now.toISOString(),
      });
      return;
    }

    const next = await this.cache.hincrby(
      CRAWL_ACTIVITY_HASH_KEY,
      ACTIVE_TASK_COUNT_FIELD,
      -normalized,
    );
    const updates: Record<string, string | number> = {
      [LAST_TERMINAL_AT_FIELD]: now.toISOString(),
    };
    if (next < 0) {
      updates[ACTIVE_TASK_COUNT_FIELD] = 0;
    }
    await this.cache.hset(CRAWL_ACTIVITY_HASH_KEY, updates);
  }

  private toOptionalInt(value: string | undefined): number | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.max(0, Math.round(parsed));
  }

  private toOptionalString(value: string | undefined): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    return value;
  }
}
