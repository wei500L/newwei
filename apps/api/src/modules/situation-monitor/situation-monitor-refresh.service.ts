import { Injectable } from "@nestjs/common";

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

export interface SituationMonitorRefreshTaskResult {
  attempted: boolean;
  ok: boolean;
  message: string;
  durationMs: number;
}

export interface SituationMonitorRefreshResponse {
  requestedAt: string;
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
    const requestedAt = new Date().toISOString();
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
        const taskWindowStart = new Date();
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
                createdAt: { gte: taskWindowStart },
              },
            }),
            this.prisma.crawlTask.count({
              where: {
                orgId,
                newsSourceId: { in: activeSourceIds },
                createdAt: { gte: taskWindowStart },
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

    return {
      requestedAt,
      status: warnings.length > 0 ? "partial" : "accepted",
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
      warnings,
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
}
