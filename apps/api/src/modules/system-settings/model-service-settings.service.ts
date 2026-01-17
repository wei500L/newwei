import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService, type ModelServiceConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  encryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

export type ModelServiceSettingsSource = "env" | "db";
export type ModelServiceTokenSource = "stored" | "env" | "none";

export interface ModelServiceSettingsPublic {
  source: ModelServiceSettingsSource;
  enabled: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  hasToken: boolean;
  tokenSource: ModelServiceTokenSource;
}

interface StoredModelServiceSettings {
  enabled?: unknown;
  baseUrl?: unknown;
  internalToken?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
}

interface CachedModelServiceSettings {
  exists: boolean;
  value?: StoredModelServiceSettings;
}

const SETTINGS_KEY = "model_service";
const SETTINGS_DESCRIPTION = "Model service integration (time-series forecasting/anomaly) configuration.";
const CACHE_KEY = "model_service:settings";
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class ModelServiceSettingsService {
  private readonly logger = createLogger({ name: "model-service-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService
  ) {}

  async getPublicSettings(): Promise<ModelServiceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const tokenSource: ModelServiceTokenSource =
      this.hasStoredToken(stored) ? "stored" : effective.internalToken ? "env" : "none";

    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      baseUrl: effective.baseUrl ?? null,
      timeoutMs: effective.timeoutMs,
      maxRetries: effective.maxRetries,
      hasToken: Boolean(effective.internalToken),
      tokenSource
    };
  }

  async getEffectiveConfig(): Promise<ModelServiceConfig> {
    const stored = await this.loadStoredSettings();
    return this.resolveEffectiveConfig(stored);
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled: boolean;
      baseUrl?: string | null;
      internalToken?: string | null;
      timeoutMs: number;
      maxRetries: number;
    }
  ): Promise<ModelServiceSettingsPublic> {
    const stored = await this.loadStoredSettings();

    const baseUrl =
      typeof input.baseUrl === "string" ? input.baseUrl.trim() : input.baseUrl ?? null;
    const normalizedBaseUrl = baseUrl ? this.validateUrl(baseUrl) : null;

    const nextTokenRaw = this.resolveNextToken(stored, input.internalToken);

    const nextStored: StoredModelServiceSettings = {
      enabled: input.enabled,
      baseUrl: normalizedBaseUrl,
      internalToken: nextTokenRaw,
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries
    };

    const effective = this.resolveEffectiveConfig(nextStored);
    if (effective.enabled) {
      if (!effective.baseUrl) {
        throw new BadRequestException("baseUrl is required when model service is enabled");
      }
      if (!effective.internalToken) {
        throw new BadRequestException("internalToken is required when model service is enabled");
      }
    }

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      },
      create: {
        key: SETTINGS_KEY,
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false
      }
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "model_service_update",
          metadata: this.toPrismaJson({
            enabled: input.enabled,
            baseUrl: normalizedBaseUrl,
            timeoutMs: input.timeoutMs,
            maxRetries: input.maxRetries,
            tokenUpdated: input.internalToken !== undefined,
            tokenConfigured: Boolean(effective.internalToken)
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "model_service_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string): Promise<ModelServiceSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "model_service_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "model_service_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredModelServiceSettings | null> {
    let cached: CachedModelServiceSettings | null = null;
    try {
      cached = await this.cache.get<CachedModelServiceSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read model service settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredModelServiceSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedModelServiceSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write model service settings cache");
    }

    return settings;
  }

  private resolveEffectiveConfig(stored: StoredModelServiceSettings | null): ModelServiceConfig {
    const envDefaults = this.env.modelServiceConfig;

    const enabled = this.asBoolean(stored?.enabled, envDefaults.enabled);
    const baseUrl =
      this.normalizeString(stored?.baseUrl) ?? envDefaults.baseUrl?.trim() ?? undefined;
    const timeoutMs = this.asPositiveInt(stored?.timeoutMs, envDefaults.timeoutMs);
    const maxRetries = this.asNonNegativeInt(stored?.maxRetries, envDefaults.maxRetries);

    const storedToken = stored?.internalToken;
    const internalToken = this.resolveToken(storedToken) ?? envDefaults.internalToken;

    return {
      enabled,
      baseUrl,
      internalToken,
      timeoutMs,
      maxRetries
    };
  }

  private resolveNextToken(stored: StoredModelServiceSettings | null, next: string | null | undefined): unknown {
    if (next === undefined) {
      return stored?.internalToken ?? null;
    }

    const normalized = typeof next === "string" ? next.trim() : "";
    if (!normalized) {
      return null;
    }

    const encryptionKey = resolveSettingsKey(this.env);
    if (!encryptionKey) {
      this.logger.warn(
        "SYSTEM_SETTINGS_ENCRYPTION_KEY is not set; storing model service token in plaintext"
      );
      return normalized;
    }

    return encryptStringValueV1(normalized, encryptionKey);
  }

  private resolveToken(raw: unknown): string | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      return trimmed ? trimmed : undefined;
    }
    if (isEncryptedStringValueV1(raw)) {
      const key = resolveSettingsKey(this.env);
      if (!key) {
        this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for model service token");
        return undefined;
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = decrypted.trim();
        return trimmed ? trimmed : undefined;
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to decrypt model service token");
        return undefined;
      }
    }
    return undefined;
  }

  private hasStoredToken(stored: StoredModelServiceSettings | null) {
    return Boolean(stored?.internalToken);
  }

  private validateUrl(value: string) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      throw new BadRequestException("baseUrl must be a valid http(s) URL");
    }
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private asPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  private asNonNegativeInt(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate model service settings cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}

