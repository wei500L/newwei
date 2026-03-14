import { type LlmRequestLog } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Inject, Injectable } from "@nestjs/common";
import type { Model } from "mongoose";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";

import { REDIS_CLIENT } from "../cache/cache.tokens";
import {
  LLM_REQUEST_LOG_MODEL,
  type LlmRequestType,
} from "../news-pipeline/llm-request-log.service";

import {
  LlmRuntimeSettingsService,
  type LlmRuntimeSettings,
  type LlmRuntimeSettingsPublic,
} from "./llm-runtime-settings.service";

export type LlmRuntimeDecision =
  | "allowed"
  | "warn_concurrency"
  | "warn_daily_budget"
  | "warn_monthly_budget"
  | "warn_multiple";

export interface LlmRuntimeRequestContext {
  runtimeRequestId: string;
  feature: string;
  requestType: LlmRequestType;
  currentConcurrency: number;
  concurrencyLimit: number;
  dailySpendUsdSnapshot: number;
  monthlySpendUsdSnapshot: number;
  settings: LlmRuntimeSettings;
}

export interface LlmRuntimeAttemptSnapshot {
  runtimeRequestId: string;
  feature: string;
  runtimeDecision: LlmRuntimeDecision;
  currentConcurrency: number;
  concurrencyLimit: number;
  dailySpendUsdSnapshot: number;
  monthlySpendUsdSnapshot: number;
}

export interface LlmRuntimeStatusResponse extends LlmRuntimeSettingsPublic {
  currentConcurrency: number;
  peakConcurrency: {
    day: number;
    month: number;
  };
  spendUsd: {
    day: number;
    month: number;
  };
  budgetUtilization: {
    day: number | null;
    month: number | null;
  };
  warningState: {
    runtimeDecision: LlmRuntimeDecision;
    concurrencyExceeded: boolean;
    dailyBudgetExceeded: boolean;
    monthlyBudgetExceeded: boolean;
  };
  lastAlert: {
    at: string | null;
    decision: LlmRuntimeDecision | null;
    feature: string | null;
    requestType: LlmRequestType | null;
  };
}

export interface LlmRuntimeSummaryTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  peakObservedConcurrency: number;
}

export interface LlmRuntimeSummaryGroupRow extends LlmRuntimeSummaryTotals {
  key: string;
}

export interface LlmRuntimeWarningBreakdownRow {
  decision: LlmRuntimeDecision;
  count: number;
}

export interface LlmRuntimeSummaryResponse {
  window: "day" | "month";
  start: string;
  end: string;
  totals: LlmRuntimeSummaryTotals;
  byFeature: LlmRuntimeSummaryGroupRow[];
  byModel: LlmRuntimeSummaryGroupRow[];
  byRequestType: LlmRuntimeSummaryGroupRow[];
  warningBreakdown: LlmRuntimeWarningBreakdownRow[];
}

interface ActiveRuntimeRequest {
  renewTimer: NodeJS.Timeout | null;
}

interface RuntimeWindowContext {
  now: Date;
  nowMs: number;
  dayKey: string;
  monthKey: string;
  daySpendKey: string;
  monthSpendKey: string;
  dayPeakKey: string;
  monthPeakKey: string;
}

interface RuntimeAggregateRow {
  requestCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  totalLatencyMs?: number;
  peakObservedConcurrency?: number;
}

interface RuntimeGroupAggregateRow extends RuntimeAggregateRow {
  _id?: string;
}

interface WarningGroupAggregateRow {
  _id?: LlmRuntimeDecision | string | null;
  count?: number;
}

const LOGGER_NAME = "llm-runtime-service";
const RUNTIME_PREFIX = "llm_runtime";
const ACTIVE_REQUESTS_CLEANUP_INTERVAL_MS = 5_000;
const DAY_KEY_TTL_SECONDS = 45 * 24 * 60 * 60;
const MONTH_KEY_TTL_SECONDS = 400 * 24 * 60 * 60;
const LAST_ALERT_KEY = `${RUNTIME_PREFIX}:alert:last`;
const WARNING_ORDER: LlmRuntimeDecision[] = [
  "warn_multiple",
  "warn_concurrency",
  "warn_daily_budget",
  "warn_monthly_budget",
  "allowed",
];

