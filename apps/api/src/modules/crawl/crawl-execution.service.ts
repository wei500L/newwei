import { createLogger, sanitizeError } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { Prisma } from "@prisma/client";
import { PipelineJobStatus } from "@prisma/client";

import { PrismaService } from "../config/prisma.service";
import { ItemsService } from "../items/items.service";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { CrawlAntiBotService } from "./crawl-anti-bot.service";
import { CrawlConditionalPreflightService } from "./crawl-conditional-preflight.service";
import { assertNoUnsupportedProxy } from "./crawl-config-policy";
import { CrawlDetailExpansionService } from "./crawl-detail-expansion.service";
import { CrawlExecutionResultsService } from "./crawl-execution-results.service";
import type { CrawlExecutionRetryContext } from "./crawl-execution.types";
import { CrawlOptionsNormalizerService } from "./crawl-options-normalizer.service";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import type {
  CrawlExecutionSummary,
  CrawlFailureDetail,
  CrawlTaskOptions,
} from "./crawl.types";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";
import type { Crawl4aiArticle, Crawl4aiResponse } from "./crawl4ai.client";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { extractUrlQueryParamAllowlistFromTaskConfig } from "./url-fingerprint";

export type { CrawlExecutionRetryContext } from "./crawl-execution.types";

const logger = createLogger({ name: "crawl-execution-service" });

