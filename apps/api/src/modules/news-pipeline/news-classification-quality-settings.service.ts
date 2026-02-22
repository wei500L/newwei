import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

export interface ClassificationQualitySettings {
  lowConfidenceThreshold: number;
  llmP95LatencyWarnMs: number;
  embeddingP95LatencyWarnMs: number;
  rerankP95LatencyWarnMs: number;
  gateRejectRateWarn: number;
  gatePenalizedRateWarn: number;
  reportMinPairCount: number;
  reportMinPairErrorRate: number;
  cacheTtlSeconds: number;
}

export interface ClassificationQualitySettingsInput {
  lowConfidenceThreshold?: number;
  llmP95LatencyWarnMs?: number;
  embeddingP95LatencyWarnMs?: number;
  rerankP95LatencyWarnMs?: number;
  gateRejectRateWarn?: number;
  gatePenalizedRateWarn?: number;
  reportMinPairCount?: number;
  reportMinPairErrorRate?: number;
  cacheTtlSeconds?: number;
}

const SETTINGS_CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = "classificationQuality:settings:";
const SYSTEM_SETTING_KEY_PREFIX = "classification_quality_settings:";

const MIN_RATE = 0;
const MAX_RATE = 1;
const MIN_CACHE_TTL_SECONDS = 0;
const MAX_CACHE_TTL_SECONDS = 3600;
const MIN_LATENCY_WARN_MS = 100;
const MAX_LATENCY_WARN_MS = 120_000;
const MIN_REPORT_PAIR_COUNT = 1;
const MAX_REPORT_PAIR_COUNT = 1000;

@Injectable()
export class NewsClassificationQualitySettingsService {
  private readonly logger = createLogger({
    name: "news-classification-quality-settings",
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async getSettings(orgId: string): Promise<ClassificationQualitySettings> {
    const cacheKey = this.cacheKey(orgId);

    try {
      const cached =
        await this.cache.get<ClassificationQualitySettings>(cacheKey);
      if (cached) {
        return this.normalizeSettings(cached);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to read classification quality settings from cache; falling back to database",
      );
    }

    let settings: ClassificationQualitySettings;
    try {
      settings = await this.loadSettings(orgId);
    } catch (error) {
      settings = this.getFallbackSettings();
      this.logger.warn(
        { err: error, orgId },
        "Failed to load classification quality settings from database; using defaults",
      );
    }

    try {
      await this.cache.set(cacheKey, settings, SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(
        { err: error, orgId },
        "Failed to write classification quality settings to cache",
      );
    }

    return settings;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: ClassificationQualitySettingsInput,
  ): Promise<ClassificationQualitySettings> {
    const cacheKey = this.cacheKey(orgId);
    const current = await this.getSettings(orgId);
    const normalized = this.normalizeSettings(input, current);
    const key = this.systemSettingKey(orgId);

    await this.prisma.systemSetting.upsert({
      where: { key },
      update: {
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Classification quality settings (org=${orgId})`,
      },
      create: {
        key,
        value: toPrismaJsonValue(normalized),
        updatedById: actorId,
        description: `Classification quality settings (org=${orgId})`,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "classification_quality_settings_update",
          metadata: toPrismaJsonValue(normalized),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "classification_quality_settings_update",
      },
    );

    await this.cache.set(cacheKey, normalized, SETTINGS_CACHE_TTL_SECONDS);
    return normalized;
  }

  async invalidateCache(orgId: string) {
    await this.cache.del(this.cacheKey(orgId));
  }

  private async loadSettings(
    orgId: string,
  ): Promise<ClassificationQualitySettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: this.systemSettingKey(orgId) },
    });
    const raw =
      (record?.value as Partial<ClassificationQualitySettingsInput> | undefined) ??
      {};
    return this.normalizeSettings(raw, fallback);
  }

  private getFallbackSettings(): ClassificationQualitySettings {
    return {
      lowConfidenceThreshold: 0.4,
      llmP95LatencyWarnMs: 8000,
      embeddingP95LatencyWarnMs: 3000,
      rerankP95LatencyWarnMs: 4000,
      gateRejectRateWarn: 0.2,
      gatePenalizedRateWarn: 0.35,
      reportMinPairCount: 3,
      reportMinPairErrorRate: 0.2,
      cacheTtlSeconds: 60,
    };
  }

  private normalizeSettings(
    value: Partial<ClassificationQualitySettingsInput>,
    fallback?: ClassificationQualitySettings,
  ): ClassificationQualitySettings {
    const defaults = fallback ?? this.getFallbackSettings();
    return {
      lowConfidenceThreshold: this.clampFloat(
        value.lowConfidenceThreshold,
        MIN_RATE,
        MAX_RATE,
        defaults.lowConfidenceThreshold,
      ),
      llmP95LatencyWarnMs: this.clampInt(
        value.llmP95LatencyWarnMs,
        MIN_LATENCY_WARN_MS,
        MAX_LATENCY_WARN_MS,
        defaults.llmP95LatencyWarnMs,
      ),
      embeddingP95LatencyWarnMs: this.clampInt(
        value.embeddingP95LatencyWarnMs,
        MIN_LATENCY_WARN_MS,
        MAX_LATENCY_WARN_MS,
        defaults.embeddingP95LatencyWarnMs,
      ),
      rerankP95LatencyWarnMs: this.clampInt(
        value.rerankP95LatencyWarnMs,
        MIN_LATENCY_WARN_MS,
        MAX_LATENCY_WARN_MS,
        defaults.rerankP95LatencyWarnMs,
      ),
      gateRejectRateWarn: this.clampFloat(
        value.gateRejectRateWarn,
        MIN_RATE,
        MAX_RATE,
        defaults.gateRejectRateWarn,
      ),
      gatePenalizedRateWarn: this.clampFloat(
        value.gatePenalizedRateWarn,
        MIN_RATE,
        MAX_RATE,
        defaults.gatePenalizedRateWarn,
      ),
      reportMinPairCount: this.clampInt(
        value.reportMinPairCount,
        MIN_REPORT_PAIR_COUNT,
        MAX_REPORT_PAIR_COUNT,
        defaults.reportMinPairCount,
      ),
      reportMinPairErrorRate: this.clampFloat(
        value.reportMinPairErrorRate,
        MIN_RATE,
        MAX_RATE,
        defaults.reportMinPairErrorRate,
      ),
      cacheTtlSeconds: this.clampInt(
        value.cacheTtlSeconds,
        MIN_CACHE_TTL_SECONDS,
        MAX_CACHE_TTL_SECONDS,
        defaults.cacheTtlSeconds,
      ),
    };
  }

  private clampFloat(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Number(value.toFixed(4))));
  }

  private clampInt(
    value: unknown,
    min: number,
    max: number,
    fallback: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const normalized = Math.round(value);
    return Math.max(min, Math.min(max, normalized));
  }

  private systemSettingKey(orgId: string) {
    return `${SYSTEM_SETTING_KEY_PREFIX}${orgId}`;
  }

  private cacheKey(orgId: string) {
    return `${CACHE_KEY_PREFIX}${orgId}`;
  }
}