@Injectable()
export class LlmRuntimeService {
  private readonly logger = createLogger({ name: LOGGER_NAME });
  private readonly activeRequests = new Map<string, ActiveRuntimeRequest>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(LLM_REQUEST_LOG_MODEL)
    private readonly llmRequestLogModel: Model<LlmRequestLog>,
    private readonly settings: LlmRuntimeSettingsService,
  ) {}

  resolveFeature(metadata?: Record<string, unknown> | null): string {
    const fromFeature = this.normalizeFeatureToken(metadata?.feature);
    if (fromFeature) {
      return fromFeature;
    }
    const fromSource = this.normalizeFeatureToken(metadata?.source);
    if (fromSource) {
      return fromSource;
    }
    const fromModule = this.normalizeFeatureToken(metadata?.module);
    if (fromModule) {
      return fromModule;
    }
    return "unknown";
  }

  async startRequest(params: {
    requestType: LlmRequestType;
    metadata?: Record<string, unknown>;
  }): Promise<LlmRuntimeRequestContext> {
    const settings = await this.settings.getEffectiveSettings();
    const feature = this.resolveFeature(params.metadata);
    const runtimeRequestId = randomUUID();
    const window = this.getWindowContext();
    const leaseTtlMs = settings.requestLeaseTtlSeconds * 1_000;
    const currentConcurrency = await this.acquireLease(
      runtimeRequestId,
      window,
      leaseTtlMs,
    );
    const renewTimer = this.startLeaseRenewal(
      runtimeRequestId,
      leaseTtlMs,
      settings.requestLeaseTtlSeconds,
    );
    this.activeRequests.set(runtimeRequestId, { renewTimer });

    const { day, month } = await this.readSpendSnapshots(window);
    const runtimeDecision = this.resolveDecision({
      currentConcurrency,
      concurrencyLimit: settings.maxConcurrency,
      dailySpendUsd: day,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      monthlySpendUsd: month,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
    });
    await this.maybeEmitWarning(runtimeDecision, {
      feature,
      requestType: params.requestType,
      currentConcurrency,
      concurrencyLimit: settings.maxConcurrency,
      dailySpendUsd: day,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      monthlySpendUsd: month,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      alertCooldownSeconds: settings.alertCooldownSeconds,
    });

    return {
      runtimeRequestId,
      feature,
      requestType: params.requestType,
      currentConcurrency,
      concurrencyLimit: settings.maxConcurrency,
      dailySpendUsdSnapshot: day,
      monthlySpendUsdSnapshot: month,
      settings,
    };
  }

  async releaseRequest(runtimeRequestId: string): Promise<void> {
    const active = this.activeRequests.get(runtimeRequestId);
    if (active?.renewTimer) {
      clearInterval(active.renewTimer);
    }
    this.activeRequests.delete(runtimeRequestId);
    try {
      await this.redis.eval(
        `
          redis.call("ZREM", KEYS[1], ARGV[1])
          redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[2])
          return redis.call("ZCARD", KEYS[1])
        `,
        1,
        this.inflightKey(),
        runtimeRequestId,
        String(Date.now()),
      );
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          runtimeRequestId,
          metricName: "llm_runtime_release_total",
          metricOutcome: "failure",
        },
        "Failed to release LiteLLM runtime lease",
      );
    }
  }

  async recordAttempt(
    context: LlmRuntimeRequestContext,
    costUsd?: number | null,
  ): Promise<LlmRuntimeAttemptSnapshot> {
    const window = this.getWindowContext();
    const spend =
      typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0
        ? await this.incrementSpend(window, costUsd)
        : await this.readSpendSnapshots(window);

    const runtimeDecision = this.resolveDecision({
      currentConcurrency: context.currentConcurrency,
      concurrencyLimit: context.concurrencyLimit,
      dailySpendUsd: spend.day,
      dailyBudgetUsd: context.settings.dailyBudgetUsd,
      monthlySpendUsd: spend.month,
      monthlyBudgetUsd: context.settings.monthlyBudgetUsd,
    });
    await this.maybeEmitWarning(runtimeDecision, {
      feature: context.feature,
      requestType: context.requestType,
      currentConcurrency: context.currentConcurrency,
      concurrencyLimit: context.concurrencyLimit,
      dailySpendUsd: spend.day,
      dailyBudgetUsd: context.settings.dailyBudgetUsd,
      monthlySpendUsd: spend.month,
      monthlyBudgetUsd: context.settings.monthlyBudgetUsd,
      alertCooldownSeconds: context.settings.alertCooldownSeconds,
    });

    context.dailySpendUsdSnapshot = spend.day;
    context.monthlySpendUsdSnapshot = spend.month;

    return {
      runtimeRequestId: context.runtimeRequestId,
      feature: context.feature,
      runtimeDecision,
      currentConcurrency: context.currentConcurrency,
      concurrencyLimit: context.concurrencyLimit,
      dailySpendUsdSnapshot: spend.day,
      monthlySpendUsdSnapshot: spend.month,
    };
  }

  async getStatus(): Promise<LlmRuntimeStatusResponse> {
    const [settings, window] = await Promise.all([
      this.settings.getPublicSettings(),
      Promise.resolve(this.getWindowContext()),
    ]);
    const [currentConcurrency, peaks, spend, lastAlert] = await Promise.all([
      this.getCurrentConcurrency(),
      this.readPeaks(window),
      this.readSpendSnapshots(window),
      this.readLastAlert(),
    ]);
    const runtimeDecision = this.resolveDecision({
      currentConcurrency,
      concurrencyLimit: settings.maxConcurrency,
      dailySpendUsd: spend.day,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      monthlySpendUsd: spend.month,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
    });

    return {
      ...settings,
      currentConcurrency,
      peakConcurrency: peaks,
      spendUsd: spend,
      budgetUtilization: {
        day:
          settings.dailyBudgetUsd > 0
            ? spend.day / settings.dailyBudgetUsd
            : null,
        month:
          settings.monthlyBudgetUsd > 0
            ? spend.month / settings.monthlyBudgetUsd
            : null,
      },
      warningState: {
        runtimeDecision,
        concurrencyExceeded: currentConcurrency > settings.maxConcurrency,
        dailyBudgetExceeded:
          settings.dailyBudgetUsd > 0 && spend.day >= settings.dailyBudgetUsd,
        monthlyBudgetExceeded:
          settings.monthlyBudgetUsd > 0 &&
          spend.month >= settings.monthlyBudgetUsd,
      },
      lastAlert,
    };
  }

  async getSummary(
    window: "day" | "month",
  ): Promise<LlmRuntimeSummaryResponse> {
    const range = this.getSummaryWindow(window);
    const match = {
      createdAt: {
        $gte: range.start,
        $lt: range.end,
      },
    };
    const featureExpression = this.featureAggregationExpression();
    const runtimeDecisionExpression = {
      $ifNull: ["$runtimeDecision", "allowed"],
    };

    const [
      totalsAgg,
      byFeatureAgg,
      byModelAgg,
      byRequestTypeAgg,
      warningBreakdownAgg,
    ] = await Promise.all([
      this.llmRequestLogModel.aggregate<RuntimeAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: null,
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
            peakObservedConcurrency: {
              $max: { $ifNull: ["$currentConcurrency", 0] },
            },
          },
        },
      ]),
      this.llmRequestLogModel.aggregate<RuntimeGroupAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: featureExpression,
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
            peakObservedConcurrency: {
              $max: { $ifNull: ["$currentConcurrency", 0] },
            },
          },
        },
        { $sort: { requestCount: -1, _id: 1 } },
      ]),
      this.llmRequestLogModel.aggregate<RuntimeGroupAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: "$model",
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
            peakObservedConcurrency: {
              $max: { $ifNull: ["$currentConcurrency", 0] },
            },
          },
        },
        { $sort: { requestCount: -1, _id: 1 } },
      ]),
      this.llmRequestLogModel.aggregate<RuntimeGroupAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: "$requestType",
            requestCount: { $sum: 1 },
            promptTokens: { $sum: { $ifNull: ["$promptTokens", 0] } },
            completionTokens: { $sum: { $ifNull: ["$completionTokens", 0] } },
            totalTokens: { $sum: { $ifNull: ["$totalTokens", 0] } },
            costUsd: { $sum: { $ifNull: ["$costUsd", 0] } },
            totalLatencyMs: { $sum: { $ifNull: ["$latencyMs", 0] } },
            peakObservedConcurrency: {
              $max: { $ifNull: ["$currentConcurrency", 0] },
            },
          },
        },
        { $sort: { requestCount: -1, _id: 1 } },
      ]),
      this.llmRequestLogModel.aggregate<WarningGroupAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: runtimeDecisionExpression,
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    return {
      window,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      totals: this.mapSummaryRow(totalsAgg[0] ?? {}),
      byFeature: byFeatureAgg.map((row) => this.mapSummaryGroupRow(row)),
      byModel: byModelAgg.map((row) => this.mapSummaryGroupRow(row)),
      byRequestType: byRequestTypeAgg.map((row) =>
        this.mapSummaryGroupRow(row),
      ),
      warningBreakdown: warningBreakdownAgg
        .map((row) => ({
          decision: this.toRuntimeDecision(row._id),
          count: this.toSafeInteger(row.count),
        }))
        .filter((row) => row.count > 0)
        .sort(
          (left, right) =>
            WARNING_ORDER.indexOf(left.decision) -
            WARNING_ORDER.indexOf(right.decision),
        ),
    };
  }

  private inflightKey(): string {
    return `${RUNTIME_PREFIX}:inflight`;
  }

  private daySpendKey(dayKey: string): string {
    return `${RUNTIME_PREFIX}:spend:day:${dayKey}`;
  }

  private monthSpendKey(monthKey: string): string {
    return `${RUNTIME_PREFIX}:spend:month:${monthKey}`;
  }

  private dayPeakKey(dayKey: string): string {
    return `${RUNTIME_PREFIX}:peak:day:${dayKey}`;
  }

  private monthPeakKey(monthKey: string): string {
    return `${RUNTIME_PREFIX}:peak:month:${monthKey}`;
  }

  private alertCooldownKey(decision: LlmRuntimeDecision): string {
    return `${RUNTIME_PREFIX}:alert:cooldown:${decision}`;
  }

  private getWindowContext(now = new Date()): RuntimeWindowContext {
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = now.toISOString().slice(0, 7);
    return {
      now,
      nowMs: now.getTime(),
      dayKey,
      monthKey,
      daySpendKey: this.daySpendKey(dayKey),
      monthSpendKey: this.monthSpendKey(monthKey),
      dayPeakKey: this.dayPeakKey(dayKey),
      monthPeakKey: this.monthPeakKey(monthKey),
    };
  }

  private getSummaryWindow(window: "day" | "month"): {
    start: Date;
    end: Date;
  } {
    const now = new Date();
    if (window === "day") {
      const start = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);
      return { start, end };
    }

    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    return { start, end };
  }

  private async acquireLease(
    runtimeRequestId: string,
    window: RuntimeWindowContext,
    leaseTtlMs: number,
  ): Promise<number> {
    const setTtlSeconds = Math.max(
      window.now.getUTCSeconds(),
      Math.ceil(leaseTtlMs / 1_000) + 60,
    );
    const result = (await this.redis.eval(
      `
        redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[2])
        redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
        redis.call("EXPIRE", KEYS[1], ARGV[4])
        local current = redis.call("ZCARD", KEYS[1])

        local dayPeak = tonumber(redis.call("GET", KEYS[2]) or "0")
        if current > dayPeak then
          dayPeak = current
          redis.call("SET", KEYS[2], current, "EX", ARGV[5])
        end

        local monthPeak = tonumber(redis.call("GET", KEYS[3]) or "0")
        if current > monthPeak then
          monthPeak = current
          redis.call("SET", KEYS[3], current, "EX", ARGV[6])
        end

        return current
      `,
      3,
      this.inflightKey(),
      window.dayPeakKey,
      window.monthPeakKey,
      runtimeRequestId,
      String(window.nowMs),
      String(window.nowMs + leaseTtlMs),
      String(setTtlSeconds),
      String(DAY_KEY_TTL_SECONDS),
      String(MONTH_KEY_TTL_SECONDS),
    )) as number;
    return this.toSafeInteger(result);
  }

  private startLeaseRenewal(
    runtimeRequestId: string,
    leaseTtlMs: number,
    requestLeaseTtlSeconds: number,
  ): NodeJS.Timeout {
    const intervalMs = Math.max(
      1_000,
      Math.min(leaseTtlMs / 3, ACTIVE_REQUESTS_CLEANUP_INTERVAL_MS),
    );
    const timer = setInterval(() => {
      void this.redis
        .eval(
          `
            if redis.call("ZSCORE", KEYS[1], ARGV[1]) then
              redis.call("ZADD", KEYS[1], ARGV[2], ARGV[1])
              redis.call("EXPIRE", KEYS[1], ARGV[3])
              return 1
            end
            return 0
          `,
          1,
          this.inflightKey(),
          runtimeRequestId,
          String(Date.now() + leaseTtlMs),
          String(requestLeaseTtlSeconds + 60),
        )
        .catch((error: unknown) => {
          this.logger.warn(
            {
              err: error,
              runtimeRequestId,
              metricName: "llm_runtime_lease_renew_total",
              metricOutcome: "failure",
            },
            "Failed to renew LiteLLM runtime lease",
          );
        });
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private async getCurrentConcurrency(): Promise<number> {
    const result = (await this.redis.eval(
      `
        redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
        return redis.call("ZCARD", KEYS[1])
      `,
      1,
      this.inflightKey(),
      String(Date.now()),
    )) as number;
    return this.toSafeInteger(result);
  }

  private async readPeaks(window: RuntimeWindowContext): Promise<{
    day: number;
    month: number;
  }> {
    const [dayPeakRaw, monthPeakRaw] = await this.redis.mget(
      window.dayPeakKey,
      window.monthPeakKey,
    );
    return {
      day: this.toSafeInteger(dayPeakRaw),
      month: this.toSafeInteger(monthPeakRaw),
    };
  }

  private async readSpendSnapshots(window: RuntimeWindowContext): Promise<{
    day: number;
    month: number;
  }> {
    const [dayRaw, monthRaw] = await this.redis.mget(
      window.daySpendKey,
      window.monthSpendKey,
    );
    return {
      day: this.microUsdToUsd(dayRaw),
      month: this.microUsdToUsd(monthRaw),
    };
  }

  private async incrementSpend(
    window: RuntimeWindowContext,
    costUsd: number,
  ): Promise<{ day: number; month: number }> {
    const microUsd = this.usdToMicroUsd(costUsd);
    if (microUsd <= 0) {
      return this.readSpendSnapshots(window);
    }

    const pipeline = this.redis.multi();
    pipeline.incrby(window.daySpendKey, microUsd);
    pipeline.expire(window.daySpendKey, DAY_KEY_TTL_SECONDS);
    pipeline.incrby(window.monthSpendKey, microUsd);
    pipeline.expire(window.monthSpendKey, MONTH_KEY_TTL_SECONDS);
    const result = await pipeline.exec();
    const dayMicro = this.toSafeInteger(result?.[0]?.[1]);
    const monthMicro = this.toSafeInteger(result?.[2]?.[1]);
    return {
      day: this.microUsdToUsd(dayMicro),
      month: this.microUsdToUsd(monthMicro),
    };
  }

  private resolveDecision(params: {
    currentConcurrency: number;
    concurrencyLimit: number;
    dailySpendUsd: number;
    dailyBudgetUsd: number;
    monthlySpendUsd: number;
    monthlyBudgetUsd: number;
  }): LlmRuntimeDecision {
    const warnings: Array<"concurrency" | "daily_budget" | "monthly_budget"> =
      [];
    if (params.currentConcurrency > params.concurrencyLimit) {
      warnings.push("concurrency");
    }
    if (
      params.dailyBudgetUsd > 0 &&
      params.dailySpendUsd >= params.dailyBudgetUsd
    ) {
      warnings.push("daily_budget");
    }
    if (
      params.monthlyBudgetUsd > 0 &&
      params.monthlySpendUsd >= params.monthlyBudgetUsd
    ) {
      warnings.push("monthly_budget");
    }
    if (warnings.length === 0) {
      return "allowed";
    }
    if (warnings.length > 1) {
      return "warn_multiple";
    }
    if (warnings[0] === "concurrency") {
      return "warn_concurrency";
    }
    if (warnings[0] === "daily_budget") {
      return "warn_daily_budget";
    }
    return "warn_monthly_budget";
  }

  private async maybeEmitWarning(
    decision: LlmRuntimeDecision,
    payload: {
      feature: string;
      requestType: LlmRequestType;
      currentConcurrency: number;
      concurrencyLimit: number;
      dailySpendUsd: number;
      dailyBudgetUsd: number;
      monthlySpendUsd: number;
      monthlyBudgetUsd: number;
      alertCooldownSeconds: number;
    },
  ): Promise<void> {
    if (decision === "allowed") {
      return;
    }
    const cooldownSeconds = Math.max(10, payload.alertCooldownSeconds);
    const acquired = await this.redis.set(
      this.alertCooldownKey(decision),
      String(Date.now()),
      "EX",
      cooldownSeconds,
      "NX",
    );
    if (acquired !== "OK") {
      return;
    }

    const alertRecord = {
      at: new Date().toISOString(),
      decision,
      feature: payload.feature,
      requestType: payload.requestType,
    } as const;
    await this.redis.set(
      LAST_ALERT_KEY,
      JSON.stringify(alertRecord),
      "EX",
      MONTH_KEY_TTL_SECONDS,
    );
    this.logger.warn(
      {
        metricName: "llm_runtime_warning_total",
        metricOutcome: decision,
        feature: payload.feature,
        requestType: payload.requestType,
        currentConcurrency: payload.currentConcurrency,
        concurrencyLimit: payload.concurrencyLimit,
        dailySpendUsd: payload.dailySpendUsd,
        dailyBudgetUsd: payload.dailyBudgetUsd,
        monthlySpendUsd: payload.monthlySpendUsd,
        monthlyBudgetUsd: payload.monthlyBudgetUsd,
      },
      "LiteLLM runtime threshold exceeded",
    );
  }

  private async readLastAlert(): Promise<
    LlmRuntimeStatusResponse["lastAlert"]
  > {
    const raw = await this.redis.get(LAST_ALERT_KEY);
    if (!raw) {
      return {
        at: null,
        decision: null,
        feature: null,
        requestType: null,
      };
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        at: typeof parsed.at === "string" ? parsed.at : null,
        decision: this.toRuntimeDecision(parsed.decision),
        feature: typeof parsed.feature === "string" ? parsed.feature : null,
        requestType: this.toRequestType(parsed.requestType),
      };
    } catch {
      return {
        at: null,
        decision: null,
        feature: null,
        requestType: null,
      };
    }
  }

  private mapSummaryGroupRow(
    row: RuntimeGroupAggregateRow,
  ): LlmRuntimeSummaryGroupRow {
    return {
      key:
        typeof row._id === "string" && row._id.trim().length > 0
          ? row._id
          : "unknown",
      ...this.mapSummaryRow(row),
    };
  }

  private mapSummaryRow(row: RuntimeAggregateRow): LlmRuntimeSummaryTotals {
    const requestCount = this.toSafeInteger(row.requestCount);
    const totalLatencyMs = this.toSafeNumber(row.totalLatencyMs);
    return {
      requestCount,
      promptTokens: this.toSafeInteger(row.promptTokens),
      completionTokens: this.toSafeInteger(row.completionTokens),
      totalTokens: this.toSafeInteger(row.totalTokens),
      costUsd: this.toSafeNumber(row.costUsd),
      avgLatencyMs: requestCount > 0 ? totalLatencyMs / requestCount : 0,
      peakObservedConcurrency: this.toSafeInteger(row.peakObservedConcurrency),
    };
  }

  private featureAggregationExpression(): Record<string, unknown> {
    return {
      $ifNull: [
        "$feature",
        {
          $ifNull: [
            "$metadata.feature",
            {
              $ifNull: [
                "$metadata.source",
                { $ifNull: ["$metadata.module", "unknown"] },
              ],
            },
          ],
        },
      ],
    };
  }

  private toRuntimeDecision(value: unknown): LlmRuntimeDecision {
    if (
      value === "warn_concurrency" ||
      value === "warn_daily_budget" ||
      value === "warn_monthly_budget" ||
      value === "warn_multiple"
    ) {
      return value;
    }
    return "allowed";
  }

  private toRequestType(value: unknown): LlmRequestType | null {
    if (
      value === "completion" ||
      value === "embedding" ||
      value === "rerank" ||
      value === "stream" ||
      value === "responses"
    ) {
      return value;
    }
    return null;
  }

  private normalizeFeatureToken(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized.length > 64) {
      return undefined;
    }
    return /^[a-z0-9_:\-.]+$/.test(normalized) ? normalized : undefined;
  }

  private usdToMicroUsd(value: number): number {
    return Math.max(0, Math.round(value * 1_000_000));
  }

  private microUsdToUsd(value: unknown): number {
    const numeric = this.toSafeInteger(value);
    return Number((numeric / 1_000_000).toFixed(6));
  }

  private toSafeInteger(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return Math.max(0, Math.trunc(numeric));
  }

  private toSafeNumber(value: unknown): number {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return 0;
    }
    return numeric;
  }
}
