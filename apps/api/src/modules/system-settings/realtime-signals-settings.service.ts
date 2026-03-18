import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { writeAuditLogBestEffort } from "../audit/audit-log.writer";
import { CacheService } from "../cache/cache.service";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import {
  decryptStringValueV1,
  type EncryptedStringValueV1,
  isEncryptedStringValueV1,
  resolveSettingsKey,
} from "../storage/storage-settings.crypto";
import type { RealtimeSignalsRuntimeConfig } from "../realtime-signals/realtime-signals.types";

import { SystemSecuritySettingsService } from "./system-security-settings.service";

export type RealtimeSignalsSettingsSource = "env" | "db";
export type RealtimeSignalsSecretSource = "stored" | "env" | "none";
export type RealtimeSignalsAcledAccessTokenStatus =
  | "ready"
  | "expiring"
  | "missing"
  | "refresh_failed";
type AcledAccessTokenRefreshMode = "none" | "if_needed" | "force";

interface StoredRealtimeSignalsSettings {
  enabled?: unknown;
  requestTimeoutMs?: unknown;
  maxRetries?: unknown;
  openskyEnabled?: unknown;
  adsbEnabled?: unknown;
  openskyIntervalSec?: unknown;
  adsbIntervalSec?: unknown;
  openskyDailyCreditBudget?: unknown;
  openskyDayIntervalSec?: unknown;
  openskyNightIntervalSec?: unknown;
  openskyDayStartHourHkt?: unknown;
  openskyNightStartHourHkt?: unknown;
  openskyWarningRemainingPct?: unknown;
  openskyCriticalRemainingPct?: unknown;
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
  openskyBaseUrl?: unknown;
  adsbBaseUrl?: unknown;
  openskyTokenUrl?: unknown;
  aisRelayBaseUrl?: unknown;
  openskyClientId?: unknown;
  openskyClientSecret?: unknown;
  aisRelaySharedSecret?: unknown;
  relayBaseUrl?: unknown;
  relaySharedSecret?: unknown;
  acledAccessToken?: unknown;
  acledOauthUsername?: unknown;
  acledOauthPassword?: unknown;
  acledOauthClientId?: unknown;
  cloudflareApiToken?: unknown;
  wingbitsApiKey?: unknown;
  polymarketProxyUrl?: unknown;
}

interface CachedRealtimeSignalsSettings {
  exists: boolean;
  value?: StoredRealtimeSignalsSettings;
}

interface StoredRealtimeSignalsAcledAuthState {
  version: 1;
  accessToken?: string | EncryptedStringValueV1 | null;
  expiresAt?: string | null;
  refreshedAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

interface CachedRealtimeSignalsAcledAuthState {
  exists: boolean;
  value?: StoredRealtimeSignalsAcledAuthState;
}

interface ParsedRealtimeSignalsAcledAuthState {
  accessToken?: string;
  expiresAt?: string;
  refreshedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

interface EffectiveRealtimeSignalsSettings {
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  openskyEnabled: boolean;
  openskyIntervalSec: number;
  openskyDailyCreditBudget: number;
  openskyDayIntervalSec: number;
  openskyNightIntervalSec: number;
  openskyDayStartHourHkt: number;
  openskyNightStartHourHkt: number;
  openskyWarningRemainingPct: number;
  openskyCriticalRemainingPct: number;
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
  openskyBaseUrl?: string;
  openskyTokenUrl?: string;
  aisRelayBaseUrl?: string;
  openskyClientId?: string;
  openskyClientIdSource: RealtimeSignalsSecretSource;
  openskyClientSecret?: string;
  openskyClientSecretSource: RealtimeSignalsSecretSource;
  aisRelaySharedSecret?: string;
  acledOauthUsername?: string;
  acledOauthUsernameSource: RealtimeSignalsSecretSource;
  acledOauthPassword?: string;
  acledOauthPasswordSource: RealtimeSignalsSecretSource;
  acledOauthClientId: string;
  acledOauthClientIdSource: RealtimeSignalsSecretSource;
  cloudflareApiToken?: string;
  wingbitsApiKey?: string;
  polymarketProxyUrl?: string;
}

interface SecretPresence {
  has: boolean;
  source: RealtimeSignalsSecretSource;
}

interface ResolvedAcledAccessToken {
  token?: string;
  source: RealtimeSignalsSecretSource;
  status: RealtimeSignalsAcledAccessTokenStatus;
  expiresAt?: string;
  refreshedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface RealtimeSignalsSettingsPublic {
  source: RealtimeSignalsSettingsSource;
  enabled: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
  acledApiEnabled: boolean;
  acledApiDisabledReason?: string;
  openskyEnabled: boolean;
  openskyIntervalSec: number;
  openskyDailyCreditBudget: number;
  openskyDayIntervalSec: number;
  openskyNightIntervalSec: number;
  openskyDayStartHourHkt: number;
  openskyNightStartHourHkt: number;
  openskyWarningRemainingPct: number;
  openskyCriticalRemainingPct: number;
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
  openskyBaseUrl?: string;
  openskyTokenUrl?: string;
  aisRelayBaseUrl?: string;
  polymarketProxyUrl?: string;
  openskyClientId?: string;
  openskyClientIdSource: RealtimeSignalsSecretSource;
  hasAisRelaySharedSecret: boolean;
  aisRelaySharedSecretSource: RealtimeSignalsSecretSource;
  hasOpenskyClientSecret: boolean;
  openskyClientSecretSource: RealtimeSignalsSecretSource;
  hasAcledAccessToken: boolean;
  acledAccessTokenSource: RealtimeSignalsSecretSource;
  acledAccessTokenStatus: RealtimeSignalsAcledAccessTokenStatus;
  acledAccessTokenExpiresAt?: string;
  acledAccessTokenRefreshedAt?: string;
  acledAccessTokenLastAttemptAt?: string;
  acledAccessTokenLastError?: string;
  acledOauthUsername?: string;
  acledOauthUsernameSource: RealtimeSignalsSecretSource;
  hasAcledOauthPassword: boolean;
  acledOauthPasswordSource: RealtimeSignalsSecretSource;
  acledOauthClientId: string;
  acledOauthClientIdSource: RealtimeSignalsSecretSource;
  hasCloudflareApiToken: boolean;
  cloudflareApiTokenSource: RealtimeSignalsSecretSource;
  hasWingbitsApiKey: boolean;
  wingbitsApiKeySource: RealtimeSignalsSecretSource;
}

const SETTINGS_KEY = "realtime_signals_settings";
const SETTINGS_DESCRIPTION =
  "Realtime signals settings (source toggles, thresholds, and API credentials).";
const CACHE_KEY = "realtime-signals:settings";
const CACHE_TTL_SECONDS = 30;

const ACLED_AUTH_STATE_KEY = "realtime_signals_acled_auth_state";
const ACLED_AUTH_STATE_DESCRIPTION =
  "Derived ACLED OAuth access token state for realtime signals.";
const ACLED_AUTH_CACHE_KEY = "realtime-signals:acled-auth-state";
const ACLED_AUTH_REFRESH_LOCK_KEY = "realtime-signals:acled-auth-refresh";
const ACLED_OAUTH_URL = "https://acleddata.com/oauth/token";
const DEFAULT_ACLED_CLIENT_ID = "acled";
const ACLED_API_ENABLED = false;
const ACLED_API_DISABLED_REASON = "Open myACLED does not include API access.";
const ACLED_TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000;
const ACLED_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const ACLED_REFRESH_LOCK_TTL_MS = 30_000;
const ACLED_REFRESH_POLL_INTERVAL_MS = 250;

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
    const acledApiPolicy = this.getAcledApiPolicy();
    const resolvedAcledToken = await this.resolveAcledAccessToken(effective, {
      refreshMode: "none",
    });

