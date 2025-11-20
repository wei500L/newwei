import { Injectable } from "@nestjs/common";
import { PrismaService } from "../config/prisma.service";
import { EnvService } from "../config/config.service";

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

@Injectable()
export class RateLimitConfigService {
  private cache: RateLimitSettings | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs = 30_000;

  constructor(private readonly prisma: PrismaService, private readonly env: EnvService) {}

  async getRateLimitSettings(): Promise<RateLimitSettings> {
    const now = Date.now();
    if (this.cache && now < this.cacheExpiresAt) {
      return this.cache;
    }
    const settings = await this.loadSettings();
    this.cache = settings;
    this.cacheExpiresAt = now + this.cacheTtlMs;
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
    await this.prisma.auditLog.create({
      data: {
        orgId,
        actorId,
        resource: "system_settings",
        action: "rate_limit_update",
        metadata: normalized
      }
    });
    this.cache = normalized;
    this.cacheExpiresAt = Date.now() + this.cacheTtlMs;
    return normalized;
  }

  async invalidateCache() {
    this.cache = null;
    this.cacheExpiresAt = 0;
  }

  private async loadSettings(): Promise<RateLimitSettings> {
    const fallback = this.getFallbackSettings();
    const records = await this.prisma.systemSetting.findMany({
      where: {
        key: { in: Object.values(RATE_LIMIT_SETTING_KEYS) }
      }
    });
    const recordMap = new Map(records.map((record) => [record.key, record.value as any]));
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
