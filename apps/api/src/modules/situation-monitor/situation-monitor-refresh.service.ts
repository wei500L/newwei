import { Injectable } from "@nestjs/common";
import { CrawlTaskStatus, PipelineJobStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../config/prisma.service";
import { NewsSourceSchedulerService } from "../queue/news-source.scheduler.service";

import {
  OREF_POLL_JOB_NAME,
  TELEGRAM_POLL_JOB_NAME,
} from "./signals/situation-monitor-signals.constants";
import { SituationMonitorSignalsService } from "./signals/situation-monitor-signals.service";
import type { SituationMonitorWarning } from "./situation-monitor.service";

const INSIGHTS_CACHE_PREFIX = "situation-monitor:insights:";
const EXTERNAL_CACHE_PREFIX = "situation-monitor:external:";
const REFRESH_RUN_CACHE_KEY_PREFIX = "situation-monitor:refresh-run:";
const REFRESH_RUN_CACHE_TTL_SECONDS = 15 * 60;

type SituationMonitorRefreshLifecycleStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed";

interface SituationMonitorRefreshRunRecord {
  refreshId: string;
  orgId: string;
  requestedAt: string;
  taskWindowStart: string;
  activeSourceIds: string[];
  crawl: {
    attempted: boolean;
    permitted: boolean;
    activeSourceCount: number;
    scheduledSourceCount: number;
    schedulerTriggered: boolean;
    crawlTaskCount: number;
    analysisTaskCount: number;
    message: string;
  };
  signals: {
    telegram: SituationMonitorRefreshTaskResult;
    oref: SituationMonitorRefreshTaskResult;
  };
  cache: {
    insightsCleared: number;
    externalCleared: number;
  };
  warnings: SituationMonitorWarning[];
  terminal: boolean;
}

interface SituationMonitorRefreshProgressCounts {
  pending: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  paused?: number;
  delayed?: number;
}

export interface SituationMonitorRefreshRunResponse {
  refreshId: string;
  requestedAt: string;
  taskWindowStart: string;
  status: SituationMonitorRefreshLifecycleStatus;
  crawl: SituationMonitorRefreshResponse["crawl"];
  progress: {
    crawlTasks: SituationMonitorRefreshProgressCounts;
    analysisTasks: SituationMonitorRefreshProgressCounts;
  };
  signals: SituationMonitorRefreshResponse["signals"];
  cache: SituationMonitorRefreshResponse["cache"];
  warnings: SituationMonitorWarning[];
  terminal: boolean;
}

export interface SituationMonitorRefreshTaskResult {
  attempted: boolean;
  ok: boolean;
  message: string;
  durationMs: number;
}

export interface SituationMonitorRefreshResponse {
  refreshId: string;
  requestedAt: string;
  taskWindowStart: string;
  status: "accepted" | "partial";
  crawl: {
    attempted: boolean;
    permitted: boolean;
    activeSourceCount: number;
    scheduledSourceCount: number;
    schedulerTriggered: boolean;
    crawlTaskCount: number;
    analysisTaskCount: number;
    message: string;
  };
  signals: {
    telegram: SituationMonitorRefreshTaskResult;
    oref: SituationMonitorRefreshTaskResult;
  };
  cache: {
    insightsCleared: number;
    externalCleared: number;
  };
  warnings: SituationMonitorWarning[];
  terminal: boolean;
}

@Injectable()
export class SituationMonitorRefreshService {
  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
    private readonly scheduler: NewsSourceSchedulerService,
    private readonly signals: SituationMonitorSignalsService,
  ) {}

  async refresh(
    orgId: string,
    permissions: readonly string[],
  ): Promise<SituationMonitorRefreshResponse> {
    const warnings: SituationMonitorWarning[] = [];
    const refreshId = randomUUID();
    const requestedAt = new Date().toISOString();
    const taskWindowStart = new Date().toISOString();
    const canTriggerCrawl = permissions.includes("crawl.write");

    const [
      { count: insightsCleared },
      { count: externalCleared },
      activeSources,
    ] =
      await Promise.all([
        this.clearCachePrefix(INSIGHTS_CACHE_PREFIX, {
          code: "situation_monitor_insights_cache_clear_failed",
          source: "core",
          message: "Failed to clear Situation Monitor insights cache.",
        }, warnings),
        this.clearCachePrefix(EXTERNAL_CACHE_PREFIX, {
          code: "situation_monitor_external_cache_clear_failed",
          source: "external",
          message: "Failed to clear Situation Monitor external cache.",
        }, warnings),
        this.prisma.newsSource.findMany({
          where: {
            orgId,
            isActive: true,
          },
          select: {
            id: true,
          },
        }),
      ]);
    const activeSourceIds = activeSources.map((source) => source.id);
    const activeSourceCount = activeSourceIds.length;

    let crawlAttempted = false;
    let scheduledSourceCount = 0;
    let schedulerTriggered = false;
    let crawlTaskCount = 0;
    let analysisTaskCount = 0;
    let crawlMessage = "";

    if (!canTriggerCrawl) {
      crawlMessage =
        "You can refresh the view, but triggering crawl collection requires crawl.write permission.";
      warnings.push({
        code: "situation_monitor_crawl_permission_required",
        source: "crawl",
        severity: "warning",
        message: crawlMessage,
      });
    } else if (activeSourceCount === 0) {
      crawlMessage =
        "No active news sources are configured for this workspace, so no crawl jobs were queued.";
      warnings.push({
        code: "situation_monitor_no_active_sources",
        source: "crawl",
        severity: "warning",
        message: crawlMessage,
      });
    } else {
      crawlAttempted = true;
      try {
        const result = await this.prisma.newsSource.updateMany({
          where: {
            orgId,
            isActive: true,
          },
          data: {
            nextRunAt: new Date(),
            circuitOpenUntil: null,
            consecutiveFailures: 0,
          },
        });
        scheduledSourceCount = result.count;
        const dispatchResult = await this.scheduler.scheduleCron();

        if (dispatchResult === null) {
          crawlMessage = `Marked ${scheduledSourceCount} active news source${scheduledSourceCount === 1 ? "" : "s"} for refresh, but the crawl scheduler is already busy. Crawl and analysis will start on the next scheduler tick.`;
          warnings.push({
            code: "situation_monitor_crawl_scheduler_busy",
            source: "crawl",
            severity: "warning",
            message:
              "Situation Monitor crawl scheduler is already busy, so immediate dispatch was skipped.",
          });
        } else {
          schedulerTriggered = true;
          const [pipelineJobCount, queuedCrawlTaskCount] = await Promise.all([
            this.prisma.pipelineJob.count({
              where: {
                orgId,
                sourceId: { in: activeSourceIds },
                createdAt: { gte: new Date(taskWindowStart) },
              },
            }),
            this.prisma.crawlTask.count({
              where: {
                orgId,
                newsSourceId: { in: activeSourceIds },
                createdAt: { gte: new Date(taskWindowStart) },
              },
            }),
          ]);
          crawlTaskCount = queuedCrawlTaskCount;
          analysisTaskCount = Math.max(
            0,
            pipelineJobCount - queuedCrawlTaskCount,
          );
          crawlMessage = this.buildCrawlDispatchMessage({
            scheduledSourceCount,
            crawlTaskCount,
            analysisTaskCount,
          });
        }
      } catch (error) {
        crawlMessage = `Failed to queue crawl jobs: ${this.safeErrorMessage(error)}`;
        warnings.push({
          code: "situation_monitor_crawl_queue_failed",
          source: "crawl",
          severity: "error",
          message: "Failed to queue Situation Monitor crawl jobs.",
          detail: this.safeErrorMessage(error),
        });
      }
    }

    const telegram = await this.refreshTelegramSignal(warnings);
    const oref = await this.refreshOrefSignal(warnings);

    const record: SituationMonitorRefreshRunRecord = {
      refreshId,
      orgId,
      requestedAt,
      taskWindowStart,
      activeSourceIds,
      crawl: {
        attempted: crawlAttempted,
        permitted: canTriggerCrawl,
        activeSourceCount,
        scheduledSourceCount,
        schedulerTriggered,
        crawlTaskCount,
        analysisTaskCount,
        message: crawlMessage,
      },
      signals: {
        telegram,
        oref,
      },
      cache: {
        insightsCleared,
        externalCleared,
      },
      warnings: [...warnings],
      terminal: false,
    };
    await this.persistRefreshRun(record);
    const run = await this.getRefreshRun(orgId, refreshId);

    return {
      refreshId,
      requestedAt,
      taskWindowStart,
      status: warnings.length > 0 ? "partial" : "accepted",
      crawl: record.crawl,
      signals: {
        telegram,
        oref,
      },
      cache: {
        insightsCleared,
        externalCleared,
      },
      warnings,
      terminal: run?.terminal ?? false,
    };
  }

  async getRefreshRun(
    orgId: string,
    refreshId: string,
  ): Promise<SituationMonitorRefreshRunResponse | null> {
    const record = await this.cache.get<SituationMonitorRefreshRunRecord>(
      this.refreshRunCacheKey(refreshId),
    );
    if (!record || record.orgId !== orgId) {
      return null;
    }

    const taskWindowStart = new Date(record.taskWindowStart);
    const sourceFilter =
      record.activeSourceIds.length > 0 ? { in: record.activeSourceIds } : null;

    const [
      crawlPending,
      crawlQueued,
      crawlRunning,
      crawlCompleted,
      crawlFailed,
      crawlPaused,
      analysisPending,
      analysisQueued,
      analysisRunning,
      analysisCompleted,
      analysisFailed,
      analysisDelayed,
    ] = await Promise.all([
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.pending),
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.queued),
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.running),
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.completed),
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.failed),
      this.countCrawlTasks(orgId, taskWindowStart, sourceFilter, CrawlTaskStatus.paused),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.pending),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.queued),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.running),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.completed),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.failed),
      this.countPipelineJobs(orgId, taskWindowStart, sourceFilter, PipelineJobStatus.delayed),
    ]);

    const crawlTasks = {
      pending: crawlPending,
      queued: crawlQueued,
      running: crawlRunning,
      completed: crawlCompleted,
      failed: crawlFailed,
      paused: crawlPaused,
    } satisfies SituationMonitorRefreshProgressCounts;
    const analysisTasks = {
      pending: analysisPending,
      queued: analysisQueued,
      running: analysisRunning,
      completed: analysisCompleted,
      failed: analysisFailed,
      delayed: analysisDelayed,
    } satisfies SituationMonitorRefreshProgressCounts;

    const activeTaskCount =
      crawlPending +
      crawlQueued +
      crawlRunning +
      analysisPending +
      analysisQueued +
      analysisRunning +
      analysisDelayed;

    const hasErrors =
      record.warnings.some((warning) => warning.severity === "error") ||
      crawlFailed > 0 ||
      analysisFailed > 0;
    const hasWarnings = record.warnings.length > 0;
    const hasAnyTasks =
      record.crawl.crawlTaskCount > 0 ||
      record.crawl.analysisTaskCount > 0 ||
      crawlCompleted > 0 ||
      crawlFailed > 0 ||
      crawlPaused > 0 ||
      analysisCompleted > 0 ||
      analysisFailed > 0 ||
      analysisDelayed > 0;
    const terminal =
      activeTaskCount === 0 &&
      (record.crawl.activeSourceCount === 0 ||
        !record.crawl.permitted ||
        !record.crawl.attempted ||
        hasAnyTasks ||
        !record.crawl.schedulerTriggered);

    let status: SituationMonitorRefreshLifecycleStatus;
    if (activeTaskCount > 0) {
      status = hasAnyTasks ? "running" : "queued";
    } else if (hasErrors) {
      status = "failed";
    } else if (hasWarnings) {
      status = "partial";
    } else {
      status = "completed";
    }

    if (terminal !== record.terminal) {
      record.terminal = terminal;
      await this.persistRefreshRun(record);
    }

    return {
      refreshId: record.refreshId,
      requestedAt: record.requestedAt,
      taskWindowStart: record.taskWindowStart,
      status,
      crawl: record.crawl,
      progress: {
        crawlTasks,
        analysisTasks,
      },
      signals: record.signals,
      cache: record.cache,
      warnings: record.warnings,
      terminal,
    };
  }

  private async clearCachePrefix(
    prefix: string,
    warningTemplate: Pick<SituationMonitorWarning, "code" | "message" | "source">,
    warnings: SituationMonitorWarning[],
  ): Promise<{ count: number }> {
    try {
      return { count: await this.cache.delByPrefix(prefix) };
    } catch (error) {
      warnings.push({
        ...warningTemplate,
        severity: "warning",
        detail: this.safeErrorMessage(error),
      });
      return { count: 0 };
    }
  }

  private async refreshTelegramSignal(
    warnings: SituationMonitorWarning[],
  ): Promise<SituationMonitorRefreshTaskResult> {
    const startedAt = Date.now();
    try {
      await this.signals.runJob(TELEGRAM_POLL_JOB_NAME);
      const feed = await this.signals.getTelegramFeed({ limit: 1 });
      const message =
        feed.error ??
        (feed.updatedAt
          ? `Telegram refresh completed at ${feed.updatedAt}.`
          : "Telegram refresh completed.");
      if (feed.error) {
        warnings.push({
          code: "situation_monitor_telegram_refresh_failed",
          source: "telegram",
          severity: "warning",
          message: feed.error,
        });
      }
      return {
        attempted: true,
        ok: !feed.error,
        message,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = this.safeErrorMessage(error);
      warnings.push({
        code: "situation_monitor_telegram_refresh_failed",
        source: "telegram",
        severity: "error",
        message: "Failed to refresh Telegram signals.",
        detail: message,
      });
      return {
        attempted: true,
        ok: false,
        message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private async refreshOrefSignal(
    warnings: SituationMonitorWarning[],
  ): Promise<SituationMonitorRefreshTaskResult> {
    const startedAt = Date.now();
    try {
      await this.signals.runJob(OREF_POLL_JOB_NAME);
      const alerts = await this.signals.getOrefAlerts();
      const message =
        alerts.error ??
        (alerts.timestamp
          ? `OREF refresh completed at ${alerts.timestamp}.`
          : "OREF refresh completed.");
      if (alerts.error) {
        warnings.push({
          code: "situation_monitor_oref_refresh_failed",
          source: "oref",
          severity: "warning",
          message: alerts.error,
        });
      }
      return {
        attempted: true,
        ok: !alerts.error,
        message,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = this.safeErrorMessage(error);
      warnings.push({
        code: "situation_monitor_oref_refresh_failed",
        source: "oref",
        severity: "error",
        message: "Failed to refresh OREF signals.",
        detail: message,
      });
      return {
        attempted: true,
        ok: false,
        message,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private safeErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    return "Request failed";
  }

  private buildCrawlDispatchMessage(input: {
    scheduledSourceCount: number;
    crawlTaskCount: number;
    analysisTaskCount: number;
  }) {
    const scheduledLabel = `Marked ${input.scheduledSourceCount} active news source${input.scheduledSourceCount === 1 ? "" : "s"} for refresh`;
    if (input.crawlTaskCount === 0 && input.analysisTaskCount === 0) {
      return `${scheduledLabel}, but this scheduler tick did not queue any new crawl or analysis tasks.`;
    }

    return `${scheduledLabel} and immediately queued ${input.crawlTaskCount} crawl task${input.crawlTaskCount === 1 ? "" : "s"} plus ${input.analysisTaskCount} direct analysis task${input.analysisTaskCount === 1 ? "" : "s"}.`;
  }

  private async persistRefreshRun(
    record: SituationMonitorRefreshRunRecord,
  ): Promise<void> {
    await this.cache.set(
      this.refreshRunCacheKey(record.refreshId),
      record,
      REFRESH_RUN_CACHE_TTL_SECONDS,
    );
  }

  private refreshRunCacheKey(refreshId: string): string {
    return `${REFRESH_RUN_CACHE_KEY_PREFIX}${refreshId}`;
  }

  private async countCrawlTasks(
    orgId: string,
    taskWindowStart: Date,
    newsSourceId: { in: string[] } | null,
    status: CrawlTaskStatus,
  ): Promise<number> {
    if (!newsSourceId) {
      return 0;
    }
    return await this.prisma.crawlTask.count({
      where: {
        orgId,
        ...(newsSourceId ? { newsSourceId } : {}),
        createdAt: { gte: taskWindowStart },
        status,
      },
    });
  }

  private async countPipelineJobs(
    orgId: string,
    taskWindowStart: Date,
    sourceId: { in: string[] } | null,
    status: PipelineJobStatus,
  ): Promise<number> {
    if (!sourceId) {
      return 0;
    }
    return await this.prisma.pipelineJob.count({
      where: {
        orgId,
        ...(sourceId ? { sourceId } : {}),
        createdAt: { gte: taskWindowStart },
        status,
      },
    });
  }
}
