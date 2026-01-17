import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface NewsIndicatorAssociationSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  windowDays: number;
  maxLagDays: number;
  minSampleSize: number;
  minAbsCorrelation: number;
  maxPValue: number;
  topEntities: number;
  topTopics: number;
  maxAssociationsPerIndicator: number;
  indicatorSlugs: string[];
  backtestTriggerZScore: number;
  backtestBaselineDays: number;
  backtestHoldoutDays: number;
  cacheTtlSeconds: number;
}

export interface NewsIndicatorAssociationSettingsInput extends NewsIndicatorAssociationSettings {}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "newsIndicator:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "news_indicator_association_settings:";

@Injectable()
export class NewsIndicatorSettingsService {
  private readonly logger = createLogger({ name: "news-indicator-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  async getSettings(orgId: string): Promise<NewsIndicatorAssociationSettings> {
    const cacheKey = this.cacheKey(orgId);

    try {
      const cached = await this.cache.get<NewsIndicatorAssociationSettings>(cacheKey);
      if (cached) {
        return this.normalizeSettings(cached);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news indicator settings from cache; falling back to database"
      );
    }

    let settings: NewsIndicatorAssociationSettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load news indicator settings from database; using defaults"
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn({ err: error, orgId }, "Failed to write news indicator settings to cache");
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsIndicatorAssociationSettingsInput
  ): Promise<NewsIndicatorAssociationSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News indicator association settings (org=${orgId})`
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News indicator association settings (org=${orgId})`
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_indicator_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "news_indicator_settings_update" }
    );

    await this.cache.set(this.cacheKey(orgId), normalized, SETTINGS_CACHE_TTL_SECONDS);
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<NewsIndicatorAssociationSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) }
    });
    const raw = record?.value as Partial<NewsIndicatorAssociationSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): NewsIndicatorAssociationSettings {
    return {
      enabled: false,
      ingestionEnabled: false,
      windowDays: 180,
      maxLagDays: 7,
      minSampleSize: 30,
      minAbsCorrelation: 0.2,
      maxPValue: 0.2,
      topEntities: 50,
      topTopics: 50,
      maxAssociationsPerIndicator: 60,
      indicatorSlugs: [],
      backtestTriggerZScore: 2,
      backtestBaselineDays: 30,
      backtestHoldoutDays: 30,
      cacheTtlSeconds: 120
    };
  }

  private normalizeSettings(
    value: Partial<NewsIndicatorAssociationSettingsInput>,
    fallback?: NewsIndicatorAssociationSettings
  ): NewsIndicatorAssociationSettings {
    const defaults = fallback ?? this.getFallbackSettings();
    const indicatorSlugs = Array.isArray(value.indicatorSlugs) ? value.indicatorSlugs : defaults.indicatorSlugs;
    const normalizedSlugs = indicatorSlugs
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .slice(0, 50);

    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      ingestionEnabled: typeof value.ingestionEnabled === "boolean" ? value.ingestionEnabled : defaults.ingestionEnabled,
      windowDays: this.clampInt(value.windowDays, 7, 3650, defaults.windowDays),
      maxLagDays: this.clampInt(value.maxLagDays, 0, 30, defaults.maxLagDays),
      minSampleSize: this.clampInt(value.minSampleSize, 10, 2000, defaults.minSampleSize),
      minAbsCorrelation: this.clampFloat(value.minAbsCorrelation, 0, 1, defaults.minAbsCorrelation),
      maxPValue: this.clampFloat(value.maxPValue, 0, 1, defaults.maxPValue),
      topEntities: this.clampInt(value.topEntities, 0, 500, defaults.topEntities),
      topTopics: this.clampInt(value.topTopics, 0, 500, defaults.topTopics),
      maxAssociationsPerIndicator: this.clampInt(
        value.maxAssociationsPerIndicator,
        1,
        1000,
        defaults.maxAssociationsPerIndicator
      ),
      indicatorSlugs: Array.from(new Set(normalizedSlugs)),
      backtestTriggerZScore: this.clampFloat(value.backtestTriggerZScore, 0, 10, defaults.backtestTriggerZScore),
      backtestBaselineDays: this.clampInt(value.backtestBaselineDays, 5, 365, defaults.backtestBaselineDays),
      backtestHoldoutDays: this.clampInt(value.backtestHoldoutDays, 0, 365, defaults.backtestHoldoutDays),
      cacheTtlSeconds: this.clampInt(value.cacheTtlSeconds, 0, 3600, defaults.cacheTtlSeconds)
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
