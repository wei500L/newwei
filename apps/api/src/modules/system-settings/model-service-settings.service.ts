import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
import { CacheService } from "../cache/cache.service";
import { EnvService, type ModelServiceConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import {
  MODEL_SERVICE_SETTINGS_LOCK_NAME,
  withModelAccessSettingsLock
} from "./model-access-settings.lock";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

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
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService,
    private readonly platformAccess: PlatformAccessService
  ) {}

  async getPublicSettings(): Promise<ModelServiceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    return this.buildPublicSettings(stored);
  }

  /**
   * Projects one stored snapshot onto the public response contract. Both the
   * cached GET path and the write paths (which project the authoritative
   * just-written snapshot instead of re-reading Redis) use it, so the two can
   * never drift.
   */
  private buildPublicSettings(stored: StoredModelServiceSettings | null): ModelServiceSettingsPublic {
    const effective = this.resolveEffectiveConfig(stored);

    const storedToken = stored ? this.resolveToken(stored.internalToken) : undefined;
    const tokenSource: ModelServiceTokenSource =
      storedToken ? "stored" : effective.internalToken ? "env" : "none";

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
    // MA1: model_service is a GLOBAL singleton (no org dimension) and carries the
    // internal token the API attaches to every model-service call. A plain org
    // admin with settings.manage could rotate that token or point baseUrl at
    // their own server, so only platform admins may write it. The gate runs
    // before the lock, before any read, encoding, audit or cache eviction.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA3: the token-retention baseline is the authoritative row read INSIDE the
    // lock. Reading it from the 30s Redis cache would let a stale token
    // overwrite a rotation that already committed in MySQL.
    return await withModelAccessSettingsLock(MODEL_SERVICE_SETTINGS_LOCK_NAME, async () => {
      const stored = await this.readStoredSettingsFromDatabase();

      const baseUrl =
        typeof input.baseUrl === "string" ? input.baseUrl.trim() : input.baseUrl ?? null;
      const normalizedBaseUrl = baseUrl ? this.validateUrl(baseUrl) : null;

      const nextTokenRaw = await this.resolveNextToken(stored.settings, input.internalToken);

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

      // Cache eviction is best-effort but stays inside the lock so a concurrent
      // writer cannot observe the pre-commit cache entry after this commit.
      await this.invalidateCache();
      // The response is projected from this write's snapshot, never from the
      // pre-write cache entry.
      return this.buildPublicSettings(nextStored);
    });
  }

  async resetToEnv(orgId: string, actorId: string): Promise<ModelServiceSettingsPublic> {
    // MA1: same global-singleton boundary as PUT.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // MA3: reset shares the PUT lock so a reset cannot interleave with a
    // token-preserving PUT (or the reverse).
    return await withModelAccessSettingsLock(MODEL_SERVICE_SETTINGS_LOCK_NAME, async () => {
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
      // The row is gone, so the effective configuration is the env default.
      return this.buildPublicSettings(null);
    });
  }

  /**
   * Reads SystemSetting.key=model_service straight from MySQL. The write paths
   * must use this instead of the cached reader: `exists` distinguishes "row
   * missing" from "row present with an unusable value" exactly like NestJS
   * `Boolean(record)`.
   */
  private async readStoredSettingsFromDatabase(): Promise<{
    exists: boolean;
    settings: StoredModelServiceSettings | null;
  }> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredModelServiceSettings) : null;
    return { exists: Boolean(record), settings };
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

    const { exists, settings } = await this.readStoredSettingsFromDatabase();

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists, value: settings ?? undefined } satisfies CachedModelServiceSettings,
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

  private async resolveNextToken(
    stored: StoredModelServiceSettings | null,
    next: string | null | undefined
  ): Promise<unknown> {
    if (next === undefined) {
      return stored?.internalToken ?? null;
    }

    const normalized = typeof next === "string" ? next.trim() : "";
    if (!normalized) {
      return null;
    }

    return this.securitySettings.encodeSecretForStorage(normalized);
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
