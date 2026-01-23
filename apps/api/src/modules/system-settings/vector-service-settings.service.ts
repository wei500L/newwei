import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService, type VectorServiceConfig } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey
} from "../storage/storage-settings.crypto";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type VectorServiceSettingsSource = "env" | "db";
export type VectorServiceTokenSource = "stored" | "env" | "none";

export interface VectorServiceSettingsPublic {
  source: VectorServiceSettingsSource;
  enabled: boolean;
  fallbackToMongo: boolean;
  baseUrl: string | null;
  timeoutMs: number;
  maxRetries: number;
  hasToken: boolean;
  tokenSource: VectorServiceTokenSource;
}

interface StoredVectorServiceSettings {
  enabled?: unknown;
  fallbackToMongo?: unknown;
  baseUrl?: unknown;
  token?: unknown;
  timeoutMs?: unknown;
  maxRetries?: unknown;
}

interface CachedVectorServiceSettings {
  exists: boolean;
  value?: StoredVectorServiceSettings;
}

const SETTINGS_KEY = "vector_service";
const SETTINGS_DESCRIPTION = "Vector service integration (semantic search/dedupe) configuration.";
const CACHE_KEY = "vector_service:settings";
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class VectorServiceSettingsService {
  private readonly logger = createLogger({ name: "vector-service-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService
  ) {}

  async getPublicSettings(): Promise<VectorServiceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const storedToken = stored ? this.resolveToken(stored.token) : undefined;
    const tokenSource: VectorServiceTokenSource =
      storedToken ? "stored" : effective.token ? "env" : "none";

    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      fallbackToMongo: effective.fallbackToMongo,
      baseUrl: effective.baseUrl ?? null,
      timeoutMs: effective.timeoutMs,
      maxRetries: effective.maxRetries,
      hasToken: Boolean(effective.token),
      tokenSource
    };
  }

  async getEffectiveConfig(): Promise<VectorServiceConfig> {
    const stored = await this.loadStoredSettings();
    return this.resolveEffectiveConfig(stored);
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled: boolean;
      fallbackToMongo: boolean;
      baseUrl?: string | null;
      token?: string | null;
      timeoutMs: number;
      maxRetries: number;
    }
  ): Promise<VectorServiceSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const baseUrl =
      typeof input.baseUrl === "string" ? input.baseUrl.trim() : input.baseUrl ?? null;
    const normalizedBaseUrl = baseUrl ? this.validateUrl(baseUrl) : null;

    const nextTokenRaw = await this.resolveNextToken(stored, input.token);

    const nextStored: StoredVectorServiceSettings = {
      enabled: input.enabled,
      fallbackToMongo: input.fallbackToMongo,
      baseUrl: normalizedBaseUrl,
      token: nextTokenRaw,
      timeoutMs: input.timeoutMs,
      maxRetries: input.maxRetries
    };

    const effective = this.resolveEffectiveConfig(nextStored);
    if (effective.enabled) {
      if (!effective.baseUrl) {
        throw new BadRequestException("baseUrl is required when vector service is enabled");
      }
      if (!effective.token) {
        throw new BadRequestException("token is required when vector service is enabled");
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
          action: "vector_service_update",
          metadata: this.toPrismaJson({
            enabled: input.enabled,
            fallbackToMongo: input.fallbackToMongo,
            baseUrl: normalizedBaseUrl,
            timeoutMs: input.timeoutMs,
            maxRetries: input.maxRetries,
            tokenUpdated: input.token !== undefined,
            tokenConfigured: Boolean(effective.token)
          } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "vector_service_update" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string): Promise<VectorServiceSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "vector_service_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject)
        }
      },
      { orgId, actorId, resource: "system_settings", action: "vector_service_reset" }
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredVectorServiceSettings | null> {
    let cached: CachedVectorServiceSettings | null = null;
    try {
      cached = await this.cache.get<CachedVectorServiceSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read vector settings cache");
    }

    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY }
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredVectorServiceSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedVectorServiceSettings,
        CACHE_TTL_SECONDS
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write vector settings cache");
    }

    return settings;
  }

  private resolveEffectiveConfig(stored: StoredVectorServiceSettings | null): VectorServiceConfig {
    const envDefaults = this.env.vectorServiceConfig;

    const enabled = this.asBoolean(stored?.enabled, envDefaults.enabled);
    const fallbackToMongo = this.asBoolean(stored?.fallbackToMongo, envDefaults.fallbackToMongo);
    const baseUrl =
      this.normalizeString(stored?.baseUrl) ?? envDefaults.baseUrl?.trim() ?? undefined;
    const timeoutMs = this.asPositiveInt(stored?.timeoutMs, envDefaults.timeoutMs);
    const maxRetries = this.asNonNegativeInt(stored?.maxRetries, envDefaults.maxRetries);

    const storedToken = stored?.token;
    const token = this.resolveToken(storedToken) ?? envDefaults.token;

    return {
      enabled,
      fallbackToMongo,
      baseUrl,
      token,
      timeoutMs,
      maxRetries
    };
  }

  private async resolveNextToken(
    stored: StoredVectorServiceSettings | null,
    next: string | null | undefined
  ): Promise<unknown> {
    if (next === undefined) {
      return stored?.token ?? null;
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
        this.logger.warn("Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for vector service token");
        return undefined;
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = decrypted.trim();
        return trimmed ? trimmed : undefined;
      } catch (error) {
        this.logger.warn({ err: error }, "Failed to decrypt vector service token");
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
      this.logger.warn({ err: error }, "Failed to invalidate vector settings cache");
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
