import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export type RateLimitBucket = "login" | "crawlCreate" | "rbacWrite";

export interface RateLimitBucketConfig {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitSettings {
  login: RateLimitBucketConfig;
  crawlCreate: RateLimitBucketConfig;
  rbacWrite: RateLimitBucketConfig;
}

export interface RateLimitSettingsInput {
  login: RateLimitBucketConfig;
  crawlCreate: RateLimitBucketConfig;
  rbacWrite: RateLimitBucketConfig;
}

const RATE_LIMIT_SETTING_KEYS: Record<RateLimitBucket, string> = {
  login: "rate_limit_login",
  crawlCreate: "rate_limit_crawl_create",
  rbacWrite: "rate_limit_rbac_write"
};

const MIN_LIMIT = 1;
const MAX_LIMIT = 1_000;
const MIN_WINDOW_SECONDS = 5;
const MAX_WINDOW_SECONDS = 86_400;
const RATE_LIMIT_CACHE_KEY = "rate_limit:settings";

@Injectable()
export class RateLimitConfigService {
  private readonly cacheTtlSeconds: number;
  private readonly logger = createLogger({ name: "rate-limit-config" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService
  ) {
    this.cacheTtlSeconds = this.env.rateLimitSettingsCacheTtlSeconds;
  }

  async getRateLimitSettings(): Promise<RateLimitSettings> {
    let cached: RateLimitSettings | null = null;
    try {
      cached = await this.cache.get<RateLimitSettings>(RATE_LIMIT_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read rate limit settings from cache; falling back to database"
      );
    }

    if (cached) {
      return this.normalizeSettings(cached);
    }

    let settings: RateLimitSettings;
    try {
      settings = await this.loadSettings();
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error },
        "Failed to load rate limit settings from database; using environment defaults"
      );
    }

    try {
      await this.cache.set(RATE_LIMIT_CACHE_KEY, settings, this.cacheTtlSeconds);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write rate limit settings to cache");
    }

    return settings;
  }

  async getBucketConfig(bucket: RateLimitBucket): Promise<RateLimitBucketConfig> {
    const settings = await this.getRateLimitSettings();
    return settings[bucket];
  }

  async updateRateLimitSettings(
    orgId: string,
    actorId: string,
    input: RateLimitSettingsInput
  ): Promise<RateLimitSettings> {
    const normalized = this.normalizeSettings(input);
    await this.prisma.$transaction(
      (Object.keys(RATE_LIMIT_SETTING_KEYS) as RateLimitBucket[]).map((bucket) =>
        this.prisma.systemSetting.upsert({
          where: { key: RATE_LIMIT_SETTING_KEYS[bucket] },
          update: {
            value: normalized[bucket],
            updatedById: actorId
          },
          create: {
            key: RATE_LIMIT_SETTING_KEYS[bucket],
            value: normalized[bucket],
            updatedById: actorId,
            description: `${bucket} rate limit`
          }
        })
      )
    );
    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "rate_limit_update",
          metadata: normalized
        }
      },
      { orgId, actorId, resource: "system_settings", action: "rate_limit_update" }
    );
    await this.cache.set(RATE_LIMIT_CACHE_KEY, normalized, this.cacheTtlSeconds);
    return normalized;
  }

  async invalidateCache() {
    await this.cache.del(RATE_LIMIT_CACHE_KEY);
  }

  private async loadSettings(): Promise<RateLimitSettings> {
    const fallback = this.getFallbackSettings();
    const records = await this.prisma.systemSetting.findMany({
      where: {
        key: { in: Object.values(RATE_LIMIT_SETTING_KEYS) }
      }
    });
    const recordMap = new Map(records.map((record) => [record.key, record.value as unknown]));
    return {
      login: this.normalizeBucket(recordMap.get(RATE_LIMIT_SETTING_KEYS.login), fallback.login),
      crawlCreate: this.normalizeBucket(
        recordMap.get(RATE_LIMIT_SETTING_KEYS.crawlCreate),
        fallback.crawlCreate
      ),
      rbacWrite: this.normalizeBucket(
        recordMap.get(RATE_LIMIT_SETTING_KEYS.rbacWrite),
        fallback.rbacWrite
      )
    };
  }

  private normalizeSettings(settings: RateLimitSettingsInput): RateLimitSettings {
    const fallback = this.getFallbackSettings();
    return {
      login: this.normalizeBucket(settings.login, fallback.login),
      crawlCreate: this.normalizeBucket(settings.crawlCreate, fallback.crawlCreate),
      rbacWrite: this.normalizeBucket(settings.rbacWrite, fallback.rbacWrite)
    };
  }

  private normalizeBucket(
    value: RateLimitBucketConfig | undefined,
    fallback: RateLimitBucketConfig
  ): RateLimitBucketConfig {
    if (!value) {
      return fallback;
    }
    return {
      limit: this.clamp(Math.floor(value.limit), MIN_LIMIT, MAX_LIMIT),
      windowSeconds: this.clamp(
        Math.floor(value.windowSeconds),
        MIN_WINDOW_SECONDS,
        MAX_WINDOW_SECONDS
      )
    };
  }

  private clamp(value: number, min: number, max: number) {
    if (Number.isNaN(value) || value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private getFallbackSettings(): RateLimitSettings {
    const rateLimit = this.env.rateLimit;
    return {
      login: {
        limit: rateLimit.login,
        windowSeconds: rateLimit.loginWindowSeconds
      },
      crawlCreate: {
        limit: rateLimit.crawlTaskCreate,
        windowSeconds: rateLimit.crawlTaskCreateWindowSeconds
      },
      rbacWrite: {
        limit: rateLimit.rbacWrite,
        windowSeconds: rateLimit.rbacWriteWindowSeconds
      }
    };
  }
}
