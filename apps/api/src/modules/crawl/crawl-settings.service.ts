import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export interface CrawlClientSettings {
  healthCheckTtlMs: number;
  // Legacy alias kept for backward compatibility. Mirrors requestTimeoutNormalMs.
  requestTimeoutMs: number;
  requestTimeoutHotMs: number;
  requestTimeoutNormalMs: number;
  conditionalRequestEnabled: boolean;
  conditionalRequestTimeoutMs: number;
  conditionalRequestMaxRetries: number;
  detailPublishSignalHeadFetchTimeoutMs: number;
  detailPublishSignalHeadFetchConcurrency: number;
  detailPublishSignalHeadFetchMaxReadBytes: number;
  maxRetries: number;
  retryBackoffMs: number;
  queueOverloadCooldownMs: number;
  adaptiveConcurrencyEnabled: boolean;
  adaptiveWindowMinutes: number;
  adaptiveCooldownMinutes: number;
  adaptiveLatencyThresholdRatio: number;
  adaptiveErrorRateThreshold: number;
  adaptiveMemoryHeadroomThreshold: number;
  maxConcurrency: number;
}

export interface CrawlClientSettingsInput {
  healthCheckTtlMs?: number;
  requestTimeoutMs?: number;
  requestTimeoutHotMs?: number;
  requestTimeoutNormalMs?: number;
  conditionalRequestEnabled?: boolean;
  conditionalRequestTimeoutMs?: number;
  conditionalRequestMaxRetries?: number;
  detailPublishSignalHeadFetchTimeoutMs?: number;
  detailPublishSignalHeadFetchConcurrency?: number;
  detailPublishSignalHeadFetchMaxReadBytes?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  queueOverloadCooldownMs?: number;
  adaptiveConcurrencyEnabled?: boolean;
  adaptiveWindowMinutes?: number;
  adaptiveCooldownMinutes?: number;
  adaptiveLatencyThresholdRatio?: number;
  adaptiveErrorRateThreshold?: number;
  adaptiveMemoryHeadroomThreshold?: number;
  maxConcurrency?: number;
}

const CRAWL_CLIENT_SETTINGS_KEY = "crawl_client_settings";
const MIN_HEALTH_CHECK_TTL_MS = 5_000;
const MAX_HEALTH_CHECK_TTL_MS = 900_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 900_000;
const DEFAULT_REQUEST_TIMEOUT_HOT_MS = 60_000;
const DEFAULT_CONDITIONAL_REQUEST_ENABLED = true;
const DEFAULT_CONDITIONAL_REQUEST_TIMEOUT_MS = 5_000;
const MIN_CONDITIONAL_REQUEST_TIMEOUT_MS = 500;
const MAX_CONDITIONAL_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CONDITIONAL_REQUEST_MAX_RETRIES = 0;
const MIN_CONDITIONAL_REQUEST_MAX_RETRIES = 0;
const MAX_CONDITIONAL_REQUEST_MAX_RETRIES = 5;
const DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS = 1_500;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS = 500;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY = 2;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY = 1;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY = 8;
const DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES = 8_000_000;
const MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES = 1_048_576;
const MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES = 64_000_000;
const MIN_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_BACKOFF_MS = 600_000;
const MIN_RETRY_ATTEMPTS = 1;
const MAX_RETRY_ATTEMPTS = 10;
const MIN_QUEUE_OVERLOAD_COOLDOWN_MS = 5_000;
const MAX_QUEUE_OVERLOAD_COOLDOWN_MS = 600_000;
const DEFAULT_QUEUE_OVERLOAD_COOLDOWN_MS = 30_000;
const MIN_CRAWL_MAX_CONCURRENCY = 1;
const MAX_CRAWL_MAX_CONCURRENCY = 20;
const DEFAULT_ADAPTIVE_WINDOW_MINUTES = 15;
const DEFAULT_ADAPTIVE_COOLDOWN_MINUTES = 5;
const MIN_ADAPTIVE_WINDOW_MINUTES = 1;
const MAX_ADAPTIVE_WINDOW_MINUTES = 180;
const MIN_ADAPTIVE_COOLDOWN_MINUTES = 1;
const MAX_ADAPTIVE_COOLDOWN_MINUTES = 60;
const DEFAULT_ADAPTIVE_LATENCY_THRESHOLD_RATIO = 0.85;
const DEFAULT_ADAPTIVE_ERROR_RATE_THRESHOLD = 0.2;
const DEFAULT_ADAPTIVE_MEMORY_HEADROOM_THRESHOLD = 0.12;
const MIN_ADAPTIVE_THRESHOLD_RATIO = 0.01;
const MAX_ADAPTIVE_THRESHOLD_RATIO = 0.99;
const SETTINGS_CACHE_TTL_MS = 30_000;
const CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS = [
  "healthCheckTtlMs",
  "requestTimeoutHotMs",
  "requestTimeoutNormalMs",
  "conditionalRequestEnabled",
  "conditionalRequestTimeoutMs",
  "conditionalRequestMaxRetries",
  "detailPublishSignalHeadFetchTimeoutMs",
  "detailPublishSignalHeadFetchConcurrency",
  "detailPublishSignalHeadFetchMaxReadBytes",
  "maxRetries",
  "retryBackoffMs",
  "queueOverloadCooldownMs",
  "adaptiveConcurrencyEnabled",
  "adaptiveWindowMinutes",
  "adaptiveCooldownMinutes",
  "adaptiveLatencyThresholdRatio",
  "adaptiveErrorRateThreshold",
  "adaptiveMemoryHeadroomThreshold",
  "maxConcurrency"
] as const;