    const cloudflareTokenPresence = this.resolveSecretPresence(
      this.resolveStoredSecret(
        stored?.cloudflareApiToken,
        "cloudflare api token",
      ),
      effective.cloudflareApiToken,
    );
    const wingbitsApiKeyPresence = this.resolveSecretPresence(
      this.resolveStoredSecret(stored?.wingbitsApiKey, "wingbits api key"),
      effective.wingbitsApiKey,
    );
    const aisRelaySharedSecretPresence = this.resolveSecretPresence(
      this.resolveStoredSecret(
        stored?.aisRelaySharedSecret ?? stored?.relaySharedSecret,
        "ais relay shared secret",
      ),
      effective.aisRelaySharedSecret,
    );
    const openskyClientSecretPresence = this.resolveSecretPresence(
      this.resolveStoredSecret(
        stored?.openskyClientSecret,
        "opensky client secret",
      ),
      effective.openskyClientSecret,
    );

    return {
      source: stored ? "db" : "env",
      enabled: effective.enabled,
      requestTimeoutMs: effective.requestTimeoutMs,
      maxRetries: effective.maxRetries,
      acledApiEnabled: acledApiPolicy.enabled,
      acledApiDisabledReason: acledApiPolicy.reason,
      openskyEnabled: effective.openskyEnabled,
      openskyIntervalSec: effective.openskyIntervalSec,
      openskyDailyCreditBudget: effective.openskyDailyCreditBudget,
      openskyDayIntervalSec: effective.openskyDayIntervalSec,
      openskyNightIntervalSec: effective.openskyNightIntervalSec,
      openskyDayStartHourHkt: effective.openskyDayStartHourHkt,
      openskyNightStartHourHkt: effective.openskyNightStartHourHkt,
      openskyWarningRemainingPct: effective.openskyWarningRemainingPct,
      openskyCriticalRemainingPct: effective.openskyCriticalRemainingPct,
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
      predictionNewsActivityThreshold:
        effective.predictionNewsActivityThreshold,
      openskyBaseUrl: effective.openskyBaseUrl,
      openskyTokenUrl: effective.openskyTokenUrl,
      aisRelayBaseUrl: effective.aisRelayBaseUrl,
      polymarketProxyUrl: effective.polymarketProxyUrl,
      openskyClientId: effective.openskyClientId,
      openskyClientIdSource: effective.openskyClientIdSource,
      hasAisRelaySharedSecret: aisRelaySharedSecretPresence.has,
      aisRelaySharedSecretSource: aisRelaySharedSecretPresence.source,
      hasOpenskyClientSecret: openskyClientSecretPresence.has,
      openskyClientSecretSource: openskyClientSecretPresence.source,
      hasAcledAccessToken: Boolean(resolvedAcledToken.token),
      acledAccessTokenSource: resolvedAcledToken.source,
      acledAccessTokenStatus: resolvedAcledToken.status,
      acledAccessTokenExpiresAt: resolvedAcledToken.expiresAt,
      acledAccessTokenRefreshedAt: resolvedAcledToken.refreshedAt,
      acledAccessTokenLastAttemptAt: resolvedAcledToken.lastAttemptAt,
      acledAccessTokenLastError: resolvedAcledToken.lastError,
      acledOauthUsername: effective.acledOauthUsername,
      acledOauthUsernameSource: effective.acledOauthUsernameSource,
      hasAcledOauthPassword: effective.acledOauthPasswordSource !== "none",
      acledOauthPasswordSource: effective.acledOauthPasswordSource,
      acledOauthClientId: effective.acledOauthClientId,
      acledOauthClientIdSource: effective.acledOauthClientIdSource,
      hasCloudflareApiToken: cloudflareTokenPresence.has,
      cloudflareApiTokenSource: cloudflareTokenPresence.source,
      hasWingbitsApiKey: wingbitsApiKeyPresence.has,
      wingbitsApiKeySource: wingbitsApiKeyPresence.source,
    };
  }

  async getSettingsSource(): Promise<RealtimeSignalsSettingsSource> {
    const stored = await this.loadStoredSettings();
    return stored ? "db" : "env";
  }

