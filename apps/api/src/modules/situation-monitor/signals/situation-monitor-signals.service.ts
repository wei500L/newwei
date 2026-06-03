import { createLogger } from "@modular/utils";
import {
  Injectable,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import {
  AlertMetricProvider,
  AlertOperator,
  AlertSeverity,
  AlertStatus,
  Prisma,
} from "@prisma/client";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  claimSchedulerTick,
  settleWithConcurrency,
} from "../../../common/multi-tenant-scheduler";
import { AlertsService } from "../../alerts/alerts.service";
import { CacheService } from "../../cache/cache.service";
import { EnvService } from "../../config/config.service";
import { PrismaService } from "../../config/prisma.service";
import { MultiTenantSchedulerSettingsService } from "../../system-settings/multi-tenant-scheduler-settings.service";
import {
  SituationMonitorSettingsService,
  type SituationMonitorTelegramRuntimeConfig,
} from "../../system-settings/situation-monitor-settings.service";
import {
  SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES,
  SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG,
  SITUATION_MONITOR_OREF_METRICS_CACHE_KEY,
} from "../signal-metrics.constants";

import {
  OREF_POLL_JOB_NAME,
  SITUATION_MONITOR_OREF_ALERTS_CACHE_KEY,
  SITUATION_MONITOR_OREF_HISTORY_CACHE_KEY,
  SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY,
  TELEGRAM_POLL_JOB_NAME,
} from "./situation-monitor-signals.constants";
import { SituationMonitorSignalsDispatcher } from "./situation-monitor-signals.dispatcher";
import type {
  SituationOrefAlertsResponse,
  SituationOrefHistoryResponse,
  SituationTelegramFeedResponse,
  OrefAlert,
  OrefHistoryEntry,
  TelegramChannelConfig,
  TelegramSignalItem,
} from "./situation-monitor-signals.types";
import telegramChannelsConfig from "./telegram-channels.json";

const logger = createLogger({ name: "situation-monitor-signals" });
const execFileAsync = promisify(execFile);

const TELEGRAM_CACHE_TTL_SECONDS = 24 * 60 * 60;
const OREF_ALERTS_CACHE_TTL_SECONDS = 60 * 60;
const OREF_HISTORY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const OREF_PERSIST_MAX_WAVES_DEFAULT = 200;
const OREF_DEFAULT_RULE_TICK_GATE_TTL_MS = 55_000;

interface TelegramState {
  client: unknown | null;
  channels: TelegramChannelConfig[];
  channelSet: string | null;
  cursorByHandle: Record<string, number>;
  items: TelegramSignalItem[];
  lastPollAt: number;
  lastError: string | null;
  permanentlyDisabled: boolean;
  credentialsFingerprint: string | null;
}

interface CachedTelegramState {
  channelSet?: string | null;
  cursorByHandle?: Record<string, number>;
  items?: TelegramSignalItem[];
  lastPollAt?: number;
  lastError?: string | null;
}

interface OrefState {
  lastAlerts: OrefAlert[];
  lastAlertsJson: string;
  lastPollAt: number;
  lastError: string | null;
  historyCount24h: number;
  totalHistoryCount: number;
  history: OrefHistoryEntry[];
  bootstrapSource: "cache" | "upstream" | null;
  persistVersion: number;
  lastPersistedVersion: number;
  persistInFlight: boolean;
}

interface OrefMetricsSnapshot {
  activeAlerts: number;
  historyCount24h: number;
  updatedAt: string;
}

