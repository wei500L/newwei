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
export type SituationMonitorTelegramSecretSource = SituationMonitorApiKeySource;
export type SituationMonitorLiveHlsProxyChannel = "cnn" | "cnbc";
export type SituationMonitorLiveHlsProxySource = "stored" | "none";

export interface SituationMonitorLiveHlsProxyRuntimeConfig {
  channel: SituationMonitorLiveHlsProxyChannel;
  configured: boolean;
  upstreamUrl: string | null;
  referer: string | null;
  allowedHosts: string[];
}

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
  telegramEnabled: boolean;
  hasTelegramApiId: boolean;
  telegramApiIdSource: SituationMonitorTelegramSecretSource;
  telegramApiId?: string;
  hasTelegramApiHash: boolean;
  telegramApiHashSource: SituationMonitorTelegramSecretSource;
  hasTelegramSession: boolean;
  telegramSessionSource: SituationMonitorTelegramSecretSource;
  telegramChannelSet: string;
  telegramMaxFeedItems: number;
  telegramMaxTextChars: number;
  telegramChannelTimeoutMs: number;
  telegramPollCycleTimeoutMs: number;
  telegramStartupDelayMs: number;
  telegramRateLimitMs: number;
  telegramPollIntervalMs: number;
  liveHlsProxyCnnConfigured: boolean;
  liveHlsProxyCnnSource: SituationMonitorLiveHlsProxySource;
  liveHlsProxyCnnUpstreamUrl: string;
  liveHlsProxyCnnReferer: string;
  liveHlsProxyCnnAllowedHosts: string[];
  liveHlsProxyCnbcConfigured: boolean;
  liveHlsProxyCnbcSource: SituationMonitorLiveHlsProxySource;
  liveHlsProxyCnbcUpstreamUrl: string;
  liveHlsProxyCnbcReferer: string;
  liveHlsProxyCnbcAllowedHosts: string[];
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

export interface SituationMonitorTelegramRuntimeConfig {
  enabled: boolean;
  apiId?: string;
  apiHash?: string;
  session?: string;
  channelSet: string;
  maxFeedItems: number;
  maxTextChars: number;
  channelTimeoutMs: number;
  pollCycleTimeoutMs: number;
  startupDelayMs: number;
  rateLimitMs: number;
  pollIntervalMs: number;
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
  telegramEnabled?: unknown;
  telegramApiId?: unknown;
  telegramApiHash?: unknown;
  telegramSession?: unknown;
  telegramChannelSet?: unknown;
  telegramMaxFeedItems?: unknown;
  telegramMaxTextChars?: unknown;
  telegramChannelTimeoutMs?: unknown;
  telegramPollCycleTimeoutMs?: unknown;
  telegramStartupDelayMs?: unknown;
  telegramRateLimitMs?: unknown;
  telegramPollIntervalMs?: unknown;
  liveHlsProxyCnnUpstreamUrl?: unknown;
  liveHlsProxyCnnReferer?: unknown;
  liveHlsProxyCnnAllowedHosts?: unknown;
  liveHlsProxyCnbcUpstreamUrl?: unknown;
  liveHlsProxyCnbcReferer?: unknown;
  liveHlsProxyCnbcAllowedHosts?: unknown;
}

interface CachedSituationMonitorSettings {
  exists: boolean;
  value?: StoredSituationMonitorSettings;
}

interface EffectiveSituationMonitorSettings {
  translationMaxConcurrency: number;
  translationApiEnabled: boolean;
  translationApiBaseUrl: string;
  translationApiKey?: string;
  translationFallbackApiEnabled: boolean;
  translationFallbackApiBaseUrl: string;
  finnhubApiKey?: string;
  fredApiKey?: string;
  translationApiTimeoutMs: number;
  translationApiMaxRetries: number;
  telegramEnabled: boolean;
  telegramApiId?: string;
  telegramApiHash?: string;
  telegramSession?: string;
  telegramChannelSet: string;
  telegramMaxFeedItems: number;
  telegramMaxTextChars: number;
  telegramChannelTimeoutMs: number;
  telegramPollCycleTimeoutMs: number;
  telegramStartupDelayMs: number;
  telegramRateLimitMs: number;
  telegramPollIntervalMs: number;
  liveHlsProxyCnnUpstreamUrl: string | null;
  liveHlsProxyCnnReferer: string | null;
  liveHlsProxyCnnAllowedHosts: string[];
  liveHlsProxyCnbcUpstreamUrl: string | null;
  liveHlsProxyCnbcReferer: string | null;
  liveHlsProxyCnbcAllowedHosts: string[];
}