  async getRuntimeConfig(options?: {
    refreshAcledToken?: boolean;
  }): Promise<RealtimeSignalsRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    const acledApiPolicy = this.getAcledApiPolicy();
    const resolvedAcledToken = await this.resolveAcledAccessToken(effective, {
      refreshMode: options?.refreshAcledToken === false ? "none" : "if_needed",
    });
    return {
      enabled: effective.enabled,
      requestTimeoutMs: effective.requestTimeoutMs,
      maxRetries: effective.maxRetries,
      capabilities: {
        acledApiEnabled: acledApiPolicy.enabled,
        acledApiDisabledReason: acledApiPolicy.reason,
      },
      sources: {
        opensky: {
          enabled: effective.openskyEnabled,
          intervalSec: effective.openskyIntervalSec,
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
        predictionNewsActivityThreshold:
          effective.predictionNewsActivityThreshold,
      },
      aisRelay: {
        baseUrl: effective.aisRelayBaseUrl,
        sharedSecret: effective.aisRelaySharedSecret,
      },
      opensky: {
        baseUrl: effective.openskyBaseUrl,
        tokenUrl: effective.openskyTokenUrl,
        clientId: effective.openskyClientId,
        clientSecret: effective.openskyClientSecret,
        dailyCreditBudget: effective.openskyDailyCreditBudget,
        dayIntervalSec: effective.openskyDayIntervalSec,
        nightIntervalSec: effective.openskyNightIntervalSec,
        dayStartHourHkt: effective.openskyDayStartHourHkt,
        nightStartHourHkt: effective.openskyNightStartHourHkt,
        warningRemainingPct: effective.openskyWarningRemainingPct,
        criticalRemainingPct: effective.openskyCriticalRemainingPct,
      },
      credentials: {
        acledAccessToken: acledApiPolicy.enabled
          ? resolvedAcledToken.token
          : undefined,
        cloudflareApiToken: effective.cloudflareApiToken,
        wingbitsApiKey: effective.wingbitsApiKey,
      },
      polymarket: {
        proxyUrl: effective.polymarketProxyUrl,
      },
    };
  }

  async forceRefreshAcledAccessToken(): Promise<string | undefined> {
    if (!this.getAcledApiPolicy().enabled) {
      return undefined;
    }
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    const resolved = await this.resolveAcledAccessToken(effective, {
      refreshMode: "force",
    });
    return resolved.token;
  }

  async updateSettings(
    orgId: string,
    actorId: string,
    input: {
      enabled?: boolean;
      requestTimeoutMs?: number;
      maxRetries?: number;
      openskyEnabled?: boolean;
      adsbEnabled?: boolean;
      openskyIntervalSec?: number;
      adsbIntervalSec?: number;
      openskyDailyCreditBudget?: number;
      openskyDayIntervalSec?: number;
      openskyNightIntervalSec?: number;
      openskyDayStartHourHkt?: number;
      openskyNightStartHourHkt?: number;
      openskyWarningRemainingPct?: number;
      openskyCriticalRemainingPct?: number;
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
      openskyBaseUrl?: string | null;
      adsbBaseUrl?: string | null;
      openskyTokenUrl?: string | null;
      aisRelayBaseUrl?: string | null;
      relayBaseUrl?: string | null;
      openskyClientId?: string | null;
      openskyClientSecret?: string | null;
      aisRelaySharedSecret?: string | null;
      relaySharedSecret?: string | null;
      acledOauthUsername?: string | null;
      acledOauthPassword?: string | null;
      acledOauthClientId?: string | null;
      cloudflareApiToken?: string | null;
      wingbitsApiKey?: string | null;
      polymarketProxyUrl?: string | null;
    },
  ): Promise<RealtimeSignalsSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const nextStored: StoredRealtimeSignalsSettings = {
      enabled: this.asBoolean(input.enabled, effective.enabled),
      requestTimeoutMs: this.asBoundedInt(
        input.requestTimeoutMs,
        effective.requestTimeoutMs,
        1_000,
        120_000,
      ),
      maxRetries: this.asBoundedInt(
        input.maxRetries,
        effective.maxRetries,
        0,
        6,
      ),
      openskyEnabled: this.asBoolean(
        input.openskyEnabled ?? input.adsbEnabled,
        effective.openskyEnabled,
      ),
      openskyIntervalSec: this.asBoundedInt(
        input.openskyIntervalSec ?? input.adsbIntervalSec,
        effective.openskyIntervalSec,
        30,
        86_400,
      ),
      openskyDailyCreditBudget: this.asBoundedInt(
        input.openskyDailyCreditBudget,
        effective.openskyDailyCreditBudget,
        1,
        100_000,
      ),
      openskyDayIntervalSec: this.asBoundedInt(
        input.openskyDayIntervalSec,
        effective.openskyDayIntervalSec,
        30,
        86_400,
      ),
      openskyNightIntervalSec: this.asBoundedInt(
        input.openskyNightIntervalSec,
        effective.openskyNightIntervalSec,
        30,
        86_400,
      ),
      openskyDayStartHourHkt: this.asBoundedInt(
        input.openskyDayStartHourHkt,
        effective.openskyDayStartHourHkt,
        0,
        23,
      ),
      openskyNightStartHourHkt: this.asBoundedInt(
        input.openskyNightStartHourHkt,
        effective.openskyNightStartHourHkt,
        0,
        23,
      ),
      openskyWarningRemainingPct: this.asBoundedInt(
        input.openskyWarningRemainingPct,
        effective.openskyWarningRemainingPct,
        1,
        99,
      ),
      openskyCriticalRemainingPct: this.asBoundedInt(
        input.openskyCriticalRemainingPct,
        effective.openskyCriticalRemainingPct,
        0,
        98,
      ),
      aisEnabled: this.asBoolean(input.aisEnabled, effective.aisEnabled),
      aisIntervalSec: this.asBoundedInt(
        input.aisIntervalSec,
        effective.aisIntervalSec,
        30,
        86_400,
      ),
      unrestEnabled: this.asBoolean(
        input.unrestEnabled,
        effective.unrestEnabled,
      ),
      unrestIntervalSec: this.asBoundedInt(
        input.unrestIntervalSec,
        effective.unrestIntervalSec,
        30,
        86_400,
      ),
      outagesEnabled: this.asBoolean(
        input.outagesEnabled,
        effective.outagesEnabled,
      ),
      outagesIntervalSec: this.asBoundedInt(
        input.outagesIntervalSec,
        effective.outagesIntervalSec,
        30,
        86_400,
      ),
      keywordSpikeEnabled: this.asBoolean(
        input.keywordSpikeEnabled,
        effective.keywordSpikeEnabled,
      ),
      keywordSpikeIntervalSec: this.asBoundedInt(
        input.keywordSpikeIntervalSec,
        effective.keywordSpikeIntervalSec,
        30,
        86_400,
      ),
      pizzintEnabled: this.asBoolean(
        input.pizzintEnabled,
        effective.pizzintEnabled,
      ),
      pizzintIntervalSec: this.asBoundedInt(
        input.pizzintIntervalSec,
        effective.pizzintIntervalSec,
        30,
        86_400,
      ),
      gdeltTensionEnabled: this.asBoolean(
        input.gdeltTensionEnabled,
        effective.gdeltTensionEnabled,
      ),
      gdeltTensionIntervalSec: this.asBoundedInt(
        input.gdeltTensionIntervalSec,
        effective.gdeltTensionIntervalSec,
        30,
        86_400,
      ),
      polymarketLeadsEnabled: this.asBoolean(
        input.polymarketLeadsEnabled,
        effective.polymarketLeadsEnabled,
      ),
      polymarketLeadsIntervalSec: this.asBoundedInt(
        input.polymarketLeadsIntervalSec,
        effective.polymarketLeadsIntervalSec,
        30,
        86_400,
      ),
      keywordSpikeMinCount: this.asBoundedInt(
        input.keywordSpikeMinCount,
        effective.keywordSpikeMinCount,
        1,
        500,
      ),
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
      openskyBaseUrl: this.resolveNextUrl(
        stored?.openskyBaseUrl ?? stored?.adsbBaseUrl,
        input.openskyBaseUrl ?? input.adsbBaseUrl,
        "openskyBaseUrl",
      ),
      openskyTokenUrl: this.resolveNextUrl(
        stored?.openskyTokenUrl,
        input.openskyTokenUrl,
        "openskyTokenUrl",
      ),
      aisRelayBaseUrl: this.resolveNextUrl(
        stored?.aisRelayBaseUrl ?? stored?.relayBaseUrl,
        input.aisRelayBaseUrl ?? input.relayBaseUrl,
        "aisRelayBaseUrl",
      ),
      openskyClientId: this.resolveNextString(
        stored?.openskyClientId,
        input.openskyClientId,
      ),
      openskyClientSecret: await this.resolveNextSecret(
        stored?.openskyClientSecret,
        input.openskyClientSecret,
      ),
      aisRelaySharedSecret: await this.resolveNextSecret(
        stored?.aisRelaySharedSecret ?? stored?.relaySharedSecret,
        input.aisRelaySharedSecret ?? input.relaySharedSecret,
      ),
      relayBaseUrl: undefined,
      relaySharedSecret: undefined,
      acledAccessToken: null,
      acledOauthUsername: this.resolveNextString(
        stored?.acledOauthUsername,
        input.acledOauthUsername,
      ),
      acledOauthPassword: await this.resolveNextSecret(
        stored?.acledOauthPassword,
        input.acledOauthPassword,
      ),
      acledOauthClientId: this.resolveNextString(
        stored?.acledOauthClientId,
        input.acledOauthClientId,
      ),
      cloudflareApiToken: await this.resolveNextSecret(
        stored?.cloudflareApiToken,
        input.cloudflareApiToken,
      ),
      wingbitsApiKey: await this.resolveNextSecret(
        stored?.wingbitsApiKey,
        input.wingbitsApiKey,
      ),
      polymarketProxyUrl: this.resolveNextUrl(
        stored?.polymarketProxyUrl,
        input.polymarketProxyUrl,
        "polymarketProxyUrl",
      ),
    };

