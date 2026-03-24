import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CrawlTaskStatus } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlActivityService } from "./crawl-activity.service";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import { CrawlQueueProcessor } from "./crawl.processor";

const logger = createLogger({ name: "crawl-adaptive-concurrency" });
const ADAPTIVE_LOCK_KEY = "cron:crawl-adaptive-concurrency";
const ADAPTIVE_LOCK_TTL_MS = 45_000;
const ADAPTIVE_STATE_CACHE_KEY = "crawl:adaptive-concurrency:state";
const ADAPTIVE_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const ADAPTIVE_METRIC_SAMPLE_LIMIT = 200;

interface AdaptiveConcurrencyMetrics {
  taskCount: number;
  failedCount: number;
  errorRate: number;
  p95LatencyMs: number | null;
  memoryHeadroom: number | null;
  memorySampleCount: number;
  latencySampleCount: number;
  samplingMode: "recent_sample";
}

interface AdaptiveConcurrencyState {
  enabled: boolean;
  lastDecision: string;
  lastAdjustedAt: string | null;
  reason: string | null;
  currentMaxConcurrency: number;
  updatedAt: string;
  metrics: AdaptiveConcurrencyMetrics;
}

interface AdaptiveConcurrencyThresholds {
  latencyRatio: number;
  errorRate: number;
  memoryHeadroom: number;
}

export interface CrawlAdaptiveConcurrencyStatus {
  enabled: boolean;
  lastDecision: string;
  lastAdjustedAt: string | null;
  reason: string | null;
  currentMaxConcurrency: number;
  windowMinutes: number;
  cooldownMinutes: number;
  thresholds: AdaptiveConcurrencyThresholds;
  metrics: AdaptiveConcurrencyMetrics;
}

function createEmptyAdaptiveMetrics(): AdaptiveConcurrencyMetrics {
  return {
    taskCount: 0,
    failedCount: 0,
    errorRate: 0,
    p95LatencyMs: null,
    memoryHeadroom: null,
    memorySampleCount: 0,
    latencySampleCount: 0,
    samplingMode: "recent_sample"
  };
}

