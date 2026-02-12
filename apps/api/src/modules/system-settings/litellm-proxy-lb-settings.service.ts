import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey,
} from "../storage/storage-settings.crypto";

import type { LiteLlmRoutingStrategy } from "./dto/llm-gateway-proxy-lb-settings.dto";
import { LITELLM_ROUTING_STRATEGIES } from "./dto/llm-gateway-proxy-lb-settings.dto";
import {
  OpenAiKeysSettingsService,
  type OpenAiKeysSettingsPublic,
} from "./openai-keys-settings.service";
import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type LiteLlmProxyLoadBalancingSettingsSource = "none" | "db";

export interface LiteLlmProxyLoadBalancingSettingsPublic {
  source: LiteLlmProxyLoadBalancingSettingsSource;
  enabled: boolean;
  openai: OpenAiKeysSettingsPublic;
  anthropicKeysCount: number;
  anthropicKeyFingerprints: string[];
  routingStrategy: LiteLlmRoutingStrategy;
  redisHost: string;
  redisPort: number;
  hasRedisPassword: boolean;
  deploymentRpm: number | null;
  deploymentTpm: number | null;
}

export interface LiteLlmProxyLoadBalancingInternalSnapshot {
  hasStoredConfig: boolean;
  enabled: boolean;
  openaiApiKeys: string[];
  anthropicApiKeys: string[];
  routingStrategy: LiteLlmRoutingStrategy;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  deploymentRpm?: number;
  deploymentTpm?: number;
}

interface StoredSecretEntryV1 {
  fingerprint: string;
  value: unknown;
}

interface StoredLiteLlmProxyLoadBalancingSettings {
  enabled?: unknown;
  anthropicApiKeys?: unknown;
  routingStrategy?: unknown;
  redisHost?: unknown;
  redisPort?: unknown;
  redisPassword?: unknown;
  deploymentRpm?: unknown;
  deploymentTpm?: unknown;
}

interface CachedLiteLlmProxyLoadBalancingSettings {
  exists: boolean;
  value?: StoredLiteLlmProxyLoadBalancingSettings;
}

interface ResolvedLiteLlmProxyLoadBalancingSettings {
  enabled: boolean;
  anthropicApiKeys: string[];
  routingStrategy: LiteLlmRoutingStrategy;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  deploymentRpm: number | null;
  deploymentTpm: number | null;
}

const SETTINGS_KEY = "litellm_proxy_load_balancing";
const SETTINGS_DESCRIPTION =
  "LiteLLM proxy load balancing configuration (Anthropic keys + router settings)";
const CACHE_KEY = "litellm_proxy_load_balancing:settings";
const CACHE_TTL_SECONDS = 30;
const MAX_KEYS = 100;

const DEFAULT_ROUTING_STRATEGY: LiteLlmRoutingStrategy = "simple-shuffle";
const DEFAULT_REDIS_HOST = "redis";
const DEFAULT_REDIS_PORT = 6379;

function isStoredSecretEntryV1(value: unknown): value is StoredSecretEntryV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.fingerprint === "string" && "value" in record;
}

@Injectable()
export class LiteLlmProxyLoadBalancingSettingsService {
  private readonly logger = createLogger({ name: "litellm-proxy-lb-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService,
    private readonly openaiKeys: OpenAiKeysSettingsService,
  ) {}

  async getPublicSettings(): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    const openai = await this.openaiKeys.getPublicSettings();

    return {
      source: stored ? "db" : "none",
      enabled: stored ? resolved.enabled : false,
      openai,
      anthropicKeysCount: resolved.anthropicApiKeys.length,
      anthropicKeyFingerprints: this.listAnthropicKeyFingerprints(
        stored?.anthropicApiKeys,
      ),
      routingStrategy: resolved.routingStrategy,
      redisHost: resolved.redisHost,
      redisPort: resolved.redisPort,
      hasRedisPassword: Boolean(resolved.redisPassword),
      deploymentRpm: resolved.deploymentRpm,
      deploymentTpm: resolved.deploymentTpm,
    };
  }

  async getInternalSnapshot(): Promise<LiteLlmProxyLoadBalancingInternalSnapshot> {
    const stored = await this.loadStoredSettings();
    const resolved = this.resolveEffectiveConfig(stored);
    const openaiApiKeys = await this.openaiKeys.getPlaintextKeys();

    return {
      hasStoredConfig: Boolean(stored),
      enabled: stored ? resolved.enabled : false,
      openaiApiKeys,
      anthropicApiKeys: resolved.anthropicApiKeys,
      routingStrategy: resolved.routingStrategy,
      redisHost: resolved.redisHost,
      redisPort: resolved.redisPort,
      redisPassword: resolved.redisPassword,
      ...(resolved.deploymentRpm
        ? { deploymentRpm: resolved.deploymentRpm }
        : {}),
      ...(resolved.deploymentTpm
        ? { deploymentTpm: resolved.deploymentTpm }
        : {}),
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled: boolean;
      anthropicApiKeys?: string[];
      clearAnthropicApiKeys?: boolean;
      routingStrategy: LiteLlmRoutingStrategy;
      redisHost: string;
      redisPort: number;
      redisPassword?: string;
      deploymentRpm?: number | null;
      deploymentTpm?: number | null;
    },
  ): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    const stored = await this.loadStoredSettings();