    this.validateOpenskyBudgetSettings({
      openskyDailyCreditBudget: nextStored.openskyDailyCreditBudget as number,
      openskyDayIntervalSec: nextStored.openskyDayIntervalSec as number,
      openskyNightIntervalSec: nextStored.openskyNightIntervalSec as number,
      openskyDayStartHourHkt: nextStored.openskyDayStartHourHkt as number,
      openskyNightStartHourHkt: nextStored.openskyNightStartHourHkt as number,
      openskyWarningRemainingPct:
        nextStored.openskyWarningRemainingPct as number,
      openskyCriticalRemainingPct:
        nextStored.openskyCriticalRemainingPct as number,
    });

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

    const acledOauthUpdated =
      input.acledOauthUsername !== undefined ||
      input.acledOauthPassword !== undefined ||
      input.acledOauthClientId !== undefined;
    if (acledOauthUpdated && this.getAcledApiPolicy().enabled) {
      await this.clearAcledAuthState();
    }

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
              aisRelaySharedSecret:
                input.aisRelaySharedSecret !== undefined ||
                input.relaySharedSecret !== undefined,
              openskyClientSecret: input.openskyClientSecret !== undefined,
              acledOauthPassword: input.acledOauthPassword !== undefined,
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

    const nextEffective = this.resolveEffectiveConfig(nextStored);
    if (
      this.getAcledApiPolicy().enabled &&
      this.hasAcledOauthCredentials(nextEffective)
    ) {
      await this.resolveAcledAccessToken(nextEffective, {
        refreshMode: "force",
      });
    }

    return this.getPublicSettings();
  }