@Injectable()
export class SituationMonitorSignalsService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private telegramState: TelegramState = {
    client: null,
    channels: [],
    channelSet: null,
    cursorByHandle: {},
    items: [],
    lastPollAt: 0,
    lastError: null,
    permanentlyDisabled: false,
    credentialsFingerprint: null,
  };

  private orefState: OrefState = {
    lastAlerts: [],
    lastAlertsJson: "[]",
    lastPollAt: 0,
    lastError: null,
    historyCount24h: 0,
    totalHistoryCount: 0,
    history: [],
    bootstrapSource: null,
    persistVersion: 0,
    lastPersistedVersion: 0,
    persistInFlight: false,
  };

  private telegramPollInFlight = false;
  private telegramPollStartedAt = 0;
  private serviceStartedAt = Date.now();
  private orefBootstrapped = false;
  private orefEnsureRulesAt = 0;
  private lastOrefAlertRuleCheckAt = 0;

  constructor(
    private readonly env: EnvService,
    private readonly cache: CacheService,
    private readonly dispatcher: SituationMonitorSignalsDispatcher,
    private readonly alerts: AlertsService,
    private readonly settings: SituationMonitorSettingsService,
    private readonly schedulerSettings: MultiTenantSchedulerSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    await this.restoreCachedState();
  }

  async onModuleDestroy() {
    await this.cleanupTelegramRuntime();
  }

  async onApplicationShutdown() {
    await this.cleanupTelegramRuntime();
  }

  async runJob(jobName: string): Promise<void> {
    if (jobName === TELEGRAM_POLL_JOB_NAME) {
      await this.guardedTelegramPoll();
      return;
    }

    if (jobName === OREF_POLL_JOB_NAME) {
      await this.pollOrefOnce();
    }
  }

  async getTelegramFeed(options?: {
    limit?: number;
    topic?: string;
    channel?: string;
  }): Promise<SituationTelegramFeedResponse> {
    await this.restoreCachedTelegramState();
    const runtime = await this.getTelegramRuntimeConfig();
    await this.syncTelegramStateWithRuntime(runtime.channelSet);

    const topic = options?.topic?.trim().toLowerCase();
    const channel = options?.channel?.trim().toLowerCase();
    const limitRaw = Number(options?.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 50;

    const configured = Boolean(
      runtime.apiId && runtime.apiHash && runtime.session,
    );
    const enabled = runtime.enabled;

    const filtered = this.telegramState.items
      .filter((item) => {
        if (topic && (item.topic || "").toLowerCase() !== topic) return false;
        if (channel && (item.channel || "").toLowerCase() !== channel)
          return false;
        return true;
      })
      .slice(0, limit);

    return {
      source: "telegram",
      scope: "global",
      earlySignal: true,
      configured,
      enabled,
      channelSet: this.telegramState.channelSet ?? runtime.channelSet,
      count: filtered.length,
      updatedAt: this.telegramState.lastPollAt
        ? new Date(this.telegramState.lastPollAt).toISOString()
        : null,
      items: filtered,
      ...(this.telegramState.lastError
        ? { error: this.telegramState.lastError }
        : {}),
    };
  }

  async getOrefAlerts(): Promise<SituationOrefAlertsResponse> {
    await this.restoreCachedOrefState();

    const configured = this.isOrefConfigured();
    return {
      scope: "global",
      configured,
      alerts: this.orefState.lastAlerts,
      historyCount24h: this.orefState.historyCount24h,
      totalHistoryCount: this.orefState.totalHistoryCount,
      timestamp: this.orefState.lastPollAt
        ? new Date(this.orefState.lastPollAt).toISOString()
        : new Date().toISOString(),
      ...(this.orefState.lastError ? { error: this.orefState.lastError } : {}),
    };
  }

  async getOrefHistory(): Promise<SituationOrefHistoryResponse> {
    await this.restoreCachedOrefState();

    const configured = this.isOrefConfigured();
    return {
      scope: "global",
      configured,
      history: this.orefState.history,
      historyCount24h: this.orefState.historyCount24h,
      totalHistoryCount: this.orefState.totalHistoryCount,
      timestamp: this.orefState.lastPollAt
        ? new Date(this.orefState.lastPollAt).toISOString()
        : new Date().toISOString(),
      ...(this.orefState.lastError ? { error: this.orefState.lastError } : {}),
    };
  }

  private async guardedTelegramPoll() {
    const runtime = await this.getTelegramRuntimeConfig();
    const cycleTimeoutMs = runtime.pollCycleTimeoutMs;
    if (this.telegramPollInFlight) {
      const stuckForMs = Date.now() - this.telegramPollStartedAt;
      if (stuckForMs <= cycleTimeoutMs + 30_000) {
        return;
      }
      logger.warn(
        { stuckForMs },
        "Force-clearing stuck Telegram poll in-flight flag",
      );
      this.telegramPollInFlight = false;
    }

    this.telegramPollInFlight = true;
    this.telegramPollStartedAt = Date.now();
    try {
      await this.pollTelegramOnce();
    } catch (error) {
      logger.warn({ error }, "Telegram poll failed");
    } finally {
      this.telegramPollInFlight = false;
    }
  }

  private async pollTelegramOnce() {
    const runtime = await this.getTelegramRuntimeConfig();
    await this.syncTelegramStateWithRuntime(runtime.channelSet);

    if (!runtime.enabled) {
      this.telegramState.lastError = "Telegram polling is disabled";
      return;
    }

    if (!runtime.apiId || !runtime.apiHash || !runtime.session) {
      this.telegramState.lastError = "Telegram credentials are not configured";
      return;
    }

    if (this.telegramState.permanentlyDisabled) {
      return;
    }

    const startupDelayMs = runtime.startupDelayMs;
    if (startupDelayMs > 0 && this.telegramState.lastPollAt === 0) {
      // Delay is measured from service startup, not from per-cycle poll timestamps.
      const sinceServiceStartMs = Date.now() - this.serviceStartedAt;
      if (sinceServiceStartMs < startupDelayMs) {
        return;
      }
    }

    const ok = await this.initTelegramClientIfNeeded(runtime);
    if (!ok) {
      return;
    }

    const channels =
      this.telegramState.channels.length > 0 &&
      this.telegramState.channelSet === runtime.channelSet
        ? this.telegramState.channels
        : this.loadTelegramChannels(runtime.channelSet);
    if (channels.length === 0) {
      this.telegramState.lastError = "No Telegram channels configured";
      return;
    }

    const client = this.telegramState.client as {
      getEntity: (input: string) => Promise<unknown>;
      getMessages: (
        entity: unknown,
        options: { limit: number; minId?: number },
      ) => Promise<Record<string, unknown>[]>;
    };

    const pollStartAt = Date.now();
    const maxFeedItems = runtime.maxFeedItems;
    const cycleTimeoutMs = runtime.pollCycleTimeoutMs;
    const perChannelTimeoutMs = runtime.channelTimeoutMs;
    const perChannelDelayMs = runtime.rateLimitMs;

    let channelsPolled = 0;
    let channelsFailed = 0;
    let mediaSkipped = 0;
    const newItems: TelegramSignalItem[] = [];

    for (const channel of channels) {
      if (Date.now() - pollStartAt > cycleTimeoutMs) {
        logger.warn(
          {
            channelsPolled,
            channelsTotal: channels.length,
            cycleTimeoutMs,
          },
          "Telegram poll cycle timeout reached",
        );
        break;
      }

      const handle = channel.handle.replace(/^@/, "").trim();
      if (!handle) {
        continue;
      }

      const minId = this.telegramState.cursorByHandle[handle] ?? 0;
      const limit = Math.max(
        1,
        Math.min(50, Math.floor(channel.maxMessages ?? 25)),
      );

      try {
        const entity = await this.withTimeout(
          client.getEntity(handle),
          perChannelTimeoutMs,
          `getEntity(${handle})`,
        );
        const messages = await this.withTimeout(
          client.getMessages(entity, { limit, minId }),
          perChannelTimeoutMs,
          `getMessages(${handle})`,
        );

        for (const message of messages) {
          const messageId = Number(message.id);
          if (!Number.isFinite(messageId) || messageId <= 0) {
            continue;
          }

          const text =
            typeof message.message === "string" ? message.message.trim() : "";
          if (!text) {
            mediaSkipped += 1;
            continue;
          }

          const item = this.normalizeTelegramMessage(
            message,
            channel,
            handle,
            runtime.maxTextChars,
          );
          newItems.push(item);

          const currentCursor = this.telegramState.cursorByHandle[handle] ?? 0;
          if (messageId > currentCursor) {
            this.telegramState.cursorByHandle[handle] = messageId;
          }
        }

        channelsPolled += 1;
        await this.delay(perChannelDelayMs);
      } catch (error) {
        channelsFailed += 1;
        const message = this.toErrorMessage(error);
        this.telegramState.lastError = `poll ${handle} failed: ${message}`;

        if (/AUTH_KEY_DUPLICATED/i.test(message)) {
          this.telegramState.permanentlyDisabled = true;
          this.telegramState.lastError =
            "Telegram session invalidated (AUTH_KEY_DUPLICATED). Generate a new session.";
          await this.disconnectTelegramClient();
          break;
        }

        if (/FLOOD_WAIT/i.test(message)) {
          logger.warn(
            { message },
            "Telegram FLOOD_WAIT detected, stopping cycle early",
          );
          break;
        }

        logger.warn({ error, handle }, "Telegram channel poll failed");
      }
    }

    if (newItems.length > 0) {
      const dedupe = new Set<string>();
      const merged = [...newItems, ...this.telegramState.items]
        .filter((item) => {
          if (dedupe.has(item.id)) {
            return false;
          }
          dedupe.add(item.id);
          return true;
        })
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, maxFeedItems);

      this.telegramState.items = merged;
    }

    this.telegramState.lastPollAt = Date.now();
    this.telegramState.lastError = null;
    await this.persistTelegramState();

    if (newItems.length > 0) {
      await this.dispatcher.publish("situation:telegram.update", {
        count: this.telegramState.items.length,
        updatedAt: new Date(this.telegramState.lastPollAt).toISOString(),
        items: newItems.slice(0, 30),
      });
    }

    logger.info(
      {
        channelsPolled,
        channelsTotal: channels.length,
        newItems: newItems.length,
        totalItems: this.telegramState.items.length,
        channelsFailed,
        mediaSkipped,
      },
      "Telegram poll finished",
    );
  }

  private async pollOrefOnce() {
    if (!this.isOrefEnabled()) {
      this.orefState.lastError = "OREF polling is disabled";
      return;
    }

    if (!this.isOrefConfigured()) {
      this.orefState.lastError = "OREF proxy credentials are not configured";
      return;
    }

    if (!this.orefBootstrapped) {
      const bootstrapSucceeded = await this.bootstrapOrefHistoryWithRetry();
      if (bootstrapSucceeded) {
        this.orefBootstrapped = true;
      }
    }

    try {
      const raw = await this.orefCurlFetch(this.getOrefAlertsUrl());
      const cleaned = this.stripBom(raw).trim();

      let alerts: OrefAlert[] = [];
      if (cleaned && cleaned !== "[]" && cleaned !== "null") {
        try {
          const parsed = JSON.parse(cleaned) as unknown;
          if (Array.isArray(parsed)) {
            alerts = parsed as OrefAlert[];
          } else if (parsed && typeof parsed === "object") {
            alerts = [parsed as OrefAlert];
          }
        } catch {
          alerts = [];
        }
      }

      const newJson = JSON.stringify(alerts);
      const changed = newJson !== this.orefState.lastAlertsJson;

      this.orefState.lastAlerts = alerts;
      this.orefState.lastAlertsJson = newJson;
      this.orefState.lastPollAt = Date.now();
      this.orefState.lastError = null;

      let historyEntry: OrefHistoryEntry | null = null;
      if (changed && alerts.length > 0) {
        historyEntry = {
          alerts,
          timestamp: new Date().toISOString(),
        };
        this.orefState.history.push(historyEntry);
        this.orefState.persistVersion += 1;
      }

      this.recomputeOrefHistoryCounts();

      await Promise.allSettled([
        this.persistOrefAlerts(),
        this.persistOrefHistory(),
      ]);

      await this.persistOrefMetrics();

      if (changed) {
        await this.dispatcher.publish("situation:oref.update", {
          alerts,
          historyCount24h: this.orefState.historyCount24h,
          totalHistoryCount: this.orefState.totalHistoryCount,
          updatedAt: new Date(this.orefState.lastPollAt).toISOString(),
          historyEntry,
        });
      }

      await this.triggerOrefAlertChecks();
    } catch (error) {
      this.orefState.lastError = this.redactOrefError(
        this.toErrorMessage(error),
      );
      logger.warn({ error }, "OREF poll failed");
    }
  }

  private async initTelegramClientIfNeeded(
    runtime: SituationMonitorTelegramRuntimeConfig,
  ): Promise<boolean> {
    const apiId = Number(runtime.apiId);
    const apiHash = runtime.apiHash;
    const session = runtime.session;
    if (!Number.isFinite(apiId) || !apiHash || !session) {
      this.telegramState.lastError = "Telegram credentials are incomplete";
      return false;
    }

    const credentialsFingerprint = this.computeTelegramCredentialsFingerprint(
      apiId,
      apiHash,
      session,
    );
    if (
      this.telegramState.client &&
      this.telegramState.credentialsFingerprint === credentialsFingerprint
    ) {
      return true;
    }

    if (
      this.telegramState.client &&
      this.telegramState.credentialsFingerprint !== credentialsFingerprint
    ) {
      await this.disconnectTelegramClient();
      this.telegramState.permanentlyDisabled = false;
    }

    try {
      const telegramModule = (await import("telegram")) as unknown as {
        TelegramClient: new (
          session: unknown,
          apiId: number,
          apiHash: string,
          options: { connectionRetries: number },
        ) => {
          connect: () => Promise<unknown>;
          disconnect: () => Promise<void>;
          getEntity: (input: string) => Promise<unknown>;
          getMessages: (
            entity: unknown,
            options: { limit: number; minId?: number },
          ) => Promise<Record<string, unknown>[]>;
        };
      };
      const sessionsModule = (await import("telegram/sessions")) as unknown as {
        StringSession: new (session: string) => unknown;
      };

      const client = new telegramModule.TelegramClient(
        new sessionsModule.StringSession(session),
        apiId,
        apiHash,
        { connectionRetries: 3 },
      );

      await client.connect();
      this.telegramState.client = client;
      this.telegramState.credentialsFingerprint = credentialsFingerprint;
      this.telegramState.lastError = null;
      return true;
    } catch (error) {
      const message = this.toErrorMessage(error);
      if (/ERR_MODULE_NOT_FOUND|Cannot find package/i.test(message)) {
        this.telegramState.permanentlyDisabled = true;
        this.telegramState.lastError = "telegram package is not installed";
        return false;
      }
      this.telegramState.lastError = `telegram init failed: ${message}`;
      logger.warn({ error }, "Telegram init failed");
      return false;
    }
  }

  private async disconnectTelegramClient() {
    const current = this.telegramState.client as {
      disconnect?: () => Promise<void>;
    } | null;
    if (!current) {
      return;
    }
    try {
      await current.disconnect?.();
    } catch {
      // best-effort
    }
    this.telegramState.client = null;
    this.telegramState.credentialsFingerprint = null;
  }

  private async cleanupTelegramRuntime() {
    await this.disconnectTelegramClient();
    this.telegramPollInFlight = false;
    this.telegramPollStartedAt = 0;
  }

  private loadTelegramChannels(setName: string): TelegramChannelConfig[] {
    const channelsRecord =
      telegramChannelsConfig && typeof telegramChannelsConfig === "object"
        ? (telegramChannelsConfig as { channels?: Record<string, unknown> })
            .channels
        : undefined;
    const bucket = channelsRecord ? channelsRecord[setName] : undefined;
    const channels = Array.isArray(bucket) ? bucket : [];

    this.telegramState.channels = channels
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const record = entry as Record<string, unknown>;
        const handle =
          typeof record.handle === "string"
            ? record.handle.replace(/^@/, "").trim()
            : "";
        if (!handle) {
          return null;
        }

        const channel: TelegramChannelConfig = {
          handle,
          label: typeof record.label === "string" ? record.label : undefined,
          topic: typeof record.topic === "string" ? record.topic : undefined,
          tier: Number.isFinite(Number(record.tier))
            ? Number(record.tier)
            : undefined,
          enabled: record.enabled !== false,
          region: typeof record.region === "string" ? record.region : undefined,
          maxMessages: Number.isFinite(Number(record.maxMessages))
            ? Number(record.maxMessages)
            : undefined,
        };

        return channel.enabled !== false ? channel : null;
      })
      .filter((entry): entry is TelegramChannelConfig => Boolean(entry));

    this.telegramState.channelSet = setName;
    return this.telegramState.channels;
  }

  private normalizeTelegramMessage(
    message: Record<string, unknown>,
    channel: TelegramChannelConfig,
    handle: string,
    maxTextChars: number,
  ): TelegramSignalItem {
    const textRaw = typeof message.message === "string" ? message.message : "";
    const text = textRaw.slice(0, maxTextChars);
    const messageId = Number(message.id);
    const messageDate = Number(message.date);

    const timestamp = Number.isFinite(messageDate)
      ? new Date(messageDate * 1000).toISOString()
      : new Date().toISOString();

    return {
      id: `${handle}:${messageId}`,
      source: "telegram",
      channel: handle,
      channelTitle: channel.label || handle,
      url: `https://t.me/${handle}/${messageId}`,
      ts: timestamp,
      text,
      topic: channel.topic || "other",
      tags: channel.region ? [channel.region] : [],
      earlySignal: true,
    };
  }

  private async bootstrapOrefHistoryWithRetry(): Promise<boolean> {
    const cached = await this.cache.get<SituationOrefHistoryResponse>(
      SITUATION_MONITOR_OREF_HISTORY_CACHE_KEY,
    );
    if (cached && Array.isArray(cached.history)) {
      this.orefState.history = cached.history;
      this.orefState.historyCount24h = cached.historyCount24h ?? 0;
      this.orefState.totalHistoryCount = cached.totalHistoryCount ?? 0;
      if (
        typeof cached.timestamp === "string" &&
        cached.timestamp.trim().length > 0
      ) {
        const ts = Date.parse(cached.timestamp);
        if (Number.isFinite(ts)) {
          this.orefState.lastPollAt = ts;
        }
      }
      this.orefState.bootstrapSource = "cache";
      return true;
    }

    const maxAttempts = this.getOrefBootstrapRetries();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.bootstrapOrefHistoryFromUpstream();
        this.orefState.bootstrapSource = "upstream";
        await this.persistOrefHistory();
        return true;
      } catch (error) {
        if (attempt >= maxAttempts) {
          logger.warn(
            { error },
            "OREF history bootstrap exhausted all retries",
          );
          return false;
        }
        const delayMs =
          3_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 800);
        await this.delay(delayMs);
      }
    }

    return false;
  }

  private async bootstrapOrefHistoryFromUpstream() {
    const tmpPath = join(tmpdir(), `oref-history-${Date.now()}.json`);
    let raw = "";
    try {
      raw = await this.orefCurlFetch(this.getOrefHistoryUrl(), {
        toFile: tmpPath,
      });
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }

    const cleaned = this.stripBom(raw).trim();
    if (!cleaned || cleaned === "[]" || cleaned === "null") {
      return;
    }

    const parsed = JSON.parse(cleaned) as Record<string, unknown>[];
    const records = Array.isArray(parsed) ? parsed.slice(0, 500) : [];

    const waves = new Map<string, OrefAlert[]>();
    let typeIndex = 0;

    for (const record of records) {
      if (!record || typeof record !== "object") {
        continue;
      }

      const alertDate =
        typeof record.alertDate === "string" ? record.alertDate : "";
      if (!alertDate) {
        continue;
      }

      if (!waves.has(alertDate)) {
        waves.set(alertDate, []);
      }

      const wave = waves.get(alertDate);
      if (!wave) {
        continue;
      }

      wave.push({
        id: `${String(record.category ?? "cat")}-${typeIndex}-${alertDate.replace(/[^0-9]/g, "")}`,
        cat: String(record.category ?? ""),
        title: String(record.title ?? record.category ?? ""),
        data: [String(record.data ?? "")].filter((entry) => entry.length > 0),
        desc: "",
        alertDate,
      });
      typeIndex += 1;
    }

    const history: OrefHistoryEntry[] = [];
    for (const [date, alerts] of waves.entries()) {
      history.push({
        alerts,
        timestamp: this.orefDateToUtc(date),
      });
    }

    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.orefState.history = history;
    this.recomputeOrefHistoryCounts();
    this.orefState.persistVersion += 1;
  }

  private recomputeOrefHistoryCounts() {
    const retentionDays = this.getOrefHistoryRetentionDays();
    const now = Date.now();
    const cutoff24h = now - 24 * 60 * 60 * 1000;
    const purgeCutoff = now - retentionDays * 24 * 60 * 60 * 1000;

    const before = this.orefState.history.length;
    this.orefState.history = this.orefState.history.filter((entry) => {
      const ts = new Date(entry.timestamp).getTime();
      return Number.isFinite(ts) && ts > purgeCutoff;
    });

    if (this.orefState.history.length !== before) {
      this.orefState.persistVersion += 1;
    }

    this.orefState.historyCount24h = this.orefState.history
      .filter((entry) => new Date(entry.timestamp).getTime() > cutoff24h)
      .reduce((sum, entry) => sum + this.countAlertAreas(entry.alerts), 0);

    this.orefState.totalHistoryCount = this.orefState.history.reduce(
      (sum, entry) => sum + this.countAlertAreas(entry.alerts),
      0,
    );
  }

  private countAlertAreas(alerts: OrefAlert[]): number {
    return alerts.reduce((sum, alert) => {
      const size =
        Array.isArray(alert.data) && alert.data.length > 0
          ? alert.data.length
          : 1;
      return sum + size;
    }, 0);
  }

  private async persistTelegramState() {
    const payload: CachedTelegramState = {
      channelSet: this.telegramState.channelSet,
      cursorByHandle: this.telegramState.cursorByHandle,
      items: this.telegramState.items,
      lastPollAt: this.telegramState.lastPollAt,
      lastError: this.telegramState.lastError,
    };
    await this.cache
      .set(
        SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY,
        payload,
        TELEGRAM_CACHE_TTL_SECONDS,
      )
      .catch((error) =>
        logger.debug({ error }, "Failed to persist Telegram state"),
      );
  }

  private async persistOrefAlerts() {
    const payload: SituationOrefAlertsResponse = {
      scope: "global",
      configured: this.isOrefConfigured(),
      alerts: this.orefState.lastAlerts,
      historyCount24h: this.orefState.historyCount24h,
      totalHistoryCount: this.orefState.totalHistoryCount,
      timestamp: this.orefState.lastPollAt
        ? new Date(this.orefState.lastPollAt).toISOString()
        : new Date().toISOString(),
      ...(this.orefState.lastError ? { error: this.orefState.lastError } : {}),
    };

    await this.cache
      .set(
        SITUATION_MONITOR_OREF_ALERTS_CACHE_KEY,
        payload,
        OREF_ALERTS_CACHE_TTL_SECONDS,
      )
      .catch((error) =>
        logger.debug({ error }, "Failed to persist OREF alerts"),
      );
  }

  private async persistOrefHistory() {
    if (this.orefState.persistVersion === this.orefState.lastPersistedVersion) {
      return;
    }
    if (this.orefState.persistInFlight) {
      return;
    }

    this.orefState.persistInFlight = true;
    const versionAtStart = this.orefState.persistVersion;

    try {
      const maxWaves = this.getOrefHistoryMaxWaves();
      const history =
        this.orefState.history.length > maxWaves
          ? this.orefState.history.slice(-maxWaves)
          : this.orefState.history;

      const payload: SituationOrefHistoryResponse = {
        scope: "global",
        configured: this.isOrefConfigured(),
        history,
        historyCount24h: this.orefState.historyCount24h,
        totalHistoryCount: this.orefState.totalHistoryCount,
        timestamp: this.orefState.lastPollAt
          ? new Date(this.orefState.lastPollAt).toISOString()
          : new Date().toISOString(),
      };

      await this.cache.set(
        SITUATION_MONITOR_OREF_HISTORY_CACHE_KEY,
        payload,
        OREF_HISTORY_CACHE_TTL_SECONDS,
      );
      this.orefState.lastPersistedVersion = versionAtStart;
    } catch (error) {
      logger.warn({ error }, "Failed to persist OREF history");
    } finally {
      this.orefState.persistInFlight = false;
    }
  }

  private async persistOrefMetrics() {
    const payload: OrefMetricsSnapshot = {
      activeAlerts: this.orefState.lastAlerts.length,
      historyCount24h: this.orefState.historyCount24h,
      updatedAt: this.orefState.lastPollAt
        ? new Date(this.orefState.lastPollAt).toISOString()
        : new Date().toISOString(),
    };

    await this.cache
      .set(
        SITUATION_MONITOR_OREF_METRICS_CACHE_KEY,
        payload,
        OREF_HISTORY_CACHE_TTL_SECONDS,
      )
      .catch((error) =>
        logger.debug({ error }, "Failed to persist OREF metric snapshot"),
      );
  }

  private async restoreCachedState() {
    await Promise.allSettled([
      this.restoreCachedTelegramState(),
      this.restoreCachedOrefState(),
    ]);
  }

  private async restoreCachedTelegramState() {
    if (this.telegramState.items.length > 0) {
      return;
    }

    try {
      const cached = await this.cache.get<CachedTelegramState>(
        SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY,
      );

      if (!cached || !Array.isArray(cached.items)) {
        return;
      }

      this.telegramState.channelSet =
        typeof cached.channelSet === "string" &&
        cached.channelSet.trim().length > 0
          ? cached.channelSet.trim()
          : null;
      this.telegramState.cursorByHandle =
        cached.cursorByHandle &&
        typeof cached.cursorByHandle === "object" &&
        !Array.isArray(cached.cursorByHandle)
          ? Object.fromEntries(
              Object.entries(cached.cursorByHandle).flatMap(
                ([handle, cursor]) => {
                  const normalizedHandle = handle.trim();
                  const normalizedCursor = Number(cursor);
                  return normalizedHandle.length > 0 &&
                    Number.isFinite(normalizedCursor) &&
                    normalizedCursor > 0
                    ? [[normalizedHandle, normalizedCursor] as const]
                    : [];
                },
              ),
            )
          : {};
      this.telegramState.items = cached.items;
      this.telegramState.lastPollAt = Number.isFinite(Number(cached.lastPollAt))
        ? Number(cached.lastPollAt)
        : 0;
      this.telegramState.lastError =
        typeof cached.lastError === "string" ? cached.lastError : null;
    } catch {
      // best-effort
    }
  }

  private async syncTelegramStateWithRuntime(
    runtimeChannelSet: string,
  ): Promise<void> {
    if (this.telegramState.channelSet === runtimeChannelSet) {
      return;
    }

    const hasCachedState =
      this.telegramState.channels.length > 0 ||
      this.telegramState.items.length > 0 ||
      this.telegramState.lastPollAt > 0 ||
      Object.keys(this.telegramState.cursorByHandle).length > 0;

    if (!hasCachedState && this.telegramState.channelSet === null) {
      return;
    }

    logger.info(
      {
        previousChannelSet: this.telegramState.channelSet,
        runtimeChannelSet,
        itemCount: this.telegramState.items.length,
      },
      "Telegram channel set changed; clearing cached feed state",
    );

    this.telegramState.channels = [];
    this.telegramState.channelSet = runtimeChannelSet;
    this.telegramState.cursorByHandle = {};
    this.telegramState.items = [];
    this.telegramState.lastPollAt = 0;
    this.telegramState.lastError = null;

    await this.persistTelegramState();
  }

  async clearTelegramState(options?: { clearItems?: boolean }): Promise<void> {
    await this.disconnectTelegramClient();
    this.telegramState.channels = [];
    this.telegramState.channelSet = null;
    this.telegramState.cursorByHandle = {};
    if (options?.clearItems ?? true) {
      this.telegramState.items = [];
      this.telegramState.lastPollAt = 0;
    }
    this.telegramState.lastError = null;
    this.telegramState.permanentlyDisabled = false;

    await this.cache
      .del(SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY)
      .catch(() => undefined);
  }

  private async restoreCachedOrefState() {
    if (
      this.orefState.history.length > 0 ||
      this.orefState.lastAlerts.length > 0
    ) {
      return;
    }

    try {
      const [alerts, history] = await Promise.all([
        this.cache.get<SituationOrefAlertsResponse>(
          SITUATION_MONITOR_OREF_ALERTS_CACHE_KEY,
        ),
        this.cache.get<SituationOrefHistoryResponse>(
          SITUATION_MONITOR_OREF_HISTORY_CACHE_KEY,
        ),
      ]);

      if (alerts) {
        this.orefState.lastAlerts = Array.isArray(alerts.alerts)
          ? alerts.alerts
          : [];
        this.orefState.lastAlertsJson = JSON.stringify(
          this.orefState.lastAlerts,
        );
        this.orefState.lastPollAt = Date.parse(alerts.timestamp) || 0;
        this.orefState.lastError =
          typeof alerts.error === "string" ? alerts.error : null;
      }

      if (history && Array.isArray(history.history)) {
        this.orefState.history = history.history;
        this.orefState.historyCount24h = Number(history.historyCount24h) || 0;
        this.orefState.totalHistoryCount =
          Number(history.totalHistoryCount) || 0;
      }
    } catch {
      // best-effort
    }
  }

  private async triggerOrefAlertChecks() {
    const now = Date.now();
    if (now - this.lastOrefAlertRuleCheckAt < 30_000) {
      return;
    }
    this.lastOrefAlertRuleCheckAt = now;

    await this.ensureOrefDefaultRules();

    const rules = await this.prisma.alertRule.findMany({
      where: {
        status: AlertStatus.active,
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: {
          in: SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES.map(
            (rule) => rule.slug,
          ),
        },
      },
      select: { id: true, orgId: true },
    });

    await Promise.allSettled(
      rules.map(async (rule) => {
        await this.alerts.enqueueRuleCheck(rule.id, rule.orgId);
      }),
    );
  }

  private async ensureOrefDefaultRules() {
    const now = Date.now();
    if (now - this.orefEnsureRulesAt < 60_000) {
      return;
    }
    this.orefEnsureRulesAt = now;

    const claimed = await claimSchedulerTick(
      this.cache,
      "cron:situation-monitor-oref-default-rules:tick-gate",
      OREF_DEFAULT_RULE_TICK_GATE_TTL_MS,
    );
    if (!claimed) {
      logger.info(
        "Skipped OREF default alert rule maintenance because another instance already claimed this interval",
      );
      return;
    }

    const orgs = await this.prisma.org.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    if (orgs.length === 0) {
      return;
    }

    const orgIds = orgs.map((org) => org.id);
    const orefMetricSlugs = SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES.map(
      (rule) => rule.slug,
    );
    const existingRules = await this.prisma.alertRule.findMany({
      where: {
        orgId: { in: orgIds },
        metricProvider: AlertMetricProvider.system_metric,
        metricSlug: { in: orefMetricSlugs },
      },
      select: {
        orgId: true,
        metricSlug: true,
      },
    });
    const existingRuleKeys = new Set(
      existingRules.map(
        (rule) => `${rule.orgId}:${String(rule.metricSlug).trim()}`,
      ),
    );
    const missingRuleGroups = orgs
      .map((org) => ({
        orgId: org.id,
        definitions: SITUATION_MONITOR_DEFAULT_OREF_ALERT_RULES.filter(
          (definition) => !existingRuleKeys.has(`${org.id}:${definition.slug}`),
        ),
      }))
      .filter((group) => group.definitions.length > 0);

    if (missingRuleGroups.length === 0) {
      return;
    }

    const runtime = await this.schedulerSettings.getRuntimeSettings();
    const concurrency = runtime.situationMonitorOrefDefaultRuleOrgConcurrency;
    const results = await settleWithConcurrency(
      missingRuleGroups,
      concurrency,
      async ({ orgId, definitions }) => {
        for (const definition of definitions) {
          try {
            await this.prisma.alertRule.create({
              data: {
                id: this.buildDefaultOrefRuleId(orgId, definition.slug),
                orgId,
                name: definition.name,
                description: definition.description,
                severity:
                  definition.slug ===
                  SITUATION_MONITOR_OREF_HISTORY_24H_METRIC_SLUG
                    ? AlertSeverity.medium
                    : AlertSeverity.high,
                status: AlertStatus.active,
                metricProvider: AlertMetricProvider.system_metric,
                metricSlug: definition.slug,
                operator: AlertOperator.gte,
                thresholdValue: new Prisma.Decimal(definition.thresholdValue),
                thresholdLower: null,
                thresholdUpper: null,
                changeWindowMin: 60,
                cooldownSeconds: 300,
                checkIntervalSec: 300,
                metadata: {
                  source: "situation-monitor-signals",
                  systemDefault: true,
                },
                dataItemId: null,
              },
            });
          } catch (error) {
            if (
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === "P2002"
            ) {
              logger.debug(
                { orgId, metricSlug: definition.slug },
                "Default OREF alert rule already exists",
              );
              continue;
            }
            throw error;
          }
        }
      },
    );

    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn(
          { err: result.reason, orgId: result.item.orgId },
          "Failed to ensure OREF default alert rules for org",
        );
      }
    }
  }

  private buildDefaultOrefRuleId(orgId: string, metricSlug: string) {
    const key = createHash("sha1")
      .update(`${orgId}:${metricSlug}`)
      .digest("hex")
      .slice(0, 40);
    return `default-oref-alert-${key}`;
  }

  private async orefCurlFetch(
    url: string,
    options?: { toFile?: string },
  ): Promise<string> {
    const proxyAuth = this.getOrefProxyAuth();
    if (!proxyAuth) {
      throw new Error("OREF proxy credentials are missing");
    }

    const timeoutSec = this.getOrefCurlTimeoutSeconds();
    const args = [
      "-sS",
      "-x",
      `http://${proxyAuth}`,
      "--max-time",
      String(timeoutSec),
      "-H",
      "Accept: application/json",
      "-H",
      "Referer: https://www.oref.org.il/",
      "-H",
      "X-Requested-With: XMLHttpRequest",
    ];

    if (options?.toFile) {
      args.push("-o", options.toFile, url);
      await execFileAsync("curl", args, {
        timeout: (timeoutSec + 5) * 1000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return await readFile(options.toFile, "utf8");
    }

    args.push(url);
    const result = await execFileAsync("curl", args, {
      timeout: (timeoutSec + 5) * 1000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return typeof result.stdout === "string"
      ? result.stdout
      : String(result.stdout ?? "");
  }

  private orefDateToUtc(dateStr: string): string {
    if (!dateStr || !dateStr.includes(" ")) {
      return new Date().toISOString();
    }

    const [datePart, timePart] = dateStr.split(" ");
    if (!datePart || !timePart) {
      return new Date().toISOString();
    }

    const dateSegments = datePart.split("-");
    const timeSegments = timePart.split(":");
    if (dateSegments.length !== 3 || timeSegments.length !== 3) {
      return new Date().toISOString();
    }

    const year = Number(dateSegments[0]);
    const month = Number(dateSegments[1]);
    const day = Number(dateSegments[2]);
    const hours = Number(timeSegments[0]);
    const minutes = Number(timeSegments[1]);
    const seconds = Number(timeSegments[2]);
    if (
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      !Number.isFinite(seconds)
    ) {
      return new Date().toISOString();
    }

    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const partsAt = (ms: number): string => {
      const parts = Object.fromEntries(
        format
          .formatToParts(new Date(ms))
          .map((entry) => [entry.type, entry.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    };

    const utc2 = Date.UTC(year, month - 1, day, hours - 2, minutes, seconds);
    const utc3 = Date.UTC(year, month - 1, day, hours - 3, minutes, seconds);

    const candidates: number[] = [];
    if (partsAt(utc2) === dateStr) candidates.push(utc2);
    if (partsAt(utc3) === dateStr) candidates.push(utc3);

    const selected = candidates.length > 0 ? Math.min(...candidates) : utc2;
    return new Date(selected).toISOString();
  }

  private stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  private redactOrefError(message: string): string {
    return message.replace(/\/\/[^@]+@/g, "//<redacted>@");
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`TIMEOUT ${timeoutMs}ms: ${label}`)),
          timeoutMs,
        );
      });
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private async getTelegramRuntimeConfig(): Promise<SituationMonitorTelegramRuntimeConfig> {
    try {
      return await this.settings.getTelegramRuntimeConfig();
    } catch (error) {
      logger.warn(
        { error },
        "Failed to read telegram runtime config from system settings; using env fallback",
      );
      return {
        enabled:
          this.readBooleanEnv(
            "SITUATION_MONITOR_TELEGRAM_ENABLED",
            "TELEGRAM_ENABLED",
          ) ?? false,
        apiId:
          this.readStringEnv(
            "SITUATION_MONITOR_TELEGRAM_API_ID",
            "TELEGRAM_API_ID",
          ) || undefined,
        apiHash:
          this.readStringEnv(
            "SITUATION_MONITOR_TELEGRAM_API_HASH",
            "TELEGRAM_API_HASH",
          ) || undefined,
        session: undefined,
        channelSet:
          this.readStringEnv(
            "SITUATION_MONITOR_TELEGRAM_CHANNEL_SET",
            "TELEGRAM_CHANNEL_SET",
          ) || "full",
        maxFeedItems: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_MAX_FEED_ITEMS",
          200,
          50,
        ),
        maxTextChars: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_MAX_TEXT_CHARS",
          800,
          200,
        ),
        channelTimeoutMs: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_CHANNEL_TIMEOUT_MS",
          15_000,
          3_000,
        ),
        pollCycleTimeoutMs: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_POLL_CYCLE_TIMEOUT_MS",
          180_000,
          30_000,
        ),
        startupDelayMs: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_STARTUP_DELAY_MS",
          60_000,
          0,
        ),
        rateLimitMs: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_RATE_LIMIT_MS",
          800,
          100,
        ),
        pollIntervalMs: this.readNumberEnv(
          "SITUATION_MONITOR_TELEGRAM_POLL_INTERVAL_MS",
          60_000,
          15_000,
        ),
      };
    }
  }

  private computeTelegramCredentialsFingerprint(
    apiId: number,
    apiHash: string,
    session: string,
  ): string {
    return createHash("sha256")
      .update(`${apiId}|${apiHash}|${session}`)
      .digest("hex");
  }

  private isOrefEnabled(): boolean {
    const value = this.readBooleanEnv("SITUATION_MONITOR_OREF_ENABLED");
    return value ?? false;
  }

  private isOrefConfigured(): boolean {
    return Boolean(this.getOrefProxyAuth());
  }

  private getOrefProxyAuth(): string {
    return this.readStringEnv(
      "SITUATION_MONITOR_OREF_PROXY_AUTH",
      "OREF_PROXY_AUTH",
    );
  }

  private getOrefAlertsUrl(): string {
    return (
      this.readStringEnv("SITUATION_MONITOR_OREF_ALERTS_URL") ||
      "https://www.oref.org.il/WarningMessages/alert/alerts.json"
    );
  }

  private getOrefHistoryUrl(): string {
    return (
      this.readStringEnv("SITUATION_MONITOR_OREF_HISTORY_URL") ||
      "https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json"
    );
  }

  private getOrefHistoryRetentionDays(): number {
    return this.readNumberEnv(
      "SITUATION_MONITOR_OREF_HISTORY_RETENTION_DAYS",
      7,
      1,
    );
  }

  private getOrefHistoryMaxWaves(): number {
    return this.readNumberEnv(
      "SITUATION_MONITOR_OREF_HISTORY_MAX_WAVES",
      OREF_PERSIST_MAX_WAVES_DEFAULT,
      10,
    );
  }

  private getOrefCurlTimeoutSeconds(): number {
    return this.readNumberEnv("SITUATION_MONITOR_OREF_CURL_TIMEOUT_SEC", 15, 5);
  }

  private getOrefBootstrapRetries(): number {
    return this.readNumberEnv(
      "SITUATION_MONITOR_OREF_BOOTSTRAP_MAX_RETRIES",
      3,
      1,
    );
  }

  private readStringEnv(...keys: string[]): string {
    for (const key of keys) {
      const value =
        this.env.get<string | undefined>(key, { infer: true }) ??
        process.env[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    return "";
  }

  private readNumberEnv(key: string, fallback: number, min: number): number {
    const raw =
      this.env.get<number | string | undefined>(key, { infer: true }) ??
      process.env[key];
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.floor(parsed));
  }

  private readBooleanEnv(...keys: string[]): boolean | undefined {
    for (const key of keys) {
      const raw =
        this.env.get<boolean | string | number | undefined>(key, {
          infer: true,
        }) ?? process.env[key];
      if (typeof raw === "boolean") {
        return raw;
      }
      if (typeof raw === "number") {
        if (raw === 1) return true;
        if (raw === 0) return false;
      }
      if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized)) {
          return true;
        }
        if (["0", "false", "no", "off"].includes(normalized)) {
          return false;
        }
      }
    }
    return undefined;
  }
}