const SETTINGS_KEY = "situation_monitor_settings";
const SETTINGS_DESCRIPTION =
  "Situation monitor settings (DeepLX translation + fallback endpoint + Finnhub/FRED API keys + Telegram ingestion config + live HLS proxy config).";
const CACHE_KEY = "situation_monitor:settings";
const CACHE_TTL_SECONDS = 30;
const DEFAULT_TRANSLATION_MAX_CONCURRENCY = 2;
const MAX_TRANSLATION_MAX_CONCURRENCY = 5_000;
const DEFAULT_TRANSLATION_API_TIMEOUT_MS = 15_000;
const DEFAULT_TRANSLATION_API_MAX_RETRIES = 2;
const DEFAULT_TRANSLATION_API_BASE_URL = "https://api.deeplx.org";
const DEFAULT_TRANSLATION_FALLBACK_API_ENABLED = false;
const DEFAULT_TRANSLATION_PROVIDER: SituationMonitorTranslationProvider = "deeplx";
const DEFAULT_TELEGRAM_CHANNEL_SET = "full";
const DEFAULT_TELEGRAM_MAX_FEED_ITEMS = 200;
const DEFAULT_TELEGRAM_MAX_TEXT_CHARS = 800;
const DEFAULT_TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000;
const DEFAULT_TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000;
const DEFAULT_TELEGRAM_STARTUP_DELAY_MS = 60_000;
const DEFAULT_TELEGRAM_RATE_LIMIT_MS = 800;
const DEFAULT_TELEGRAM_POLL_INTERVAL_MS = 60_000;
const LIVE_HLS_PROXY_CHANNELS: readonly SituationMonitorLiveHlsProxyChannel[] = [
  "cnn",
  "cnbc",
];

