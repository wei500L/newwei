import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export interface AuthCacheSettings {
  profileTtlSeconds: number;
  lockTtlMs: number;
  maxWaitMs: number;
  retryDelayMs: number;
}

const AUTH_CACHE_SETTINGS_KEY = "auth_profile_cache_settings";
const AUTH_CACHE_SETTINGS_CACHE_KEY = "auth_cache:settings";

const MIN_PROFILE_TTL_SECONDS = 60;
const MAX_PROFILE_TTL_SECONDS = 86_400;
const MIN_LOCK_TTL_MS = 100;
const MAX_LOCK_TTL_MS = 60_000;
const MIN_RETRY_DELAY_MS = 10;
const MAX_RETRY_DELAY_MS = 1_000;
const MIN_MAX_WAIT_MS = 50;
const MAX_MAX_WAIT_MS = 120_000;

@Injectable()
export class AuthCacheSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly cache: CacheService
  ) {}

  async getSettings(): Promise<AuthCacheSettings> {
    const cached = await this.cache.get<AuthCacheSettings>(AUTH_CACHE_SETTINGS_CACHE_KEY);
    if (cached) {
      return this.normalize(cached);
    }

    const settings = await this.loadSettings();
    await this.cache.set(AUTH_CACHE_SETTINGS_CACHE_KEY, settings, 60);
    return settings;
  }

  async updateSettings(orgId: string, actorId: string, input: AuthCacheSettings) {
    const normalized = this.normalize(input);
    await this.prisma.systemSetting.upsert({
      where: { key: AUTH_CACHE_SETTINGS_KEY },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId
      },
      create: {
        key: AUTH_CACHE_SETTINGS_KEY,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: "Auth profile cache settings"
      }
    });

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "auth_cache_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "auth_cache_settings_update" }
    ).catch(() => undefined);

    await this.cache.set(AUTH_CACHE_SETTINGS_CACHE_KEY, normalized, 60);
    return normalized;
  }

  async invalidateCache() {
    await this.cache.del(AUTH_CACHE_SETTINGS_CACHE_KEY);
  }

  private async loadSettings(): Promise<AuthCacheSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: AUTH_CACHE_SETTINGS_KEY }
    });
    if (!record) {
      return fallback;
    }
    const value = record.value as Partial<AuthCacheSettings>;
    return this.normalize({ ...fallback, ...value });
  }

  private getFallbackSettings(): AuthCacheSettings {
    return {
      profileTtlSeconds: this.env.authProfileCacheTtlSeconds,
      lockTtlMs: this.env.authProfileCacheLockTtlMs,
      maxWaitMs: this.env.authProfileCacheMaxWaitMs,
      retryDelayMs: this.env.authProfileCacheRetryDelayMs
    };
  }

  private normalize(value: Partial<AuthCacheSettings>): AuthCacheSettings {
    const fallback = this.getFallbackSettings();
    const profileTtlSeconds = this.clamp(
      this.toInt(value.profileTtlSeconds, fallback.profileTtlSeconds),
      MIN_PROFILE_TTL_SECONDS,
      MAX_PROFILE_TTL_SECONDS
    );
    const lockTtlMs = this.clamp(
      this.toInt(value.lockTtlMs, fallback.lockTtlMs),
      MIN_LOCK_TTL_MS,
      MAX_LOCK_TTL_MS
    );
    const retryDelayMs = this.clamp(
      this.toInt(value.retryDelayMs, fallback.retryDelayMs),
      MIN_RETRY_DELAY_MS,
      MAX_RETRY_DELAY_MS
    );
    const maxWaitMs = this.clamp(
      Math.max(this.toInt(value.maxWaitMs, fallback.maxWaitMs), retryDelayMs, MIN_MAX_WAIT_MS),
      MIN_MAX_WAIT_MS,
      MAX_MAX_WAIT_MS
    );

    return {
      profileTtlSeconds,
      lockTtlMs,
      maxWaitMs,
      retryDelayMs
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

  private toInt(value: unknown, fallback: number) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.floor(value);
    }
    return fallback;
  }
}
