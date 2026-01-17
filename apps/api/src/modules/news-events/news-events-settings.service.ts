import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface NewsEventSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  cacheTtlSeconds: number;
}

export interface NewsEventSettingsInput {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  cacheTtlSeconds: number;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsEvents:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "news_event_settings:";

const MIN_MAX_BATCH_SIZE = 1;
const MAX_MAX_BATCH_SIZE = 500;
const MIN_BACKFILL_DAYS = 1;
const MAX_BACKFILL_DAYS = 365;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 180;
const MIN_TIMELINE_MAX_EVENTS_PER_RUN = 1;
const MAX_TIMELINE_MAX_EVENTS_PER_RUN = 200;
const MIN_VECTOR_MIN_SCORE = 0;
const MAX_VECTOR_MIN_SCORE = 1;
const MIN_CROSS_LANGUAGE_PENALTY = 0;
const MAX_CROSS_LANGUAGE_PENALTY = 1;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;

@Injectable()
export class NewsEventsSettingsService {
  private readonly logger = createLogger({ name: "news-events-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  async getSettings(orgId: string): Promise<NewsEventSettings> {
    const cacheKey = this.cacheKey(orgId);

    let cached: NewsEventSettings | null = null;
    try {
      cached = await this.cache.get<NewsEventSettings>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news event settings from cache; falling back to database"
      );
    }

    if (cached) {
      return this.normalizeSettings(cached);
    }

    let settings: NewsEventSettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news event settings from database; using defaults"
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, "Failed to write news event settings to cache");
    }

    return settings;
  }

  async updateSettings(orgId: string, actorId: string, input: NewsEventSettingsInput): Promise<NewsEventSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event settings (org=${orgId})`
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event settings (org=${orgId})`
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_event_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "news_event_settings_update" }
    );

    await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<NewsEventSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) }
    });
    const raw = record?.value as Partial<NewsEventSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): NewsEventSettings {
    return {
      enabled: false,
      ingestionEnabled: false,
      timelineEnabled: true,
      maxBatchSize: 100,
      backfillDays: 30,
      lookbackDays: 30,
      timelineMaxEventsPerRun: 50,
      vectorMinScore: 0.82,
      crossLanguagePenalty: 0.1,
      cacheTtlSeconds: 60
    };
  }

  private normalizeSettings(
    value: Partial<NewsEventSettingsInput>,
    fallback?: NewsEventSettings
  ): NewsEventSettings {
    const defaults = fallback ?? this.getFallbackSettings();

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      ingestionEnabled: typeof value.ingestionEnabled === "boolean" ? value.ingestionEnabled : defaults.ingestionEnabled,
      timelineEnabled: typeof value.timelineEnabled === "boolean" ? value.timelineEnabled : defaults.timelineEnabled,
      maxBatchSize: this.clampInt(value.maxBatchSize, MIN_MAX_BATCH_SIZE, MAX_MAX_BATCH_SIZE, defaults.maxBatchSize),
      backfillDays: this.clampInt(value.backfillDays, MIN_BACKFILL_DAYS, MAX_BACKFILL_DAYS, defaults.backfillDays),
      lookbackDays: this.clampInt(value.lookbackDays, MIN_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS, defaults.lookbackDays),
      timelineMaxEventsPerRun: this.clampInt(
        value.timelineMaxEventsPerRun,
        MIN_TIMELINE_MAX_EVENTS_PER_RUN,
        MAX_TIMELINE_MAX_EVENTS_PER_RUN,
        defaults.timelineMaxEventsPerRun
      ),
      vectorMinScore: this.clampFloat(
        value.vectorMinScore,
        MIN_VECTOR_MIN_SCORE,
        MAX_VECTOR_MIN_SCORE,
        defaults.vectorMinScore
      ),
      crossLanguagePenalty: this.clampFloat(
        value.crossLanguagePenalty,
        MIN_CROSS_LANGUAGE_PENALTY,
        MAX_CROSS_LANGUAGE_PENALTY,
        defaults.crossLanguagePenalty
      ),
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds
      )
    };
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    const rounded = Math.round(numeric);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }

  private clampFloat(value: unknown, min: number, max: number, fallback: number) {
    const numeric = this.toNumber(value);
    if (numeric === null || Number.isNaN(numeric)) {
      return fallback;
    }
    if (numeric < min) {
      return min;
    }
    if (numeric > max) {
      return max;
    }
    return numeric;
  }
}
