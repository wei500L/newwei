import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type SituationMonitorSettingsSource = "env" | "db";
export type SituationMonitorTranslationProvider = "deeplx";
type SituationMonitorApiKeySource = "stored" | "env" | "none";
export type SituationMonitorTranslationApiKeySource = SituationMonitorApiKeySource;
export type SituationMonitorExternalApiKeySource = SituationMonitorApiKeySource;

export interface SituationMonitorSettingsPublic {
  source: SituationMonitorSettingsSource;
  translationMaxConcurrency: number;
  translationProvider: SituationMonitorTranslationProvider;
  translationApiEnabled: boolean;
  translationApiBaseUrl: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
  hasTranslationApiKey: boolean;
  translationApiKeySource: SituationMonitorTranslationApiKeySource;
  hasFinnhubApiKey: boolean;
  finnhubApiKeySource: SituationMonitorExternalApiKeySource;
  hasFredApiKey: boolean;
  fredApiKeySource: SituationMonitorExternalApiKeySource;
}

export interface SituationMonitorTranslationRuntimeConfig {
  provider: SituationMonitorTranslationProvider;
  maxConcurrency: number;
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  fallbackEnabled: boolean;
  fallbackBaseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface SituationMonitorExternalApiRuntimeConfig {
  finnhubApiKey?: string;
  fredApiKey?: string;
}

interface StoredSituationMonitorSettings {
  translationMaxConcurrency?: unknown;
  translationApiEnabled?: unknown;
  translationApiBaseUrl?: unknown;
  translationApiKey?: unknown;
  translationFallbackApiEnabled?: unknown;
  translationFallbackApiBaseUrl?: unknown;
  finnhubApiKey?: unknown;
  fredApiKey?: unknown;
  translationApiTimeoutMs?: unknown;
  translationApiMaxRetries?: unknown;
}

interface CachedSituationMonitorSettings {
  exists: boolean;
  value?: StoredSituationMonitorSettings;
}

const SETTINGS_KEY = "situation_monitor_settings";
const SETTINGS_DESCRIPTION = "Situation monitor settings (DeepLX translation + fallback translation endpoint + Finnhub/FRED API keys).";
const CACHE_KEY = "situation_monitor:settings";
const CACHE_TTL_SECONDS = 30;
const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;
const MAX_TRANSLATION_MAX_CONCURRENCY = 5_000;
const DEFAULT_TRANSLATION_API_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSLATION_API_MAX_RETRIES = 2;
const DEFAULT_TRANSLATION_API_BASE_URL = "https://api.deeplx.org";
const DEFAULT_TRANSLATION_FALLBACK_API_ENABLED = false;
const DEFAULT_TRANSLATION_PROVIDER: SituationMonitorTranslationProvider = "deeplx";

@Injectable()
export class SituationMonitorSettingsService {
  private readonly logger = createLogger({ name: "situation-monitor-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async getPublicSettings(): Promise<SituationMonitorSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    const storedTranslationApiKey = this.resolveStoredApiKey(stored?.translationApiKey, "translation api key");
    const storedFinnhubApiKey = this.resolveStoredApiKey(stored?.finnhubApiKey, "finnhub api key");
    const storedFredApiKey = this.resolveStoredApiKey(stored?.fredApiKey, "fred api key");

    return {
      source: stored ? "db" : "env",
      translationMaxConcurrency: effective.translationMaxConcurrency,
      translationProvider: DEFAULT_TRANSLATION_PROVIDER,
      translationApiEnabled: effective.translationApiEnabled,
      translationApiBaseUrl: effective.translationApiBaseUrl,
      translationFallbackApiEnabled: effective.translationFallbackApiEnabled,
      translationFallbackApiBaseUrl: effective.translationFallbackApiBaseUrl,
      translationApiTimeoutMs: effective.translationApiTimeoutMs,
      translationApiMaxRetries: effective.translationApiMaxRetries,
      hasTranslationApiKey: Boolean(effective.translationApiKey),
      translationApiKeySource: this.resolveApiKeySource(storedTranslationApiKey, effective.translationApiKey),
      hasFinnhubApiKey: Boolean(effective.finnhubApiKey),
      finnhubApiKeySource: this.resolveApiKeySource(storedFinnhubApiKey, effective.finnhubApiKey),
      hasFredApiKey: Boolean(effective.fredApiKey),
      fredApiKeySource: this.resolveApiKeySource(storedFredApiKey, effective.fredApiKey)
    };
  }

  async getTranslationMaxConcurrency(): Promise<number> {
    const stored = await this.loadStoredSettings();
    return this.resolveEffectiveConfig(stored).translationMaxConcurrency;
  }

  async getTranslationRuntimeConfig(): Promise<SituationMonitorTranslationRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    return {
      provider: DEFAULT_TRANSLATION_PROVIDER,
      maxConcurrency: effective.translationMaxConcurrency,
      enabled: effective.translationApiEnabled,
      baseUrl: effective.translationApiBaseUrl,
      apiKey: effective.translationApiKey,
      fallbackEnabled: effective.translationFallbackApiEnabled,
      fallbackBaseUrl: this.normalizeUrl(effective.translationFallbackApiBaseUrl),
      timeoutMs: effective.translationApiTimeoutMs,
      maxRetries: effective.translationApiMaxRetries
    };
  }

