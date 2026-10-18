import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { PlatformAccessService } from "../auth/platform-access.service";
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
  PROXY_LOAD_BALANCING_SETTINGS_LOCK_NAME,
  withModelAccessSettingsLock,
} from "./model-access-settings.lock";
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
  anthropicKeyFingerprints: string[];
  routingStrategy: LiteLlmRoutingStrategy;
  redisHost: string;
  redisPort: number;
  redisPassword?: string;
  deploymentRpm: number | null;
  deploymentTpm: number | null;
}

/**
 * One stored Anthropic key entry, classified once and projected onto the two
 * values every caller needs. An encrypted entry is decrypted at most once per
 * snapshot even when both projections read it.
 */
interface ParsedAnthropicKeyEntry {
  /** Bearer-stripped usable plaintext; empty when unresolvable. */
  plaintext: string;
  /** Projected fingerprint; null when it cannot be computed. */
  fingerprint: string | null;
}

/**
 * The single decoded view of one `anthropicApiKeys` array: the resolved keys and
 * the public fingerprints, each in first-appearance order.
 */
interface AnthropicKeySnapshot {
  keys: string[];
  fingerprints: string[];
}

interface NextAnthropicKeys {
  raw: unknown;
  storedCount: number;
  updated: boolean;
}

interface NextRedisPassword {
  raw: unknown;
  hasPassword: boolean;
  updated: boolean;
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
    private readonly platformAccess: PlatformAccessService,
  ) {}

  async getPublicSettings(): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const openai = await this.openaiKeys.getPublicSettings();
    return this.buildPublicSettings(stored, openai);
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
      redisPassword?: string | null;
      deploymentRpm?: number | null;
      deploymentTpm?: number | null;
    },
  ): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    // LB0: the load balancing row is a global singleton, so only a platform
    // admin may write it. The DTO (the ValidationPipe) has already run, which is
    // why this gate sits inside the service.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // LB2/LB3: the merge baseline is the authoritative MySQL row read INSIDE the
    // shared lock, and the response is projected from the bytes just written —
    // never from the pre-write 30 second cache envelope.
    return await withModelAccessSettingsLock(
      PROXY_LOAD_BALANCING_SETTINGS_LOCK_NAME,
      async () => {
        const { settings: stored } =
          await this.readStoredSettingsFromDatabase();

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

        const anthropic = await this.resolveNextAnthropicKeys(stored, {
          keys: input.anthropicApiKeys,
          clear: Boolean(input.clearAnthropicApiKeys),
        });

        const redisPassword = await this.resolveNextRedisPassword(
          stored,
          input.redisPassword,
        );

        const nextStored: StoredLiteLlmProxyLoadBalancingSettings = {
          enabled: input.enabled,
          anthropicApiKeys: anthropic.raw,
          routingStrategy,
          redisHost,
          redisPort,
          redisPassword: redisPassword.raw,
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
                anthropicKeysCount: anthropic.storedCount,
                routingStrategy,
                redisHost,
                redisPort,
                hasRedisPassword: redisPassword.hasPassword,
                deploymentRpm,
                deploymentTpm,
                anthropicKeysUpdated: anthropic.updated,
                redisPasswordUpdated: redisPassword.updated,
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
        // The OpenAI key pool is an independent configuration: its own metadata
        // is read through its own contract, while the LB body comes from the
        // object that was just committed.
        const openai = await this.openaiKeys.getPublicSettings();
        return this.buildPublicSettings(nextStored, openai);
      },
    );
  }

  async resetToDisabled(
    orgId: string,
    actorId: string,
  ): Promise<LiteLlmProxyLoadBalancingSettingsPublic> {
    // LB0: same global-singleton boundary as PUT.
    await this.platformAccess.assertPlatformAdmin(actorId);

    // LB2: DELETE takes the same lock as PUT, so a reset cannot interleave with
    // a field-preserving update.
    return await withModelAccessSettingsLock(
      PROXY_LOAD_BALANCING_SETTINGS_LOCK_NAME,
      async () => {
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
        const openai = await this.openaiKeys.getPublicSettings();
        // No row remains, so the response is the documented default shape.
        return this.buildPublicSettings(null, openai);
      },
    );
  }

  /**
   * Projects one stored snapshot plus the OpenAI key metadata onto the public
   * response contract. The cached GET path and both write paths (which pass the
   * just-committed object) share it.
   */
  private buildPublicSettings(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
    openai: OpenAiKeysSettingsPublic,
  ): LiteLlmProxyLoadBalancingSettingsPublic {
    const resolved = this.resolveEffectiveConfig(stored);

    return {
      source: stored ? "db" : "none",
      enabled: stored ? resolved.enabled : false,
      openai,
      anthropicKeysCount: resolved.anthropicApiKeys.length,
      anthropicKeyFingerprints: resolved.anthropicKeyFingerprints,
      routingStrategy: resolved.routingStrategy,
      redisHost: resolved.redisHost,
      redisPort: resolved.redisPort,
      hasRedisPassword: Boolean(resolved.redisPassword),
      deploymentRpm: resolved.deploymentRpm,
      deploymentTpm: resolved.deploymentTpm,
    };
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

    const { exists, settings } = await this.readStoredSettingsFromDatabase();

    try {
      await this.cache.set(
        CACHE_KEY,
        {
          exists,
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

  /**
   * Reads SystemSetting.key=litellm_proxy_load_balancing straight from MySQL.
   * Every write path MUST use this instead of the cached reader so a stale 30
   * second envelope can never become a read-modify-write baseline (LB2).
   */
  private async readStoredSettingsFromDatabase(): Promise<{
    exists: boolean;
    settings: StoredLiteLlmProxyLoadBalancingSettings | null;
  }> {
    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    const raw = record?.value as unknown;
    const settings =
      raw && typeof raw === "object"
        ? (raw as StoredLiteLlmProxyLoadBalancingSettings)
        : null;
    return { exists: Boolean(record), settings };
  }

  private resolveEffectiveConfig(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
  ): ResolvedLiteLlmProxyLoadBalancingSettings {
    const enabled = this.asBoolean(stored?.enabled, false);
    const anthropic = this.buildAnthropicKeySnapshot(stored?.anthropicApiKeys);
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
      anthropicApiKeys: anthropic.keys,
      anthropicKeyFingerprints: anthropic.fingerprints,
      routingStrategy,
      redisHost,
      redisPort,
      redisPassword,
      deploymentRpm,
      deploymentTpm,
    };
  }

  /**
   * Classifies every stored Anthropic key entry exactly once. Entries keep their
   * stored order and the classification mirrors the NestJS predicates:
   * `{fingerprint, value}` first, then a legacy plaintext string, then a bare
   * system-settings:v1 envelope. Anything else is skipped by all projections.
   */
  private parseAnthropicKeyEntries(raw: unknown): ParsedAnthropicKeyEntry[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    const parsed: ParsedAnthropicKeyEntry[] = [];

    for (const entry of raw) {
      if (!entry) {
        continue;
      }

      if (isStoredSecretEntryV1(entry)) {
        // A wrapped entry needs its value decrypted only for the plaintext
        // projection; the fingerprint list reads the STORED fingerprint and
        // never decrypts this entry.
        const secret = this.resolveSecret(entry.value);
        const storedFingerprint =
          typeof entry.fingerprint === "string" ? entry.fingerprint.trim() : "";
        parsed.push({
          plaintext: secret ? this.stripBearerPrefix(secret) : "",
          fingerprint: storedFingerprint || null,
        });
        continue;
      }

      if (typeof entry === "string") {
        parsed.push({
          plaintext: this.stripBearerPrefix(entry),
          // A legacy plaintext entry is hashed even when its stripped form is
          // empty; that asymmetry against the plaintext projection is
          // intentional and matches the reference implementation.
          fingerprint: this.fingerprintKey(entry),
        });
        continue;
      }

      if (isEncryptedStringValueV1(entry)) {
        // The same decrypted value feeds both the plaintext and the fingerprint
        // projections, so this envelope is decrypted once.
        const secret = this.resolveSecret(entry);
        parsed.push({
          plaintext: secret ? this.stripBearerPrefix(secret) : "",
          fingerprint: secret ? this.fingerprintKey(secret) : null,
        });
      }
    }

    return parsed;
  }

  /**
   * Builds both projections from one parse: the resolved key list (empty entries
   * dropped, de-duplicated in first-appearance order) and the public fingerprint
   * list.
   */
  private buildAnthropicKeySnapshot(raw: unknown): AnthropicKeySnapshot {
    const entries = this.parseAnthropicKeyEntries(raw);

    const keys: string[] = [];
    const fingerprints: string[] = [];

    for (const entry of entries) {
      if (entry.plaintext) {
        keys.push(entry.plaintext);
      }
      if (entry.fingerprint) {
        fingerprints.push(entry.fingerprint);
      }
    }

    return {
      keys: Array.from(new Set(keys)),
      fingerprints: Array.from(new Set(fingerprints)),
    };
  }

  /**
   * Mirrors countStoredKeys: a purely structural count that never decrypts, so
   * a retained stored list can be counted without being re-encrypted.
   */
  private countStoredAnthropicKeys(raw: unknown): number {
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

  private async resolveNextAnthropicKeys(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
    input: { keys?: string[]; clear: boolean },
  ): Promise<NextAnthropicKeys> {
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
      return { raw: encoded, storedCount: encoded.length, updated: true };
    }

    if (input.clear) {
      return { raw: [], storedCount: 0, updated: true };
    }

    // Retained entry: the stored representation is written back untouched and
    // the structural count never decrypts it.
    const raw = stored?.anthropicApiKeys ?? [];
    return {
      raw,
      storedCount: this.countStoredAnthropicKeys(raw),
      updated: false,
    };
  }

  private async resolveNextRedisPassword(
    stored: StoredLiteLlmProxyLoadBalancingSettings | null,
    input: string | null | undefined,
  ): Promise<NextRedisPassword> {
    if (input === undefined) {
      const raw = stored?.redisPassword ?? null;
      return {
        raw,
        hasPassword: Boolean(this.resolveSecret(raw)),
        updated: false,
      };
    }

    // An explicit null clears the password, exactly like an empty or
    // whitespace-only string. Only a string is trimmed.
    const normalized = typeof input === "string" ? input.trim() : "";
    if (!normalized) {
      return { raw: null, hasPassword: false, updated: true };
    }

    return {
      raw: await this.securitySettings.encodeSecretForStorage(normalized),
      hasPassword: true,
      updated: true,
    };
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