export function isSituationMonitorLiveHlsProxyChannel(
  value: string,
): value is SituationMonitorLiveHlsProxyChannel {
  return LIVE_HLS_PROXY_CHANNELS.includes(value as SituationMonitorLiveHlsProxyChannel);
}

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
    const storedTelegramApiId = this.normalizeString(stored?.telegramApiId);
    const storedTelegramApiHash = this.resolveStoredApiKey(stored?.telegramApiHash, "telegram api hash");
    const storedTelegramSession = this.resolveStoredApiKey(stored?.telegramSession, "telegram session");

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
      fredApiKeySource: this.resolveApiKeySource(storedFredApiKey, effective.fredApiKey),
      telegramEnabled: effective.telegramEnabled,
      hasTelegramApiId: Boolean(effective.telegramApiId),
      telegramApiIdSource: this.resolveApiKeySource(storedTelegramApiId, effective.telegramApiId),
      telegramApiId: effective.telegramApiId,
      hasTelegramApiHash: Boolean(effective.telegramApiHash),
      telegramApiHashSource: this.resolveApiKeySource(storedTelegramApiHash, effective.telegramApiHash),
      hasTelegramSession: Boolean(effective.telegramSession),
      telegramSessionSource: this.resolveApiKeySource(storedTelegramSession, effective.telegramSession),
      telegramChannelSet: effective.telegramChannelSet,
      telegramMaxFeedItems: effective.telegramMaxFeedItems,
      telegramMaxTextChars: effective.telegramMaxTextChars,
      telegramChannelTimeoutMs: effective.telegramChannelTimeoutMs,
      telegramPollCycleTimeoutMs: effective.telegramPollCycleTimeoutMs,
      telegramStartupDelayMs: effective.telegramStartupDelayMs,
      telegramRateLimitMs: effective.telegramRateLimitMs,
      telegramPollIntervalMs: effective.telegramPollIntervalMs,
      liveHlsProxyCnnConfigured: Boolean(effective.liveHlsProxyCnnUpstreamUrl),
      liveHlsProxyCnnSource: effective.liveHlsProxyCnnUpstreamUrl ? "stored" : "none",
      liveHlsProxyCnnUpstreamUrl: effective.liveHlsProxyCnnUpstreamUrl ?? "",
      liveHlsProxyCnnReferer: effective.liveHlsProxyCnnReferer ?? "",
      liveHlsProxyCnnAllowedHosts: [...effective.liveHlsProxyCnnAllowedHosts],
      liveHlsProxyCnbcConfigured: Boolean(effective.liveHlsProxyCnbcUpstreamUrl),
      liveHlsProxyCnbcSource: effective.liveHlsProxyCnbcUpstreamUrl ? "stored" : "none",
      liveHlsProxyCnbcUpstreamUrl: effective.liveHlsProxyCnbcUpstreamUrl ?? "",
      liveHlsProxyCnbcReferer: effective.liveHlsProxyCnbcReferer ?? "",
      liveHlsProxyCnbcAllowedHosts: [...effective.liveHlsProxyCnbcAllowedHosts],
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

  async getTelegramRuntimeConfig(): Promise<SituationMonitorTelegramRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);
    return {
      enabled: effective.telegramEnabled,
      apiId: effective.telegramApiId,
      apiHash: effective.telegramApiHash,
      session: effective.telegramSession,
      channelSet: effective.telegramChannelSet,
      maxFeedItems: effective.telegramMaxFeedItems,
      maxTextChars: effective.telegramMaxTextChars,
      channelTimeoutMs: effective.telegramChannelTimeoutMs,
      pollCycleTimeoutMs: effective.telegramPollCycleTimeoutMs,
      startupDelayMs: effective.telegramStartupDelayMs,
      rateLimitMs: effective.telegramRateLimitMs,
      pollIntervalMs: effective.telegramPollIntervalMs
    };
  }

  async getLiveHlsProxyRuntimeConfig(
    channel: SituationMonitorLiveHlsProxyChannel,
  ): Promise<SituationMonitorLiveHlsProxyRuntimeConfig> {
    const stored = await this.loadStoredSettings();
    const effective = this.resolveEffectiveConfig(stored);

    const upstreamUrl =
      channel === "cnn"
        ? effective.liveHlsProxyCnnUpstreamUrl
        : effective.liveHlsProxyCnbcUpstreamUrl;
    const referer =
      channel === "cnn"
        ? effective.liveHlsProxyCnnReferer
        : effective.liveHlsProxyCnbcReferer;
    const configuredAllowedHosts =
      channel === "cnn"
        ? effective.liveHlsProxyCnnAllowedHosts
        : effective.liveHlsProxyCnbcAllowedHosts;

    if (!upstreamUrl) {
      return {
        channel,
        configured: false,
        upstreamUrl: null,
        referer: null,
        allowedHosts: [],
      };
    }

    const allowedHosts = new Set(configuredAllowedHosts);
    try {
      allowedHosts.add(new URL(upstreamUrl).hostname.toLowerCase());
    } catch {
      // ignore invalid URL: configured=false is already handled during update validation.
    }

    return {
      channel,
      configured: true,
      upstreamUrl,
      referer,
      allowedHosts: [...allowedHosts],
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
      telegramEnabled?: boolean;
      telegramApiId?: string | null;
      telegramApiHash?: string | null;
      telegramSession?: string | null;
      telegramChannelSet?: string | null;
      telegramMaxFeedItems?: number;
      telegramMaxTextChars?: number;
      telegramChannelTimeoutMs?: number;
      telegramPollCycleTimeoutMs?: number;
      telegramStartupDelayMs?: number;
      telegramRateLimitMs?: number;
      telegramPollIntervalMs?: number;
      liveHlsProxyCnnUpstreamUrl?: string | null;
      liveHlsProxyCnnReferer?: string | null;
      liveHlsProxyCnnAllowedHosts?: string | null;
      liveHlsProxyCnbcUpstreamUrl?: string | null;
      liveHlsProxyCnbcReferer?: string | null;
      liveHlsProxyCnbcAllowedHosts?: string | null;
    }
  ): Promise<SituationMonitorSettingsPublic> {
    const stored = await this.loadStoredSettings();
    const current = this.resolveEffectiveConfig(stored);

    const nextTranslationMaxConcurrency = this.asBoundedInt(
      input.translationMaxConcurrency,
      current.translationMaxConcurrency,
      1,
      MAX_TRANSLATION_MAX_CONCURRENCY
    );
    const nextTranslationApiEnabled = this.asBoolean(input.translationApiEnabled, current.translationApiEnabled);
    const nextTranslationApiTimeoutMs = this.asBoundedInt(
      input.translationApiTimeoutMs,
      current.translationApiTimeoutMs,
      1_000,
      120_000
    );
    const nextTranslationApiMaxRetries = this.asBoundedInt(
      input.translationApiMaxRetries,
      current.translationApiMaxRetries,
      0,
      5
    );
    const nextTranslationApiBaseUrl = this.resolveNextApiBaseUrl(stored, input.translationApiBaseUrl);
    const nextTranslationFallbackApiEnabled = this.asBoolean(
      input.translationFallbackApiEnabled,
      current.translationFallbackApiEnabled
    );
    const nextTranslationFallbackApiBaseUrl = this.resolveNextFallbackApiBaseUrl(
      stored,
      input.translationFallbackApiBaseUrl
    );
    const nextTranslationApiKey = await this.resolveNextApiKey(stored?.translationApiKey, input.translationApiKey);
    const nextFinnhubApiKey = await this.resolveNextApiKey(stored?.finnhubApiKey, input.finnhubApiKey);
    const nextFredApiKey = await this.resolveNextApiKey(stored?.fredApiKey, input.fredApiKey);

    const nextTelegramEnabled = this.asBoolean(input.telegramEnabled, current.telegramEnabled);
    const nextTelegramApiId = this.resolveNextString(stored?.telegramApiId, input.telegramApiId);
    const nextTelegramApiHash = await this.resolveNextApiKey(stored?.telegramApiHash, input.telegramApiHash);
    const nextTelegramSession = await this.resolveNextApiKey(stored?.telegramSession, input.telegramSession);
    const nextTelegramChannelSet = this.asString(
      input.telegramChannelSet,
      current.telegramChannelSet,
      DEFAULT_TELEGRAM_CHANNEL_SET
    );
    const nextTelegramMaxFeedItems = this.asBoundedInt(
      input.telegramMaxFeedItems,
      current.telegramMaxFeedItems,
      50,
      500
    );
    const nextTelegramMaxTextChars = this.asBoundedInt(
      input.telegramMaxTextChars,
      current.telegramMaxTextChars,
      200,
      10_000
    );
    const nextTelegramChannelTimeoutMs = this.asBoundedInt(
      input.telegramChannelTimeoutMs,
      current.telegramChannelTimeoutMs,
      3_000,
      120_000
    );
    const nextTelegramPollCycleTimeoutMs = this.asBoundedInt(
      input.telegramPollCycleTimeoutMs,
      current.telegramPollCycleTimeoutMs,
      30_000,
      600_000
    );
    const nextTelegramStartupDelayMs = this.asBoundedInt(
      input.telegramStartupDelayMs,
      current.telegramStartupDelayMs,
      0,
      600_000
    );
    const nextTelegramRateLimitMs = this.asBoundedInt(
      input.telegramRateLimitMs,
      current.telegramRateLimitMs,
      100,
      60_000
    );
    const nextTelegramPollIntervalMs = this.asBoundedInt(
      input.telegramPollIntervalMs,
      current.telegramPollIntervalMs,
      15_000,
      3_600_000
    );
    const nextLiveHlsProxyCnnUpstreamUrl = this.resolveNextHttpsUrl(
      stored?.liveHlsProxyCnnUpstreamUrl,
      input.liveHlsProxyCnnUpstreamUrl,
      "liveHlsProxyCnnUpstreamUrl",
    );
    const nextLiveHlsProxyCnnReferer = this.resolveNextHttpUrl(
      stored?.liveHlsProxyCnnReferer,
      input.liveHlsProxyCnnReferer,
      "liveHlsProxyCnnReferer",
    );
    const nextLiveHlsProxyCnnAllowedHosts = this.resolveNextHostList(
      stored?.liveHlsProxyCnnAllowedHosts,
      input.liveHlsProxyCnnAllowedHosts,
      "liveHlsProxyCnnAllowedHosts",
    );
    const nextLiveHlsProxyCnbcUpstreamUrl = this.resolveNextHttpsUrl(
      stored?.liveHlsProxyCnbcUpstreamUrl,
      input.liveHlsProxyCnbcUpstreamUrl,
      "liveHlsProxyCnbcUpstreamUrl",
    );
    const nextLiveHlsProxyCnbcReferer = this.resolveNextHttpUrl(
      stored?.liveHlsProxyCnbcReferer,
      input.liveHlsProxyCnbcReferer,
      "liveHlsProxyCnbcReferer",
    );
    const nextLiveHlsProxyCnbcAllowedHosts = this.resolveNextHostList(
      stored?.liveHlsProxyCnbcAllowedHosts,
      input.liveHlsProxyCnbcAllowedHosts,
      "liveHlsProxyCnbcAllowedHosts",
    );

    const nextStored: StoredSituationMonitorSettings = {
      translationMaxConcurrency: nextTranslationMaxConcurrency,
      translationApiEnabled: nextTranslationApiEnabled,
      translationApiBaseUrl: nextTranslationApiBaseUrl,
      translationApiKey: nextTranslationApiKey,
      translationFallbackApiEnabled: nextTranslationFallbackApiEnabled,
      translationFallbackApiBaseUrl: nextTranslationFallbackApiBaseUrl,
      finnhubApiKey: nextFinnhubApiKey,
      fredApiKey: nextFredApiKey,
      translationApiTimeoutMs: nextTranslationApiTimeoutMs,
      translationApiMaxRetries: nextTranslationApiMaxRetries,
      telegramEnabled: nextTelegramEnabled,
      telegramApiId: nextTelegramApiId,
      telegramApiHash: nextTelegramApiHash,
      telegramSession: nextTelegramSession,
      telegramChannelSet: nextTelegramChannelSet,
      telegramMaxFeedItems: nextTelegramMaxFeedItems,
      telegramMaxTextChars: nextTelegramMaxTextChars,
      telegramChannelTimeoutMs: nextTelegramChannelTimeoutMs,
      telegramPollCycleTimeoutMs: nextTelegramPollCycleTimeoutMs,
      telegramStartupDelayMs: nextTelegramStartupDelayMs,
      telegramRateLimitMs: nextTelegramRateLimitMs,
      telegramPollIntervalMs: nextTelegramPollIntervalMs,
      liveHlsProxyCnnUpstreamUrl: nextLiveHlsProxyCnnUpstreamUrl,
      liveHlsProxyCnnReferer: nextLiveHlsProxyCnnReferer,
      liveHlsProxyCnnAllowedHosts: nextLiveHlsProxyCnnAllowedHosts,
      liveHlsProxyCnbcUpstreamUrl: nextLiveHlsProxyCnbcUpstreamUrl,
      liveHlsProxyCnbcReferer: nextLiveHlsProxyCnbcReferer,
      liveHlsProxyCnbcAllowedHosts: nextLiveHlsProxyCnbcAllowedHosts,
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
            translationMaxConcurrency: nextTranslationMaxConcurrency,
            translationApiEnabled: nextTranslationApiEnabled,
            translationApiBaseUrl: nextTranslationApiBaseUrl,
            translationFallbackApiEnabled: nextTranslationFallbackApiEnabled,
            translationFallbackApiBaseUrl: nextTranslationFallbackApiBaseUrl,
            translationApiTimeoutMs: nextTranslationApiTimeoutMs,
            translationApiMaxRetries: nextTranslationApiMaxRetries,
            translationApiKeyUpdated: input.translationApiKey !== undefined,
            finnhubApiKeyUpdated: input.finnhubApiKey !== undefined,
            fredApiKeyUpdated: input.fredApiKey !== undefined,
            telegramEnabled: nextTelegramEnabled,
            telegramChannelSet: nextTelegramChannelSet,
            telegramMaxFeedItems: nextTelegramMaxFeedItems,
            telegramMaxTextChars: nextTelegramMaxTextChars,
            telegramChannelTimeoutMs: nextTelegramChannelTimeoutMs,
            telegramPollCycleTimeoutMs: nextTelegramPollCycleTimeoutMs,
            telegramStartupDelayMs: nextTelegramStartupDelayMs,
            telegramRateLimitMs: nextTelegramRateLimitMs,
            telegramPollIntervalMs: nextTelegramPollIntervalMs,
            telegramApiIdUpdated: input.telegramApiId !== undefined,
            telegramApiHashUpdated: input.telegramApiHash !== undefined,
            telegramSessionUpdated: input.telegramSession !== undefined,
            liveHlsProxyCnnConfigured: Boolean(nextLiveHlsProxyCnnUpstreamUrl),
            liveHlsProxyCnnAllowedHostsCount: nextLiveHlsProxyCnnAllowedHosts.length,
            liveHlsProxyCnbcConfigured: Boolean(nextLiveHlsProxyCnbcUpstreamUrl),
            liveHlsProxyCnbcAllowedHostsCount: nextLiveHlsProxyCnbcAllowedHosts.length,
            liveHlsProxyCnnUpdated:
              input.liveHlsProxyCnnUpstreamUrl !== undefined ||
              input.liveHlsProxyCnnReferer !== undefined ||
              input.liveHlsProxyCnnAllowedHosts !== undefined,
            liveHlsProxyCnbcUpdated:
              input.liveHlsProxyCnbcUpstreamUrl !== undefined ||
              input.liveHlsProxyCnbcReferer !== undefined ||
              input.liveHlsProxyCnbcAllowedHosts !== undefined,
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

  private resolveEffectiveConfig(stored: StoredSituationMonitorSettings | null): EffectiveSituationMonitorSettings {
    const envTranslation = this.env.situationMonitorTranslationConfig;
    const envTelegram = this.resolveTelegramEnvDefaults();

    const storedTranslationApiKey = this.resolveStoredApiKey(stored?.translationApiKey, "translation api key");
    const storedFinnhubApiKey = this.resolveStoredApiKey(stored?.finnhubApiKey, "finnhub api key");
    const storedFredApiKey = this.resolveStoredApiKey(stored?.fredApiKey, "fred api key");
    const storedTelegramApiId = this.normalizeString(stored?.telegramApiId);
    const storedTelegramApiHash = this.resolveStoredApiKey(stored?.telegramApiHash, "telegram api hash");
    const storedTelegramSession = this.resolveStoredApiKey(stored?.telegramSession, "telegram session");

    return {
      translationMaxConcurrency: this.asBoundedInt(
        stored?.translationMaxConcurrency,
        DEFAULT_TRANSLATION_MAX_CONCURRENCY,
        1,
        MAX_TRANSLATION_MAX_CONCURRENCY
      ),
      translationApiEnabled: this.asBoolean(stored?.translationApiEnabled, envTranslation.enabled),
      translationApiBaseUrl:
        this.normalizeUrl(stored?.translationApiBaseUrl) ??
        this.normalizeUrl(envTranslation.baseUrl) ??
        DEFAULT_TRANSLATION_API_BASE_URL,
      translationFallbackApiEnabled: this.asBoolean(
        stored?.translationFallbackApiEnabled,
        this.asBoolean(envTranslation.fallbackEnabled, DEFAULT_TRANSLATION_FALLBACK_API_ENABLED)
      ),
      translationFallbackApiBaseUrl:
        this.normalizeUrl(stored?.translationFallbackApiBaseUrl) ??
        this.normalizeUrl(envTranslation.fallbackBaseUrl) ??
        "",
      translationApiTimeoutMs: this.asBoundedInt(
        stored?.translationApiTimeoutMs,
        this.asBoundedInt(envTranslation.timeoutMs, DEFAULT_TRANSLATION_API_TIMEOUT_MS, 1_000, 120_000),
        1_000,
        120_000
      ),
      translationApiMaxRetries: this.asBoundedInt(
        stored?.translationApiMaxRetries,
        this.asBoundedInt(envTranslation.maxRetries, DEFAULT_TRANSLATION_API_MAX_RETRIES, 0, 5),
        0,
        5
      ),
      translationApiKey: storedTranslationApiKey,
      finnhubApiKey: storedFinnhubApiKey,
      fredApiKey: storedFredApiKey,
      telegramEnabled: this.asBoolean(stored?.telegramEnabled, envTelegram.enabled),
      telegramApiId: storedTelegramApiId ?? envTelegram.apiId,
      telegramApiHash: storedTelegramApiHash ?? envTelegram.apiHash,
      telegramSession: storedTelegramSession ?? envTelegram.session,
      telegramChannelSet:
        this.normalizeString(stored?.telegramChannelSet) ?? envTelegram.channelSet,
      telegramMaxFeedItems: this.asBoundedInt(
        stored?.telegramMaxFeedItems,
        envTelegram.maxFeedItems,
        50,
        500
      ),
      telegramMaxTextChars: this.asBoundedInt(
        stored?.telegramMaxTextChars,
        envTelegram.maxTextChars,
        200,
        10_000
      ),
      telegramChannelTimeoutMs: this.asBoundedInt(
        stored?.telegramChannelTimeoutMs,
        envTelegram.channelTimeoutMs,
        3_000,
        120_000
      ),
      telegramPollCycleTimeoutMs: this.asBoundedInt(
        stored?.telegramPollCycleTimeoutMs,
        envTelegram.pollCycleTimeoutMs,
        30_000,
        600_000
      ),
      telegramStartupDelayMs: this.asBoundedInt(
        stored?.telegramStartupDelayMs,
        envTelegram.startupDelayMs,
        0,
        600_000
      ),
      telegramRateLimitMs: this.asBoundedInt(
        stored?.telegramRateLimitMs,
        envTelegram.rateLimitMs,
        100,
        60_000
      ),
      telegramPollIntervalMs: this.asBoundedInt(
        stored?.telegramPollIntervalMs,
        envTelegram.pollIntervalMs,
        15_000,
        3_600_000
      ),
      liveHlsProxyCnnUpstreamUrl: this.normalizeHttpsUrl(stored?.liveHlsProxyCnnUpstreamUrl),
      liveHlsProxyCnnReferer: this.normalizeHttpUrl(stored?.liveHlsProxyCnnReferer),
      liveHlsProxyCnnAllowedHosts: this.normalizeHostList(stored?.liveHlsProxyCnnAllowedHosts),
      liveHlsProxyCnbcUpstreamUrl: this.normalizeHttpsUrl(stored?.liveHlsProxyCnbcUpstreamUrl),
      liveHlsProxyCnbcReferer: this.normalizeHttpUrl(stored?.liveHlsProxyCnbcReferer),
      liveHlsProxyCnbcAllowedHosts: this.normalizeHostList(stored?.liveHlsProxyCnbcAllowedHosts),
    };
  }

  private resolveTelegramEnvDefaults() {
    return {
      enabled: this.readBooleanEnv("SITUATION_MONITOR_TELEGRAM_ENABLED", "TELEGRAM_ENABLED") ?? false,
      apiId: this.readStringEnv("SITUATION_MONITOR_TELEGRAM_API_ID", "TELEGRAM_API_ID"),
      apiHash: this.readStringEnv("SITUATION_MONITOR_TELEGRAM_API_HASH", "TELEGRAM_API_HASH"),
      session: this.readStringEnv("SITUATION_MONITOR_TELEGRAM_SESSION", "TELEGRAM_SESSION"),
      channelSet:
        this.readStringEnv("SITUATION_MONITOR_TELEGRAM_CHANNEL_SET", "TELEGRAM_CHANNEL_SET") ??
        DEFAULT_TELEGRAM_CHANNEL_SET,
      maxFeedItems: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS", "TELEGRAM_MAX_FEED_ITEMS"],
        DEFAULT_TELEGRAM_MAX_FEED_ITEMS,
        50,
        500
      ),
      maxTextChars: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS", "TELEGRAM_MAX_TEXT_CHARS"],
        DEFAULT_TELEGRAM_MAX_TEXT_CHARS,
        200,
        10_000
      ),
      channelTimeoutMs: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS", "TELEGRAM_CHANNEL_TIMEOUT_MS"],
        DEFAULT_TELEGRAM_CHANNEL_TIMEOUT_MS,
        3_000,
        120_000
      ),
      pollCycleTimeoutMs: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS", "TELEGRAM_POLL_CYCLE_TIMEOUT_MS"],
        DEFAULT_TELEGRAM_POLL_CYCLE_TIMEOUT_MS,
        30_000,
        600_000
      ),
      startupDelayMs: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS", "TELEGRAM_STARTUP_DELAY_MS"],
        DEFAULT_TELEGRAM_STARTUP_DELAY_MS,
        0,
        600_000
      ),
      rateLimitMs: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS", "TELEGRAM_RATE_LIMIT_MS"],
        DEFAULT_TELEGRAM_RATE_LIMIT_MS,
        100,
        60_000
      ),
      pollIntervalMs: this.readNumberEnv(
        ["SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS", "TELEGRAM_POLL_INTERVAL_MS"],
        DEFAULT_TELEGRAM_POLL_INTERVAL_MS,
        15_000,
        3_600_000
      )
    };
  }

  private readStringEnv(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.env.get<string | undefined>(key, { infer: true }) ?? process.env[key];
      const normalized = this.normalizeString(value);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }

  private readBooleanEnv(...keys: string[]): boolean | undefined {
    for (const key of keys) {
      const raw = this.env.get<boolean | string | undefined>(key, { infer: true }) ?? process.env[key];
      if (typeof raw === "boolean") {
        return raw;
      }
      if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (["true", "1", "yes", "y", "on"].includes(normalized)) {
          return true;
        }
        if (["false", "0", "no", "n", "off"].includes(normalized)) {
          return false;
        }
      }
    }
    return undefined;
  }

  private readNumberEnv(keys: string[], fallback: number, min: number, max: number): number {
    for (const key of keys) {
      const raw = this.env.get<number | string | undefined>(key, { infer: true }) ?? process.env[key];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        continue;
      }
      const normalized = Math.trunc(parsed);
      return Math.max(min, Math.min(max, normalized));
    }
    return Math.max(min, Math.min(max, Math.trunc(fallback)));
  }

  private asString(value: unknown, fallback: string, defaultValue: string): string {
    if (typeof value === "string") {
      const normalized = value.trim();
      return normalized.length > 0 ? normalized : defaultValue;
    }
    return fallback;
  }

  private resolveNextString(current: unknown, next: string | null | undefined): string | null {
    if (next === undefined) {
      const currentValue = this.normalizeString(current);
      return currentValue ?? null;
    }
    const normalized = this.normalizeString(next);
    return normalized ?? null;
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

  private resolveNextHttpsUrl(
    current: unknown,
    next: string | null | undefined,
    fieldName: string,
  ): string | null {
    if (next === undefined) {
      return this.normalizeHttpsUrl(current);
    }
    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.validateUrl(normalized, fieldName, ["https:"]);
  }

  private resolveNextHttpUrl(
    current: unknown,
    next: string | null | undefined,
    fieldName: string,
  ): string | null {
    if (next === undefined) {
      return this.normalizeHttpUrl(current);
    }
    const normalized = this.normalizeString(next);
    if (!normalized) {
      return null;
    }
    return this.validateUrl(normalized, fieldName, ["http:", "https:"]);
  }

  private resolveNextHostList(
    current: unknown,
    next: string | null | undefined,
    fieldName: string,
  ): string[] {
    if (next === undefined) {
      return this.normalizeHostList(current);
    }
    const normalized = this.normalizeString(next);
    if (!normalized) {
      return [];
    }
    return this.parseHostCsv(normalized, fieldName);
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

  private validateUrl(
    value: string,
    fieldName: string,
    allowedProtocols: readonly string[] = ["http:", "https:"],
  ): string {
    try {
      const parsed = new URL(value);
      if (!allowedProtocols.includes(parsed.protocol)) {
        throw new Error("Invalid protocol");
      }
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      const protocolHint =
        allowedProtocols.length === 1 && allowedProtocols[0] === "https:"
          ? "https URL"
          : "http(s) URL";
      throw new BadRequestException(`${fieldName} must be a valid ${protocolHint}`);
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

  private normalizeHttpsUrl(value: unknown): string | null {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return null;
    }
    try {
      return this.validateUrl(normalized, "url", ["https:"]);
    } catch {
      return null;
    }
  }

  private normalizeHttpUrl(value: unknown): string | null {
    const normalized = this.normalizeString(value);
    if (!normalized) {
      return null;
    }
    try {
      return this.validateUrl(normalized, "url", ["http:", "https:"]);
    } catch {
      return null;
    }
  }

  private normalizeHostList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    const normalized = value
      .map((entry) => this.normalizeHostEntry(entry))
      .filter((entry): entry is string => Boolean(entry));
    return [...new Set(normalized)];
  }

  private parseHostCsv(value: string, fieldName: string): string[] {
    const entries = value
      .split(/[\n,]/)
      .map((entry) => this.normalizeHostEntry(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (entries.length === 0) {
      return [];
    }

    const unique = [...new Set(entries)];
    if (unique.length > 64) {
      throw new BadRequestException(`${fieldName} must have at most 64 hosts`);
    }
    return unique;
  }

  private normalizeHostEntry(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(`https://${normalized}`);
      if (parsed.hostname !== normalized || parsed.pathname !== "/") {
        return null;
      }
      return parsed.hostname;
    } catch {
      return null;
    }
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