@Injectable()
export class CrawlAdaptiveConcurrencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly activity: CrawlActivityService,
    private readonly crawlQueue: CrawlQueueService,
    private readonly crawlProcessor: CrawlQueueProcessor
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async adjustCron() {
    await this.cache.withLock(ADAPTIVE_LOCK_KEY, ADAPTIVE_LOCK_TTL_MS, async () =>
      this.adjustConcurrency(new Date())
    );
  }

  async getStatus(
    settingsInput?: Awaited<ReturnType<CrawlSettingsService["getSettings"]>>
  ): Promise<CrawlAdaptiveConcurrencyStatus> {
    const settings = settingsInput ?? (await this.crawlSettings.getSettings());
    const cached = await this.cache.get<AdaptiveConcurrencyState>(ADAPTIVE_STATE_CACHE_KEY);
    const thresholds: AdaptiveConcurrencyThresholds = {
      latencyRatio: settings.adaptiveLatencyThresholdRatio,
      errorRate: settings.adaptiveErrorRateThreshold,
      memoryHeadroom: settings.adaptiveMemoryHeadroomThreshold
    };
    const enabled = settings.adaptiveConcurrencyEnabled;

    return {
      enabled,
      lastDecision: enabled ? cached?.lastDecision ?? "idle" : "disabled",
      lastAdjustedAt: enabled ? cached?.lastAdjustedAt ?? null : null,
      reason: enabled ? cached?.reason ?? null : "adaptive concurrency is disabled",
      currentMaxConcurrency: settings.maxConcurrency,
      windowMinutes: settings.adaptiveWindowMinutes,
      cooldownMinutes: settings.adaptiveCooldownMinutes,
      thresholds,
      metrics: enabled ? this.normalizeMetrics(cached?.metrics) : createEmptyAdaptiveMetrics()
    };
  }

  async adjustConcurrency(now: Date): Promise<void> {
    const settings = await this.crawlSettings.getSettings();
    const thresholds: AdaptiveConcurrencyThresholds = {
      latencyRatio: settings.adaptiveLatencyThresholdRatio,
      errorRate: settings.adaptiveErrorRateThreshold,
      memoryHeadroom: settings.adaptiveMemoryHeadroomThreshold
    };
    if (!settings.adaptiveConcurrencyEnabled) {
      await this.persistState({
        enabled: false,
        lastDecision: "disabled",
        lastAdjustedAt: null,
        reason: "adaptive concurrency is disabled",
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics: createEmptyAdaptiveMetrics()
      });
      return;
    }

    if (!(await this.hasRecentCrawlActivity(now, settings.adaptiveWindowMinutes))) {
      await this.persistState({
        enabled: true,
        lastDecision: "idle",
        lastAdjustedAt: null,
        reason: "no recent crawl activity",
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics: createEmptyAdaptiveMetrics()
      });
      return;
    }

    const metrics = await this.computeMetrics(now, settings.adaptiveWindowMinutes);
    const reasons: string[] = [];
    if (
      typeof metrics.p95LatencyMs === "number" &&
      metrics.p95LatencyMs > settings.requestTimeoutNormalMs * thresholds.latencyRatio
    ) {
      reasons.push(
        `p95 latency ${metrics.p95LatencyMs}ms > ${Math.round(settings.requestTimeoutNormalMs * thresholds.latencyRatio)}ms`
      );
    }
    if (metrics.errorRate > thresholds.errorRate) {
      reasons.push(
        `error rate ${(metrics.errorRate * 100).toFixed(1)}% > ${(thresholds.errorRate * 100).toFixed(0)}%`
      );
    }
    if (
      typeof metrics.memoryHeadroom === "number" &&
      metrics.memoryHeadroom < thresholds.memoryHeadroom
    ) {
      reasons.push(
        `memory headroom ${(metrics.memoryHeadroom * 100).toFixed(1)}% < ${(thresholds.memoryHeadroom * 100).toFixed(0)}%`
      );
    }

    if (reasons.length === 0) {
      await this.persistState({
        enabled: true,
        lastDecision: "stable",
        lastAdjustedAt: null,
        reason: null,
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics
      });
      return;
    }

    if (settings.maxConcurrency <= 1) {
      await this.persistState({
        enabled: true,
        lastDecision: "at_floor",
        lastAdjustedAt: null,
        reason: reasons.join("; "),
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics
      });
      return;
    }

    const previous = await this.cache.get<AdaptiveConcurrencyState>(ADAPTIVE_STATE_CACHE_KEY);
    if (previous?.lastAdjustedAt) {
      const previousAt = Date.parse(previous.lastAdjustedAt);
      if (Number.isFinite(previousAt)) {
        const elapsed = now.getTime() - previousAt;
        if (elapsed < settings.adaptiveCooldownMinutes * 60_000) {
          await this.persistState({
            enabled: true,
            lastDecision: "cooldown",
            lastAdjustedAt: previous.lastAdjustedAt,
            reason: reasons.join("; "),
            currentMaxConcurrency: settings.maxConcurrency,
            updatedAt: now.toISOString(),
            metrics
          });
          return;
        }
      }
    }

    const nextConcurrency = Math.max(1, settings.maxConcurrency - 1);
    try {
      await this.crawlSettings.updateMaxConcurrencyInternal(nextConcurrency);
      await this.crawlQueue.setGlobalConcurrency(nextConcurrency);
      this.crawlProcessor.setWorkerConcurrency(nextConcurrency);

      await this.persistState({
        enabled: true,
        lastDecision: "decrease",
        lastAdjustedAt: now.toISOString(),
        reason: reasons.join("; "),
        currentMaxConcurrency: nextConcurrency,
        updatedAt: now.toISOString(),
        metrics
      });

      logger.warn(
        {
          from: settings.maxConcurrency,
          to: nextConcurrency,
          reasons,
          metrics
        },
        "Adaptive crawl concurrency decreased"
      );
    } catch (error) {
      logger.error({ err: error, reasons, metrics }, "Failed to apply adaptive crawl concurrency decrease");
      await this.persistState({
        enabled: true,
        lastDecision: "error",
        lastAdjustedAt: null,
        reason: reasons.join("; "),
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics
      });
    }
  }

  private async computeMetrics(now: Date, windowMinutes: number): Promise<AdaptiveConcurrencyMetrics> {
    const from = new Date(now.getTime() - windowMinutes * 60_000);
    const baseWhere = {
      updatedAt: { gte: from },
      lastRunAt: { not: null }
    };
    const terminalStatuses = [CrawlTaskStatus.completed, CrawlTaskStatus.failed];
    const [taskCount, failedCount, rows] = await Promise.all([
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          status: { in: terminalStatuses }
        }
      }),
      this.prisma.crawlTask.count({
        where: {
          ...baseWhere,
          status: CrawlTaskStatus.failed
        }
      }),
      this.prisma.crawlTask.findMany({
        where: {
          ...baseWhere,
          status: { in: terminalStatuses }
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: ADAPTIVE_METRIC_SAMPLE_LIMIT,
        select: {
          lastRunAt: true,
          updatedAt: true,
          lastServerMemoryMb: true,
          lastPeakMemoryMb: true
        }
      })
    ]);

    const latencies: number[] = [];
    const headrooms: number[] = [];

    for (const row of rows) {
      const startedAt = row.lastRunAt?.getTime();
      const endedAt = row.updatedAt.getTime();
      if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
        latencies.push(Math.max(0, endedAt - startedAt));
      }

      if (
        typeof row.lastServerMemoryMb === "number" &&
        Number.isFinite(row.lastServerMemoryMb) &&
        row.lastServerMemoryMb > 0 &&
        typeof row.lastPeakMemoryMb === "number" &&
        Number.isFinite(row.lastPeakMemoryMb) &&
        row.lastPeakMemoryMb >= 0
      ) {
        const usageRatio = Math.max(0, Math.min(1, row.lastPeakMemoryMb / row.lastServerMemoryMb));
        headrooms.push(1 - usageRatio);
      }
    }

    return {
      taskCount,
      failedCount,
      errorRate: taskCount > 0 ? failedCount / taskCount : 0,
      p95LatencyMs: this.computePercentile(latencies, 0.95),
      memoryHeadroom:
        headrooms.length > 0
          ? headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length
          : null,
      memorySampleCount: headrooms.length,
      latencySampleCount: latencies.length,
      samplingMode: "recent_sample"
    };
  }

  private async hasRecentCrawlActivity(now: Date, windowMinutes: number): Promise<boolean> {
    const state = await this.activity.getState();
    const activeTaskCount =
      typeof state.activeTaskCount === "number"
        ? state.activeTaskCount
        : await this.activity.ensureActiveTaskCount();
    if (activeTaskCount > 0) {
      return true;
    }

    const cutoffMs = now.getTime() - windowMinutes * 60_000;
    const lastEnqueuedAt = this.toTimestamp(state.lastEnqueuedAt);
    const lastTerminalAt = this.toTimestamp(state.lastTerminalAt);
    return (
      (typeof lastEnqueuedAt === "number" && lastEnqueuedAt >= cutoffMs) ||
      (typeof lastTerminalAt === "number" && lastTerminalAt >= cutoffMs)
    );
  }

  private computePercentile(values: number[], percentile: number): number | null {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentile) - 1));
    return sorted[index] ?? null;
  }

  private async persistState(state: AdaptiveConcurrencyState) {
    await this.cache.set(ADAPTIVE_STATE_CACHE_KEY, state, ADAPTIVE_STATE_TTL_SECONDS);
  }

  private normalizeMetrics(metrics?: Partial<AdaptiveConcurrencyMetrics> | null): AdaptiveConcurrencyMetrics {
    return {
      ...createEmptyAdaptiveMetrics(),
      ...metrics,
      samplingMode: "recent_sample"
    };
  }

  private toTimestamp(value: string | null | undefined): number | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
