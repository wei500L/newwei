import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export const NEWS_EVENT_CLUSTERING_MODES = [
  "vector",
  "bertopic_primary",
] as const;

export type NewsEventClusteringMode =
  (typeof NEWS_EVENT_CLUSTERING_MODES)[number];

export interface NewsEventSettings {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  clusteringMode: NewsEventClusteringMode;
  bertopicMinItemsPerGroup: number;
  bertopicMaxItemsPerRequest: number;
  bertopicMinTopicSize: number;
  forceAuthoritativeMode: boolean;
  forceMinAuthoritativeSources: number;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  classificationGateEnabled: boolean;
  categoryConflictReject: boolean;
  categorySoftPenalty: number;
  minCategoryConfidenceForGate: number;
  timelineLowConfidenceThreshold: number;
  timelineHighConfidenceThreshold: number;
  timelineDriftKlThreshold: number;
  timelineMinBucketItemsForDrift: number;
  timelineCrossCategoryWarningShare: number;
  timelineMaxCategoryDistributionItems: number;
  timelineMaxPhaseSummaries: number;
  timelinePresetCustomDistanceThreshold: number;
  cacheTtlSeconds: number;
}

export interface NewsEventSettingsInput {
  enabled: boolean;
  ingestionEnabled: boolean;
  timelineEnabled: boolean;
  clusteringMode: NewsEventClusteringMode;
  bertopicMinItemsPerGroup: number;
  bertopicMaxItemsPerRequest: number;
  bertopicMinTopicSize: number;
  forceAuthoritativeMode: boolean;
  forceMinAuthoritativeSources: number;
  maxBatchSize: number;
  backfillDays: number;
  lookbackDays: number;
  timelineMaxEventsPerRun: number;
  vectorMinScore: number;
  crossLanguagePenalty: number;
  classificationGateEnabled: boolean;
  categoryConflictReject: boolean;
  categorySoftPenalty: number;
  minCategoryConfidenceForGate: number;
  timelineLowConfidenceThreshold: number;
  timelineHighConfidenceThreshold: number;
  timelineDriftKlThreshold: number;
  timelineMinBucketItemsForDrift: number;
  timelineCrossCategoryWarningShare: number;
  timelineMaxCategoryDistributionItems: number;
  timelineMaxPhaseSummaries: number;
  timelinePresetCustomDistanceThreshold: number;
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
const MIN_CATEGORY_SOFT_PENALTY = 0;
const MAX_CATEGORY_SOFT_PENALTY = 1;
const MIN_CATEGORY_CONFIDENCE = 0;
const MAX_CATEGORY_CONFIDENCE = 1;
const MIN_TIMELINE_LOW_CONFIDENCE_THRESHOLD = 0;
const MAX_TIMELINE_LOW_CONFIDENCE_THRESHOLD = 1;
const MIN_TIMELINE_HIGH_CONFIDENCE_THRESHOLD = 0;
const MAX_TIMELINE_HIGH_CONFIDENCE_THRESHOLD = 1;
const MIN_TIMELINE_DRIFT_KL_THRESHOLD = 0;
const MAX_TIMELINE_DRIFT_KL_THRESHOLD = 5;
const MIN_TIMELINE_MIN_BUCKET_ITEMS_FOR_DRIFT = 1;
const MAX_TIMELINE_MIN_BUCKET_ITEMS_FOR_DRIFT = 50;
const MIN_TIMELINE_CROSS_CATEGORY_WARNING_SHARE = 0;
const MAX_TIMELINE_CROSS_CATEGORY_WARNING_SHARE = 1;
const MIN_TIMELINE_MAX_CATEGORY_DISTRIBUTION_ITEMS = 4;
const MAX_TIMELINE_MAX_CATEGORY_DISTRIBUTION_ITEMS = 64;
const MIN_TIMELINE_MAX_PHASE_SUMMARIES = 1;
const MAX_TIMELINE_MAX_PHASE_SUMMARIES = 20;
const MIN_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD = 0;
const MAX_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD = 7;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;
const MIN_FORCE_MIN_AUTHORITATIVE_SOURCES = 1;
const MAX_FORCE_MIN_AUTHORITATIVE_SOURCES = 5;
const MIN_BERTOPIC_MIN_ITEMS_PER_GROUP = 2;
const MAX_BERTOPIC_MIN_ITEMS_PER_GROUP = 100;
const MIN_BERTOPIC_MAX_ITEMS_PER_REQUEST = 2;
const MAX_BERTOPIC_MAX_ITEMS_PER_REQUEST = 500;
const MIN_BERTOPIC_MIN_TOPIC_SIZE = 2;
const MAX_BERTOPIC_MIN_TOPIC_SIZE = 100;

@Injectable()
export class NewsEventsSettingsService {
  private readonly logger = createLogger({ name: "news-events-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(orgId: string): Promise<NewsEventSettings> {
    const cacheKey = this.cacheKey(orgId);

    let cached: NewsEventSettings | null = null;
    try {
      cached = await this.cache.get<NewsEventSettings>(cacheKey);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read news event settings from cache; falling back to database",
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
        "Failed to load news event settings from database; using defaults",
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write news event settings to cache",
      );
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: NewsEventSettingsInput,
  ): Promise<NewsEventSettings> {
    const normalized = this.normalizeSettings(input);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event settings (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `News event settings (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "news_event_settings_update",
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "news_event_settings_update",
      },
    );

    await this.cache.set(
      this.cacheKey(orgId),
      normalized,
      SETTINGS_CACHE_TTL_SECONDS,
    );
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(orgId: string): Promise<NewsEventSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw = record?.value as Partial<NewsEventSettingsInput> | undefined;
    return this.normalizeSettings(raw ?? {}, fallback);
  }

  private getFallbackSettings(): NewsEventSettings {
    return {
      enabled: false,
      ingestionEnabled: false,
      timelineEnabled: true,
      clusteringMode: "vector",
      bertopicMinItemsPerGroup: 8,
      bertopicMaxItemsPerRequest: 32,
      bertopicMinTopicSize: 4,
      forceAuthoritativeMode: false,
      forceMinAuthoritativeSources: 1,
      maxBatchSize: 100,
      backfillDays: 30,
      lookbackDays: 30,
      timelineMaxEventsPerRun: 50,
      vectorMinScore: 0.82,
      crossLanguagePenalty: 0.1,
      classificationGateEnabled: true,
      categoryConflictReject: true,
      categorySoftPenalty: 0.15,
      minCategoryConfidenceForGate: 0.4,
      timelineLowConfidenceThreshold: 0.5,
      timelineHighConfidenceThreshold: 0.8,
      timelineDriftKlThreshold: 0.35,
      timelineMinBucketItemsForDrift: 3,
      timelineCrossCategoryWarningShare: 0.3,
      timelineMaxCategoryDistributionItems: 16,
      timelineMaxPhaseSummaries: 8,
      timelinePresetCustomDistanceThreshold: 0.22,
      cacheTtlSeconds: 60,
    };
  }

  private normalizeSettings(
    value: Partial<NewsEventSettingsInput>,
    fallback?: NewsEventSettings,
  ): NewsEventSettings {
    const defaults = fallback ?? this.getFallbackSettings();
    const rawTimelineLowConfidenceThreshold = this.clampFloat(
      value.timelineLowConfidenceThreshold,
      MIN_TIMELINE_LOW_CONFIDENCE_THRESHOLD,
      MAX_TIMELINE_LOW_CONFIDENCE_THRESHOLD,
      defaults.timelineLowConfidenceThreshold,
    );
    const rawTimelineHighConfidenceThreshold = this.clampFloat(
      value.timelineHighConfidenceThreshold,
      MIN_TIMELINE_HIGH_CONFIDENCE_THRESHOLD,
      MAX_TIMELINE_HIGH_CONFIDENCE_THRESHOLD,
      defaults.timelineHighConfidenceThreshold,
    );
    const timelineLowConfidenceThreshold = Math.min(
      rawTimelineLowConfidenceThreshold,
      rawTimelineHighConfidenceThreshold,
    );
    const timelineHighConfidenceThreshold = Math.max(
      rawTimelineLowConfidenceThreshold,
      rawTimelineHighConfidenceThreshold,
    );

    return {
      enabled:
        typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
      ingestionEnabled:
        typeof value.ingestionEnabled === "boolean"
          ? value.ingestionEnabled
          : defaults.ingestionEnabled,
      timelineEnabled:
        typeof value.timelineEnabled === "boolean"
          ? value.timelineEnabled
          : defaults.timelineEnabled,
      clusteringMode: this.normalizeClusteringMode(
        value.clusteringMode,
        defaults.clusteringMode,
      ),
      bertopicMinItemsPerGroup: this.clampInt(
        value.bertopicMinItemsPerGroup,
        MIN_BERTOPIC_MIN_ITEMS_PER_GROUP,
        MAX_BERTOPIC_MIN_ITEMS_PER_GROUP,
        defaults.bertopicMinItemsPerGroup,
      ),
      bertopicMaxItemsPerRequest: this.clampInt(
        value.bertopicMaxItemsPerRequest,
        MIN_BERTOPIC_MAX_ITEMS_PER_REQUEST,
        MAX_BERTOPIC_MAX_ITEMS_PER_REQUEST,
        defaults.bertopicMaxItemsPerRequest,
      ),
      bertopicMinTopicSize: this.clampInt(
        value.bertopicMinTopicSize,
        MIN_BERTOPIC_MIN_TOPIC_SIZE,
        MAX_BERTOPIC_MIN_TOPIC_SIZE,
        defaults.bertopicMinTopicSize,
      ),
      forceAuthoritativeMode:
        typeof value.forceAuthoritativeMode === "boolean"
          ? value.forceAuthoritativeMode
          : defaults.forceAuthoritativeMode,
      forceMinAuthoritativeSources: this.clampInt(
        value.forceMinAuthoritativeSources,
        MIN_FORCE_MIN_AUTHORITATIVE_SOURCES,
        MAX_FORCE_MIN_AUTHORITATIVE_SOURCES,
        defaults.forceMinAuthoritativeSources,
      ),
      maxBatchSize: this.clampInt(
        value.maxBatchSize,
        MIN_MAX_BATCH_SIZE,
        MAX_MAX_BATCH_SIZE,
        defaults.maxBatchSize,
      ),
      backfillDays: this.clampInt(
        value.backfillDays,
        MIN_BACKFILL_DAYS,
        MAX_BACKFILL_DAYS,
        defaults.backfillDays,
      ),
      lookbackDays: this.clampInt(
        value.lookbackDays,
        MIN_LOOKBACK_DAYS,
        MAX_LOOKBACK_DAYS,
        defaults.lookbackDays,
      ),
      timelineMaxEventsPerRun: this.clampInt(
        value.timelineMaxEventsPerRun,
        MIN_TIMELINE_MAX_EVENTS_PER_RUN,
        MAX_TIMELINE_MAX_EVENTS_PER_RUN,
        defaults.timelineMaxEventsPerRun,
      ),
      vectorMinScore: this.clampFloat(
        value.vectorMinScore,
        MIN_VECTOR_MIN_SCORE,
        MAX_VECTOR_MIN_SCORE,
        defaults.vectorMinScore,
      ),
      crossLanguagePenalty: this.clampFloat(
        value.crossLanguagePenalty,
        MIN_CROSS_LANGUAGE_PENALTY,
        MAX_CROSS_LANGUAGE_PENALTY,
        defaults.crossLanguagePenalty,
      ),
      classificationGateEnabled:
        typeof value.classificationGateEnabled === "boolean"
          ? value.classificationGateEnabled
          : defaults.classificationGateEnabled,
      categoryConflictReject:
        typeof value.categoryConflictReject === "boolean"
          ? value.categoryConflictReject
          : defaults.categoryConflictReject,
      categorySoftPenalty: this.clampFloat(
        value.categorySoftPenalty,
        MIN_CATEGORY_SOFT_PENALTY,
        MAX_CATEGORY_SOFT_PENALTY,
        defaults.categorySoftPenalty,
      ),
      minCategoryConfidenceForGate: this.clampFloat(
        value.minCategoryConfidenceForGate,
        MIN_CATEGORY_CONFIDENCE,
        MAX_CATEGORY_CONFIDENCE,
        defaults.minCategoryConfidenceForGate,
      ),
      timelineLowConfidenceThreshold,
      timelineHighConfidenceThreshold,
      timelineDriftKlThreshold: this.clampFloat(
        value.timelineDriftKlThreshold,
        MIN_TIMELINE_DRIFT_KL_THRESHOLD,
        MAX_TIMELINE_DRIFT_KL_THRESHOLD,
        defaults.timelineDriftKlThreshold,
      ),
      timelineMinBucketItemsForDrift: this.clampInt(
        value.timelineMinBucketItemsForDrift,
        MIN_TIMELINE_MIN_BUCKET_ITEMS_FOR_DRIFT,
        MAX_TIMELINE_MIN_BUCKET_ITEMS_FOR_DRIFT,
        defaults.timelineMinBucketItemsForDrift,
      ),
      timelineCrossCategoryWarningShare: this.clampFloat(
        value.timelineCrossCategoryWarningShare,
        MIN_TIMELINE_CROSS_CATEGORY_WARNING_SHARE,
        MAX_TIMELINE_CROSS_CATEGORY_WARNING_SHARE,
        defaults.timelineCrossCategoryWarningShare,
      ),
      timelineMaxCategoryDistributionItems: this.clampInt(
        value.timelineMaxCategoryDistributionItems,
        MIN_TIMELINE_MAX_CATEGORY_DISTRIBUTION_ITEMS,
        MAX_TIMELINE_MAX_CATEGORY_DISTRIBUTION_ITEMS,
        defaults.timelineMaxCategoryDistributionItems,
      ),
      timelineMaxPhaseSummaries: this.clampInt(
        value.timelineMaxPhaseSummaries,
        MIN_TIMELINE_MAX_PHASE_SUMMARIES,
        MAX_TIMELINE_MAX_PHASE_SUMMARIES,
        defaults.timelineMaxPhaseSummaries,
      ),
      timelinePresetCustomDistanceThreshold: this.clampFloat(
        value.timelinePresetCustomDistanceThreshold,
        MIN_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD,
        MAX_TIMELINE_PRESET_CUSTOM_DISTANCE_THRESHOLD,
        defaults.timelinePresetCustomDistanceThreshold,
      ),
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds,
      ),
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

  private normalizeClusteringMode(
    value: unknown,
    fallback: NewsEventClusteringMode,
  ): NewsEventClusteringMode {
    if (typeof value !== "string") {
      return fallback;
    }
    const normalized = value.trim();
    return NEWS_EVENT_CLUSTERING_MODES.includes(
      normalized as NewsEventClusteringMode,
    )
      ? (normalized as NewsEventClusteringMode)
      : fallback;
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

  private clampFloat(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ) {
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