type CrawlClientSettingsAuditField = (typeof CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS)[number];
type CrawlClientSettingsAuditSnapshot = Record<CrawlClientSettingsAuditField, number | boolean>;

@Injectable()
export class CrawlSettingsService {
  private cachedSettings:
    | {
        value: CrawlClientSettings;
        expiresAt: number;
      }
    | null = null;
  private loadingPromise: Promise<CrawlClientSettings> | null = null;

  constructor(private readonly prisma: PrismaService, private readonly env: EnvService) {}

  async getSettings(): Promise<CrawlClientSettings> {
    const cached = this.cachedSettings;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.loadSettings()
      .then((settings) => {
        this.cachedSettings = {
          value: settings,
          expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS
        };
        return settings;
      })
      .finally(() => {
        this.loadingPromise = null;
      });

    return this.loadingPromise;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: CrawlClientSettingsInput
  ): Promise<CrawlClientSettings> {
    const current = await this.getSettings();
    const normalized = this.normalize(input, current);
    await this.persistSettings(normalized, actorId);

    const auditMetadata = this.buildAuditMetadata(current, normalized, input);
    if (auditMetadata) {
      void writeAuditLogBestEffort(
        this.prisma,
        {
          data: {
            orgId,
            actorId,
            resource: "system_settings",
            action: "crawl_client_settings_update",
            metadata: toPrismaJsonValue(auditMetadata)
          }
        },
        { orgId, actorId, resource: "system_settings", action: "crawl_client_settings_update" }
      ).catch(() => undefined);
    }

    return normalized;
  }

  async updateSettingsInternal(input: CrawlClientSettingsInput): Promise<CrawlClientSettings> {
    const current = await this.getSettings();
    const normalized = this.normalize(input, current);
    await this.persistSettings(normalized, null);
    return normalized;
  }

  async updateMaxConcurrency(orgId: string, actorId: string, maxConcurrency: number) {
    return this.updateSettings(orgId, actorId, { maxConcurrency });
  }

  async updateMaxConcurrencyInternal(maxConcurrency: number) {
    return this.updateSettingsInternal({ maxConcurrency });
  }