@Injectable()
export class CrawlExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resultService: CrawlResultService,
    private readonly moduleRef: ModuleRef,
    private readonly preflight: CrawlConditionalPreflightService,
    private readonly antiBot: CrawlAntiBotService,
    private readonly detailExpansion: CrawlDetailExpansionService,
    private readonly optionsNormalizer: CrawlOptionsNormalizerService,
    private readonly executionResults: CrawlExecutionResultsService,
  ) {}

  async runTask(
    taskId: string,
    orgId: string,
    triggeredById?: string,
    retryContext?: CrawlExecutionRetryContext,
  ): Promise<CrawlExecutionSummary> {
    const task = await this.prisma.crawlTask.findFirst({
      where: { id: taskId, orgId },
    });
    if (!task) {
      logger.warn({ taskId }, "Attempted to run missing crawl task");
      return {
        inserted: 0,
        skipped: 0,
      };
    }

    const pipelineJobId = this.executionResults.extractPipelineJobId(task.config);
    const sourceId =
      task.newsSourceId ?? this.executionResults.extractPipelineSourceId(task.config);

    await this.prisma.crawlTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        lastRunAt: new Date(),
      },
    });
    await this.executionResults.syncSourceQueueCounts(orgId, sourceId);

    try {
      const configRecord =
        task.config &&
        typeof task.config === "object" &&
        !Array.isArray(task.config)
          ? (task.config as Record<string, unknown>)
          : null;
      assertNoUnsupportedProxy(configRecord, "task.config");
      const options = this.optionsNormalizer.extractOptions(
        configRecord as Prisma.JsonValue | null,
      );
      const requestTimeoutMs = this.preflight.normalizeRequestTimeoutMs(
        retryContext?.requestTimeoutMs,
      );
      const urlQueryParamAllowlist =
        extractUrlQueryParamAllowlistFromTaskConfig(task.config);
      const conditionalRequestSettings =
        await this.preflight.getConditionalRequestSettings();
      assertNoCrawl4aiLlmOptions(options, "task.config.options");
      const ingestToItems = configRecord?.ingestToItems === true;
      let effectiveOptions = this.optionsNormalizer.ensureTaskSessionReuse(task.id, options);
      const payload = this.optionsNormalizer.buildRequestPayload(task, effectiveOptions);
      effectiveOptions = payload.options ?? effectiveOptions;
      const payloadUrls =
        Array.isArray(payload.urls) && payload.urls.length > 0
          ? payload.urls
          : [task.targetUrl];
      if (!Array.isArray(payload.urls) || payload.urls.length === 0) {
        payload.urls = payloadUrls;
      }
      const isSingleUrlPayload = payloadUrls.length <= 1;
      const latestHttpValidationState =
        await this.preflight.findLatestResultHttpValidationState({
          taskId: task.id,
          targetUrl: task.targetUrl,
          urlQueryParamAllowlist,
        });
      const preflightResult = this.preflight.shouldRunConditionalPreflight(
        conditionalRequestSettings.enabled,
      )
        ? await this.preflight.runConditionalPreflight({
            targetUrl: task.targetUrl,
            options: effectiveOptions,
            requestTimeoutMs,
            etag: latestHttpValidationState?.etag,
            lastModified: latestHttpValidationState?.lastModified,
            timeoutMs: conditionalRequestSettings.timeoutMs,
            maxRetries: conditionalRequestSettings.maxRetries,
          })
        : null;
      if (preflightResult) {
        if (preflightResult.status === "completed") {
          await this.safeCreateTaskLog({
            queue: CRAWL_QUEUE_NAME,
            jobId: taskId,
            orgId,
            stage: "preflight",
            status: "completed",
            message: "HTTP validator preflight completed",
            data: {
              method: preflightResult.result.method,
              status: preflightResult.result.status,
              attempts: preflightResult.attempts,
              failures: preflightResult.failures,
              etag: preflightResult.result.etag ?? null,
              lastModified: preflightResult.result.lastModified ?? null,
              hasConditionalHeaders:
                Boolean(latestHttpValidationState?.etag) ||
                Boolean(latestHttpValidationState?.lastModified),
            },
          });
        } else {
          await this.safeCreateTaskLog({
            queue: CRAWL_QUEUE_NAME,
            jobId: taskId,
            orgId,
            stage: "preflight",
            status: "failed",
            message: "HTTP validator preflight failed",
            data: {
              attempts: preflightResult.attempts,
              failures: preflightResult.failures,
              hasConditionalHeaders:
                Boolean(latestHttpValidationState?.etag) ||
                Boolean(latestHttpValidationState?.lastModified),
            },
          });
        }
      }
      if (
        preflightResult?.status === "completed" &&
        preflightResult.result.status === 304 &&
        isSingleUrlPayload &&
        latestHttpValidationState?.resultId
      ) {
        const summary: CrawlExecutionSummary = {
          inserted: 0,
          skipped: 1,
          reusedResultId: latestHttpValidationState.resultId,
          lastFetchedAt: latestHttpValidationState.fetchedAt,
        };

        await this.safeCreateTaskLog({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          orgId,
          stage: "crawler",
          status: "completed",
          message: "Skipped crawl body extraction via HTTP 304 reuse",
          data: {
            reusedResultId: latestHttpValidationState.resultId,
            status: preflightResult.result.status,
            etag:
              preflightResult.result.etag ??
              latestHttpValidationState.etag ??
              null,
            lastModified:
              preflightResult.result.lastModified ??
              latestHttpValidationState.lastModified ??
              null,
          },
        });

        await this.prisma.crawlTask.update({
          where: { id: task.id },
          data: {
            status: "completed",
            runCount: { increment: 1 },
            lastSuccessAt: new Date(),
            lastResultAt: latestHttpValidationState.fetchedAt,
            lastError: null,
          },
        });
        await this.executionResults.syncSourceQueueCounts(orgId, sourceId);

        await this.safeCreateTaskLog({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          orgId,
          stage: "complete",
          status: "completed",
          data: summary,
        });

        if (triggeredById) {
          await this.executionResults.safeNotifyCrawl(task, summary, triggeredById, "completed");
        }

        // 304 reuse skips persistResults entirely, so an ingestToItems task
        // whose reused result was never ingested (fresh switch, or a reuse of
        // a pre-ingest history run) would silently never reach the pipeline.
        // createFromCrawlResultsBatch is idempotent, so re-running it is safe.
        if (ingestToItems && latestHttpValidationState.resultId) {
          try {
            const itemsService = this.moduleRef.get(ItemsService, {
              strict: false,
            });
            await itemsService.createFromCrawlResultsBatch(
              orgId,
              triggeredById ?? task.createdById,
              { crawlResultIds: [latestHttpValidationState.resultId] },
            );
          } catch (error) {
            logger.warn(
              { err: error, taskId, resultId: latestHttpValidationState.resultId },
              "Failed to ingest reused crawl result on 304 path",
            );
          }
        }

        return summary;
      }
      const preflightMetadata = this.preflight.buildHttpValidationMetadata(
        preflightResult?.status === "completed" ? preflightResult.result : null,
      );
      const initialRun = await this.antiBot.runCrawlWithHeadedFallback({
        request: payload,
        options: effectiveOptions,
        requestTimeoutMs,
        taskId,
        orgId,
        stage: "crawler",
        reason: "initial_request",
      });
      let response = initialRun.response;
      effectiveOptions = initialRun.options;
      let { successes, failures, lowSignalCandidates } =
        this.executionResults.partitionCrawlerResults(response.results);

      const challengeRetryResult = await this.antiBot.retryForBotChallengeIfNeeded({
        task,
        taskId,
        orgId,
        options: effectiveOptions,
        response,
        successes,
        failures,
        lowSignalCandidates,
        requestTimeoutMs,
      });
      if (challengeRetryResult) {
        response = challengeRetryResult.response;
        successes = challengeRetryResult.successes;
        failures = challengeRetryResult.failures;
        lowSignalCandidates = challengeRetryResult.lowSignalCandidates;
        effectiveOptions = this.optionsNormalizer.ensureTaskSessionReuse(
          task.id,
          challengeRetryResult.options,
        );
      }

      if (this.antiBot.shouldAttemptEmptyMarkdownFallback(successes, failures)) {
        const fallbackProfiles =
          this.antiBot.buildEmptyMarkdownFallbackProfiles(effectiveOptions);
        const fallbackAttempts: Record<string, unknown>[] = [];
        const fallbackCandidates: {
          label: string;
          options: CrawlTaskOptions;
          response: Crawl4aiResponse;
          successes: Crawl4aiArticle[];
          failures: CrawlFailureDetail[];
          lowSignalCandidates: Crawl4aiArticle[];
          qualityScore: number;
        }[] = [];

        for (const profile of fallbackProfiles) {
          try {
            const fallbackPayload = this.optionsNormalizer.buildRequestPayload(
              task,
              profile.options,
            );
            const fallbackRun = await this.antiBot.runCrawlWithHeadedFallback({
              request: fallbackPayload,
              options: fallbackPayload.options ?? profile.options,
              requestTimeoutMs,
              taskId,
              orgId,
              stage: "fallback",
              reason: `markdown_profile_${profile.label}`,
            });
            const fallbackOptions = fallbackRun.options;
            const fallbackResponse = fallbackRun.response;
            const fallbackPartition = this.executionResults.partitionCrawlerResults(
              fallbackResponse.results,
            );
            const qualityScore = this.antiBot.scoreMarkdownQuality(
              fallbackPartition.successes,
            );

            if (fallbackPartition.successes.length > 0) {
              fallbackCandidates.push({
                label: profile.label,
                options: fallbackOptions,
                response: fallbackResponse,
                successes: fallbackPartition.successes,
                failures: fallbackPartition.failures,
                lowSignalCandidates: fallbackPartition.lowSignalCandidates,
                qualityScore,
              });
            } else if (fallbackPartition.lowSignalCandidates.length > 0) {
              response = fallbackResponse;
              failures = fallbackPartition.failures;
              lowSignalCandidates = fallbackPartition.lowSignalCandidates;
              effectiveOptions = fallbackOptions;
            }
            fallbackAttempts.push({
              profile: profile.label,
              result: "completed",
              fallback: profile.summary,
              successes: fallbackPartition.successes.length,
              failures: fallbackPartition.failures.length,
              qualityScore,
              lowSignalCandidates: fallbackPartition.lowSignalCandidates.length,
              failureSamples: fallbackPartition.failures.slice(0, 5),
            });
          } catch (fallbackError) {
            fallbackAttempts.push({
              profile: profile.label,
              result: "failed",
              fallback: profile.summary,
              error: this.antiBot.extractCrawlErrorMessage(fallbackError) ?? null,
            });
          }
        }

        const bestFallback = fallbackCandidates.sort(
          (left, right) => right.qualityScore - left.qualityScore,
        )[0];
        if (bestFallback) {
          response = bestFallback.response;
          successes = bestFallback.successes;
          failures = bestFallback.failures;
          lowSignalCandidates = bestFallback.lowSignalCandidates;
          effectiveOptions = bestFallback.options;
        }

        if (fallbackAttempts.length > 0) {
          const completedFallbackAttempts = fallbackAttempts.filter(
            (entry) => entry.result === "completed",
          );
          const fallbackStatus =
            completedFallbackAttempts.length > 0 ? "completed" : "failed";
          await this.safeCreateTaskLog({
            queue: CRAWL_QUEUE_NAME,
            jobId: taskId,
            orgId,
            stage: "fallback",
            status: fallbackStatus,
            message: bestFallback
              ? `Selected markdown fallback profile: ${bestFallback.label}`
              : completedFallbackAttempts.length > 0
                ? "Markdown fallback completed without selecting an improved profile"
                : "Markdown fallback failed for all profiles",
            data: {
              selectedProfile: bestFallback?.label ?? null,
              selectedQualityScore: bestFallback?.qualityScore ?? null,
              selectedSuccesses: bestFallback?.successes.length ?? 0,
              selectedFailures: bestFallback?.failures.length ?? 0,
              attempts: fallbackAttempts.length,
              completedAttempts: completedFallbackAttempts.length,
              failedAttempts:
                fallbackAttempts.length - completedFallbackAttempts.length,
              profiles: fallbackAttempts,
            },
          });
        }
      }

      const expansionSeedCandidates = this.executionResults.buildExpansionSeedCandidates(
        successes,
        lowSignalCandidates,
      );
      const seededFromLowSignal =
        successes.length === 0 && expansionSeedCandidates.length > 0;
      const expansionResult = await this.detailExpansion.expandListLikeResultsIfNeeded({
        task,
        orgId,
        taskId,
        keywords: payload.keywords ?? [],
        crawlOptions: this.optionsNormalizer.ensureTaskSessionReuse(task.id, effectiveOptions),
        successes: expansionSeedCandidates,
        seededFromLowSignal,
        requestTimeoutMs,
      });
      if (expansionResult) {
        successes = expansionResult.successes;
        if (expansionResult.failures.length > 0) {
          failures = [...failures, ...expansionResult.failures];
        }
        if (expansionResult.runId) {
          response = {
            ...response,
            runId: expansionResult.runId,
          };
        }
      }
      const persistedSuccesses = this.preflight.attachHttpValidationMetadata(
        successes,
        preflightMetadata,
        task.targetUrl,
      );

      let failureRetryableCount = 0;

      if (failures.length > 0) {
        failureRetryableCount = failures.filter(
          (failure) => failure.retryable,
        ).length;
      }

      await this.safeCreateTaskLog({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "crawler",
        status: "completed",
        message:
          failures.length > 0
            ? "crawl4ai completed with partial failures"
            : response.warnings && response.warnings.length > 0
              ? "crawl4ai completed with warnings"
              : "crawl4ai request completed",
        data: {
          request: {
            urls: payloadUrls.length,
            scanFullPage: effectiveOptions.scanFullPage ?? false,
            scrollDelayMs: effectiveOptions.scrollDelayMs ?? null,
            virtualScroll: effectiveOptions.virtualScroll
              ? {
                  containerSelector:
                    effectiveOptions.virtualScroll.containerSelector ?? "body",
                  scrollCount:
                    effectiveOptions.virtualScroll.scrollCount ?? null,
                  scrollBy: effectiveOptions.virtualScroll.scrollBy ?? null,
                  waitAfterScrollMs:
                    effectiveOptions.virtualScroll.waitAfterScrollMs ?? null,
                }
              : null,
            onlyMainContent: effectiveOptions.onlyMainContent ?? null,
            wordCountThreshold: effectiveOptions.wordCountThreshold ?? null,
            includeImages: effectiveOptions.includeImages ?? null,
            storeMedia: effectiveOptions.storeMedia ?? null,
            waitForImages: effectiveOptions.waitForImages ?? null,
          },
          runId: response.runId ?? null,
          nextCursor: response.nextCursor ?? null,
          totalResults: response.results?.length ?? 0,
          successes: persistedSuccesses.length,
          failures: failures.length,
          retryableFailures: failureRetryableCount,
          warnings: response.warnings ?? [],
          warningCount: response.warnings?.length ?? 0,
          failureSamples: failures.slice(0, 10),
        },
      });

      const summary = await this.resultService.persistResults(
        task,
        persistedSuccesses,
        effectiveOptions,
        response.runId ?? undefined,
        this.executionResults.extractMemoryStats(response),
        ingestToItems
          ? {
              orgId,
              userId: triggeredById ?? task.createdById,
            }
          : undefined,
      );

      if (failures.length > 0) {
        summary.failures = failures;
        summary.retryableFailures = failureRetryableCount;
      }

      if (summary.inserted === 0 && summary.skipped === 0) {
        const firstFailure = failures[0];
        if (firstFailure) {
          const statusLabel =
            typeof firstFailure.statusCode === "number" &&
            Number.isFinite(firstFailure.statusCode)
              ? `HTTP ${firstFailure.statusCode}`
              : null;
          const urlLabel = firstFailure.url ? `${firstFailure.url}: ` : "";
          const statusPrefix = statusLabel ? `${statusLabel}: ` : "";
          const failureCountLabel =
            failures.length === 1 ? "1 failure" : `${failures.length} failures`;
          throw new Error(
            `crawl task produced no results (${failureCountLabel}). ${urlLabel}${statusPrefix}${firstFailure.error}`,
          );
        }
        throw new Error("crawl task produced no results (0 results returned)");
      }

      await this.prisma.crawlTask.update({
        where: { id: task.id },
        data: {
          status: "completed",
          runCount: { increment: 1 },
          lastSuccessAt: new Date(),
          lastResultAt: summary.lastFetchedAt ?? task.lastResultAt,
          lastCursor: response.nextCursor ?? task.lastCursor,
          lastError: null,
          lastServerMemoryMb:
            summary.memory?.serverMemoryMb ?? task.lastServerMemoryMb,
          lastPeakMemoryMb:
            summary.memory?.peakMemoryMb ?? task.lastPeakMemoryMb,
          lastMemoryEfficiency:
            summary.memory?.efficiencyPercent ?? task.lastMemoryEfficiency,
        },
      });
      await this.executionResults.syncSourceQueueCounts(orgId, sourceId);

      await this.safeCreateTaskLog({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "complete",
        status: "completed",
        data: summary,
      });

      if (triggeredById) {
        await this.executionResults.safeNotifyCrawl(task, summary, triggeredById, "completed");
      }

      return summary;
    } catch (error) {
      const message =
        error instanceof Crawl4aiRequestException
          ? error.message
          : error instanceof Error
            ? error.message
            : "crawl job failed";
      const normalizedMessage = (() => {
        const trimmed = message.trim();
        const fallback = trimmed.length > 0 ? trimmed : "crawl job failed";
        const maxLength = 4000;
        if (fallback.length <= maxLength) {
          return fallback;
        }
        return `${fallback.slice(0, maxLength - 1).trimEnd()}…`;
      })();

      const attempt = retryContext?.attempt;
      const maxAttempts = retryContext?.maxAttempts;
      const backoffDelayMs = retryContext?.backoffDelayMs;
      const retryable =
        error instanceof Crawl4aiRequestException
          ? this.executionResults.isRetryableStatus(error.status, error.message)
          : this.executionResults.isRetryableStatus(undefined, message);
      const shouldRetry =
        retryable &&
        typeof attempt === "number" &&
        Number.isFinite(attempt) &&
        typeof maxAttempts === "number" &&
        Number.isFinite(maxAttempts) &&
        attempt < maxAttempts;
      const nextRetryAt =
        shouldRetry &&
        typeof backoffDelayMs === "number" &&
        Number.isFinite(backoffDelayMs)
          ? new Date(Date.now() + Math.max(0, Math.round(backoffDelayMs)))
          : null;

      const crawlTaskStatus = shouldRetry ? "queued" : "failed";
      try {
        await this.prisma.crawlTask.update({
          where: { id: task.id },
          data: {
            status: crawlTaskStatus,
            lastError: normalizedMessage,
          },
        });
      } catch (updateError) {
        const maxVarchar191 = 191;
        const fallbackMessage =
          normalizedMessage.length <= maxVarchar191
            ? normalizedMessage
            : `${normalizedMessage.slice(0, maxVarchar191 - 1).trimEnd()}…`;
        logger.warn(
          { err: updateError, taskId: task.id, orgId },
          "Failed to persist crawl task error; retrying with truncated message",
        );
        await this.prisma.crawlTask
          .update({
            where: { id: task.id },
            data: {
              status: crawlTaskStatus,
              lastError: fallbackMessage,
            },
          })
          .catch((fallbackError) => {
            logger.error(
              { err: fallbackError, taskId: task.id, orgId },
              "Failed to persist crawl task error after truncation",
            );
          });
      }
      await this.executionResults.syncSourceQueueCounts(orgId, sourceId);
      await this.safeCreateTaskLog({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "error",
        status: "failed",
        error: sanitizeError(error, {
          redactSensitive: true,
        }),
        data: {
          attempt: attempt ?? null,
          maxAttempts: maxAttempts ?? null,
          backoffDelayMs: backoffDelayMs ?? null,
          retryable,
          willRetry: shouldRetry,
          nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null,
        },
      });

      if (pipelineJobId) {
        try {
          await this.prisma.pipelineJob.updateMany({
            where: { id: pipelineJobId },
            data: {
              status: shouldRetry
                ? PipelineJobStatus.delayed
                : PipelineJobStatus.failed,
              completedAt: shouldRetry ? null : new Date(),
              error: normalizedMessage,
              attempts:
                typeof attempt === "number" && Number.isFinite(attempt)
                  ? Math.max(0, attempt)
                  : 0,
            },
          });
        } catch (pipelineError) {
          logger.warn(
            { pipelineError, pipelineJobId, taskId: task.id, orgId },
            "Failed to update pipeline job status for crawl failure",
          );
        }
      }

      if (sourceId && pipelineJobId && !shouldRetry) {
        try {
          await this.executionResults.markSourceFailureState({
            sourceId,
            failureAt: new Date(),
          });
        } catch (sourceError) {
          logger.warn(
            { sourceError, sourceId, pipelineJobId, taskId: task.id, orgId },
            "Failed to update news source failure state for crawl failure",
          );
        }
      }

      if (triggeredById && !shouldRetry) {
        await this.executionResults.safeNotifyCrawl(
          task,
          { inserted: 0, skipped: 0 },
          triggeredById,
          "failed",
          normalizedMessage,
        );
      }
      throw error;
    }
  }

  public normalizeOptions(
    options?: Partial<CrawlTaskOptions>,
  ): CrawlTaskOptions {
    return this.optionsNormalizer.normalizeOptions(options);
  }

  private async safeCreateTaskLog(
    payload: Parameters<typeof writeTaskLogBestEffort>[0],
  ): Promise<void> {
    await writeTaskLogBestEffort(payload);
  }
}