  async resetToEnv(orgId: string, actorId: string) {
    await this.prisma.systemSetting.deleteMany({
      where: { key: { in: [SETTINGS_KEY, ACLED_AUTH_STATE_KEY] } },
    });

    await writeAuditLogBestEffort(
      this.prisma,
      {
        data: {
          orgId,
          actorId,
          resource: "system_settings",
          action: "realtime_signals_reset",
          metadata: this.toPrismaJson({
            ok: true,
          } satisfies Prisma.InputJsonObject),
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
    await this.invalidateAcledAuthStateCache();
    return this.getPublicSettings();
  }

  private resolveEffectiveConfig(
    stored: StoredRealtimeSignalsSettings | null,
  ): EffectiveRealtimeSignalsSettings {
    const envConfig = this.env.realtimeSignalsConfig;
    const envAisRelayBaseUrl = this.normalizeUrl(envConfig.ais.baseUrl);
    const storedAisRelayBaseUrl = this.normalizeUrl(stored?.aisRelayBaseUrl);
    const storedLegacyRelayBaseUrl = this.normalizeUrl(stored?.relayBaseUrl);
    const envAisRelaySharedSecret = this.normalizeString(
      envConfig.ais.sharedSecret,
    );
    const storedAisRelaySharedSecret = this.resolveStoredSecret(
      stored?.aisRelaySharedSecret,
      "ais relay shared secret",
    );
    const storedLegacyRelaySharedSecret = this.resolveStoredSecret(
      stored?.relaySharedSecret,
      "legacy relay shared secret",
    );

    const envOpenskyClientId = this.normalizeString(envConfig.opensky.clientId);
    const storedOpenskyClientId = this.resolveStoredString(
      stored?.openskyClientId,
    );

    const envOpenskyClientSecret = this.normalizeString(
      envConfig.opensky.clientSecret,
    );
    const storedOpenskyClientSecret = this.resolveStoredSecret(
      stored?.openskyClientSecret,
      "opensky client secret",
    );

    const envAcledOauthUsername = this.normalizeString(
      envConfig.credentials.acledOauthUsername,
    );
    const storedAcledOauthUsername = this.resolveStoredString(
      stored?.acledOauthUsername,
    );

    const envAcledOauthPassword = this.normalizeString(
      envConfig.credentials.acledOauthPassword,
    );
    const storedAcledOauthPassword = this.resolveStoredSecret(
      stored?.acledOauthPassword,
      "acled oauth password",
    );

    const envAcledOauthClientId = this.normalizeString(
      envConfig.credentials.acledOauthClientId,
    );
    const storedAcledOauthClientId = this.resolveStoredString(
      stored?.acledOauthClientId,
    );

    const envCloudflareApiToken = this.normalizeString(
      envConfig.credentials.cloudflareApiToken,
    );
    const storedCloudflareApiToken = this.resolveStoredSecret(
      stored?.cloudflareApiToken,
      "cloudflare api token",
    );

    const envWingbitsApiKey = this.normalizeString(
      envConfig.credentials.wingbitsApiKey,
    );
    const storedWingbitsApiKey = this.resolveStoredSecret(
      stored?.wingbitsApiKey,
      "wingbits api key",
    );

    const effective: EffectiveRealtimeSignalsSettings = {
      enabled: this.asBoolean(stored?.enabled, envConfig.enabled),
      requestTimeoutMs: this.asBoundedInt(
        stored?.requestTimeoutMs,
        envConfig.requestTimeoutMs,
        1_000,
        120_000,
      ),
      maxRetries: this.asBoundedInt(
        stored?.maxRetries,
        envConfig.maxRetries,
        0,
        6,
      ),
      openskyEnabled: this.asBoolean(
        stored?.openskyEnabled ?? stored?.adsbEnabled,
        envConfig.sources.opensky.enabled,
      ),
      openskyIntervalSec: this.asBoundedInt(
        stored?.openskyIntervalSec ?? stored?.adsbIntervalSec,
        envConfig.sources.opensky.intervalSec,
        30,
        86_400,
      ),
      openskyDailyCreditBudget: this.asBoundedInt(
        stored?.openskyDailyCreditBudget,
        envConfig.opensky.dailyCreditBudget,
        1,
        100_000,
      ),
      openskyDayIntervalSec: this.asBoundedInt(
        stored?.openskyDayIntervalSec,
        envConfig.opensky.dayIntervalSec,
        30,
        86_400,
      ),
      openskyNightIntervalSec: this.asBoundedInt(
        stored?.openskyNightIntervalSec,
        envConfig.opensky.nightIntervalSec,
        30,
        86_400,
      ),
      openskyDayStartHourHkt: this.asBoundedInt(
        stored?.openskyDayStartHourHkt,
        envConfig.opensky.dayStartHourHkt,
        0,
        23,
      ),
      openskyNightStartHourHkt: this.asBoundedInt(
        stored?.openskyNightStartHourHkt,
        envConfig.opensky.nightStartHourHkt,
        0,
        23,
      ),
      openskyWarningRemainingPct: this.asBoundedInt(
        stored?.openskyWarningRemainingPct,
        envConfig.opensky.warningRemainingPct,
        1,
        99,
      ),
      openskyCriticalRemainingPct: this.asBoundedInt(
        stored?.openskyCriticalRemainingPct,
        envConfig.opensky.criticalRemainingPct,
        0,
        98,
      ),
      aisEnabled: this.asBoolean(
        stored?.aisEnabled,
        envConfig.sources.ais.enabled,
      ),
      aisIntervalSec: this.asBoundedInt(
        stored?.aisIntervalSec,
        envConfig.sources.ais.intervalSec,
        30,
        86_400,
      ),
      unrestEnabled: this.asBoolean(
        stored?.unrestEnabled,
        envConfig.sources.unrest.enabled,
      ),
      unrestIntervalSec: this.asBoundedInt(
        stored?.unrestIntervalSec,
        envConfig.sources.unrest.intervalSec,
        30,
        86_400,
      ),
      outagesEnabled: this.asBoolean(
        stored?.outagesEnabled,
        envConfig.sources.outages.enabled,
      ),
      outagesIntervalSec: this.asBoundedInt(
        stored?.outagesIntervalSec,
        envConfig.sources.outages.intervalSec,
        30,
        86_400,
      ),
      keywordSpikeEnabled: this.asBoolean(
        stored?.keywordSpikeEnabled,
        envConfig.sources.keywordSpike.enabled,
      ),
      keywordSpikeIntervalSec: this.asBoundedInt(
        stored?.keywordSpikeIntervalSec,
        envConfig.sources.keywordSpike.intervalSec,
        30,
        86_400,
      ),
      pizzintEnabled: this.asBoolean(
        stored?.pizzintEnabled,
        envConfig.sources.pizzint.enabled,
      ),
      pizzintIntervalSec: this.asBoundedInt(
        stored?.pizzintIntervalSec,
        envConfig.sources.pizzint.intervalSec,
        30,
        86_400,
      ),
      gdeltTensionEnabled: this.asBoolean(
        stored?.gdeltTensionEnabled,
        envConfig.sources.gdeltTension.enabled,
      ),
      gdeltTensionIntervalSec: this.asBoundedInt(
        stored?.gdeltTensionIntervalSec,
        envConfig.sources.gdeltTension.intervalSec,
        30,
        86_400,
      ),
      polymarketLeadsEnabled: this.asBoolean(
        stored?.polymarketLeadsEnabled,
        envConfig.sources.polymarketLeads.enabled,
      ),
      polymarketLeadsIntervalSec: this.asBoundedInt(
        stored?.polymarketLeadsIntervalSec,
        envConfig.sources.polymarketLeads.intervalSec,
        30,
        86_400,
      ),
      keywordSpikeMinCount: this.asBoundedInt(
        stored?.keywordSpikeMinCount,
        envConfig.thresholds.keywordSpikeMinCount,
        1,
        500,
      ),
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
      openskyBaseUrl:
        this.normalizeUrl(stored?.openskyBaseUrl ?? stored?.adsbBaseUrl) ??
        this.normalizeUrl(envConfig.opensky.baseUrl) ??
        "https://opensky-network.org/api",
      openskyTokenUrl:
        this.normalizeUrl(stored?.openskyTokenUrl) ??
        this.normalizeUrl(envConfig.opensky.tokenUrl) ??
        "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
      openskyClientId: storedOpenskyClientId ?? envOpenskyClientId,
      openskyClientIdSource: this.resolveSecretPresence(
        storedOpenskyClientId,
        envOpenskyClientId,
      ).source,
      openskyClientSecret: storedOpenskyClientSecret ?? envOpenskyClientSecret,
      openskyClientSecretSource: this.resolveSecretPresence(
        storedOpenskyClientSecret,
        envOpenskyClientSecret,
      ).source,
      aisRelayBaseUrl:
        storedAisRelayBaseUrl ?? storedLegacyRelayBaseUrl ?? envAisRelayBaseUrl,
      aisRelaySharedSecret:
        storedAisRelaySharedSecret ??
        storedLegacyRelaySharedSecret ??
        envAisRelaySharedSecret,
      acledOauthUsername: storedAcledOauthUsername ?? envAcledOauthUsername,
      acledOauthUsernameSource: this.resolveSecretPresence(
        storedAcledOauthUsername,
        envAcledOauthUsername,
      ).source,
      acledOauthPassword: storedAcledOauthPassword ?? envAcledOauthPassword,
      acledOauthPasswordSource: this.resolveSecretPresence(
        storedAcledOauthPassword,
        envAcledOauthPassword,
      ).source,
      acledOauthClientId:
        storedAcledOauthClientId ??
        envAcledOauthClientId ??
        DEFAULT_ACLED_CLIENT_ID,
      acledOauthClientIdSource: this.resolveSecretPresence(
        storedAcledOauthClientId,
        envAcledOauthClientId,
      ).source,
      cloudflareApiToken: storedCloudflareApiToken ?? envCloudflareApiToken,
      wingbitsApiKey: storedWingbitsApiKey ?? envWingbitsApiKey,
      polymarketProxyUrl:
        this.normalizeUrl(stored?.polymarketProxyUrl) ??
        this.normalizeUrl(envConfig.polymarket.proxyUrl),
    };

    this.validateOpenskyBudgetSettings(effective);
    return effective;
  }

  private resolveSecretPresence(
    stored: string | undefined,
    effective: string | undefined,
  ): SecretPresence {
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

  private resolveStoredString(raw: unknown) {
    return typeof raw === "string" ? this.normalizeString(raw) : undefined;
  }

  private resolveNextUrl(
    current: unknown,
    next: string | null | undefined,
    fieldName: string,
  ) {
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

  private resolveNextString(current: unknown, next: string | null | undefined) {
    if (next === undefined) {
      return this.resolveStoredString(current) ?? null;
    }
    return this.normalizeString(next) ?? null;
  }

  private async resolveNextSecret(
    current: unknown,
    next: string | null | undefined,
  ) {
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

  private validateOpenskyBudgetSettings(input: {
    openskyDailyCreditBudget: number;
    openskyDayIntervalSec: number;
    openskyNightIntervalSec: number;
    openskyDayStartHourHkt: number;
    openskyNightStartHourHkt: number;
    openskyWarningRemainingPct: number;
    openskyCriticalRemainingPct: number;
  }) {
    if (input.openskyDailyCreditBudget <= 0) {
      throw new BadRequestException(
        "openskyDailyCreditBudget must be greater than 0",
      );
    }
    if (input.openskyDayStartHourHkt >= input.openskyNightStartHourHkt) {
      throw new BadRequestException(
        "openskyDayStartHourHkt must be earlier than openskyNightStartHourHkt",
      );
    }
    if (input.openskyCriticalRemainingPct >= input.openskyWarningRemainingPct) {
      throw new BadRequestException(
        "openskyCriticalRemainingPct must be lower than openskyWarningRemainingPct",
      );
    }
    if (input.openskyDayIntervalSec > input.openskyNightIntervalSec) {
      throw new BadRequestException(
        "openskyDayIntervalSec must be less than or equal to openskyNightIntervalSec",
      );
    }
  }

  private asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private asBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed =
      typeof value === "number" ? Math.trunc(value) : Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }

  private asBoundedNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
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

  private normalizeIsoTimestamp(value: unknown) {
    if (typeof value !== "string") {
      return undefined;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return new Date(parsed).toISOString();
  }

  private hasAcledOauthCredentials(
    effective: EffectiveRealtimeSignalsSettings,
  ) {
    return Boolean(
      effective.acledOauthUsername?.trim() &&
        effective.acledOauthPassword?.trim(),
    );
  }

  private isAcledTokenUsable(expiresAt: string | undefined) {
    if (!expiresAt) {
      return false;
    }
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) && parsed > Date.now();
  }

  private isAcledTokenExpiring(expiresAt: string | undefined) {
    if (!expiresAt) {
      return false;
    }
    const parsed = Date.parse(expiresAt);
    return (
      Number.isFinite(parsed) &&
      parsed - Date.now() <= ACLED_TOKEN_REFRESH_WINDOW_MS
    );
  }

  private isAcledRefreshCoolingDown(lastAttemptAt: string | undefined) {
    if (!lastAttemptAt) {
      return false;
    }
    const parsed = Date.parse(lastAttemptAt);
    return (
      Number.isFinite(parsed) && Date.now() - parsed < ACLED_REFRESH_COOLDOWN_MS
    );
  }

  private async resolveAcledAccessToken(
    effective: EffectiveRealtimeSignalsSettings,
    options: { refreshMode: AcledAccessTokenRefreshMode },
  ): Promise<ResolvedAcledAccessToken> {
    if (!this.getAcledApiPolicy().enabled) {
      return {
        source: "none",
        status: "missing",
      };
    }

    let state = await this.loadAcledAuthState();
    const hasUsableToken = Boolean(
      state?.accessToken && this.isAcledTokenUsable(state.expiresAt),
    );
    const shouldRefresh =
      options.refreshMode === "force" ||
      (options.refreshMode === "if_needed" &&
        (!hasUsableToken || this.isAcledTokenExpiring(state?.expiresAt)));
    const coolingDown =
      options.refreshMode !== "force" &&
      Boolean(state?.lastError) &&
      hasUsableToken &&
      this.isAcledRefreshCoolingDown(state?.lastAttemptAt);

    if (
      this.hasAcledOauthCredentials(effective) &&
      shouldRefresh &&
      !coolingDown
    ) {
      state = await this.refreshAcledAccessToken(effective, state, {
        forceRefresh: options.refreshMode === "force",
      });
    }

    if (state?.accessToken && this.isAcledTokenUsable(state.expiresAt)) {
      return {
        token: state.accessToken,
        source: "stored",
        status: this.isAcledTokenExpiring(state.expiresAt)
          ? "expiring"
          : "ready",
        expiresAt: state.expiresAt,
        refreshedAt: state.refreshedAt,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
      };
    }

    if (state?.lastError) {
      return {
        source: "none",
        status: "refresh_failed",
        expiresAt: state.expiresAt,
        refreshedAt: state.refreshedAt,
        lastAttemptAt: state.lastAttemptAt,
        lastError: state.lastError,
      };
    }

    return {
      source: "none",
      status: "missing",
      expiresAt: state?.expiresAt,
      refreshedAt: state?.refreshedAt,
      lastAttemptAt: state?.lastAttemptAt,
    };
  }

  private async refreshAcledAccessToken(
    effective: EffectiveRealtimeSignalsSettings,
    currentState: ParsedRealtimeSignalsAcledAuthState | null,
    options: { forceRefresh: boolean },
  ): Promise<ParsedRealtimeSignalsAcledAuthState | null> {
    const result = await this.cache.withLock(
      ACLED_AUTH_REFRESH_LOCK_KEY,
      ACLED_REFRESH_LOCK_TTL_MS,
      async () => {
        const latestState = await this.loadAcledAuthState();
        if (
          !options.forceRefresh &&
          latestState?.accessToken &&
          this.isAcledTokenUsable(latestState.expiresAt) &&
          !this.isAcledTokenExpiring(latestState.expiresAt)
        ) {
          return latestState;
        }

        try {
          const nextState = await this.requestAcledAccessToken(effective);
          await this.persistAcledAuthState(nextState);
          return nextState;
        } catch (error) {
          const nextState = {
            accessToken:
              latestState?.accessToken &&
              this.isAcledTokenUsable(latestState.expiresAt)
                ? latestState.accessToken
                : currentState?.accessToken &&
                    this.isAcledTokenUsable(currentState.expiresAt)
                  ? currentState.accessToken
                  : undefined,
            expiresAt:
              latestState?.expiresAt &&
              this.isAcledTokenUsable(latestState.expiresAt)
                ? latestState.expiresAt
                : currentState?.expiresAt &&
                    this.isAcledTokenUsable(currentState.expiresAt)
                  ? currentState.expiresAt
                  : undefined,
            refreshedAt:
              latestState?.refreshedAt &&
              latestState?.expiresAt &&
              this.isAcledTokenUsable(latestState.expiresAt)
                ? latestState.refreshedAt
                : currentState?.refreshedAt &&
                    currentState?.expiresAt &&
                    this.isAcledTokenUsable(currentState.expiresAt)
                  ? currentState.refreshedAt
                  : undefined,
            lastAttemptAt: new Date().toISOString(),
            lastError: this.toAcledAuthErrorMessage(error),
          } satisfies ParsedRealtimeSignalsAcledAuthState;
          await this.persistAcledAuthState(nextState);
          this.logger.warn(
            { err: error },
            "Failed to refresh ACLED access token",
          );
          return nextState;
        }
      },
    );

    if (result) {
      return result;
    }

    return await this.waitForAcledAuthStateUpdate(currentState);
  }

  private async requestAcledAccessToken(
    effective: EffectiveRealtimeSignalsSettings,
  ): Promise<ParsedRealtimeSignalsAcledAuthState> {
    const username = effective.acledOauthUsername?.trim();
    const password = effective.acledOauthPassword?.trim();
    const clientId = effective.acledOauthClientId.trim();

    if (!username || !password) {
      throw new Error("ACLED OAuth credentials are not configured");
    }

    const timeoutMs = Math.max(1_000, Math.trunc(effective.requestTimeoutMs));
    const maxRetries = Math.max(0, Math.trunc(effective.maxRetries));
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body = new URLSearchParams({
          username,
          password,
          grant_type: "password",
          client_id: clientId,
        });
        const response = await fetch(ACLED_OAUTH_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as {
          access_token?: unknown;
          expires_in?: unknown;
          message?: unknown;
          error?: unknown;
          error_description?: unknown;
        };
        if (!response.ok) {
          throw new Error(
            this.buildAcledOAuthHttpErrorMessage(
              response.status,
              response.statusText,
              payload,
            ),
          );
        }
        const accessToken = this.normalizeString(payload.access_token);
        if (!accessToken) {
          throw new Error("ACLED OAuth response missing access_token");
        }
        const expiresInRaw =
          typeof payload.expires_in === "number"
            ? payload.expires_in
            : Number(payload.expires_in);
        const expiresInSeconds =
          Number.isFinite(expiresInRaw) && expiresInRaw > 0
            ? Math.trunc(expiresInRaw)
            : 86_400;
        const refreshedAt = new Date().toISOString();
        const expiresAt = new Date(
          Date.now() + expiresInSeconds * 1_000,
        ).toISOString();
        return {
          accessToken,
          expiresAt,
          refreshedAt,
          lastAttemptAt: refreshedAt,
        };
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await this.sleep(Math.min(5_000, 300 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new Error("ACLED OAuth request failed");
  }

  private buildAcledOAuthHttpErrorMessage(
    status: number,
    statusText: string,
    payload: {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    },
  ) {
    const detail =
      this.normalizeString(payload.error_description) ??
      this.normalizeString(payload.error) ??
      this.normalizeString(payload.message);
    return detail
      ? `ACLED OAuth HTTP ${status} ${statusText}: ${detail}`
      : `ACLED OAuth HTTP ${status} ${statusText}`;
  }

  private toAcledAuthErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    return "Unknown ACLED OAuth error";
  }

  private getAcledApiPolicy() {
    return {
      enabled: ACLED_API_ENABLED,
      reason: ACLED_API_DISABLED_REASON,
    };
  }

  private async loadStoredSettings(): Promise<StoredRealtimeSignalsSettings | null> {
    let cached: CachedRealtimeSignalsSettings | null = null;
    try {
      cached = await this.cache.get<CachedRealtimeSignalsSettings>(CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to read realtime signals settings cache",
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
        ? (raw as StoredRealtimeSignalsSettings)
        : null;

    try {
      await this.cache.set(
        CACHE_KEY,
        {
          exists: Boolean(record),
          value: settings ?? undefined,
        } satisfies CachedRealtimeSignalsSettings,
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to write realtime signals settings cache",
      );
    }
    return settings;
  }

  private async loadStoredAcledAuthStateRecord(): Promise<StoredRealtimeSignalsAcledAuthState | null> {
    let cached: CachedRealtimeSignalsAcledAuthState | null = null;
    try {
      cached =
        await this.cache.get<CachedRealtimeSignalsAcledAuthState>(
          ACLED_AUTH_CACHE_KEY,
        );
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to read ACLED auth state cache");
    }
    if (cached) {
      return cached.exists ? (cached.value ?? null) : null;
    }

    const record = await this.prisma.systemSetting.findUnique({
      where: { key: ACLED_AUTH_STATE_KEY },
    });
    const raw = record?.value as unknown;
    const state =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as StoredRealtimeSignalsAcledAuthState)
        : null;

    try {
      await this.cache.set(
        ACLED_AUTH_CACHE_KEY,
        {
          exists: Boolean(record),
          value: state ?? undefined,
        } satisfies CachedRealtimeSignalsAcledAuthState,
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to write ACLED auth state cache",
      );
    }
    return state;
  }

  private async loadAcledAuthState(): Promise<ParsedRealtimeSignalsAcledAuthState | null> {
    const record = await this.loadStoredAcledAuthStateRecord();
    if (!record) {
      return null;
    }
    if (record.version !== 1) {
      this.logger.warn(
        { version: record.version },
        "Unsupported ACLED auth state version",
      );
      return null;
    }
    const accessToken = this.resolveStoredSecret(
      record.accessToken,
      "acled oauth access token",
    );
    const expiresAt = this.normalizeIsoTimestamp(record.expiresAt);
    const refreshedAt = this.normalizeIsoTimestamp(record.refreshedAt);
    const lastAttemptAt = this.normalizeIsoTimestamp(record.lastAttemptAt);
    const lastError = this.normalizeString(record.lastError);
    if (
      !accessToken &&
      !expiresAt &&
      !refreshedAt &&
      !lastAttemptAt &&
      !lastError
    ) {
      return null;
    }
    return {
      accessToken,
      expiresAt,
      refreshedAt,
      lastAttemptAt,
      lastError,
    };
  }

  private async persistAcledAuthState(
    state: ParsedRealtimeSignalsAcledAuthState | null,
  ) {
    if (
      !state ||
      (!state.accessToken &&
        !state.expiresAt &&
        !state.refreshedAt &&
        !state.lastAttemptAt &&
        !state.lastError)
    ) {
      await this.clearAcledAuthState();
      return;
    }

    const storedToken = state.accessToken
      ? await this.securitySettings.encodeSecretForStorage(state.accessToken)
      : null;
    const value: StoredRealtimeSignalsAcledAuthState = {
      version: 1,
      accessToken: storedToken,
      expiresAt: state.expiresAt ?? null,
      refreshedAt: state.refreshedAt ?? null,
      lastAttemptAt: state.lastAttemptAt ?? null,
      lastError: state.lastError ?? null,
    };

    await this.prisma.systemSetting.upsert({
      where: { key: ACLED_AUTH_STATE_KEY },
      update: {
        value: this.toPrismaJson(value),
        description: ACLED_AUTH_STATE_DESCRIPTION,
      },
      create: {
        key: ACLED_AUTH_STATE_KEY,
        value: this.toPrismaJson(value),
        description: ACLED_AUTH_STATE_DESCRIPTION,
      },
    });

    await this.invalidateAcledAuthStateCache();
  }

  private acledAuthStateSignature(
    state: ParsedRealtimeSignalsAcledAuthState | null,
  ) {
    if (!state) {
      return "null";
    }
    return JSON.stringify({
      hasAccessToken: Boolean(state.accessToken),
      expiresAt: state.expiresAt ?? null,
      refreshedAt: state.refreshedAt ?? null,
      lastAttemptAt: state.lastAttemptAt ?? null,
      lastError: state.lastError ?? null,
    });
  }

  private async waitForAcledAuthStateUpdate(
    previousState: ParsedRealtimeSignalsAcledAuthState | null,
  ) {
    const previousSignature = this.acledAuthStateSignature(previousState);
    const deadline = Date.now() + ACLED_REFRESH_LOCK_TTL_MS + 1_000;

    while (Date.now() < deadline) {
      await this.sleep(ACLED_REFRESH_POLL_INTERVAL_MS);
      const nextState = await this.loadAcledAuthState();
      if (this.acledAuthStateSignature(nextState) !== previousSignature) {
        return nextState;
      }
    }

    return (await this.loadAcledAuthState()) ?? previousState;
  }

  private async clearAcledAuthState() {
    await this.prisma.systemSetting.deleteMany({
      where: { key: ACLED_AUTH_STATE_KEY },
    });
    await this.invalidateAcledAuthStateCache();
  }

  private async invalidateCache() {
    try {
      await this.cache.del(CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to invalidate realtime signals settings cache",
      );
    }
  }

  private async invalidateAcledAuthStateCache() {
    try {
      await this.cache.del(ACLED_AUTH_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        { err: error },
        "Failed to invalidate ACLED auth state cache",
      );
    }
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toPrismaJson(value: unknown) {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