  private async loadSettings(): Promise<CrawlClientSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: CRAWL_CLIENT_SETTINGS_KEY }
    });
    const raw = (record?.value as Partial<CrawlClientSettingsInput> | undefined) ?? {};
    return this.normalize(
      {
        healthCheckTtlMs: raw.healthCheckTtlMs,
        requestTimeoutMs: raw.requestTimeoutMs,
        requestTimeoutHotMs: raw.requestTimeoutHotMs,
        requestTimeoutNormalMs: raw.requestTimeoutNormalMs,
        conditionalRequestEnabled: raw.conditionalRequestEnabled,
        conditionalRequestTimeoutMs: raw.conditionalRequestTimeoutMs,
        conditionalRequestMaxRetries: raw.conditionalRequestMaxRetries,
        detailPublishSignalHeadFetchTimeoutMs:
          raw.detailPublishSignalHeadFetchTimeoutMs,
        detailPublishSignalHeadFetchConcurrency:
          raw.detailPublishSignalHeadFetchConcurrency,
        detailPublishSignalHeadFetchMaxReadBytes:
          raw.detailPublishSignalHeadFetchMaxReadBytes,
        maxRetries: raw.maxRetries,
        retryBackoffMs: raw.retryBackoffMs,
        queueOverloadCooldownMs: raw.queueOverloadCooldownMs,
        adaptiveConcurrencyEnabled: raw.adaptiveConcurrencyEnabled,
        adaptiveWindowMinutes: raw.adaptiveWindowMinutes,
        adaptiveCooldownMinutes: raw.adaptiveCooldownMinutes,
        adaptiveLatencyThresholdRatio: raw.adaptiveLatencyThresholdRatio,
        adaptiveErrorRateThreshold: raw.adaptiveErrorRateThreshold,
        adaptiveMemoryHeadroomThreshold: raw.adaptiveMemoryHeadroomThreshold,
        maxConcurrency: raw.maxConcurrency
      },
      fallback
    );
  }

  private getFallbackSettings(): CrawlClientSettings {
    const envConfig = this.env.crawl4aiConfig;
    const requestTimeoutNormalMs = this.clamp(
      envConfig.timeoutMs,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    );
    const requestTimeoutHotMs = this.clamp(
      Math.min(requestTimeoutNormalMs, DEFAULT_REQUEST_TIMEOUT_HOT_MS),
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      requestTimeoutNormalMs
    );

    return {
      healthCheckTtlMs: this.clamp(
        envConfig.healthCheckTtlMs ?? 60_000,
        MIN_HEALTH_CHECK_TTL_MS,
        MAX_HEALTH_CHECK_TTL_MS
      ),
      requestTimeoutMs: requestTimeoutNormalMs,
      requestTimeoutHotMs,
      requestTimeoutNormalMs,
      conditionalRequestEnabled: DEFAULT_CONDITIONAL_REQUEST_ENABLED,
      conditionalRequestTimeoutMs: DEFAULT_CONDITIONAL_REQUEST_TIMEOUT_MS,
      conditionalRequestMaxRetries: DEFAULT_CONDITIONAL_REQUEST_MAX_RETRIES,
      detailPublishSignalHeadFetchTimeoutMs: this.clamp(
        DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS
      ),
      detailPublishSignalHeadFetchConcurrency: this.clamp(
        DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY
      ),
      detailPublishSignalHeadFetchMaxReadBytes: this.clamp(
        DEFAULT_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES
      ),
      maxRetries: this.clamp(envConfig.maxRetries, MIN_RETRY_ATTEMPTS, MAX_RETRY_ATTEMPTS),
      retryBackoffMs: this.clamp(
        envConfig.retryBackoffMs ?? 5_000,
        MIN_RETRY_BACKOFF_MS,
        MAX_RETRY_BACKOFF_MS
      ),
      queueOverloadCooldownMs: this.clamp(
        DEFAULT_QUEUE_OVERLOAD_COOLDOWN_MS,
        MIN_QUEUE_OVERLOAD_COOLDOWN_MS,
        MAX_QUEUE_OVERLOAD_COOLDOWN_MS
      ),
      adaptiveConcurrencyEnabled: false,
      adaptiveWindowMinutes: DEFAULT_ADAPTIVE_WINDOW_MINUTES,
      adaptiveCooldownMinutes: DEFAULT_ADAPTIVE_COOLDOWN_MINUTES,
      adaptiveLatencyThresholdRatio: DEFAULT_ADAPTIVE_LATENCY_THRESHOLD_RATIO,
      adaptiveErrorRateThreshold: DEFAULT_ADAPTIVE_ERROR_RATE_THRESHOLD,
      adaptiveMemoryHeadroomThreshold: DEFAULT_ADAPTIVE_MEMORY_HEADROOM_THRESHOLD,
      maxConcurrency: this.clamp(
        envConfig.maxConcurrency,
        MIN_CRAWL_MAX_CONCURRENCY,
        MAX_CRAWL_MAX_CONCURRENCY
      )
    };
  }

  private normalize(
    value: Partial<CrawlClientSettingsInput>,
    fallback?: CrawlClientSettings
  ): CrawlClientSettings {
    const defaults = fallback ?? this.getFallbackSettings();

    const requestTimeoutNormalMs = this.clamp(
      this.toInt(value.requestTimeoutNormalMs ?? value.requestTimeoutMs),
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      defaults.requestTimeoutNormalMs
    );

    const requestTimeoutHotCandidateMs = this.clamp(
      this.toInt(value.requestTimeoutHotMs),
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      defaults.requestTimeoutHotMs
    );

    const requestTimeoutHotMs = Math.min(requestTimeoutNormalMs, requestTimeoutHotCandidateMs);

    return {
      healthCheckTtlMs: this.clamp(
        this.toInt(value.healthCheckTtlMs),
        MIN_HEALTH_CHECK_TTL_MS,
        MAX_HEALTH_CHECK_TTL_MS,
        defaults.healthCheckTtlMs
      ),
      requestTimeoutMs: requestTimeoutNormalMs,
      requestTimeoutHotMs,
      requestTimeoutNormalMs,
      conditionalRequestEnabled: this.toBoolean(
        value.conditionalRequestEnabled,
        defaults.conditionalRequestEnabled
      ),
      conditionalRequestTimeoutMs: this.clamp(
        this.toInt(value.conditionalRequestTimeoutMs),
        MIN_CONDITIONAL_REQUEST_TIMEOUT_MS,
        MAX_CONDITIONAL_REQUEST_TIMEOUT_MS,
        defaults.conditionalRequestTimeoutMs
      ),
      conditionalRequestMaxRetries: this.clamp(
        this.toInt(value.conditionalRequestMaxRetries),
        MIN_CONDITIONAL_REQUEST_MAX_RETRIES,
        MAX_CONDITIONAL_REQUEST_MAX_RETRIES,
        defaults.conditionalRequestMaxRetries
      ),
      detailPublishSignalHeadFetchTimeoutMs: this.clamp(
        this.toInt(value.detailPublishSignalHeadFetchTimeoutMs),
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_TIMEOUT_MS,
        defaults.detailPublishSignalHeadFetchTimeoutMs
      ),
      detailPublishSignalHeadFetchConcurrency: this.clamp(
        this.toInt(value.detailPublishSignalHeadFetchConcurrency),
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_CONCURRENCY,
        defaults.detailPublishSignalHeadFetchConcurrency
      ),
      detailPublishSignalHeadFetchMaxReadBytes: this.clamp(
        this.toInt(value.detailPublishSignalHeadFetchMaxReadBytes),
        MIN_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
        MAX_DETAIL_PUBLISH_SIGNAL_HEAD_FETCH_MAX_READ_BYTES,
        defaults.detailPublishSignalHeadFetchMaxReadBytes
      ),
      maxRetries: this.clamp(
        this.toInt(value.maxRetries),
        MIN_RETRY_ATTEMPTS,
        MAX_RETRY_ATTEMPTS,
        defaults.maxRetries
      ),
      retryBackoffMs: this.clamp(
        this.toInt(value.retryBackoffMs),
        MIN_RETRY_BACKOFF_MS,
        MAX_RETRY_BACKOFF_MS,
        defaults.retryBackoffMs
      ),
      queueOverloadCooldownMs: this.clamp(
        this.toInt(value.queueOverloadCooldownMs),
        MIN_QUEUE_OVERLOAD_COOLDOWN_MS,
        MAX_QUEUE_OVERLOAD_COOLDOWN_MS,
        defaults.queueOverloadCooldownMs
      ),
      adaptiveConcurrencyEnabled: this.toBoolean(
        value.adaptiveConcurrencyEnabled,
        defaults.adaptiveConcurrencyEnabled
      ),
      adaptiveWindowMinutes: this.clamp(
        this.toInt(value.adaptiveWindowMinutes),
        MIN_ADAPTIVE_WINDOW_MINUTES,
        MAX_ADAPTIVE_WINDOW_MINUTES,
        defaults.adaptiveWindowMinutes
      ),
      adaptiveCooldownMinutes: this.clamp(
        this.toInt(value.adaptiveCooldownMinutes),
        MIN_ADAPTIVE_COOLDOWN_MINUTES,
        MAX_ADAPTIVE_COOLDOWN_MINUTES,
        defaults.adaptiveCooldownMinutes
      ),
      adaptiveLatencyThresholdRatio: this.clampFloat(
        this.toFloat(value.adaptiveLatencyThresholdRatio),
        MIN_ADAPTIVE_THRESHOLD_RATIO,
        MAX_ADAPTIVE_THRESHOLD_RATIO,
        defaults.adaptiveLatencyThresholdRatio
      ),
      adaptiveErrorRateThreshold: this.clampFloat(
        this.toFloat(value.adaptiveErrorRateThreshold),
        MIN_ADAPTIVE_THRESHOLD_RATIO,
        MAX_ADAPTIVE_THRESHOLD_RATIO,
        defaults.adaptiveErrorRateThreshold
      ),
      adaptiveMemoryHeadroomThreshold: this.clampFloat(
        this.toFloat(value.adaptiveMemoryHeadroomThreshold),
        MIN_ADAPTIVE_THRESHOLD_RATIO,
        MAX_ADAPTIVE_THRESHOLD_RATIO,
        defaults.adaptiveMemoryHeadroomThreshold
      ),
      maxConcurrency: this.clamp(
        this.toInt(value.maxConcurrency),
        MIN_CRAWL_MAX_CONCURRENCY,
        MAX_CRAWL_MAX_CONCURRENCY,
        defaults.maxConcurrency
      )
    };
  }

  private async persistSettings(settings: CrawlClientSettings, updatedById: string | null) {
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({
        where: { key: CRAWL_CLIENT_SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue(settings),
          updatedById,
          description: "Crawl client runtime settings"
        },
        create: {
          key: CRAWL_CLIENT_SETTINGS_KEY,
          value: toPrismaJsonValue(settings),
          updatedById,
          description: "Crawl client runtime settings"
        }
      })
    ]);
    this.cachedSettings = {
      value: settings,
      expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS
    };
  }

  private buildAuditMetadata(
    current: CrawlClientSettings,
    next: CrawlClientSettings,
    input: CrawlClientSettingsInput
  ) {
    const before = this.toAuditSnapshot(current);
    const after = this.toAuditSnapshot(next);
    const changedFields = CRAWL_CLIENT_SETTINGS_AUDIT_FIELDS.filter(
      (field) => !Object.is(before[field], after[field])
    );
    if (changedFields.length === 0) {
      return null;
    }

    const inputFields = Object.keys(input).filter(
      (field) => (input as Record<string, unknown>)[field] !== undefined
    );

    return {
      settingsKey: CRAWL_CLIENT_SETTINGS_KEY,
      changedFields,
      changedCount: changedFields.length,
      inputFields,
      before,
      after
    };
  }

  private toAuditSnapshot(settings: CrawlClientSettings): CrawlClientSettingsAuditSnapshot {
    return {
      healthCheckTtlMs: settings.healthCheckTtlMs,
      requestTimeoutHotMs: settings.requestTimeoutHotMs,
      requestTimeoutNormalMs: settings.requestTimeoutNormalMs,
      conditionalRequestEnabled: settings.conditionalRequestEnabled,
      conditionalRequestTimeoutMs: settings.conditionalRequestTimeoutMs,
      conditionalRequestMaxRetries: settings.conditionalRequestMaxRetries,
      detailPublishSignalHeadFetchTimeoutMs:
        settings.detailPublishSignalHeadFetchTimeoutMs,
      detailPublishSignalHeadFetchConcurrency:
        settings.detailPublishSignalHeadFetchConcurrency,
      detailPublishSignalHeadFetchMaxReadBytes:
        settings.detailPublishSignalHeadFetchMaxReadBytes,
      maxRetries: settings.maxRetries,
      retryBackoffMs: settings.retryBackoffMs,
      queueOverloadCooldownMs: settings.queueOverloadCooldownMs,
      adaptiveConcurrencyEnabled: settings.adaptiveConcurrencyEnabled,
      adaptiveWindowMinutes: settings.adaptiveWindowMinutes,
      adaptiveCooldownMinutes: settings.adaptiveCooldownMinutes,
      adaptiveLatencyThresholdRatio: settings.adaptiveLatencyThresholdRatio,
      adaptiveErrorRateThreshold: settings.adaptiveErrorRateThreshold,
      adaptiveMemoryHeadroomThreshold: settings.adaptiveMemoryHeadroomThreshold,
      maxConcurrency: settings.maxConcurrency
    };
  }

  private clamp(value: number | null, min: number, max: number, fallback?: number) {
    if (value === null || Number.isNaN(value)) {
      return fallback ?? min;
    }
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  private clampFloat(value: number | null, min: number, max: number, fallback?: number) {
    if (value === null || Number.isNaN(value)) {
      return fallback ?? min;
    }
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return Math.round(value * 1000) / 1000;
  }

  private toInt(value: unknown) {
    if (typeof value !== "number") {
      return null;
    }
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.round(value);
  }

  private toFloat(value: unknown) {
    if (typeof value !== "number") {
      return null;
    }
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  private toBoolean(value: unknown, fallback: boolean) {
    if (typeof value === "boolean") {
      return value;
    }
    return fallback;
  }
}
