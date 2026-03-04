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
  resolveSettingsKey,
} from "../storage/storage-settings.crypto";
import type { RealtimeSignalsRuntimeConfig } from "../realtime-signals/realtime-signals.types";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type RealtimeSignalsSettingsSource = "env" | "db";
export type RealtimeSignalsSecretSource = "stored" | "env" | "none";

interface StoredRealtimeSignalsSettings {
  enabled?: unknown;
  requestTimeoutMs?: unknown;
  maxRetries?: unknown;
  adsbEnabled?: unknown;
  adsbIntervalSec?: unknown;
  aisEnabled?: unknown;
  aisIntervalSec?: unknown;
  unrestEnabled?: unknown;
  unrestIntervalSec?: unknown;
  outagesEnabled?: unknown;
  outagesIntervalSec?: unknown;
  keywordSpikeEnabled?: unknown;
  keywordSpikeIntervalSec?: unknown;
  pizzintEnabled?: unknown;
  pizzintIntervalSec?: unknown;
  gdeltTensionEnabled?: unknown;
  gdeltTensionIntervalSec?: unknown;
  polymarketLeadsEnabled?: unknown;
  polymarketLeadsIntervalSec?: unknown;
  keywordSpikeMinCount?: unknown;
  keywordSpikeMultiplier?: unknown;
  predictionShiftThreshold?: unknown;
  predictionNewsActivityThreshold?: unknown;
  adsbBaseUrl?: unknown;
  relayBaseUrl?: unknown;
  relaySharedSecret?: unknown;
  aisApiKey?: unknown;
  acledAccessToken?: unknown;
  cloudflareApiToken?: unknown;
  wingbitsApiKey?: unknown;
  polymarketProxyUrl?: unknown;
}

interface CachedRealtimeSignalsSettings {
  exists: boolean;
  value?: StoredRealtimeSignalsSettings;
}

interface EffectiveRealtimeSignalsSettings {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  adsbEnabled: boolean;
  adsbIntervalSec: number;
  aisEnabled: boolean;
  aisIntervalSec: number;
  unrestEnabled: boolean;
  unrestIntervalSec: number;
  outagesEnabled: boolean;
  outagesIntervalSec: number;
  keywordSpikeEnabled: boolean;
  keywordSpikeIntervalSec: number;
  pizzintEnabled: boolean;
  pizzintIntervalSec: number;
  gdeltTensionEnabled: boolean;
  gdeltTensionIntervalSec: number;
  polymarketLeadsEnabled: boolean;
  polymarketLeadsIntervalSec: number;
  keywordSpikeMinCount: number;
  keywordSpikeMultiplier: number;
  predictionShiftThreshold: number;
  predictionNewsActivityThreshold: number;
  adsbBaseUrl?: string;
  relayBaseUrl?: string;
  relaySharedSecret?: string;
  aisApiKey?: string;
  acledAccessToken?: string;
  cloudflareApiToken?: string;
  wingbitsApiKey?: string;
  polymarketProxyUrl?: string;
}

interface SecretPresence {
  has: boolean;
  source: RealtimeSignalsSecretSource;
}

export interface RealtimeSignalsSettingsPublic {
  source: RealtimeSignalsSettingsSource;
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  adsbEnabled: boolean;
  adsbIntervalSec: number;
  aisEnabled: boolean;
  aisIntervalSec: number;
  unrestEnabled: boolean;
  unrestIntervalSec: number;
  outagesEnabled: boolean;
  outagesIntervalSec: number;
  keywordSpikeEnabled: boolean;
  keywordSpikeIntervalSec: number;
  pizzintEnabled: boolean;
  pizzintIntervalSec: number;
  gdeltTensionEnabled: boolean;
  gdeltTensionIntervalSec: number;
  polymarketLeadsEnabled: boolean;
  polymarketLeadsIntervalSec: number;
  keywordSpikeMinCount: number;
  keywordSpikeMultiplier: number;
  predictionShiftThreshold: number;
  predictionNewsActivityThreshold: number;
  adsbBaseUrl?: string;
  relayBaseUrl?: string;
  polymarketProxyUrl?: string;
  hasRelaySharedSecret: boolean;
  relaySharedSecretSource: RealtimeSignalsSecretSource;
  hasAisApiKey: boolean;
  aisApiKeySource: RealtimeSignalsSecretSource;
  hasAcledAccessToken: boolean;
  acledAccessTokenSource: RealtimeSignalsSecretSource;
  hasCloudflareApiToken: boolean;
  cloudflareApiTokenSource: RealtimeSignalsSecretSource;
  hasWingbitsApiKey: boolean;
  wingbitsApiKeySource: RealtimeSignalsSecretSource;
}

