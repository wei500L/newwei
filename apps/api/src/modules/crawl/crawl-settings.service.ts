import { Injectable } from "@nestjs/common";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";

export interface CrawlClientSettings {
  healthCheckTtlMs: number;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  queueOverloadCooldownMs: number;
  maxConcurrency: number;
}

export interface CrawlClientSettingsInput {
  healthCheckTtlMs?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  queueOverloadCooldownMs?: number;
  maxConcurrency?: number;
}

const CRAWL_CLIENT_SETTINGS_KEY = "crawl_client_settings";
const MIN_HEALTH_CHECK_TTL_MS = 5_000;
const MAX_HEALTH_CHECK_TTL_MS = 900_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 900_000;
const MIN_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_BACKOFF_MS = 600_000;
const MIN_RETRY_ATTEMPTS = 1;
const MAX_RETRY_ATTEMPTS = 10;
const MIN_QUEUE_OVERLOAD_COOLDOWN_MS = 5_000;
const MAX_QUEUE_OVERLOAD_COOLDOWN_MS = 600_000;
const DEFAULT_QUEUE_OVERLOAD_COOLDOWN_MS = 30_000;
const MIN_CRAWL_MAX_CONCURRENCY = 1;
const MAX_CRAWL_MAX_CONCURRENCY = 20;

@Injectable()
export class CrawlSettingsService {
  constructor(private readonly prisma: PrismaService, private readonly env: EnvService) {}

  async getSettings(): Promise<CrawlClientSettings> {
    return this.loadSettings();
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: CrawlClientSettingsInput
  ): Promise<CrawlClientSettings> {
    const current = await this.loadSettings();
    const normalized = this.normalize(input, current);
    await this.prisma.$transaction([
      this.prisma.systemSetting.upsert({
        where: { key: CRAWL_CLIENT_SETTINGS_KEY },
        update: {
          value: toPrismaJsonValue(normalized),
          updatedById: actorId,
          description: "Crawl client runtime settings"
        },
        create: {
          key: CRAWL_CLIENT_SETTINGS_KEY,
          value: toPrismaJsonValue(normalized),
          updatedById: actorId,
          description: "Crawl client runtime settings"
        }
      })
    ]);

    void writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "crawl_client_settings_update",
          metadata: toPrismaJsonValue(normalized)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "crawl_client_settings_update" }
    ).catch(() => undefined);

    return normalized;
  }

  async updateMaxConcurrency(orgId: string, actorId: string, maxConcurrency: number) {
    return this.updateSettings(orgId, actorId, { maxConcurrency });
  }

  private async loadSettings(): Promise<CrawlClientSettings> {
    const fallback = this.getFallbackSettings();
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: CRAWL_CLIENT_SETTINGS_KEY }
    });
    const raw = (record?.value as Partial<CrawlClientSettingsInput> | undefined) ?? {};
    return this.normalize({
      healthCheckTtlMs: raw.healthCheckTtlMs,
      requestTimeoutMs: raw.requestTimeoutMs,
      maxRetries: raw.maxRetries,
      retryBackoffMs: raw.retryBackoffMs,
      queueOverloadCooldownMs: raw.queueOverloadCooldownMs,
      maxConcurrency: raw.maxConcurrency
    }, fallback);
  }

  private getFallbackSettings(): CrawlClientSettings {
    const envConfig = this.env.crawl4aiConfig;
    return {
      healthCheckTtlMs: this.clamp(
        envConfig.healthCheckTtlMs ?? 60_000,
        MIN_HEALTH_CHECK_TTL_MS,
        MAX_HEALTH_CHECK_TTL_MS
      ),
      requestTimeoutMs: this.clamp(
        envConfig.timeoutMs,
        MIN_REQUEST_TIMEOUT_MS,
        MAX_REQUEST_TIMEOUT_MS
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
    return {
      healthCheckTtlMs: this.clamp(
        this.toInt(value.healthCheckTtlMs),
        MIN_HEALTH_CHECK_TTL_MS,
        MAX_HEALTH_CHECK_TTL_MS,
        defaults.healthCheckTtlMs
      ),
      requestTimeoutMs: this.clamp(
        this.toInt(value.requestTimeoutMs),
        MIN_REQUEST_TIMEOUT_MS,
        MAX_REQUEST_TIMEOUT_MS,
        defaults.requestTimeoutMs
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
      maxConcurrency: this.clamp(
        this.toInt(value.maxConcurrency),
        MIN_CRAWL_MAX_CONCURRENCY,
        MAX_CRAWL_MAX_CONCURRENCY,
        defaults.maxConcurrency
      )
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

  private toInt(value: unknown) {
    if (typeof value !== "number") {
      return null;
    }
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.round(value);
  }
}