    const redisHost = input.redisHost?.trim();
    if (!redisHost) {
      throw new BadRequestException("redisHost is required");
    }

    const routingStrategy = this.normalizeRoutingStrategy(
      input.routingStrategy,
    );
    if (!routingStrategy) {
      throw new BadRequestException("routingStrategy is invalid");
    }

    const redisPort = this.asPort(input.redisPort, DEFAULT_REDIS_PORT);
    const deploymentRpm = this.asNullablePositiveInt(input.deploymentRpm);
    const deploymentTpm = this.asNullablePositiveInt(input.deploymentTpm);

    const anthropicApiKeysRaw = await this.resolveNextAnthropicKeysRaw(stored, {
      keys: input.anthropicApiKeys,
      clear: Boolean(input.clearAnthropicApiKeys),
    });

    const redisPasswordRaw = await this.resolveNextRedisPasswordRaw(
      stored,
      input.redisPassword,
    );

    const nextStored: StoredLiteLlmProxyLoadBalancingSettings = {
      enabled: input.enabled,
      anthropicApiKeys: anthropicApiKeysRaw,
      routingStrategy,
      redisHost,
      redisPort,
      redisPassword: redisPasswordRaw,
      deploymentRpm,
      deploymentTpm,
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      update: {
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
      create: {
        key: SETTINGS_KEY,
        value: this.toPrismaJson(nextStored),
        updatedById: actorId,
        description: SETTINGS_DESCRIPTION,
        isPublic: false,
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "litellm_proxy_lb_update",
          metadata: this.toPrismaJson({
            enabled: input.enabled,
            anthropicKeysCount: this.countStoredKeys(anthropicApiKeysRaw),
            routingStrategy,
            redisHost,
            redisPort,
            hasRedisPassword: Boolean(this.resolveSecret(redisPasswordRaw)),
            deploymentRpm,
            deploymentTpm,
            anthropicKeysUpdated:
              Array.isArray(input.anthropicApiKeys) ||
              Boolean(input.clearAnthropicApiKeys),
            redisPasswordUpdated: input.redisPassword !== undefined,
          } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "litellm_proxy_lb_update",
      },
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToDisabled(
    orgId: string,
    actorId: string,
  ): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    await this.prisma.systemSetting.deleteMany({
      where: { key: SETTINGS_KEY },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "litellm_proxy_lb_reset",
          metadata: this.toPrismaJson({
            ok: true,
          } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "litellm_proxy_lb_reset",
      },
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private async loadStoredSettings(): Promise<StoredLiteLlmProxyLoadBalancingSettings | null> {
    let cached: CachedLiteLlmProxyLoadBalancingSettings | null = null;
    try {
      cached =
        await this.cache.get<CachedLiteLlmProxyLoadBalancingSettings>(
          CACHE_KEY,
        );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read LiteLLM proxy LB settings cache",
      );
    }

    if (cached) {
      return cached.exists ? (cached.value ?? null) : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    const raw = record?.value as unknown;
    const settings =
      raw && typeof raw === "object"
        ? (raw as StoredLiteLlmProxyLoadBalancingSettings)
        : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        {
          exists: Boolean(record),
          value: settings ?? undefined,
        } satisfies CachedLiteLlmProxyLoadBalancingSettings,
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to write LiteLLM proxy LB settings cache",
      );
    }

    return settings;
  }

  private resolveEffectiveConfig(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
  ): ResolvedLiteLlmProxyLoadBalancingSettings {
    const enabled = this.asBoolean(stored?.enabled, false);
    const anthropicApiKeys = this.resolveAnthropicKeys(
      stored?.anthropicApiKeys,
    );
    const routingStrategy =
      this.normalizeRoutingStrategy(stored?.routingStrategy) ??
      DEFAULT_ROUTING_STRATEGY;
    const redisHost =
      this.normalizeString(stored?.redisHost) ?? DEFAULT_REDIS_HOST;
    const redisPort = this.asPort(stored?.redisPort, DEFAULT_REDIS_PORT);
    const redisPassword = this.resolveSecret(stored?.redisPassword);
    const deploymentRpm = this.asNullablePositiveInt(stored?.deploymentRpm);
    const deploymentTpm = this.asNullablePositiveInt(stored?.deploymentTpm);

    return {
      enabled,
      anthropicApiKeys,
      routingStrategy,
      redisHost,
      redisPort,
      redisPassword,
      deploymentRpm,
      deploymentTpm,
    };
  }

  private normalizeKeys(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const normalized = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => this.stripBearerPrefix(entry))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    return Array.from(new Set(normalized));
  }

  private stripBearerPrefix(value: string) {
    return value.replace(/^bearer\s+/i, "").trim();
  }

  private async resolveNextAnthropicKeysRaw(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
    input: { keys?: string[]; clear: boolean },
  ): Promise<unknown> {
    if (Array.isArray(input.keys)) {
      const normalized = this.normalizeKeys(input.keys);
      if (normalized.length > MAX_KEYS) {
        throw new BadRequestException(
          `Too many Anthropic API keys (max ${MAX_KEYS})`,
        );
      }
      const encoded: StoredSecretEntryV1[] = [];
      for (const key of normalized) {
        const storedValue =
          await this.securitySettings.encodeSecretForStorage(key);
        encoded.push({
          fingerprint: this.fingerprintKey(key),
          value: storedValue,
        });
      }
      return encoded;
    }

    if (input.clear) {
      return [];
    }

    return stored?.anthropicApiKeys ?? [];
  }

  private async resolveNextRedisPasswordRaw(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
    input: string | undefined,
  ): Promise<unknown> {
    if (input === undefined) {
      return stored?.redisPassword ?? null;
    }

    const normalized = input.trim();
    if (!normalized) {
      return null;
    }

    return this.securitySettings.encodeSecretForStorage(normalized);
  }

  private resolveAnthropicKeys(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const out: string[] = [];

    for (const entry of raw) {
      if (!entry) {
        continue;
      }

      if (isStoredSecretEntryV1(entry)) {
        const secret = this.resolveSecret(entry.value);
        if (secret) {
          out.push(this.stripBearerPrefix(secret));
        }
        continue;
      }

      if (typeof entry === "string") {
        const trimmed = this.stripBearerPrefix(entry);
        if (trimmed) {
          out.push(trimmed);
        }
        continue;
      }

      if (isEncryptedStringValueV1(entry)) {
        const secret = this.resolveSecret(entry);
        if (secret) {
          out.push(this.stripBearerPrefix(secret));
        }
      }
    }

    return Array.from(new Set(out));
  }

  private listAnthropicKeyFingerprints(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const out: string[] = [];
    for (const entry of raw) {
      if (!entry) {
        continue;
      }

      if (isStoredSecretEntryV1(entry)) {
        if (typeof entry.fingerprint === "string" && entry.fingerprint.trim()) {
          out.push(entry.fingerprint.trim());
        }
        continue;
      }

      if (typeof entry === "string") {
        out.push(this.fingerprintKey(entry));
        continue;
      }

      if (isEncryptedStringValueV1(entry)) {
        const decrypted = this.resolveSecret(entry);
        if (decrypted) {
          out.push(this.fingerprintKey(decrypted));
        }
      }
    }

    return Array.from(new Set(out));
  }

  private countStoredKeys(raw: unknown): number {
    if (!Array.isArray(raw)) {
      return 0;
    }

    let count = 0;
    for (const entry of raw) {
      if (!entry) {
        continue;
      }
      if (typeof entry === "string") {
        count += 1;
        continue;
      }
      if (isEncryptedStringValueV1(entry)) {
        count += 1;
        continue;
      }
      if (isStoredSecretEntryV1(entry) && entry.value) {
        count += 1;
      }
    }

    return count;
  }

  private resolveSecret(raw: unknown): string | undefined {
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
        this.logger.warn(
          "Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for LiteLLM proxy LB secret",
        );
        return undefined;
      }
      try {
        const decrypted = decryptStringValueV1(raw, key);
        const trimmed = decrypted.trim();
        return trimmed ? trimmed : undefined;
      } catch (error) {
        this.logger.warn(
          { err: error },
          "Failed to decrypt LiteLLM proxy LB secret",
        );
        return undefined;
      }
    }

    return undefined;
  }

  private fingerprintKey(key: string): string {
    const normalized = this.stripBearerPrefix(key).trim();
    return createHash("sha256").update(normalized).digest("hex");
  }

  private normalizeRoutingStrategy(
    value: unknown,
  ): LiteLlmRoutingStrategy | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if ((LITELLM_ROUTING_STRATEGIES as readonly string[]).includes(trimmed)) {
      return trimmed as LiteLlmRoutingStrategy;
    }
    return null;
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

  private asPort(value: unknown, fallback: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  private asNullablePositiveInt(value: unknown): number | null {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return Math.floor(parsed);
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to invalidate LiteLLM proxy LB settings cache",
      );
    }
  }

  private toPrismaJson(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
