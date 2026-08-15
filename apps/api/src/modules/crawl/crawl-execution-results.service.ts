import {
  createLogger,
  NotificationPresentationKind,
} from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";
import { NotificationType } from "@prisma/client";

import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { pickBoolean, pickNumber, pickString } from "./crawl-execution.helpers";
import type { CrawlClassifiedResult, PartitionedCrawlerResults } from "./crawl-execution.types";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import type {
  CrawlExecutionSummary,
  CrawlFailureDetail,
  CrawlMemoryStats,
} from "./crawl.types";
import type { Crawl4aiArticle, Crawl4aiResponse } from "./crawl4ai.client";
import { NewsSourceOpsSnapshotService } from "./news-source-ops-snapshot.service";

const logger = createLogger({ name: "crawl-execution-service" });

@Injectable()
export class CrawlExecutionResultsService {
  private readonly retryableStatusCodes = new Set([
    408, 423, 425, 429, 500, 502, 503, 504,
  ]);
  private readonly pipelineJobIdMaxLength = 128;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly resultService: CrawlResultService,
    private readonly notifications: NotificationsService,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
  ) {}

  async safeNotifyCrawl(
    task: CrawlTask,
    summary: CrawlExecutionSummary,
    triggeredById: string,
    status: "completed" | "failed",
    errorMessage?: string,
  ): Promise<void> {
    const truncateVarchar191 = (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length <= 191) {
        return trimmed;
      }
      return `${trimmed.slice(0, 190).trimEnd()}…`;
    };

    const lastResultAt = summary.lastFetchedAt
      ? summary.lastFetchedAt.toISOString()
      : null;
    const title = truncateVarchar191(
      `${status === "completed" ? "Crawl completed" : "Crawl failed"}: ${task.displayName ?? task.targetUrl}`,
    );
    const body =
      status === "completed"
        ? truncateVarchar191(
            `Inserted ${summary.inserted}, skipped ${summary.skipped}${
              summary.retryableFailures
                ? `, retryable ${summary.retryableFailures}`
                : ""
            }`,
          )
        : errorMessage
          ? truncateVarchar191(errorMessage)
          : "Crawl task failed";

    const taskLabel = task.displayName ?? task.targetUrl;
    const payload = {
      orgId: task.orgId,
      userId: triggeredById,
      type:
        status === "completed"
          ? NotificationType.crawl_completed
          : NotificationType.crawl_failed,
      title,
      body,
      data: {
        taskId: task.id,
        status,
        lastResultAt,
        presentation: {
          kind:
            status === "completed"
              ? NotificationPresentationKind.CrawlCompleted
              : NotificationPresentationKind.CrawlFailed,
          params: {
            taskId: task.id,
            taskLabel,
            inserted: summary.inserted,
            skipped: summary.skipped,
            ...(summary.retryableFailures
              ? { retryableFailures: summary.retryableFailures }
              : {}),
            ...(lastResultAt ? { lastResultAt } : {}),
          },
          ...(status === "failed" && errorMessage
            ? { technicalDetail: errorMessage }
            : {}),
        },
      },
    };

    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.notifications.notify(payload);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts) {
          break;
        }
        const delayMs = Math.min(250 * 2 ** (attempt - 1), 2_000);
        logger.warn(
          { taskId: task.id, attempt, maxAttempts, delayMs, error },
          "Failed to send crawl notification, retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    logger.error(
      { taskId: task.id, attempts: maxAttempts, error: lastError },
      "Failed to send crawl notification after retries",
    );

    await writeTaskLogBestEffort({
      queue: CRAWL_QUEUE_NAME,
      jobId: task.id,
      orgId: task.orgId,
      stage: "notify",
      status: "failed",
      message: "crawl notification delivery failed",
      data: {
        taskId: task.id,
        status,
        notificationType: payload.type,
      },
      error: {
        message:
          lastError instanceof Error ? lastError.message : String(lastError),
      },
    });
  }

  extractMemoryStats(
    response: Crawl4aiResponse,
  ): CrawlMemoryStats | undefined {
    if (
      response.serverMemoryMb === undefined &&
      response.peakMemoryMb === undefined &&
      response.memoryEfficiency === undefined
    ) {
      return undefined;
    }
    return {
      serverMemoryMb: response.serverMemoryMb,
      peakMemoryMb: response.peakMemoryMb,
      efficiencyPercent: response.memoryEfficiency,
    };
  }

  partitionCrawlerResults(
    items?: Crawl4aiArticle[],
  ): PartitionedCrawlerResults {
    const successes: Crawl4aiArticle[] = [];
    const failures: CrawlFailureDetail[] = [];
    const lowSignalCandidates: Crawl4aiArticle[] = [];

    if (!items || items.length === 0) {
      return { successes, failures, lowSignalCandidates };
    }

    for (const item of items) {
      const resultStatus = this.classifyResult(item);
      if (resultStatus.kind === "success") {
        successes.push(item);
      } else if (resultStatus.kind === "low_signal") {
        lowSignalCandidates.push(item);
        failures.push(this.buildFailureDetail(item, resultStatus));
      } else {
        failures.push(this.buildFailureDetail(item, resultStatus));
      }
    }

    return { successes, failures, lowSignalCandidates };
  }

  private classifyResult(item: Crawl4aiArticle): CrawlClassifiedResult {
    const markdownResult = this.resultService.extractMarkdownResult(
      item.markdown,
    );
    const markdownPrimary = markdownResult.primary;
    const markdownText =
      typeof markdownPrimary === "string" ? markdownPrimary.trim() : "";
    const hasMarkdown = markdownText.length > 0;
    const lowSignalMarkdown = hasMarkdown
      ? this.resultService.isLowSignalMarkdown(markdownText)
      : true;
    const statusCode = this.extractStatusCode(item);
    const isChallengePage =
      typeof markdownPrimary === "string" &&
      this.resultService.isLikelyBotChallengeMarkdown(markdownPrimary);

    if (
      typeof statusCode === "number" &&
      Number.isFinite(statusCode) &&
      statusCode >= 400
    ) {
      return {
        kind: "failure",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }

    if (isChallengePage) {
      return {
        kind: "failure",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }

    if (lowSignalMarkdown) {
      return {
        kind: "low_signal",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }

    if (typeof item.success === "boolean") {
      return {
        kind: item.success && hasMarkdown ? "success" : "failure",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }
    const inlineSuccess = pickBoolean(item as Record<string, unknown>, [
      "success",
      "isSuccess",
      "ok",
    ]);
    if (typeof inlineSuccess === "boolean") {
      return {
        kind: inlineSuccess && hasMarkdown ? "success" : "failure",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }
    const metadataSuccess = pickBoolean(
      item.metadata as Record<string, unknown> | undefined,
      ["success", "isSuccess", "ok"],
    );
    if (typeof metadataSuccess === "boolean") {
      return {
        kind: metadataSuccess && hasMarkdown ? "success" : "failure",
        hasMarkdown,
        lowSignalMarkdown,
        isChallengePage,
        statusCode,
      };
    }
    return {
      kind: hasMarkdown ? "success" : "failure",
      hasMarkdown,
      lowSignalMarkdown,
      isChallengePage,
      statusCode,
    };
  }

  private buildFailureDetail(
    item: Crawl4aiArticle,
    classified?: CrawlClassifiedResult,
  ): CrawlFailureDetail {
    const classification = classified ?? this.classifyResult(item);
    const statusCode = classification.statusCode;
    const errorMessage = this.extractErrorMessage(item);
    const fallbackMessage = this.buildDefaultFailureMessage(
      classification.hasMarkdown,
      statusCode,
      classification.isChallengePage,
      classification.lowSignalMarkdown,
    );
    return {
      url:
        item.url ??
        pickString(item.metadata as Record<string, unknown> | undefined, [
          "url",
        ]),
      statusCode,
      error: errorMessage ?? fallbackMessage,
      retryable: this.isRetryableStatus(
        statusCode,
        errorMessage ?? fallbackMessage,
      ),
    };
  }

  buildExpansionSeedCandidates(
    successes: Crawl4aiArticle[],
    lowSignalCandidates: Crawl4aiArticle[],
  ): Crawl4aiArticle[] {
    if (successes.length > 0) {
      return successes;
    }
    return lowSignalCandidates;
  }

  private buildDefaultFailureMessage(
    hasMarkdown: boolean,
    statusCode?: number,
    isChallengePage = false,
    isLowSignalMarkdown = false,
  ): string {
    if (isChallengePage) {
      if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
        return `crawl4ai received HTTP ${statusCode} and captured an anti-bot verification page instead of article content.`;
      }
      return "crawl4ai captured an anti-bot verification page instead of article content.";
    }

    if (
      typeof statusCode === "number" &&
      Number.isFinite(statusCode) &&
      statusCode >= 400
    ) {
      if (statusCode === 401 || statusCode === 403) {
        return `crawl4ai received HTTP ${statusCode}; target may be blocked by anti-bot or require verification/login.`;
      }
      return `crawl4ai received HTTP ${statusCode} from target URL.`;
    }

    if (hasMarkdown) {
      if (isLowSignalMarkdown) {
        return "crawl4ai returned low-signal markdown (reference-only/placeholder content). Triggering fallback and detail expansion.";
      }
      return "Unknown crawl error";
    }

    return "crawl4ai returned an empty markdown result. Check wordCountThreshold/cssSelector/cleanMarkdown and pruning settings.";
  }

  private extractStatusCode(item: Crawl4aiArticle): number | undefined {
    return (
      pickNumber(item as Record<string, unknown>, [
        "statusCode",
        "status_code",
      ]) ??
      pickNumber(item.metadata as Record<string, unknown> | undefined, [
        "statusCode",
        "status_code",
        "status",
      ])
    );
  }

  private extractErrorMessage(item: Crawl4aiArticle): string | undefined {
    return (
      pickString(item as Record<string, unknown>, [
        "error",
        "errorMessage",
        "error_message",
      ]) ??
      pickString(item.metadata as Record<string, unknown> | undefined, [
        "error",
        "error_message",
        "message",
      ])
    );
  }

  isRetryableStatus(
    statusCode?: number,
    errorMessage?: string,
  ): boolean {
    if (statusCode && this.retryableStatusCodes.has(statusCode)) {
      return true;
    }
    if (!errorMessage) {
      return false;
    }
    const normalized = errorMessage.toLowerCase();
    return [
      "timeout",
      "temporarily",
      "rate limit",
      "connection reset",
      "connection refused",
    ].some((needle) => normalized.includes(needle));
  }

  extractPipelineJobId(config: Prisma.JsonValue | null): string | null {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }
    const raw = (config as Record<string, unknown>).pipelineJobId;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) {
      return null;
    }
    return trimmed.slice(0, this.pipelineJobIdMaxLength);
  }

  extractPipelineSourceId(
    config: Prisma.JsonValue | null,
  ): string | null {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }
    const record = config as Record<string, unknown>;
    const directSourceIdRaw = record.sourceId;
    const directSourceId =
      typeof directSourceIdRaw === "string" ? directSourceIdRaw.trim() : "";
    if (directSourceId) {
      return directSourceId;
    }

    const itemPayload = record.itemPayload;
    if (
      !itemPayload ||
      typeof itemPayload !== "object" ||
      Array.isArray(itemPayload)
    ) {
      return null;
    }
    const metadata = (itemPayload as Record<string, unknown>).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return null;
    }
    const raw = (metadata as Record<string, unknown>).sourceId;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : null;
  }

  private computeExponentialBackoffDelayMs(
    baseDelayMs: number,
    attempt: number,
    maxDelayMs: number,
  ) {
    const normalizedAttempt = Math.max(1, Math.floor(attempt));
    const exponential = baseDelayMs * 2 ** Math.max(0, normalizedAttempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    const jitterFactor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
  }

  async markSourceFailureState(options: {
    sourceId: string;
    failureAt: Date;
  }) {
    const cfg = this.env.newsSourceSchedulerConfig;
    const threshold = Math.max(0, Math.floor(cfg.circuitBreakerThreshold));
    const autoDisableThresholdRaw = cfg.autoDisableThreshold;
    const autoDisableThreshold = Number.isFinite(autoDisableThresholdRaw)
      ? Math.max(0, Math.floor(autoDisableThresholdRaw))
      : 0;

    const { notifyCircuitOpen, notifyAutoDisable } =
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.newsSource.findUnique({
          where: { id: options.sourceId },
          select: {
            consecutiveFailures: true,
            isActive: true,
            orgId: true,
            name: true,
          },
        });
        if (!existing?.isActive) {
          return { notifyCircuitOpen: null, notifyAutoDisable: null };
        }

        const previousFailures = Number(existing.consecutiveFailures ?? 0);
        const consecutiveFailures = previousFailures + 1;

        const retryDelayMs = this.computeExponentialBackoffDelayMs(
          cfg.failureRecoveryDelayMs,
          consecutiveFailures,
          cfg.failureMaxDelayMs,
        );
        const retryAt = new Date(options.failureAt.getTime() + retryDelayMs);

        let circuitOpenUntil: Date | null = null;
        if (threshold > 0 && consecutiveFailures >= threshold) {
          const circuitAttempt = consecutiveFailures - threshold + 1;
          const circuitDelayMs = this.computeExponentialBackoffDelayMs(
            cfg.circuitBreakerBaseDelayMs,
            circuitAttempt,
            cfg.circuitBreakerMaxDelayMs,
          );
          circuitOpenUntil = new Date(
            options.failureAt.getTime() + circuitDelayMs,
          );
        }

        let notifyCircuitOpen: {
          orgId: string;
          name: string;
          circuitOpenUntil: Date;
        } | null = null;
        if (
          threshold > 0 &&
          consecutiveFailures === threshold &&
          circuitOpenUntil
        ) {
          notifyCircuitOpen = {
            orgId: existing.orgId,
            name: existing.name,
            circuitOpenUntil,
          };
        }

        const nextRunAt =
          circuitOpenUntil && circuitOpenUntil.getTime() > retryAt.getTime()
            ? circuitOpenUntil
            : retryAt;

        const shouldDisable =
          autoDisableThreshold > 0 &&
          consecutiveFailures >= autoDisableThreshold;
        let notifyAutoDisable: {
          orgId: string;
          name: string;
          failures: number;
        } | null = null;
        if (shouldDisable && consecutiveFailures === autoDisableThreshold) {
          notifyAutoDisable = {
            orgId: existing.orgId,
            name: existing.name,
            failures: consecutiveFailures,
          };
        }

        await tx.newsSource.update({
          where: { id: options.sourceId },
          data: {
            lastFailureAt: options.failureAt,
            consecutiveFailures,
            circuitOpenUntil,
            nextRunAt: shouldDisable ? null : nextRunAt,
            isActive: shouldDisable ? false : undefined,
          },
        });

        return { notifyCircuitOpen, notifyAutoDisable };
      });

    if (notifyCircuitOpen) {
      try {
        await this.notifications.notify({
          orgId: notifyCircuitOpen.orgId,
          userId: null,
          type: NotificationType.system,
          title: "News source circuit opened",
          body: `News source "${notifyCircuitOpen.name}" reached ${threshold} consecutive failures and is paused until ${notifyCircuitOpen.circuitOpenUntil.toISOString()}.`,
          data: {
            sourceId: options.sourceId,
            sourceName: notifyCircuitOpen.name,
            consecutiveFailures: threshold,
            circuitOpenUntil: notifyCircuitOpen.circuitOpenUntil.toISOString(),
            presentation: {
              kind: NotificationPresentationKind.NewsSourceCircuitOpened,
              params: {
                sourceId: options.sourceId,
                sourceName: notifyCircuitOpen.name,
                consecutiveFailures: threshold,
                circuitOpenUntil:
                  notifyCircuitOpen.circuitOpenUntil.toISOString(),
              },
            },
          },
        });
      } catch (error) {
        logger.warn(
          { error, sourceId: options.sourceId, orgId: notifyCircuitOpen.orgId },
          "Failed to notify circuit open for news source",
        );
      }
    }

    if (notifyAutoDisable) {
      try {
        await this.notifications.notify({
          orgId: notifyAutoDisable.orgId,
          userId: null,
          type: NotificationType.system,
          title: "News source disabled after failures",
          body: `News source "${notifyAutoDisable.name}" was disabled after ${notifyAutoDisable.failures} consecutive failures.`,
          data: {
            sourceId: options.sourceId,
            consecutiveFailures: notifyAutoDisable.failures,
            sourceName: notifyAutoDisable.name,
            presentation: {
              kind: NotificationPresentationKind.NewsSourceAutoDisabled,
              params: {
                sourceId: options.sourceId,
                sourceName: notifyAutoDisable.name,
                consecutiveFailures: notifyAutoDisable.failures,
              },
            },
          },
        });
      } catch (error) {
        logger.warn(
          { error, sourceId: options.sourceId, orgId: notifyAutoDisable.orgId },
          "Failed to notify auto-disable for news source",
        );
      }
    }
  }

  async syncSourceQueueCounts(orgId: string, sourceId?: string | null) {
    if (!sourceId || !this.newsSourceOpsSnapshots) {
      return;
    }
    try {
      await this.newsSourceOpsSnapshots.syncQueueCounts(orgId, sourceId);
    } catch (error) {
      logger.warn(
        { error, orgId, sourceId },
        "Failed to sync news source queue counts",
      );
    }
  }
}