  async getExternalApiRuntimeConfig(): Promise<SituationMonitorExternalApiRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    return {
      finnhubApiKey: effective.finnhubApiKey,
      fredApiKey: effective.fredApiKey
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      translationMaxConcurrency?: number;
      translationApiEnabled?: boolean;
      translationApiBaseUrl?: string | null;
      translationApiKey?: string | null;
      translationFallbackApiEnabled?: boolean;
      translationFallbackApiBaseUrl?: string | null;
      finnhubApiKey?: string | null;
      fredApiKey?: string | null;
      translationApiTimeoutMs?: number;
      translationApiMaxRetries?: number;
    }
  ): Promise<SituationMonitorSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);

    const nextConcurrency = this.asBoundedInt(
      input.translationMaxConcurrency,
      current.translationMaxConcurrency,
      1,
      MAX_TRANSLATION_MAX_CONCURRENCY
    );
    const nextApiEnabled = this.asBoolean(input.translationApiEnabled, current.translationApiEnabled);
    const nextApiTimeoutMs = this.asBoundedInt(
      input.translationApiTimeoutMs,
      current.translationApiTimeoutMs,
      1_000,
      120_000
    );
    const nextApiMaxRetries = this.asBoundedInt(
      input.translationApiMaxRetries,
      current.translationApiMaxRetries,
      0,
      5
    );
    const nextApiBaseUrl = this.resolveNextApiBaseUrl(stored, input.translationApiBaseUrl);
    const nextFallbackApiEnabled = this.asBoolean(
      input.translationFallbackApiEnabled,
      current.translationFallbackApiEnabled
    );
    const nextFallbackApiBaseUrl = this.resolveNextFallbackApiBaseUrl(
      stored,
      input.translationFallbackApiBaseUrl
    );
    const nextTranslationApiKey = await this.resolveNextApiKey(stored?.translationApiKey, input.translationApiKey);
    const nextFinnhubApiKey = await this.resolveNextApiKey(stored?.finnhubApiKey, input.finnhubApiKey);
    const nextFredApiKey = await this.resolveNextApiKey(stored?.fredApiKey, input.fredApiKey);

    const nextStored: StoredSituationMonitorSettings = {
      translationMaxConcurrency: nextConcurrency,
      translationApiEnabled: nextApiEnabled,
      translationApiBaseUrl: nextApiBaseUrl,
      translationApiKey: nextTranslationApiKey,
      translationFallbackApiEnabled: nextFallbackApiEnabled,
      translationFallbackApiBaseUrl: nextFallbackApiBaseUrl,
      finnhubApiKey: nextFinnhubApiKey,
      fredApiKey: nextFredApiKey,
      translationApiTimeoutMs: nextApiTimeoutMs,
      translationApiMaxRetries: nextApiMaxRetries
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored)
      },
      update: {
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored)
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "situation_monitor_update",
          metadata: this.toPrismaJson({
            ok: true,
            translationMaxConcurrency: nextConcurrency,
            translationApiEnabled: nextApiEnabled,
            translationApiBaseUrl: nextApiBaseUrl,
            translationFallbackApiEnabled: nextFallbackApiEnabled,
            translationFallbackApiBaseUrl: nextFallbackApiBaseUrl,
            translationApiTimeoutMs: nextApiTimeoutMs,
            translationApiMaxRetries: nextApiMaxRetries,
            translationApiKeyUpdated: input.translationApiKey !== undefined,
            finnhubApiKeyUpdated: input.finnhubApiKey !== undefined,
            fredApiKeyUpdated: input.fredApiKey !== undefined
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "situation_monitor_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string): Promise<SituationMonitorSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "situation_monitor_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "situation_monitor_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private resolveEffectiveConfig(stored: StoredSituationMonitorSettings | null) {
    const envDefaults = this.env.situationMonitorTranslationConfig;
    const storedTranslationApiKey = this.resolveStoredApiKey(stored?.translationApiKey, "translation api key");
    const storedFinnhubApiKey = this.resolveStoredApiKey(stored?.finnhubApiKey, "finnhub api key");
    const storedFredApiKey = this.resolveStoredApiKey(stored?.fredApiKey, "fred api key");

    return {
      translationMaxConcurrency: this.asBoundedInt(
        stored?.translationMaxConcurrency,
        DEFAULT_TRANSLATION_MAX_CONCURRENCY,
        1,
        MAX_TRANSLATION_MAX_CONCURRENCY
      ),
      translationApiEnabled: this.asBoolean(stored?.translationApiEnabled, envDefaults.enabled),
      translationApiBaseUrl:
        this.normalizeUrl(stored?.translationApiBaseUrl) ??
        this.normalizeUrl(envDefaults.baseUrl) ??
        DEFAULT_TRANSLATION_API_BASE_URL,
      translationFallbackApiEnabled: this.asBoolean(
        stored?.translationFallbackApiEnabled,
        this.asBoolean(envDefaults.fallbackEnabled, DEFAULT_TRANSLATION_FALLBACK_API_ENABLED)
      ),
      translationFallbackApiBaseUrl:
        this.normalizeUrl(stored?.translationFallbackApiBaseUrl) ??
        this.normalizeUrl(envDefaults.fallbackBaseUrl) ??
        "",
      translationApiTimeoutMs: this.asBoundedInt(
        stored?.translationApiTimeoutMs,
        this.asBoundedInt(envDefaults.timeoutMs, DEFAULT_TRANSLATION_API_TIMEOUT_MS, 1_000, 120_000),
        1_000,
        120_000
      ),
      translationApiMaxRetries: this.asBoundedInt(
        stored?.translationApiMaxRetries,
        this.asBoundedInt(envDefaults.maxRetries, DEFAULT_TRANSLATION_API_MAX_RETRIES, 0, 5),
        0,
        5
      ),
      translationApiKey: storedTranslationApiKey,
      finnhubApiKey: storedFinnhubApiKey,
      fredApiKey: storedFredApiKey
    };
  }

  private resolveNextApiBaseUrl(
    stored: StoredSituationMonitorSettings | null,
    next: string | null | undefined
  ): string | null {
    if (next === undefined) {
      const current = this.normalizeUrl(stored?.translationApiBaseUrl);
      return current ?? null;
    }

    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.validateUrl(normalized, "translationApiBaseUrl");
  }

  private resolveNextFallbackApiBaseUrl(
    stored: StoredSituationMonitorSettings | null,
    next: string | null | undefined
  ): string | null {
    if (next === undefined) {
      const current = this.normalizeUrl(stored?.translationFallbackApiBaseUrl);
      return current ?? null;
    }

    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.validateUrl(normalized, "translationFallbackApiBaseUrl");
  }

  private async resolveNextApiKey(
    current: unknown,
    next: string | null | undefined
  ): Promise<unknown> {
    if (next === undefined) {
      return current ?? null;
    }

    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }

    return this.securitySettings.encodeSecretForStorage(normalized);
  }

  private resolveStoredApiKey(raw: unknown, keyName: string): string | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === "string") {
      return this.normalizeString(raw);
    }
    if (!isEncryptedStringValueV1(raw)) {
      return undefined;
    }
    const key = resolveSettingsKey(this.env);
    if (!key) {
      this.logger.warn(`Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for situation monitor ${keyName}`);
      return undefined;
    }

    try {
      const decrypted = decryptStringValueV1(raw, key);
      return this.normalizeString(decrypted);
    } catch (error) {
      this.logger.warn({ err: error }, `Failed to decrypt situation monitor ${keyName}`);
      return undefined;
    }
  }

  private resolveApiKeySource(
    storedValue: string | undefined,
    effectiveValue: string | undefined
  ): SituationMonitorApiKeySource {
    if (storedValue) {
      return "stored";
    }
    if (effectiveValue) {
      return "env";
    }
    return "none";
  }

  private validateUrl(value: string, fieldName: string): string {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      throw new BadRequestException(`${fieldName} must be a valid http(s) URL`);
    }
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private asBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsedValue = typeof value === "number" ? value : Number(value);
    const parsed = Number.isFinite(parsedValue) ? Math.trunc(parsedValue) : fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private normalizeUrl(value: unknown): string | undefined {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return undefined;
    }
    return normalized.replace(/\/+$/, "");
  }

  private async loadStoredSettings(): Promise<StoredSituationMonitorSettings | null> {
    let cached: CachedSituationMonitorSettings | null = null;
    try {
      cached = await this.cache.get<CachedSituationMonitorSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read situation monitor settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredSituationMonitorSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedSituationMonitorSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write situation monitor settings cache");
    }

    return settings;
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate situation monitor settings cache");
    }
  }

  private toPrismaJson(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
