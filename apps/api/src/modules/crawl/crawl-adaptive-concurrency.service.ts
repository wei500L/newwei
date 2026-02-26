import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { CrawlTaskStatus } from "@prisma/client";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";

import { CrawlQueueProcessor } from "./crawl.processor";
import { CrawlQueueService } from "./crawl-queue.service";
import { CrawlSettingsService } from "./crawl-settings.service";

const logger = createLogger({ name: "crawl-adaptive-concurrency" });
const ADAPTIVE_LOCK_KEY = "cron:crawl-adaptive-concurrency";
const ADAPTIVE_LOCK_TTL_MS = 45_000;
const ADAPTIVE_STATE_CACHE_KEY = "crawl:adaptive-concurrency:state";
const ADAPTIVE_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

interface AdaptiveConcurrencyMetrics {
  taskCount: number;
  failedCount: number;
  errorRate: number;
  p95LatencyMs: number | null;
  memoryHeadroom: number | null;
  memorySampleCount: number;
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

@Injectable()
export class CrawlAdaptiveConcurrencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly crawlQueue: CrawlQueueService,
    private readonly crawlProcessor: CrawlQueueProcessor
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async adjustCron() {
    await this.cache.withLock(ADAPTIVE_LOCK_KEY, ADAPTIVE_LOCK_TTL_MS, async () =>
      this.adjustConcurrency(new Date())
    );
  }

  async getStatus(): Promise<CrawlAdaptiveConcurrencyStatus> {
    const settings = await this.crawlSettings.getSettings();
    const cached = await this.cache.get<AdaptiveConcurrencyState>(ADAPTIVE_STATE_CACHE_KEY);
    const thresholds: AdaptiveConcurrencyThresholds = {
      latencyRatio: settings.adaptiveLatencyThresholdRatio,
      errorRate: settings.adaptiveErrorRateThreshold,
      memoryHeadroom: settings.adaptiveMemoryHeadroomThreshold
    };

    return {
      enabled: settings.adaptiveConcurrencyEnabled,
      lastDecision: cached?.lastDecision ?? "idle",
      lastAdjustedAt: cached?.lastAdjustedAt ?? null,
      reason: cached?.reason ?? null,
      currentMaxConcurrency: settings.maxConcurrency,
      windowMinutes: settings.adaptiveWindowMinutes,
      cooldownMinutes: settings.adaptiveCooldownMinutes,
      thresholds,
      metrics:
        cached?.metrics ?? {
          taskCount: 0,
          failedCount: 0,
          errorRate: 0,
          p95LatencyMs: null,
          memoryHeadroom: null,
          memorySampleCount: 0
        }
    };
  }

  async adjustConcurrency(now: Date): Promise<void> {
    const settings = await this.crawlSettings.getSettings();
    const thresholds: AdaptiveConcurrencyThresholds = {
      latencyRatio: settings.adaptiveLatencyThresholdRatio,
      errorRate: settings.adaptiveErrorRateThreshold,
      memoryHeadroom: settings.adaptiveMemoryHeadroomThreshold
    };
    const metrics = await this.computeMetrics(now, settings.adaptiveWindowMinutes);

    if (!settings.adaptiveConcurrencyEnabled) {
      await this.persistState({
        enabled: false,
        lastDecision: "disabled",
        lastAdjustedAt: null,
        reason: "adaptive concurrency is disabled",
        currentMaxConcurrency: settings.maxConcurrency,
        updatedAt: now.toISOString(),
        metrics
      });
      return;
    }

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
    const rows = await this.prisma.crawlTask.findMany({
      where: {
        updatedAt: { gte: from },
        status: { in: [CrawlTaskStatus.completed, CrawlTaskStatus.failed] },
        lastRunAt: { not: null }
      },
      select: {
        status: true,
        lastRunAt: true,
        updatedAt: true,
        lastServerMemoryMb: true,
        lastPeakMemoryMb: true
      }
    });

    const latencies: number[] = [];
    let failedCount = 0;
    const headrooms: number[] = [];

    for (const row of rows) {
      if (row.status === CrawlTaskStatus.failed) {
        failedCount += 1;
      }

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
      taskCount: rows.length,
      failedCount,
      errorRate: rows.length > 0 ? failedCount / rows.length : 0,
      p95LatencyMs: this.computePercentile(latencies, 0.95),
      memoryHeadroom:
        headrooms.length > 0
          ? headrooms.reduce((sum, value) => sum + value, 0) / headrooms.length
          : null,
      memorySampleCount: headrooms.length
    };
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
}