const SETTINGS_KEY = "realtime_signals_settings";
const SETTINGS_DESCRIPTION =
  "Realtime signals settings (source toggles, thresholds, relay URLs, and API credentials).";
const CACHE_KEY = "realtime-signals:settings";
const CACHE_TTL_SECONDS = 30;

@Injectable()
export class RealtimeSignalsSettingsService {
  private readonly logger = createLogger({ name: "realtime-signals-settings" });

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly env: EnvService,
    private readonly securitySettings: SystemSecuritySettingsService,
  ) {}

  async getPublicSettings(): Promise<RealtimeSignalsSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const relaySharedSecret = this.resolveStoredSecret(stored?.relaySharedSecret, "relay shared secret");
    const aisApiKey = this.resolveStoredSecret(stored?.aisApiKey, "ais api key");
    const acledAccessToken = this.resolveStoredSecret(stored?.acledAccessToken, "acled access token");
    const cloudflareApiToken = this.resolveStoredSecret(stored?.cloudflareApiToken, "cloudflare api token");
    const wingbitsApiKey = this.resolveStoredSecret(stored?.wingbitsApiKey, "wingbits api key");

    const relaySharedSecretPresence = this.resolveSecretPresence(
      relaySharedSecret,
      effective.relaySharedSecret,
    );
    const aisApiKeyPresence = this.resolveSecretPresence(
      aisApiKey,
      effective.aisApiKey,
    );
    const acledAccessTokenPresence = this.resolveSecretPresence(
      acledAccessToken,
      effective.acledAccessToken,
    );
    const cloudflareTokenPresence = this.resolveSecretPresence(
      cloudflareApiToken,
      effective.cloudflareApiToken,
    );
    const wingbitsApiKeyPresence = this.resolveSecretPresence(
      wingbitsApiKey,
      effective.wingbitsApiKey,
    );

    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      requestTimeoutMs: effective.requestTimeoutMs,
      maxRetries: effective.maxRetries,
      adsbEnabled: effective.adsbEnabled,
      adsbIntervalSec: effective.adsbIntervalSec,
      aisEnabled: effective.aisEnabled,
      aisIntervalSec: effective.aisIntervalSec,
      unrestEnabled: effective.unrestEnabled,
      unrestIntervalSec: effective.unrestIntervalSec,
      outagesEnabled: effective.outagesEnabled,
      outagesIntervalSec: effective.outagesIntervalSec,
      keywordSpikeEnabled: effective.keywordSpikeEnabled,
      keywordSpikeIntervalSec: effective.keywordSpikeIntervalSec,
      pizzintEnabled: effective.pizzintEnabled,
      pizzintIntervalSec: effective.pizzintIntervalSec,
      gdeltTensionEnabled: effective.gdeltTensionEnabled,
      gdeltTensionIntervalSec: effective.gdeltTensionIntervalSec,
      polymarketLeadsEnabled: effective.polymarketLeadsEnabled,
      polymarketLeadsIntervalSec: effective.polymarketLeadsIntervalSec,
      keywordSpikeMinCount: effective.keywordSpikeMinCount,
      keywordSpikeMultiplier: effective.keywordSpikeMultiplier,
      predictionShiftThreshold: effective.predictionShiftThreshold,
      predictionNewsActivityThreshold: effective.predictionNewsActivityThreshold,
      adsbBaseUrl: effective.adsbBaseUrl,
      relayBaseUrl: effective.relayBaseUrl,
      polymarketProxyUrl: effective.polymarketProxyUrl,
      hasRelaySharedSecret: relaySharedSecretPresence.has,
      relaySharedSecretSource: relaySharedSecretPresence.source,
      hasAisApiKey: aisApiKeyPresence.has,
      aisApiKeySource: aisApiKeyPresence.source,
      hasAcledAccessToken: acledAccessTokenPresence.has,
      acledAccessTokenSource: acledAccessTokenPresence.source,
      hasCloudflareApiToken: cloudflareTokenPresence.has,
      cloudflareApiTokenSource: cloudflareTokenPresence.source,
      hasWingbitsApiKey: wingbitsApiKeyPresence.has,
      wingbitsApiKeySource: wingbitsApiKeyPresence.source,
    };
  }

  async getRuntimeConfig(): Promise<RealtimeSignalsRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    return {
      enabled: effective.enabled,
      requestTimeoutMs: effective.requestTimeoutMs,
      maxRetries: effective.maxRetries,
      sources: {
        adsb: {
          enabled: effective.adsbEnabled,
          intervalSec: effective.adsbIntervalSec,
        },
        ais: {
          enabled: effective.aisEnabled,
          intervalSec: effective.aisIntervalSec,
        },
        unrest: {
          enabled: effective.unrestEnabled,
          intervalSec: effective.unrestIntervalSec,
        },
        outages: {
          enabled: effective.outagesEnabled,
          intervalSec: effective.outagesIntervalSec,
        },
        keyword_spike: {
          enabled: effective.keywordSpikeEnabled,
          intervalSec: effective.keywordSpikeIntervalSec,
        },
        pizzint: {
          enabled: effective.pizzintEnabled,
          intervalSec: effective.pizzintIntervalSec,
        },
        gdelt_tension: {
          enabled: effective.gdeltTensionEnabled,
          intervalSec: effective.gdeltTensionIntervalSec,
        },
        polymarket_leads: {
          enabled: effective.polymarketLeadsEnabled,
          intervalSec: effective.polymarketLeadsIntervalSec,
        },
      },
      thresholds: {
        keywordSpikeMinCount: effective.keywordSpikeMinCount,
        keywordSpikeMultiplier: effective.keywordSpikeMultiplier,
        predictionShiftThreshold: effective.predictionShiftThreshold,
        predictionNewsActivityThreshold: effective.predictionNewsActivityThreshold,
      },
      relay: {
        baseUrl: effective.relayBaseUrl,
        sharedSecret: effective.relaySharedSecret,
      },
      adsb: {
        baseUrl: effective.adsbBaseUrl,
      },
      credentials: {
        aisApiKey: effective.aisApiKey,
        acledAccessToken: effective.acledAccessToken,
        cloudflareApiToken: effective.cloudflareApiToken,
        wingbitsApiKey: effective.wingbitsApiKey,
      },
      polymarket: {
        proxyUrl: effective.polymarketProxyUrl,
      },
    };
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled?: boolean;
      requestTimeoutMs?: number;
      maxRetries?: number;
      adsbEnabled?: boolean;
      adsbIntervalSec?: number;
      aisEnabled?: boolean;
      aisIntervalSec?: number;
      unrestEnabled?: boolean;
      unrestIntervalSec?: number;
      outagesEnabled?: boolean;
      outagesIntervalSec?: number;
      keywordSpikeEnabled?: boolean;
      keywordSpikeIntervalSec?: number;
      pizzintEnabled?: boolean;
      pizzintIntervalSec?: number;
      gdeltTensionEnabled?: boolean;
      gdeltTensionIntervalSec?: number;
      polymarketLeadsEnabled?: boolean;
      polymarketLeadsIntervalSec?: number;
      keywordSpikeMinCount?: number;
      keywordSpikeMultiplier?: number;
      predictionShiftThreshold?: number;
      predictionNewsActivityThreshold?: number;
      adsbBaseUrl?: string | null;
      relayBaseUrl?: string | null;
      relaySharedSecret?: string | null;
      aisApiKey?: string | null;
      acledAccessToken?: string | null;
      cloudflareApiToken?: string | null;
      wingbitsApiKey?: string | null;
      polymarketProxyUrl?: string | null;
    },
  ): Promise<RealtimeSignalsSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const nextStored: StoredRealtimeSignalsSettings = {
      enabled: this.asBoolean(input.enabled, effective.enabled),
      requestTimeoutMs: this.asBoundedInt(input.requestTimeoutMs, effective.requestTimeoutMs, 1_000, 120_000),
      maxRetries: this.asBoundedInt(input.maxRetries, effective.maxRetries, 0, 6),
      adsbEnabled: this.asBoolean(input.adsbEnabled, effective.adsbEnabled),
      adsbIntervalSec: this.asBoundedInt(input.adsbIntervalSec, effective.adsbIntervalSec, 30, 86_400),
      aisEnabled: this.asBoolean(input.aisEnabled, effective.aisEnabled),
      aisIntervalSec: this.asBoundedInt(input.aisIntervalSec, effective.aisIntervalSec, 30, 86_400),
      unrestEnabled: this.asBoolean(input.unrestEnabled, effective.unrestEnabled),
      unrestIntervalSec: this.asBoundedInt(input.unrestIntervalSec, effective.unrestIntervalSec, 30, 86_400),
      outagesEnabled: this.asBoolean(input.outagesEnabled, effective.outagesEnabled),
      outagesIntervalSec: this.asBoundedInt(input.outagesIntervalSec, effective.outagesIntervalSec, 30, 86_400),
      keywordSpikeEnabled: this.asBoolean(input.keywordSpikeEnabled, effective.keywordSpikeEnabled),
      keywordSpikeIntervalSec: this.asBoundedInt(
        input.keywordSpikeIntervalSec,
        effective.keywordSpikeIntervalSec,
        30,
        86_400,
      ),
      pizzintEnabled: this.asBoolean(input.pizzintEnabled, effective.pizzintEnabled),
      pizzintIntervalSec: this.asBoundedInt(input.pizzintIntervalSec, effective.pizzintIntervalSec, 30, 86_400),
      gdeltTensionEnabled: this.asBoolean(input.gdeltTensionEnabled, effective.gdeltTensionEnabled),
      gdeltTensionIntervalSec: this.asBoundedInt(
        input.gdeltTensionIntervalSec,
        effective.gdeltTensionIntervalSec,
        30,
        86_400,
      ),
      polymarketLeadsEnabled: this.asBoolean(input.polymarketLeadsEnabled, effective.polymarketLeadsEnabled),
      polymarketLeadsIntervalSec: this.asBoundedInt(
        input.polymarketLeadsIntervalSec,
        effective.polymarketLeadsIntervalSec,
        30,
        86_400,
      ),
      keywordSpikeMinCount: this.asBoundedInt(input.keywordSpikeMinCount, effective.keywordSpikeMinCount, 1, 500),
      keywordSpikeMultiplier: this.asBoundedNumber(
        input.keywordSpikeMultiplier,
        effective.keywordSpikeMultiplier,
        1,
        100,
      ),
      predictionShiftThreshold: this.asBoundedNumber(
        input.predictionShiftThreshold,
        effective.predictionShiftThreshold,
        1,
        100,
      ),
      predictionNewsActivityThreshold: this.asBoundedInt(
        input.predictionNewsActivityThreshold,
        effective.predictionNewsActivityThreshold,
        0,
        1_000,
      ),
      adsbBaseUrl: this.resolveNextUrl(stored?.adsbBaseUrl, input.adsbBaseUrl, "adsbBaseUrl"),
      relayBaseUrl: this.resolveNextUrl(stored?.relayBaseUrl, input.relayBaseUrl, "relayBaseUrl"),
      relaySharedSecret: await this.resolveNextSecret(stored?.relaySharedSecret, input.relaySharedSecret),
      aisApiKey: await this.resolveNextSecret(stored?.aisApiKey, input.aisApiKey),
      acledAccessToken: await this.resolveNextSecret(stored?.acledAccessToken, input.acledAccessToken),
      cloudflareApiToken: await this.resolveNextSecret(stored?.cloudflareApiToken, input.cloudflareApiToken),
      wingbitsApiKey: await this.resolveNextSecret(stored?.wingbitsApiKey, input.wingbitsApiKey),
      polymarketProxyUrl: this.resolveNextUrl(
        stored?.polymarketProxyUrl,
        input.polymarketProxyUrl,
        "polymarketProxyUrl",
      ),
    };

    await this.prisma.systemSetting.upsert({
      where: { key: SETTINGS_KEY },
      create: {
        key: SETTINGS_KEY,
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored),
      },
      update: {
        description: SETTINGS_DESCRIPTION,
        value: this.toPrismaJson(nextStored),
      },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "realtime_signals_update",
          metadata: this.toPrismaJson({
            ok: true,
            updatedFields: Object.keys(input),
            secretsUpdated: {
              relaySharedSecret: input.relaySharedSecret !== undefined,
              aisApiKey: input.aisApiKey !== undefined,
              acledAccessToken: input.acledAccessToken !== undefined,
              cloudflareApiToken: input.cloudflareApiToken !== undefined,
              wingbitsApiKey: input.wingbitsApiKey !== undefined,
            },
          } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "realtime_signals_update",
      },
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string) {
    await this.prisma.systemSetting.deleteMany({ where: { key: SETTINGS_KEY } });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "realtime_signals_reset",
          metadata: this.toPrismaJson({ ok: true } satisfies Prisma.InputJsonObject),
        },
      },
      {
        orgId,
        actorId,
        resource: "system_settings",
        action: "realtime_signals_reset",
      },
    );

    await this.invalidateCache();
    return this.getPublicSettings();
  }

  private resolveEffectiveConfig(
    stored: StoredRealtimeSignalsSettings | null,
  ): EffectiveRealtimeSignalsSettings {
    const envConfig = this.env.realtimeSignalsConfig;
    return {
      enabled: this.asBoolean(stored?.enabled, envConfig.enabled),
      requestTimeoutMs: this.asBoundedInt(stored?.requestTimeoutMs, envConfig.requestTimeoutMs, 1_000, 120_000),
      maxRetries: this.asBoundedInt(stored?.maxRetries, envConfig.maxRetries, 0, 6),
      adsbEnabled: this.asBoolean(stored?.adsbEnabled, envConfig.sources.adsb.enabled),
      adsbIntervalSec: this.asBoundedInt(stored?.adsbIntervalSec, envConfig.sources.adsb.intervalSec, 30, 86_400),
      aisEnabled: this.asBoolean(stored?.aisEnabled, envConfig.sources.ais.enabled),
      aisIntervalSec: this.asBoundedInt(stored?.aisIntervalSec, envConfig.sources.ais.intervalSec, 30, 86_400),
      unrestEnabled: this.asBoolean(stored?.unrestEnabled, envConfig.sources.unrest.enabled),
      unrestIntervalSec: this.asBoundedInt(stored?.unrestIntervalSec, envConfig.sources.unrest.intervalSec, 30, 86_400),
      outagesEnabled: this.asBoolean(stored?.outagesEnabled, envConfig.sources.outages.enabled),
      outagesIntervalSec: this.asBoundedInt(stored?.outagesIntervalSec, envConfig.sources.outages.intervalSec, 30, 86_400),
      keywordSpikeEnabled: this.asBoolean(stored?.keywordSpikeEnabled, envConfig.sources.keywordSpike.enabled),
      keywordSpikeIntervalSec: this.asBoundedInt(
        stored?.keywordSpikeIntervalSec,
        envConfig.sources.keywordSpike.intervalSec,
        30,
        86_400,
      ),
      pizzintEnabled: this.asBoolean(stored?.pizzintEnabled, envConfig.sources.pizzint.enabled),
      pizzintIntervalSec: this.asBoundedInt(stored?.pizzintIntervalSec, envConfig.sources.pizzint.intervalSec, 30, 86_400),
      gdeltTensionEnabled: this.asBoolean(stored?.gdeltTensionEnabled, envConfig.sources.gdeltTension.enabled),
      gdeltTensionIntervalSec: this.asBoundedInt(
        stored?.gdeltTensionIntervalSec,
        envConfig.sources.gdeltTension.intervalSec,
        30,
        86_400,
      ),
      polymarketLeadsEnabled: this.asBoolean(stored?.polymarketLeadsEnabled, envConfig.sources.polymarketLeads.enabled),
      polymarketLeadsIntervalSec: this.asBoundedInt(
        stored?.polymarketLeadsIntervalSec,
        envConfig.sources.polymarketLeads.intervalSec,
        30,
        86_400,
      ),
      keywordSpikeMinCount: this.asBoundedInt(stored?.keywordSpikeMinCount, envConfig.thresholds.keywordSpikeMinCount, 1, 500),
      keywordSpikeMultiplier: this.asBoundedNumber(
        stored?.keywordSpikeMultiplier,
        envConfig.thresholds.keywordSpikeMultiplier,
        1,
        100,
      ),
      predictionShiftThreshold: this.asBoundedNumber(
        stored?.predictionShiftThreshold,
        envConfig.thresholds.predictionShiftThreshold,
        1,
        100,
      ),
      predictionNewsActivityThreshold: this.asBoundedInt(
        stored?.predictionNewsActivityThreshold,
        envConfig.thresholds.predictionNewsActivityThreshold,
        0,
        1_000,
      ),
      adsbBaseUrl:
        this.normalizeUrl(stored?.adsbBaseUrl) ??
        this.normalizeUrl(envConfig.adsb.baseUrl) ??
        "https://api.adsb.lol",
      relayBaseUrl:
        this.normalizeUrl(stored?.relayBaseUrl) ??
        this.normalizeUrl(envConfig.relay.baseUrl),
      relaySharedSecret:
        this.resolveStoredSecret(stored?.relaySharedSecret, "relay shared secret") ??
        this.normalizeString(envConfig.relay.sharedSecret),
      aisApiKey:
        this.resolveStoredSecret(stored?.aisApiKey, "ais api key") ??
        this.normalizeString(envConfig.credentials.aisApiKey),
      acledAccessToken:
        this.resolveStoredSecret(stored?.acledAccessToken, "acled access token") ??
        this.normalizeString(envConfig.credentials.acledAccessToken),
      cloudflareApiToken:
        this.resolveStoredSecret(stored?.cloudflareApiToken, "cloudflare api token") ??
        this.normalizeString(envConfig.credentials.cloudflareApiToken),
      wingbitsApiKey:
        this.resolveStoredSecret(stored?.wingbitsApiKey, "wingbits api key") ??
        this.normalizeString(envConfig.credentials.wingbitsApiKey),
      polymarketProxyUrl:
        this.normalizeUrl(stored?.polymarketProxyUrl) ??
        this.normalizeUrl(envConfig.polymarket.proxyUrl),
    };
  }

  private resolveSecretPresence(stored: string | undefined, effective: string | undefined): SecretPresence {
    if (stored) {
      return { has: true, source: "stored" };
    }
    if (effective) {
      return { has: true, source: "env" };
    }
    return { has: false, source: "none" };
  }

  private resolveStoredSecret(raw: unknown, keyName: string) {
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
      this.logger.warn(`Missing SYSTEM_SETTINGS_ENCRYPTION_KEY for ${keyName}`);
      return undefined;
    }
    try {
      return this.normalizeString(decryptStringValueV1(raw, key));
    } catch (error) {
      this.logger.warn({ err: error }, `Failed to decrypt ${keyName}`);
      return undefined;
    }
  }

  private resolveNextUrl(current: unknown, next: string | null | undefined, fieldName: string) {
    if (next === undefined) {
      const existing = this.normalizeUrl(current);
      return existing ?? null;
    }
    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.validateUrl(normalized, fieldName);
  }

  private async resolveNextSecret(current: unknown, next: string | null | undefined) {
    if (next === undefined) {
      return current ?? null;
    }
    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.securitySettings.encodeSecretForStorage(normalized);
  }

  private validateUrl(value: string, fieldName: string): string {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("invalid protocol");
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
    const parsed = typeof value === "number" ? Math.trunc(value) : Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  private asBoundedNumber(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  private normalizeString(value: unknown) {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeUrl(value: unknown) {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return undefined;
    }
    return normalized.replace(/\/+$/, "");
  }

  private async loadStoredSettings(): Promise<StoredRealtimeSignalsSettings | null> {
    let cached: CachedRealtimeSignalsSettings | null = null;
    try {
      cached = await this.cache.get<CachedRealtimeSignalsSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read realtime signals settings cache");
    }
    if (cached) {
      return cached.exists ? cached.value ?? null : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    const raw = record?.value as unknown;
    const settings = raw && typeof raw === "object" ? (raw as StoredRealtimeSignalsSettings) : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        { exists: Boolean(record), value: settings ?? undefined } satisfies CachedRealtimeSignalsSettings,
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to write realtime signals settings cache");
    }
    return settings;
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to invalidate realtime signals settings cache");
    }
  }

  private toPrismaJson(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
