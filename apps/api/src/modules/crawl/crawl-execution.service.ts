import {
  createLogger,
  NotificationPresentationKind,
  normalizeBrowserHeaders as normalizeSharedBrowserHeaders,
  sanitizeError,
} from "@modular/utils";
import { Injectable, Optional } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { CrawlTask, Prisma } from "@prisma/client";
import { NotificationType, PipelineJobStatus } from "@prisma/client";
import { load } from "cheerio";

import { validateSsrfUrlAsync } from "../../common/validators/ssrf-url.validator";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { ItemsService } from "../items/items.service";
import { NotificationsService } from "../notifications/notifications.service";
import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import {
  CrawlQualityStrategyService,
  type CrawlArticleSignal,
} from "./crawl-quality.strategy";
import { CrawlResultService } from "./crawl-result.service";
import { CrawlSettingsService } from "./crawl-settings.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import {
  CrawlExecutionSummary,
  CrawlDetailExpansionOptions,
  CrawlTaskOptions,
  CrawlMemoryStats,
  CrawlProxyConfig,
  CrawlMultiUrlConfig,
  CrawlUrlMatcher,
  CrawlStrategyOverrides,
  CrawlFailureDetail,
  CrawlLinkPreviewOptions,
  CrawlBrowserHeader,
  CrawlBrowserCookie,
  CrawlUserAgentGeneratorConfig,
  CrawlGeolocationConfig,
  CrawlCleanMarkdownOptions,
  CrawlMarkdownOptions,
  CrawlMarkdownFilter,
  CrawlMarkdownContentSource,
  CrawlAntiBotMode,
  CrawlPageTypeHint,
  CrawlQualityProfile,
  CrawlPriorityClass,
  CrawlMarkdownStrategy,
  CrawlTableExtractionStrategy,
  CrawlVirtualScrollConfig,
} from "./crawl.types";
import { assertNoUnsupportedProxy } from "./crawl-config-policy";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";
import { translateLocalhostProxyUrlForCrawl4ai } from "./crawl4ai-proxy";
import {
  Crawl4aiClient,
  Crawl4aiArticle,
  Crawl4aiLink,
  Crawl4aiRequest,
  Crawl4aiResponse,
} from "./crawl4ai.client";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { NewsSourceOpsSnapshotService } from "./news-source-ops-snapshot.service";
import {
  buildCanonicalUrlFingerprint,
  extractUrlQueryParamAllowlistFromTaskConfig,
} from "./url-fingerprint";

const logger = createLogger({ name: "crawl-execution-service" });

const MAX_API_SIDE_REDIRECT_HOPS = 5;

export interface CrawlExecutionRetryContext {
  attempt?: number;
  maxAttempts?: number;
  backoffDelayMs?: number | null;
  requestTimeoutMs?: number | null;
  priorityClass?: CrawlPriorityClass;
}

interface CrawlRetryResult {
  response: Crawl4aiResponse;
  successes: Crawl4aiArticle[];
  failures: CrawlFailureDetail[];
  lowSignalCandidates: Crawl4aiArticle[];
  options: CrawlTaskOptions;
}

interface CrawlRetryCandidate extends CrawlRetryResult {
  fromRetry: boolean;
  qualityScore: number;
  challengeFailureCount: number;
}

interface DetailCandidateDiagnostics {
  includePatternRejected: number;
  excludePatternRejected: number;
  publishConfidenceRejected: number;
}

interface DetailCandidateConfidenceBuckets {
  lt04: number;
  from04To06: number;
  from06To08: number;
  gte08: number;
}

interface CandidatePublishSignal {
  confidence: number;
  source: "meta" | "jsonld" | "time_tag" | "url_path" | "none";
  timestamp?: number;
}

interface PublishSignalEnrichmentSettings {
  timeoutMs: number;
  concurrency: number;
  maxReadBytes: number;
}

type PublishSignalSoftFailureReason =
  | "http_status"
  | "non_html"
  | "empty_html"
  | "network_or_timeout"
  | "no_publish_signal";

interface PublishSignalSoftFailureBreakdown {
  httpStatus: number;
  nonHtml: number;
  emptyHtml: number;
  networkOrTimeout: number;
  noPublishSignal: number;
}

interface CandidatePublishSignalFetchResult {
  signal?: CandidatePublishSignal;
  truncated: boolean;
  earlyStopped: boolean;
  failureReason?: PublishSignalSoftFailureReason;
}

interface PublishSignalEnrichmentResult {
  signals: Map<string, CandidatePublishSignal>;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
  effectiveTimeoutMs: number;
  effectiveConcurrency: number;
  maxReadBytes: number;
  truncatedResponses: number;
  earlyStoppedResponses: number;
  softFailures: PublishSignalSoftFailureBreakdown;
  softFailureCount: number;
}

interface CrawlResultHttpValidationState {
  resultId: string;
  fetchedAt: Date;
  etag?: string;
  lastModified?: string;
}

interface ConditionalPreflightResult {
  status: number;
  etag?: string;
  lastModified?: string;
  method: "HEAD" | "GET";
  checkedAt: string;
}

interface ConditionalRequestSettings {
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
}

interface ConditionalPreflightOutcomeCompleted {
  status: "completed";
  result: ConditionalPreflightResult;
  attempts: number;
  failures: number;
}

interface ConditionalPreflightOutcomeFailed {
  status: "failed";
  attempts: number;
  failures: number;
}

type ConditionalPreflightOutcome =
  | ConditionalPreflightOutcomeCompleted
  | ConditionalPreflightOutcomeFailed;

@Injectable()
export class CrawlExecutionService {
  private readonly defaultConditionalRequestEnabled = true;
  private readonly defaultConditionalRequestTimeoutMs = 5_000;
  private readonly defaultConditionalRequestMaxRetries = 0;
  private readonly defaultDetailPublishSignalHeadFetchTimeoutMs = 1_500;
  private readonly defaultDetailPublishSignalHeadFetchConcurrency = 2;
  private readonly defaultDetailPublishSignalHeadFetchMaxReadBytes = 8_000_000;
  private readonly retryableStatusCodes = new Set([
    408, 423, 425, 429, 500, 502, 503, 504,
  ]);
  private readonly pipelineJobIdMaxLength = 128;
  private readonly antiBotRetryAttempts = 3;
  private readonly antiBotWarmupUrlLimit = 4;
  private readonly blockedDetailPathSegments = new Set([
    "video",
    "videos",
    "photo",
    "photos",
    "pictures",
    "gallery",
    "graphics",
    "podcast",
    "podcasts",
    "tag",
    "tags",
    "topic",
    "topics",
    "section",
    "sections",
    "author",
    "authors",
    "archive",
    "latest",
    "live",
    "newsletter",
    "newsletters",
    "country",
    "countries",
    "special-report",
    "special-reports",
    "europe-poll-of-polls",
    "poll-of-polls",
  ]);
  private readonly articleLeadPathSegments = new Set([
    "article",
    "articles",
    "news",
    "story",
    "stories",
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly crawlClient: Crawl4aiClient,
    private readonly resultService: CrawlResultService,
    private readonly qualityStrategy: CrawlQualityStrategyService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly notifications: NotificationsService,
    private readonly moduleRef: ModuleRef,
    @Optional()
    private readonly newsSourceOpsSnapshots?: NewsSourceOpsSnapshotService,
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

    const pipelineJobId = this.extractPipelineJobId(task.config);
    const sourceId =
      task.newsSourceId ?? this.extractPipelineSourceId(task.config);

    await this.prisma.crawlTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        lastRunAt: new Date(),
      },
    });
    await this.syncSourceQueueCounts(orgId, sourceId);

    try {
      const configRecord =
        task.config &&
        typeof task.config === "object" &&
        !Array.isArray(task.config)
          ? (task.config as Record<string, unknown>)
          : null;
      assertNoUnsupportedProxy(configRecord, "task.config");
      const options = this.extractOptions(
        configRecord as Prisma.JsonValue | null,
      );
      const requestTimeoutMs = this.normalizeRequestTimeoutMs(
        retryContext?.requestTimeoutMs,
      );
      const urlQueryParamAllowlist =
        extractUrlQueryParamAllowlistFromTaskConfig(task.config);
      const conditionalRequestSettings =
        await this.getConditionalRequestSettings();
      assertNoCrawl4aiLlmOptions(options, "task.config.options");
      const ingestToItems = configRecord?.ingestToItems === true;
      let effectiveOptions = this.ensureTaskSessionReuse(task.id, options);
      const payload = this.buildRequestPayload(task, effectiveOptions);
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
        await this.findLatestResultHttpValidationState({
          taskId: task.id,
          targetUrl: task.targetUrl,
          urlQueryParamAllowlist,
        });
      const preflightResult = this.shouldRunConditionalPreflight(
        conditionalRequestSettings.enabled,
      )
        ? await this.runConditionalPreflight({
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
        await this.syncSourceQueueCounts(orgId, sourceId);

        await this.safeCreateTaskLog({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          orgId,
          stage: "complete",
          status: "completed",
          data: summary,
        });

        if (triggeredById) {
          await this.safeNotifyCrawl(task, summary, triggeredById, "completed");
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
      const preflightMetadata = this.buildHttpValidationMetadata(
        preflightResult?.status === "completed" ? preflightResult.result : null,
      );
      const initialRun = await this.runCrawlWithHeadedFallback({
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
        this.partitionCrawlerResults(response.results);

      const challengeRetryResult = await this.retryForBotChallengeIfNeeded({
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
        effectiveOptions = this.ensureTaskSessionReuse(
          task.id,
          challengeRetryResult.options,
        );
      }

      if (this.shouldAttemptEmptyMarkdownFallback(successes, failures)) {
        const fallbackProfiles =
          this.buildEmptyMarkdownFallbackProfiles(effectiveOptions);
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
            const fallbackPayload = this.buildRequestPayload(
              task,
              profile.options,
            );
            const fallbackRun = await this.runCrawlWithHeadedFallback({
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
            const fallbackPartition = this.partitionCrawlerResults(
              fallbackResponse.results,
            );
            const qualityScore = this.scoreMarkdownQuality(
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
              error: this.extractCrawlErrorMessage(fallbackError) ?? null,
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

      const expansionSeedCandidates = this.buildExpansionSeedCandidates(
        successes,
        lowSignalCandidates,
      );
      const seededFromLowSignal =
        successes.length === 0 && expansionSeedCandidates.length > 0;
      const expansionResult = await this.expandListLikeResultsIfNeeded({
        task,
        orgId,
        taskId,
        keywords: payload.keywords ?? [],
        crawlOptions: this.ensureTaskSessionReuse(task.id, effectiveOptions),
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
      const persistedSuccesses = this.attachHttpValidationMetadata(
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
        this.extractMemoryStats(response),
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
      await this.syncSourceQueueCounts(orgId, sourceId);

      await this.safeCreateTaskLog({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "complete",
        status: "completed",
        data: summary,
      });

      if (triggeredById) {
        await this.safeNotifyCrawl(task, summary, triggeredById, "completed");
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
          ? this.isRetryableStatus(error.status, error.message)
          : this.isRetryableStatus(undefined, message);
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
      await this.syncSourceQueueCounts(orgId, sourceId);
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
          await this.markSourceFailureState({
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
        await this.safeNotifyCrawl(
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

  private async findLatestResultHttpValidationState(options: {
    taskId: string;
    targetUrl: string;
    urlQueryParamAllowlist: string[];
  }): Promise<CrawlResultHttpValidationState | null> {
    const normalizedTargetUrl = options.targetUrl.trim();
    const canonical = buildCanonicalUrlFingerprint(
      normalizedTargetUrl,
      options.urlQueryParamAllowlist,
    );
    const where: Prisma.CrawlResultWhereInput = {
      taskId: options.taskId,
    };
    const matchers: Prisma.CrawlResultWhereInput[] = [];
    if (canonical) {
      matchers.push({
        sourceUrlFingerprint: canonical.fingerprint,
      });
      matchers.push({
        sourceUrl: canonical.canonicalUrl,
      });
    }
    if (normalizedTargetUrl.length > 0) {
      matchers.push({
        sourceUrl: normalizedTargetUrl,
      });
    }
    if (matchers.length === 0) {
      return null;
    }
    where.OR = matchers;

    const latest = await this.prisma.crawlResult.findFirst({
      where,
      orderBy: { fetchedAt: "desc" },
      select: {
        id: true,
        fetchedAt: true,
        metadata: true,
      },
    });
    if (!latest) {
      return null;
    }

    const metadata =
      latest.metadata &&
      typeof latest.metadata === "object" &&
      !Array.isArray(latest.metadata)
        ? (latest.metadata as Record<string, unknown>)
        : undefined;
    const etag = this.pickString(metadata, ["httpEtag", "etag"]);
    const lastModified = this.pickString(metadata, [
      "httpLastModified",
      "lastModified",
      "last-modified",
    ]);

    return {
      resultId: latest.id,
      fetchedAt: latest.fetchedAt,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  }

  private shouldRunConditionalPreflight(enabled: boolean): boolean {
    return enabled && process.env.NODE_ENV !== "test";
  }

  private async runConditionalPreflight(options: {
    targetUrl: string;
    options: CrawlTaskOptions;
    requestTimeoutMs?: number;
    etag?: string;
    lastModified?: string;
    timeoutMs: number;
    maxRetries: number;
  }): Promise<ConditionalPreflightOutcome> {
    const timeoutMs = this.resolveConditionalPreflightTimeoutMs(
      options.timeoutMs,
      options.requestTimeoutMs,
    );
    const maxRetries = this.resolveConditionalPreflightMaxRetries(
      options.maxRetries,
    );
    const headers = this.buildConditionalPreflightHeaders(options.options, {
      etag: options.etag,
      lastModified: options.lastModified,
    });

    const maxAttempts = Math.max(1, maxRetries + 1);
    let failures = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const head = await this.requestConditionalUrlStatus(
        options.targetUrl,
        "HEAD",
        headers,
        timeoutMs,
      );
      if (!head) {
        failures += 1;
        continue;
      }

      if (head.status === 403 || head.status === 405 || head.status === 501) {
        const get = await this.requestConditionalUrlStatus(
          options.targetUrl,
          "GET",
          headers,
          timeoutMs,
        );
        if (!get) {
          failures += 1;
          continue;
        }
        if (
          this.shouldRetryConditionalPreflightStatus(get.status) &&
          attempt < maxAttempts
        ) {
          failures += 1;
          continue;
        }
        return {
          status: "completed",
          result: get,
          attempts: attempt,
          failures,
        };
      }

      if (
        this.shouldRetryConditionalPreflightStatus(head.status) &&
        attempt < maxAttempts
      ) {
        failures += 1;
        continue;
      }

      return {
        status: "completed",
        result: head,
        attempts: attempt,
        failures,
      };
    }

    return {
      status: "failed",
      attempts: maxAttempts,
      failures,
    };
  }

  private resolveConditionalPreflightTimeoutMs(
    configuredTimeoutMs: number,
    requestTimeoutMs?: number,
  ): number {
    const boundedConfiguredTimeoutMs = Math.max(
      500,
      Math.min(60_000, Math.round(configuredTimeoutMs)),
    );
    if (
      typeof requestTimeoutMs !== "number" ||
      !Number.isFinite(requestTimeoutMs) ||
      requestTimeoutMs <= 0
    ) {
      return boundedConfiguredTimeoutMs;
    }
    return Math.max(
      500,
      Math.min(boundedConfiguredTimeoutMs, Math.round(requestTimeoutMs)),
    );
  }

  private resolveConditionalPreflightMaxRetries(value: number): number {
    return Math.max(0, Math.min(5, Math.round(value)));
  }

  private shouldRetryConditionalPreflightStatus(status: number): boolean {
    return (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504
    );
  }

  private async getConditionalRequestSettings(): Promise<ConditionalRequestSettings> {
    const fallback: ConditionalRequestSettings = {
      enabled: this.defaultConditionalRequestEnabled,
      timeoutMs: this.defaultConditionalRequestTimeoutMs,
      maxRetries: this.defaultConditionalRequestMaxRetries,
    };
    try {
      const settings = await this.crawlSettings.getSettings();
      return {
        enabled:
          typeof settings.conditionalRequestEnabled === "boolean"
            ? settings.conditionalRequestEnabled
            : fallback.enabled,
        timeoutMs:
          typeof settings.conditionalRequestTimeoutMs === "number" &&
          Number.isFinite(settings.conditionalRequestTimeoutMs)
            ? settings.conditionalRequestTimeoutMs
            : fallback.timeoutMs,
        maxRetries:
          typeof settings.conditionalRequestMaxRetries === "number" &&
          Number.isFinite(settings.conditionalRequestMaxRetries)
            ? settings.conditionalRequestMaxRetries
            : fallback.maxRetries,
      };
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to load crawl settings for conditional requests; using defaults",
      );
      return fallback;
    }
  }

  private buildConditionalPreflightHeaders(
    options: CrawlTaskOptions,
    validators: { etag?: string; lastModified?: string },
  ): Record<string, string> {
    const userAgent =
      typeof options.userAgent === "string" &&
      options.userAgent.trim().length > 0
        ? options.userAgent.trim()
        : "Mozilla/5.0 (compatible; CrawlConditionalProbe/1.0; +https://example.com)";
    const headers: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": userAgent,
    };
    if (validators.etag) {
      headers["if-none-match"] = validators.etag;
    }
    if (validators.lastModified) {
      headers["if-modified-since"] = validators.lastModified;
    }
    return headers;
  }

  // Follow redirects manually, validating every hop against the SSRF rules:
  // a safe initial URL can still redirect into an internal address or cloud
  // metadata endpoint. Returns null when a hop is blocked or the redirect
  // chain is invalid/exhausted.
  private async ssrfSafeFetch(
    url: string,
    method: "HEAD" | "GET",
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Response | null> {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_API_SIDE_REDIRECT_HOPS; hop += 1) {
      const safety = await validateSsrfUrlAsync(currentUrl);
      if (!safety.valid) {
        logger.warn(
          { url: currentUrl, reason: safety.reason ?? "unsafe url" },
          "Blocked SSRF target during API-side fetch",
        );
        return null;
      }
      const response = await fetch(currentUrl, {
        method,
        redirect: "manual",
        signal,
        headers,
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location")
      ) {
        const location = response.headers.get("location");
        if (!location) {
          return null;
        }
        try {
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          logger.warn(
            { url: currentUrl },
            "Invalid redirect location during API-side fetch",
          );
          return null;
        }
        continue;
      }
      return response;
    }
    logger.warn(
      { url },
      "Too many redirects during API-side fetch",
    );
    return null;
  }

  private async requestConditionalUrlStatus(
    url: string,
    method: "HEAD" | "GET",
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<ConditionalPreflightResult | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.ssrfSafeFetch(
          url,
          method,
          headers,
          controller.signal,
        );
        if (!response) {
          return null;
        }
        if (method === "GET" && response.body) {
          await response.body.cancel().catch(() => undefined);
        }
        return {
          status: response.status,
          etag: response.headers.get("etag")?.trim() || undefined,
          lastModified:
            response.headers.get("last-modified")?.trim() || undefined,
          method,
          checkedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      logger.debug(
        { error, url, method },
        "HTTP validator preflight request failed",
      );
      return null;
    }
  }

  private buildHttpValidationMetadata(
    preflightResult: ConditionalPreflightResult | null,
  ): Record<string, unknown> | null {
    if (!preflightResult) {
      return null;
    }
    const metadata: Record<string, unknown> = {
      httpValidationStatus: preflightResult.status,
      httpValidationMethod: preflightResult.method,
      httpValidationCheckedAt: preflightResult.checkedAt,
    };
    if (preflightResult.etag) {
      metadata.httpEtag = preflightResult.etag;
    }
    if (preflightResult.lastModified) {
      metadata.httpLastModified = preflightResult.lastModified;
    }
    return metadata;
  }

  private attachHttpValidationMetadata(
    successes: Crawl4aiArticle[],
    metadata: Record<string, unknown> | null,
    targetUrl?: string,
  ): Crawl4aiArticle[] {
    if (!metadata || successes.length === 0) {
      return successes;
    }
    const targetFingerprint = targetUrl
      ? buildCanonicalUrlFingerprint(targetUrl, [])
      : null;
    return successes.map((article) => {
      // The preflight etag/lastModified describe the TARGET url only; writing
      // them onto detail-expansion articles pollutes their metadata and makes
      // the 304 reuse decision unstable (a detail row could masquerade as the
      // target's validation state).
      if (targetFingerprint) {
        const articleUrl =
          typeof article.url === "string" ? article.url.trim() : "";
        if (articleUrl.length > 0) {
          const articleFingerprint = buildCanonicalUrlFingerprint(
            articleUrl,
            [],
          );
          if (
            !articleFingerprint ||
            articleFingerprint.fingerprint !== targetFingerprint.fingerprint
          ) {
            return article;
          }
        }
      }
      const articleMetadata =
        article.metadata &&
        typeof article.metadata === "object" &&
        !Array.isArray(article.metadata)
          ? article.metadata
          : {};
      return {
        ...article,
        metadata: {
          ...articleMetadata,
          ...metadata,
        },
      };
    });
  }

  private normalizeRequestTimeoutMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.max(1_000, Math.round(value));
  }

  private async runCrawlWithHeadedFallback(options: {
    request: Crawl4aiRequest;
    options: CrawlTaskOptions;
    requestTimeoutMs?: number;
    taskId: string;
    orgId: string;
    stage: string;
    reason: string;
  }): Promise<{ response: Crawl4aiResponse; options: CrawlTaskOptions }> {
    const requestWithTimeout: Crawl4aiRequest =
      typeof options.requestTimeoutMs === "number"
        ? {
            ...options.request,
            requestTimeoutMs: options.requestTimeoutMs,
          }
        : options.request;

    try {
      const response = await this.crawlClient.crawl(requestWithTimeout);
      return { response, options: options.options };
    } catch (error) {
      if (!this.shouldFallbackToHeadless(options.options, error)) {
        throw error;
      }

      const fallbackOptions = this.normalizeOptions({
        ...options.options,
        headless: true,
      });
      const fallbackRequest: Crawl4aiRequest = {
        ...requestWithTimeout,
        options: fallbackOptions,
      };

      const response = await this.crawlClient.crawl(fallbackRequest);
      return { response, options: fallbackOptions };
    }
  }

  private shouldFallbackToHeadless(
    options: CrawlTaskOptions,
    error: unknown,
  ): boolean {
    if (options.headless !== false) {
      return false;
    }
    const errorMessage = this.extractCrawlErrorMessage(error);
    return this.isDisplayDependencyErrorMessage(errorMessage);
  }

  private isDisplayDependencyErrorMessage(message?: string): boolean {
    if (!message || typeof message !== "string") {
      return false;
    }
    const normalized = message.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (
      normalized.includes("cannot open display") ||
      normalized.includes("missing x server") ||
      normalized.includes("display/xvfb") ||
      normalized.includes("$display")
    ) {
      return true;
    }
    if (
      normalized.includes("display") &&
      normalized.includes("not available")
    ) {
      return true;
    }
    if (normalized.includes("display") && normalized.includes("failed")) {
      return true;
    }
    if (
      normalized.includes("xvfb") &&
      (normalized.includes("display") ||
        normalized.includes("x server") ||
        normalized.includes("not available") ||
        normalized.includes("failed to start"))
    ) {
      return true;
    }
    if (normalized.includes("x11") && normalized.includes("display")) {
      return true;
    }
    if (
      normalized.includes("headless=false") &&
      normalized.includes("display")
    ) {
      return true;
    }
    return false;
  }

  private extractCrawlErrorMessage(error: unknown): string | undefined {
    if (!error) {
      return undefined;
    }
    if (typeof error === "string") {
      const trimmed = error.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (error instanceof Crawl4aiRequestException) {
      const trimmed = error.message.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (error instanceof Error) {
      const trimmed = error.message.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof error !== "object") {
      return undefined;
    }
    const record = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["message", "detail", "error"]) {
      const value = record[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private async safeCreateTaskLog(
    payload: Parameters<typeof writeTaskLogBestEffort>[0],
  ): Promise<void> {
    await writeTaskLogBestEffort(payload);
  }

  private isEmptyMarkdownFailure(failure: CrawlFailureDetail): boolean {
    const normalizedError =
      typeof failure.error === "string" ? failure.error.toLowerCase() : "";

    const isLowSignalFailure =
      normalizedError.includes("low-signal markdown") ||
      normalizedError.includes("reference-only") ||
      normalizedError.includes("placeholder content");

    return (
      (failure.statusCode === undefined || failure.statusCode === 200) &&
      (normalizedError.includes("empty markdown") || isLowSignalFailure)
    );
  }

  private shouldAttemptEmptyMarkdownFallback(
    successes: Crawl4aiArticle[],
    failures: CrawlFailureDetail[],
  ) {
    return (
      successes.length === 0 &&
      failures.length > 0 &&
      failures.every((failure) => this.isEmptyMarkdownFailure(failure))
    );
  }

  private async retryForBotChallengeIfNeeded(options: {
    task: CrawlTask;
    taskId: string;
    orgId: string;
    options: CrawlTaskOptions;
    response: Crawl4aiResponse;
    successes: Crawl4aiArticle[];
    failures: CrawlFailureDetail[];
    lowSignalCandidates: Crawl4aiArticle[];
    requestTimeoutMs?: number;
  }): Promise<CrawlRetryResult | null> {
    if (options.failures.length === 0) {
      return null;
    }

    const antiBotMode = options.options.antiBotMode ?? "auto";
    if (antiBotMode === "disabled") {
      return null;
    }

    const initialChallengeFailureCount = this.countBotChallengeFailures(
      options.failures,
    );
    const forceRetryByMode = antiBotMode === "enabled";
    if (!forceRetryByMode && initialChallengeFailureCount === 0) {
      return null;
    }

    const retryStartReason =
      forceRetryByMode && initialChallengeFailureCount === 0
        ? "anti_bot_mode_enabled"
        : "challenge_detected";
    const retryStartMessage =
      retryStartReason === "anti_bot_mode_enabled"
        ? "Anti-bot mode enabled; retrying with hardened stealth profile"
        : "Detected anti-bot challenge; retrying with hardened stealth profile";

    const baseRetryOptions = this.buildHardenedAntiBotOptions(
      options.options,
      options.task.targetUrl,
    );
    const { options: warmedRetryOptions, summary: warmupSummary } =
      await this.runAntiBotWarmupIfNeeded({
        task: options.task,
        taskId: options.taskId,
        orgId: options.orgId,
        options: baseRetryOptions,
        requestTimeoutMs: options.requestTimeoutMs,
      });

    const retryCandidates: CrawlRetryCandidate[] = [];
    const retryAttempts: Record<string, unknown>[] = [];
    const maxAttempts = this.antiBotRetryAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptOptions = this.buildAntiBotAttemptOptions(
        warmedRetryOptions,
        options.task.targetUrl,
        attempt,
      );

      try {
        const retryPayload = this.buildRequestPayload(
          options.task,
          attemptOptions,
        );
        const retryRun = await this.runCrawlWithHeadedFallback({
          request: retryPayload,
          options: retryPayload.options ?? attemptOptions,
          requestTimeoutMs: options.requestTimeoutMs,
          taskId: options.taskId,
          orgId: options.orgId,
          stage: "anti_bot_retry",
          reason: `retry_attempt_${attempt}`,
        });
        const retryResponse = retryRun.response;
        const partition = this.partitionCrawlerResults(retryResponse.results);
        const challengeFailureCount = this.countBotChallengeFailures(
          partition.failures,
        );

        const candidate: CrawlRetryCandidate = {
          fromRetry: true,
          response: retryResponse,
          successes: partition.successes,
          failures: partition.failures,
          lowSignalCandidates: partition.lowSignalCandidates,
          options: retryRun.options,
          qualityScore: this.scoreMarkdownQuality(partition.successes),
          challengeFailureCount,
        };
        retryCandidates.push(candidate);
        retryAttempts.push({
          attempt,
          result: "completed",
          maxAttempts,
          successes: partition.successes.length,
          failures: partition.failures.length,
          lowSignalCandidates: partition.lowSignalCandidates.length,
          challengeFailures: challengeFailureCount,
          qualityScore: Number(candidate.qualityScore.toFixed(3)),
          runId: retryResponse.runId ?? null,
          options: this.summarizeAntiBotOptions(attemptOptions),
        });

        if (partition.successes.length > 0 && challengeFailureCount === 0) {
          break;
        }

        if (attempt < maxAttempts && challengeFailureCount > 0) {
          await this.sleep(this.resolveAntiBotAttemptDelayMs(attempt));
        }
      } catch (error) {
        retryAttempts.push({
          attempt,
          result: "failed",
          maxAttempts,
          error: this.extractCrawlErrorMessage(error) ?? null,
          options: this.summarizeAntiBotOptions(attemptOptions),
        });
        if (attempt < maxAttempts) {
          await this.sleep(this.resolveAntiBotAttemptDelayMs(attempt));
        }
      }
    }

    const baselineCandidate: CrawlRetryCandidate = {
      fromRetry: false,
      response: options.response,
      successes: options.successes,
      failures: options.failures,
      lowSignalCandidates: options.lowSignalCandidates,
      options: options.options,
      qualityScore: this.scoreMarkdownQuality(options.successes),
      challengeFailureCount: initialChallengeFailureCount,
    };
    const selected = this.selectBestAntiBotRetryCandidate([
      baselineCandidate,
      ...retryCandidates,
    ]);
    const hasCompletedRetryAttempt = retryAttempts.some(
      (entry) => entry.result === "completed",
    );
    await this.safeCreateTaskLog({
      queue: CRAWL_QUEUE_NAME,
      jobId: options.taskId,
      orgId: options.orgId,
      stage: "anti_bot_retry",
      status: hasCompletedRetryAttempt ? "completed" : "failed",
      message:
        selected?.fromRetry === true
          ? "Selected anti-bot retry candidate"
          : hasCompletedRetryAttempt
            ? "Anti-bot retry completed; kept baseline crawl response"
            : retryStartMessage,
      data: {
        reason: retryStartReason,
        initialFailures: options.failures.length,
        initialChallengeFailures: initialChallengeFailureCount,
        attempts: maxAttempts,
        warmup: warmupSummary,
        selectedFromRetry: selected?.fromRetry === true,
        selectedSuccesses: selected?.successes.length ?? 0,
        selectedFailures: selected?.failures.length ?? 0,
        selectedChallengeFailures: selected?.challengeFailureCount ?? 0,
        selectedQualityScore: selected
          ? Number(selected.qualityScore.toFixed(3))
          : null,
        baselineSuccesses: baselineCandidate.successes.length,
        baselineFailures: baselineCandidate.failures.length,
        baselineChallengeFailures: baselineCandidate.challengeFailureCount,
        baselineQualityScore: Number(baselineCandidate.qualityScore.toFixed(3)),
        retryCandidates: retryCandidates.length,
        attemptSummaries: retryAttempts,
      },
    });

    if (!selected || !selected.fromRetry) {
      return null;
    }

    return {
      response: selected.response,
      successes: selected.successes,
      failures: selected.failures,
      lowSignalCandidates: selected.lowSignalCandidates,
      options: selected.options,
    };
  }

  private buildHardenedAntiBotOptions(
    options: CrawlTaskOptions,
    targetUrl: string,
  ): CrawlTaskOptions {
    const recommendedWaitFor = this.resolveAntiBotWaitForSelector(
      targetUrl,
      options.pageTypeHint,
    );
    const sessionId = options.sessionId;

    return this.normalizeOptions({
      ...options,
      sessionId,
      headless: false,
      enableUndetectedBrowser: true,
      enableStealthMode: true,
      simulateUser: true,
      overrideNavigator: true,
      userAgentMode: options.userAgent ? undefined : "random",
      waitUntil: options.waitUntil ?? "domcontentloaded",
      waitForSelector:
        options.waitForScript || options.waitForSelector
          ? options.waitForSelector
          : recommendedWaitFor,
      waitForTimeoutMs: Math.max(options.waitForTimeoutMs ?? 0, 10_000),
      pageTimeoutMs: Math.max(options.pageTimeoutMs ?? 0, 120_000),
      delayBeforeReturnHtmlMs: Math.max(
        options.delayBeforeReturnHtmlMs ?? 0,
        2_000,
      ),
      meanDelayMs: Math.max(options.meanDelayMs ?? 0, 700),
      maxDelayRangeMs: Math.max(options.maxDelayRangeMs ?? 0, 1_400),
      scanFullPage: false,
      virtualScroll: options.virtualScroll ?? {
        containerSelector: "body",
        scrollCount: 8,
        scrollBy: "page_height",
        waitAfterScrollMs: 700,
      },
    });
  }

  private buildAntiBotAttemptOptions(
    options: CrawlTaskOptions,
    targetUrl: string,
    attempt: number,
  ): CrawlTaskOptions {
    const clampedAttempt = Math.max(1, Math.min(6, attempt));
    const waitForSelector = options.waitForScript
      ? undefined
      : clampedAttempt >= 3
        ? undefined
        : (options.waitForSelector ??
          this.resolveAntiBotWaitForSelector(targetUrl, options.pageTypeHint));
    const waitUntil =
      clampedAttempt >= 2 ? "load" : (options.waitUntil ?? "domcontentloaded");

    return this.normalizeOptions({
      ...options,
      waitUntil,
      waitForSelector,
      waitForTimeoutMs: Math.max(
        options.waitForTimeoutMs ?? 0,
        10_000 + (clampedAttempt - 1) * 4_000,
      ),
      pageTimeoutMs: Math.max(
        options.pageTimeoutMs ?? 0,
        120_000 + (clampedAttempt - 1) * 10_000,
      ),
      delayBeforeReturnHtmlMs: Math.max(
        options.delayBeforeReturnHtmlMs ?? 0,
        2_000 + (clampedAttempt - 1) * 350,
      ),
      meanDelayMs: Math.max(
        options.meanDelayMs ?? 0,
        700 + (clampedAttempt - 1) * 120,
      ),
      maxDelayRangeMs: Math.max(
        options.maxDelayRangeMs ?? 0,
        1_400 + (clampedAttempt - 1) * 140,
      ),
    });
  }

  private async runAntiBotWarmupIfNeeded(options: {
    task: CrawlTask;
    taskId: string;
    orgId: string;
    options: CrawlTaskOptions;
    requestTimeoutMs?: number;
  }): Promise<{
    options: CrawlTaskOptions;
    summary: Record<string, unknown> | null;
  }> {
    const warmupUrls = this.buildAntiBotWarmupUrls(options.task.targetUrl);
    if (warmupUrls.length === 0) {
      return { options: options.options, summary: null };
    }

    const warmupOptions = this.normalizeOptions({
      ...options.options,
      cacheMode: "bypass",
      waitForScript: undefined,
      waitForSelector: "main",
      pageTypeHint: "list",
    });

    try {
      const warmupPayload = this.buildRequestPayloadWithUrls(
        options.task,
        warmupOptions,
        warmupUrls,
      );
      const warmupRun = await this.runCrawlWithHeadedFallback({
        request: warmupPayload,
        options: warmupPayload.options ?? warmupOptions,
        requestTimeoutMs: options.requestTimeoutMs,
        taskId: options.taskId,
        orgId: options.orgId,
        stage: "anti_bot_retry",
        reason: "session_warmup",
      });
      const warmupResponse = warmupRun.response;
      const partition = this.partitionCrawlerResults(warmupResponse.results);
      const challengeFailures = this.countBotChallengeFailures(
        partition.failures,
      );
      return {
        options: options.options,
        summary: {
          result: "completed",
          warmupUrls,
          count: warmupUrls.length,
          sessionId: warmupOptions.sessionId ?? null,
          runId: warmupResponse.runId ?? null,
          successes: partition.successes.length,
          failures: partition.failures.length,
          challengeFailures,
        },
      };
    } catch (error) {
      return {
        options: options.options,
        summary: {
          result: "failed",
          warmupUrls,
          count: warmupUrls.length,
          sessionId: warmupOptions.sessionId ?? null,
          error: this.extractCrawlErrorMessage(error) ?? null,
        },
      };
    }
  }

  private resolveAntiBotAttemptDelayMs(attempt: number): number {
    const clampedAttempt = Math.max(1, Math.min(6, attempt));
    return Math.min(4_000, 900 + (clampedAttempt - 1) * 850);
  }

  private countBotChallengeFailures(failures: CrawlFailureDetail[]): number {
    return failures.filter((failure) => this.isBotChallengeFailure(failure))
      .length;
  }

  private summarizeAntiBotOptions(
    options: CrawlTaskOptions,
  ): Record<string, unknown> {
    return {
      sessionId: options.sessionId ?? null,
      antiBotMode: options.antiBotMode ?? null,
      headless: options.headless ?? null,
      enableUndetectedBrowser: options.enableUndetectedBrowser ?? null,
      enableStealthMode: options.enableStealthMode ?? null,
      simulateUser: options.simulateUser ?? null,
      overrideNavigator: options.overrideNavigator ?? null,
      userAgentMode: options.userAgentMode ?? null,
      waitUntil: options.waitUntil ?? null,
      waitForSelector: options.waitForSelector ?? null,
      waitForTimeoutMs: options.waitForTimeoutMs ?? null,
      pageTimeoutMs: options.pageTimeoutMs ?? null,
      delayBeforeReturnHtmlMs: options.delayBeforeReturnHtmlMs ?? null,
    };
  }

  private selectBestAntiBotRetryCandidate(
    candidates: CrawlRetryCandidate[],
  ): CrawlRetryCandidate | null {
    if (candidates.length === 0) {
      return null;
    }

    return (
      [...candidates].sort((left, right) => {
        if (left.challengeFailureCount !== right.challengeFailureCount) {
          return left.challengeFailureCount - right.challengeFailureCount;
        }
        if (left.successes.length !== right.successes.length) {
          return right.successes.length - left.successes.length;
        }
        if (left.qualityScore !== right.qualityScore) {
          return right.qualityScore - left.qualityScore;
        }
        if (left.failures.length !== right.failures.length) {
          return left.failures.length - right.failures.length;
        }
        if (left.fromRetry !== right.fromRetry) {
          return left.fromRetry ? -1 : 1;
        }
        return 0;
      })[0] ?? null
    );
  }

  private resolveAntiBotWaitForSelector(
    targetUrl: string,
    hint?: CrawlPageTypeHint,
  ): string {
    if (hint === "detail") {
      return "article";
    }
    if (hint === "list") {
      return "main";
    }
    const normalizedTarget =
      this.normalizeComparableUrl(targetUrl) ?? targetUrl;
    if (
      this.isLikelyDetailArticleUrl(
        normalizedTarget,
        normalizedTarget,
        false,
        true,
      )
    ) {
      return "article";
    }
    return "main";
  }

  private buildAntiBotWarmupUrls(targetUrl: string): string[] {
    try {
      const parsed = new URL(targetUrl);
      const targetNormalized = this.normalizeComparableUrl(parsed.toString());
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      const candidates: string[] = [];
      const addCandidate = (value: string) => {
        const normalized = this.normalizeComparableUrl(value);
        if (!normalized) {
          return;
        }
        if (targetNormalized && normalized === targetNormalized) {
          return;
        }
        if (!candidates.includes(normalized)) {
          candidates.push(normalized);
        }
      };

      addCandidate(`${parsed.origin}/`);

      if (segments.length > 0) {
        addCandidate(`${parsed.origin}/${segments[0]}/`);
      }

      const secondSegment = segments[1];
      if (
        segments.length > 1 &&
        secondSegment &&
        this.isLikelyWarmupSectionSegment(secondSegment)
      ) {
        addCandidate(`${parsed.origin}/${segments[0]}/${secondSegment}/`);
      }

      const thirdSegment = segments[2];
      if (
        segments.length > 2 &&
        secondSegment &&
        thirdSegment &&
        this.isLikelyWarmupSectionSegment(secondSegment) &&
        this.isLikelyWarmupSectionSegment(thirdSegment)
      ) {
        addCandidate(
          `${parsed.origin}/${segments[0]}/${secondSegment}/${thirdSegment}/`,
        );
      }

      return candidates.slice(0, this.antiBotWarmupUrlLimit);
    } catch {
      return [];
    }
  }

  private isLikelyWarmupSectionSegment(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (this.blockedDetailPathSegments.has(normalized)) {
      return false;
    }
    if (normalized.length > 24) {
      return false;
    }
    if (/\d/.test(normalized)) {
      return false;
    }
    const hyphenParts = normalized
      .split("-")
      .filter((entry) => entry.length > 0);
    if (hyphenParts.length >= 4) {
      return false;
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isBotChallengeFailure(failure: CrawlFailureDetail) {
    const normalizedError =
      typeof failure.error === "string" ? failure.error.toLowerCase() : "";
    if (
      failure.statusCode === 401 ||
      failure.statusCode === 403 ||
      failure.statusCode === 429
    ) {
      return true;
    }
    return (
      normalizedError.includes("anti-bot") ||
      normalizedError.includes("verification page") ||
      normalizedError.includes("cloudflare") ||
      normalizedError.includes("captcha") ||
      normalizedError.includes("datadome") ||
      normalizedError.includes("verifying the device") ||
      normalizedError.includes("please enable js and disable any ad blocker") ||
      normalizedError.includes("デバイスの確認") ||
      normalizedError.includes("access denied") ||
      normalizedError.includes("bot detection")
    );
  }

  private buildEmptyMarkdownFallbackProfiles(options: CrawlTaskOptions): {
    label: string;
    options: CrawlTaskOptions;
    summary: Record<string, unknown>;
  }[] {
    const cleanMarkdown = options.cleanMarkdown;
    const relaxedCleanMarkdown =
      cleanMarkdown && typeof cleanMarkdown === "object"
        ? {
            excludedTags: cleanMarkdown.excludedTags,
            targetElements: cleanMarkdown.targetElements,
            removeOverlayElements: cleanMarkdown.removeOverlayElements ?? true,
            wordCountThreshold: 0,
          }
        : {
            removeOverlayElements: true,
            wordCountThreshold: 0,
          };

    const ensureCitations = options.markdownOptions?.citations ?? true;

    const rawRelaxedOptions = this.normalizeOptions({
      ...options,
      onlyMainContent: false,
      markdownFilter: undefined,
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource: "raw_html",
        citations: ensureCitations,
      },
      cleanMarkdown: relaxedCleanMarkdown,
      cssSelector: undefined,
      wordCountThreshold: 10,
    });

    const cleanedBalancedOptions = this.normalizeOptions({
      ...options,
      onlyMainContent: false,
      extractLinks: true,
      markdownFilter: {
        type: "pruning",
        thresholdType: "dynamic",
        threshold: 0.2,
        minWordThreshold: 5,
      },
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource: "cleaned_html",
        citations: ensureCitations,
      },
      cleanMarkdown: {
        ...(cleanMarkdown ?? {}),
        removeOverlayElements: cleanMarkdown?.removeOverlayElements ?? true,
        wordCountThreshold:
          typeof cleanMarkdown?.wordCountThreshold === "number"
            ? Math.min(cleanMarkdown.wordCountThreshold, 40)
            : 20,
      },
      cssSelector: undefined,
      wordCountThreshold: Math.min(options.wordCountThreshold ?? 80, 40),
    });

    const profiles: {
      label: string;
      options: CrawlTaskOptions;
      summary: Record<string, unknown>;
    }[] = [
      {
        label: "raw_relaxed",
        options: rawRelaxedOptions,
        summary: {
          contentSource:
            rawRelaxedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: rawRelaxedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: rawRelaxedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold:
            rawRelaxedOptions.cleanMarkdown?.wordCountThreshold ?? null,
        },
      },
      {
        label: "cleaned_balanced",
        options: cleanedBalancedOptions,
        summary: {
          contentSource:
            cleanedBalancedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: cleanedBalancedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: cleanedBalancedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold:
            cleanedBalancedOptions.cleanMarkdown?.wordCountThreshold ?? null,
        },
      },
      {
        label: "raw_relaxed_linkscan",
        options: this.normalizeOptions({
          ...rawRelaxedOptions,
          extractLinks: true,
          onlyMainContent: false,
          cleanMarkdown: {
            ...(rawRelaxedOptions.cleanMarkdown ?? {}),
            removeOverlayElements: false,
            wordCountThreshold: 0,
          },
          excludeExternalLinks: false,
          markdownOptions: {
            ...(rawRelaxedOptions.markdownOptions ?? {}),
            contentSource: "raw_html",
            citations: ensureCitations,
          },
        }),
        summary: {
          contentSource: "raw_html",
          markdownFilter: null,
          extractLinks: true,
          onlyMainContent: false,
          cleanMarkdownWordCountThreshold: 0,
          removeOverlayElements: false,
          excludeExternalLinks: false,
        },
      },
    ];

    const sourceFilter = options.markdownFilter;
    if (
      sourceFilter?.type === "bm25" &&
      typeof sourceFilter.userQuery === "string" &&
      sourceFilter.userQuery.trim().length > 0
    ) {
      const bm25FocusedOptions = this.normalizeOptions({
        ...options,
        onlyMainContent: false,
        markdownFilter: {
          type: "bm25",
          userQuery: sourceFilter.userQuery,
          bm25Threshold: sourceFilter.bm25Threshold ?? 0.6,
          language: sourceFilter.language,
        },
        markdownOptions: {
          ...(options.markdownOptions ?? {}),
          contentSource: "cleaned_html",
          citations: ensureCitations,
        },
        cleanMarkdown: relaxedCleanMarkdown,
        cssSelector: undefined,
        wordCountThreshold: Math.min(options.wordCountThreshold ?? 80, 30),
      });
      profiles.push({
        label: "bm25_focus",
        options: bm25FocusedOptions,
        summary: {
          contentSource:
            bm25FocusedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: bm25FocusedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: bm25FocusedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold:
            bm25FocusedOptions.cleanMarkdown?.wordCountThreshold ?? null,
        },
      });
    }

    return profiles;
  }

  private scoreMarkdownQuality(successes: Crawl4aiArticle[]): number {
    return this.qualityStrategy.scoreMarkdownQuality(successes);
  }

  private async expandListLikeResultsIfNeeded(options: {
    task: CrawlTask;
    orgId: string;
    taskId: string;
    keywords: string[];
    crawlOptions: CrawlTaskOptions;
    successes: Crawl4aiArticle[];
    seededFromLowSignal?: boolean;
    requestTimeoutMs?: number;
  }): Promise<{
    successes: Crawl4aiArticle[];
    failures: CrawlFailureDetail[];
    runId: string | null;
  } | null> {
    if (options.successes.length === 0) {
      return null;
    }

    const pageTypeHint = options.crawlOptions.pageTypeHint ?? "auto";
    const qualityProfile = this.qualityStrategy.resolveQualityProfile(
      options.crawlOptions.qualityProfile,
    );
    const pageAssessment = this.qualityStrategy.assessPageSignals(
      options.successes,
      pageTypeHint,
      options.crawlOptions.detailExpansion,
    );
    const {
      assessments,
      lowSignalAssessments,
      maxLowSignalWords,
      minLowSignalWords,
      meanLowSignalWords,
      bestLowSignalScore,
      maxLowSignalLinkDensity,
      meanLowSignalLinkDensity,
      kind: pageKind,
    } = pageAssessment;

    const shouldAutoExpand = this.qualityStrategy.shouldAutoExpand(
      options.crawlOptions,
      pageAssessment,
    );
    const shouldForceExpandFromLowSignalSeed =
      options.seededFromLowSignal === true &&
      options.crawlOptions.autoExpandDetails !== false &&
      pageTypeHint !== "detail";
    if (!shouldAutoExpand && !shouldForceExpandFromLowSignalSeed) {
      return null;
    }
    const effectiveLowSignalAssessments =
      lowSignalAssessments.length > 0
        ? lowSignalAssessments
        : shouldForceExpandFromLowSignalSeed
          ? assessments
          : [];
    const effectiveAllLowSignal =
      effectiveLowSignalAssessments.length > 0 &&
      effectiveLowSignalAssessments.length === assessments.length;

    const existingUrls = new Set(
      options.successes
        .map((entry) => this.normalizeComparableUrl(entry.url))
        .filter((entry): entry is string => Boolean(entry)),
    );

    const candidateScoreMap = new Map<string, number>();
    const fallbackCandidateScoreMap = new Map<string, number>();
    const primaryCandidateDiagnostics =
      this.createEmptyDetailCandidateDiagnostics();
    const fallbackCandidateDiagnostics =
      this.createEmptyDetailCandidateDiagnostics();
    let existingUrlSkipped = 0;
    const detailExpansion = this.qualityStrategy.resolveDetailExpansion(
      options.crawlOptions,
    );
    for (const entry of effectiveLowSignalAssessments) {
      const baseUrl =
        this.resolveArticleBaseUrl(entry.article) ?? options.task.targetUrl;
      const candidates = this.extractDetailLinkCandidatesFromArticle(
        entry.article,
        detailExpansion.requireSameDomain,
        detailExpansion.allowExternalLinks,
        detailExpansion.excludeUrlPatterns,
        detailExpansion.includeUrlPatterns,
        detailExpansion.minPublishTimeConfidence,
        primaryCandidateDiagnostics,
      );
      for (const candidate of candidates) {
        if (existingUrls.has(candidate)) {
          existingUrlSkipped += 1;
          continue;
        }
        const nextScore = this.scoreDetailCandidateUrl(candidate, baseUrl);
        const currentScore = candidateScoreMap.get(candidate);
        if (currentScore === undefined || nextScore > currentScore) {
          candidateScoreMap.set(candidate, nextScore);
        }
      }

      const fallbackCandidates =
        this.extractFallbackDetailLinkCandidatesFromArticle(
          entry.article,
          detailExpansion.requireSameDomain,
          detailExpansion.allowExternalLinks,
          detailExpansion.excludeUrlPatterns,
          detailExpansion.includeUrlPatterns,
          typeof detailExpansion.minPublishTimeConfidence === "number" &&
            Number.isFinite(detailExpansion.minPublishTimeConfidence)
            ? Math.max(0, detailExpansion.minPublishTimeConfidence - 0.2)
            : undefined,
          fallbackCandidateDiagnostics,
        );
      for (const candidate of fallbackCandidates) {
        if (existingUrls.has(candidate)) {
          existingUrlSkipped += 1;
          continue;
        }
        const nextScore =
          this.scoreDetailCandidateUrl(candidate, baseUrl) - 120;
        const currentScore = fallbackCandidateScoreMap.get(candidate);
        if (currentScore === undefined || nextScore > currentScore) {
          fallbackCandidateScoreMap.set(candidate, nextScore);
        }
      }
    }

    const profileCandidateMultiplier =
      qualityProfile === "quality_first"
        ? 1.25
        : qualityProfile === "speed_first"
          ? 0.8
          : 1;
    const baseCandidateLimit = effectiveAllLowSignal
      ? detailExpansion.maxDetailUrls + 2
      : detailExpansion.maxDetailUrls;
    const candidateLimit = Math.max(
      1,
      Math.min(30, Math.round(baseCandidateLimit * profileCandidateMultiplier)),
    );
    const minCandidateScore = this.detailRelevanceToScore(
      detailExpansion.minRelevanceScore,
    );
    const candidateEntriesRaw = Array.from(candidateScoreMap.entries())
      .filter((entry) => Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1]);
    const fallbackCandidateEntriesRaw = Array.from(
      fallbackCandidateScoreMap.entries(),
    )
      .filter((entry) => Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1]);
    const publishSignalPool = new Map<string, number>();
    for (const [url, score] of candidateEntriesRaw) {
      const current = publishSignalPool.get(url);
      if (current === undefined || score > current) {
        publishSignalPool.set(url, score);
      }
    }
    for (const [url, score] of fallbackCandidateEntriesRaw) {
      const current = publishSignalPool.get(url);
      if (current === undefined || score > current) {
        publishSignalPool.set(url, score);
      }
    }
    const sortedPublishSignalPool = Array.from(
      publishSignalPool.entries(),
    ).sort((left, right) => right[1] - left[1]);
    const publishSignalTopK = this.resolvePublishSignalTopK(
      candidateLimit,
      detailExpansion.maxDetailUrls,
      sortedPublishSignalPool.length,
    );
    const publishSignalSettings =
      await this.getPublishSignalEnrichmentSettings();
    const publishSignalEnrichment = await this.enrichCandidatePublishSignals({
      urls: sortedPublishSignalPool
        .slice(0, publishSignalTopK)
        .map((entry) => entry[0]),
      requestTimeoutMs: options.requestTimeoutMs,
      settings: publishSignalSettings,
    });
    const candidateSignalByUrl = new Map<string, CandidatePublishSignal>();
    for (const [candidateUrl] of sortedPublishSignalPool) {
      candidateSignalByUrl.set(
        candidateUrl,
        this.resolveCandidatePublishSignal(
          candidateUrl,
          publishSignalEnrichment.signals.get(candidateUrl),
        ),
      );
    }
    const totalSignalCandidates = candidateSignalByUrl.size;
    const urlPathFallbackCount = Array.from(
      candidateSignalByUrl.values(),
    ).filter((signal) => signal.source === "url_path").length;
    const urlPathFallbackRatio =
      totalSignalCandidates > 0
        ? Number((urlPathFallbackCount / totalSignalCandidates).toFixed(4))
        : 0;
    const minPublishTimeConfidenceThreshold =
      typeof detailExpansion.minPublishTimeConfidence === "number" &&
      Number.isFinite(detailExpansion.minPublishTimeConfidence)
        ? Math.max(0, Math.min(1, detailExpansion.minPublishTimeConfidence))
        : undefined;
    const fallbackPublishTimeConfidenceThreshold =
      typeof minPublishTimeConfidenceThreshold === "number"
        ? Math.max(0, minPublishTimeConfidenceThreshold - 0.15)
        : undefined;
    let publishConfidenceRejectedPrimary = 0;
    let publishConfidenceRejectedFallback = 0;
    const candidateEntries = candidateEntriesRaw.filter(([url]) => {
      if (minPublishTimeConfidenceThreshold === undefined) {
        return true;
      }
      const confidence =
        candidateSignalByUrl.get(url)?.confidence ??
        this.estimatePublishTimeConfidenceFromCandidateUrl(url);
      if (confidence >= minPublishTimeConfidenceThreshold) {
        return true;
      }
      publishConfidenceRejectedPrimary += 1;
      return false;
    });
    const fallbackCandidateEntries = fallbackCandidateEntriesRaw.filter(
      ([url]) => {
        if (fallbackPublishTimeConfidenceThreshold === undefined) {
          return true;
        }
        const confidence =
          candidateSignalByUrl.get(url)?.confidence ??
          this.estimatePublishTimeConfidenceFromCandidateUrl(url);
        if (confidence >= fallbackPublishTimeConfidenceThreshold) {
          return true;
        }
        publishConfidenceRejectedFallback += 1;
        return false;
      },
    );
    const candidateDiagnostics = this.combineDetailCandidateDiagnostics(
      primaryCandidateDiagnostics,
      fallbackCandidateDiagnostics,
    );
    candidateDiagnostics.publishConfidenceRejected +=
      publishConfidenceRejectedPrimary + publishConfidenceRejectedFallback;
    const publishConfidenceBuckets = this.buildDetailCandidateConfidenceBuckets(
      candidateSignalByUrl,
      sortedPublishSignalPool.map((entry) => entry[0]),
    );

    const minimumCandidateCount = this.resolveMinimumDetailExpansionCandidates(
      detailExpansion.maxDetailUrls,
      candidateLimit,
      effectiveAllLowSignal,
      qualityProfile,
    );
    const strictThreshold = minCandidateScore;
    const relaxedThreshold = minCandidateScore - 80;
    const fallbackThreshold = minCandidateScore - 140;
    const selectedCandidateSet = new Set<string>();
    const pushCandidates = (
      entries: [string, number][],
      threshold: number,
      targetSize: number,
    ): number => {
      if (targetSize <= 0) {
        return 0;
      }
      let added = 0;
      for (const [candidateUrl, score] of entries) {
        if (
          !Number.isFinite(score) ||
          score < threshold ||
          selectedCandidateSet.has(candidateUrl)
        ) {
          continue;
        }
        selectedCandidateSet.add(candidateUrl);
        added += 1;
        if (selectedCandidateSet.size >= targetSize) {
          break;
        }
      }
      return added;
    };

    const strictCandidateCount = pushCandidates(
      candidateEntries,
      strictThreshold,
      candidateLimit,
    );
    const relaxedCandidateCount =
      selectedCandidateSet.size < minimumCandidateCount
        ? pushCandidates(
            candidateEntries,
            relaxedThreshold,
            minimumCandidateCount,
          )
        : 0;
    const linkFallbackCandidateCount =
      selectedCandidateSet.size < minimumCandidateCount
        ? pushCandidates(
            fallbackCandidateEntries,
            fallbackThreshold,
            minimumCandidateCount,
          )
        : 0;

    if (
      selectedCandidateSet.size === 0 &&
      effectiveAllLowSignal &&
      fallbackCandidateEntries.length > 0
    ) {
      pushCandidates(fallbackCandidateEntries, Number.NEGATIVE_INFINITY, 1);
    }

    const candidateUrls = Array.from(selectedCandidateSet).slice(
      0,
      candidateLimit,
    );

    if (candidateUrls.length === 0) {
      await this.safeCreateTaskLog({
        queue: CRAWL_QUEUE_NAME,
        jobId: options.taskId,
        orgId: options.orgId,
        stage: "expansion",
        status: "failed",
        message:
          "Low-signal markdown detected but no detail candidate URLs were extracted",
        data: {
          qualityProfile,
          pageTypeHint,
          pageKind,
          detailExpansion,
          allLowSignal: effectiveAllLowSignal,
          forcedByLowSignalSeed: shouldForceExpandFromLowSignalSeed,
          totalSuccesses: assessments.length,
          minimumCandidateCount,
          primaryCandidatePool: candidateEntriesRaw.length,
          fallbackCandidatePool: fallbackCandidateEntriesRaw.length,
          primaryCandidatePoolAfterConfidenceFilter: candidateEntries.length,
          fallbackCandidatePoolAfterConfidenceFilter:
            fallbackCandidateEntries.length,
          strictCandidateCount,
          relaxedCandidateCount,
          linkFallbackCandidateCount,
          existingUrlSkipped,
          candidateRejects: candidateDiagnostics,
          publishConfidenceThreshold: minPublishTimeConfidenceThreshold ?? null,
          fallbackPublishConfidenceThreshold:
            fallbackPublishTimeConfidenceThreshold ?? null,
          publishConfidenceBuckets,
          headSignalEnrichment: {
            attempted: publishSignalEnrichment.attempted,
            succeeded: publishSignalEnrichment.succeeded,
            failed: publishSignalEnrichment.failed,
            topK: publishSignalTopK,
            skipped: publishSignalEnrichment.skipped,
            configuredTimeoutMs: publishSignalSettings.timeoutMs,
            configuredConcurrency: publishSignalSettings.concurrency,
            configuredMaxReadBytes: publishSignalSettings.maxReadBytes,
            effectiveTimeoutMs: publishSignalEnrichment.effectiveTimeoutMs,
            effectiveConcurrency: publishSignalEnrichment.effectiveConcurrency,
            maxReadBytes: publishSignalEnrichment.maxReadBytes,
            truncatedResponses: publishSignalEnrichment.truncatedResponses,
            earlyStoppedResponses:
              publishSignalEnrichment.earlyStoppedResponses,
            softFailures: publishSignalEnrichment.softFailures,
            softFailureCount: publishSignalEnrichment.softFailureCount,
            urlPathFallbackCount,
            totalSignalCandidates,
            urlPathFallbackRatio,
          },
          lowSignalResults: effectiveLowSignalAssessments.length,
          lowSignalWords: {
            min: Number.isFinite(minLowSignalWords) ? minLowSignalWords : 0,
            max: maxLowSignalWords,
            avg: Number.isFinite(meanLowSignalWords)
              ? Number(meanLowSignalWords.toFixed(1))
              : 0,
          },
          lowSignalLinkDensity: {
            max: Number(maxLowSignalLinkDensity.toFixed(3)),
            avg: Number(meanLowSignalLinkDensity.toFixed(3)),
          },
          qualitySamples: effectiveLowSignalAssessments
            .slice(0, 5)
            .map((entry) => ({
              url: entry.article.url ?? null,
              wordCount: entry.quality.wordCount,
              linkCount: entry.quality.linkCount,
              linkDensity: Number(entry.quality.linkDensity.toFixed(3)),
              publishTimeConfidence: Number(
                (typeof entry.quality.publishTimeConfidence === "number"
                  ? entry.quality.publishTimeConfidence
                  : 0
                ).toFixed(3),
              ),
              publishTimeSource: entry.quality.publishTimeSource ?? "none",
              mediaDensity: Number(
                (typeof entry.quality.mediaDensity === "number"
                  ? entry.quality.mediaDensity
                  : 0
                ).toFixed(4),
              ),
              domListRisk: Number(
                (typeof entry.quality.domListRisk === "number"
                  ? entry.quality.domListRisk
                  : 0
                ).toFixed(3),
              ),
              bulletLines: entry.quality.bulletLines,
              score: Number(entry.quality.score.toFixed(2)),
              linkInventory: entry.linkInventory,
            })),
        },
      });

      if (effectiveAllLowSignal) {
        throw new Error(
          "crawl markdown is low-signal/list-like and no detail candidate URLs were extracted from the page content",
        );
      }
      return null;
    }

    const detailOptions = this.buildDetailExpansionOptions(
      options.crawlOptions,
      qualityProfile,
    );
    const candidateBatchSize =
      qualityProfile === "quality_first"
        ? 2
        : qualityProfile === "speed_first"
          ? 4
          : 3;
    const candidateBatches = Array.from(
      { length: Math.ceil(candidateUrls.length / candidateBatchSize) },
      (_, index) =>
        candidateUrls.slice(
          index * candidateBatchSize,
          (index + 1) * candidateBatchSize,
        ),
    );

    const expansionSuccesses: Crawl4aiArticle[] = [];
    const expansionFailures: CrawlFailureDetail[] = [];
    let expansionRunId: string | null = null;

    for (let index = 0; index < candidateBatches.length; index += 1) {
      const batchUrls = candidateBatches[index] ?? [];
      if (batchUrls.length === 0) {
        continue;
      }

      try {
        const batchRequest: Crawl4aiRequest = {
          url: options.task.targetUrl,
          urls: batchUrls,
          keywords: options.keywords,
          options: detailOptions,
        };
        const batchRun = await this.runCrawlWithHeadedFallback({
          request: batchRequest,
          options: detailOptions,
          requestTimeoutMs: options.requestTimeoutMs,
          taskId: options.taskId,
          orgId: options.orgId,
          stage: "expansion",
          reason: `detail_batch_${index + 1}`,
        });
        const batchResponse = batchRun.response;
        const partition = this.partitionCrawlerResults(batchResponse.results);
        expansionRunId = expansionRunId ?? batchResponse.runId ?? null;
        expansionSuccesses.push(...partition.successes);
        if (partition.failures.length > 0) {
          expansionFailures.push(...partition.failures);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error && error.message.trim().length > 0
            ? error.message.trim()
            : "detail expansion batch failed";
        for (const candidateUrl of batchUrls) {
          expansionFailures.push({
            url: candidateUrl,
            error: errorMessage,
            retryable: this.isRetryableStatus(undefined, errorMessage),
          });
        }
      }
    }

    const improvedByUrl = new Map<
      string,
      {
        article: Crawl4aiArticle;
        quality: ReturnType<
          CrawlExecutionService["assessArticleMarkdownSignal"]
        >;
      }
    >();

    for (const article of expansionSuccesses) {
      const quality = this.assessArticleMarkdownSignal(article);
      const articleUrl = article.url ?? "";
      if (
        !this.isLikelyDetailArticleUrl(
          articleUrl,
          options.task.targetUrl,
          detailExpansion.requireSameDomain,
          detailExpansion.allowExternalLinks,
        )
      ) {
        continue;
      }
      const isImproved = this.isSignificantDetailImprovement(
        quality,
        bestLowSignalScore,
        maxLowSignalWords,
        maxLowSignalLinkDensity,
      );
      if (!isImproved) {
        continue;
      }

      const normalizedArticleUrl = this.normalizeComparableUrl(article.url);
      const selectedByExpansionCandidates = normalizedArticleUrl
        ? selectedCandidateSet.has(normalizedArticleUrl)
        : false;
      const detailScore = this.scoreDetailCandidateUrl(
        article.url ?? "",
        options.task.targetUrl,
      );
      if (
        !selectedByExpansionCandidates &&
        Number.isFinite(detailScore) &&
        detailScore < minCandidateScore
      ) {
        continue;
      }

      const comparableUrl =
        this.normalizeComparableUrl(article.url) ??
        article.url ??
        `__missing_url_${improvedByUrl.size}`;
      const current = improvedByUrl.get(comparableUrl);
      if (!current || quality.score > current.quality.score) {
        improvedByUrl.set(comparableUrl, {
          article,
          quality,
        });
      }
    }

    const improvedEntries = Array.from(improvedByUrl.values()).sort(
      (left, right) =>
        right.quality.score - left.quality.score ||
        right.quality.wordCount - left.quality.wordCount ||
        left.quality.linkDensity - right.quality.linkDensity,
    );

    const preferredPathSegment = this.extractPrimaryPathSegment(
      options.task.targetUrl,
    );
    const rankedImprovedEntries = (() => {
      if (!preferredPathSegment) {
        return improvedEntries;
      }

      const preferredEntries = improvedEntries.filter((entry) =>
        this.urlMatchesPrimaryPathSegment(
          entry.article.url,
          preferredPathSegment,
        ),
      );
      if (preferredEntries.length === 0) {
        return improvedEntries;
      }

      if (preferredEntries.length >= Math.min(3, improvedEntries.length)) {
        return preferredEntries;
      }

      const nonPreferredEntries = improvedEntries.filter(
        (entry) =>
          !this.urlMatchesPrimaryPathSegment(
            entry.article.url,
            preferredPathSegment,
          ),
      );
      return [...preferredEntries, ...nonPreferredEntries];
    })();

    const profileImprovedBoost =
      qualityProfile === "quality_first"
        ? 2
        : qualityProfile === "speed_first"
          ? -1
          : 0;
    const baseImprovedResults = effectiveAllLowSignal ? 8 : 5;
    const maxImprovedResults = Math.max(
      1,
      Math.min(
        detailExpansion.maxDetailUrls,
        baseImprovedResults + profileImprovedBoost,
      ),
    );
    const improvedSuccesses = rankedImprovedEntries
      .slice(0, maxImprovedResults)
      .map((entry) => entry.article);

    await this.safeCreateTaskLog({
      queue: CRAWL_QUEUE_NAME,
      jobId: options.taskId,
      orgId: options.orgId,
      stage: "expansion",
      status: "completed",
      message:
        improvedSuccesses.length > 0
          ? `Detail expansion selected ${improvedSuccesses.length} richer article result(s)`
          : "Detail expansion did not produce richer markdown",
      data: {
        qualityProfile,
        pageTypeHint,
        pageKind,
        detailExpansion,
        allLowSignal: effectiveAllLowSignal,
        forcedByLowSignalSeed: shouldForceExpandFromLowSignalSeed,
        totalSuccesses: assessments.length,
        lowSignalResults: effectiveLowSignalAssessments.length,
        lowSignalWords: {
          min: Number.isFinite(minLowSignalWords) ? minLowSignalWords : 0,
          max: maxLowSignalWords,
          avg: Number.isFinite(meanLowSignalWords)
            ? Number(meanLowSignalWords.toFixed(1))
            : 0,
        },
        lowSignalLinkDensity: {
          max: Number(maxLowSignalLinkDensity.toFixed(3)),
          avg: Number(meanLowSignalLinkDensity.toFixed(3)),
        },
        qualitySamples: effectiveLowSignalAssessments
          .slice(0, 5)
          .map((entry) => ({
            url: entry.article.url ?? null,
            wordCount: entry.quality.wordCount,
            linkCount: entry.quality.linkCount,
            linkDensity: Number(entry.quality.linkDensity.toFixed(3)),
            publishTimeConfidence: Number(
              (typeof entry.quality.publishTimeConfidence === "number"
                ? entry.quality.publishTimeConfidence
                : 0
              ).toFixed(3),
            ),
            publishTimeSource: entry.quality.publishTimeSource ?? "none",
            mediaDensity: Number(
              (typeof entry.quality.mediaDensity === "number"
                ? entry.quality.mediaDensity
                : 0
              ).toFixed(4),
            ),
            domListRisk: Number(
              (typeof entry.quality.domListRisk === "number"
                ? entry.quality.domListRisk
                : 0
              ).toFixed(3),
            ),
            bulletLines: entry.quality.bulletLines,
            score: Number(entry.quality.score.toFixed(2)),
            linkInventory: entry.linkInventory,
          })),
        minimumCandidateCount,
        primaryCandidatePool: candidateEntriesRaw.length,
        fallbackCandidatePool: fallbackCandidateEntriesRaw.length,
        primaryCandidatePoolAfterConfidenceFilter: candidateEntries.length,
        fallbackCandidatePoolAfterConfidenceFilter:
          fallbackCandidateEntries.length,
        strictCandidateCount,
        relaxedCandidateCount,
        linkFallbackCandidateCount,
        existingUrlSkipped,
        candidateRejects: candidateDiagnostics,
        publishConfidenceThreshold: minPublishTimeConfidenceThreshold ?? null,
        fallbackPublishConfidenceThreshold:
          fallbackPublishTimeConfidenceThreshold ?? null,
        publishConfidenceBuckets,
        headSignalEnrichment: {
          attempted: publishSignalEnrichment.attempted,
          succeeded: publishSignalEnrichment.succeeded,
          failed: publishSignalEnrichment.failed,
          topK: publishSignalTopK,
          skipped: publishSignalEnrichment.skipped,
          configuredTimeoutMs: publishSignalSettings.timeoutMs,
          configuredConcurrency: publishSignalSettings.concurrency,
          configuredMaxReadBytes: publishSignalSettings.maxReadBytes,
          effectiveTimeoutMs: publishSignalEnrichment.effectiveTimeoutMs,
          effectiveConcurrency: publishSignalEnrichment.effectiveConcurrency,
          maxReadBytes: publishSignalEnrichment.maxReadBytes,
          truncatedResponses: publishSignalEnrichment.truncatedResponses,
          earlyStoppedResponses: publishSignalEnrichment.earlyStoppedResponses,
          softFailures: publishSignalEnrichment.softFailures,
          softFailureCount: publishSignalEnrichment.softFailureCount,
          urlPathFallbackCount,
          totalSignalCandidates,
          urlPathFallbackRatio,
        },
        candidateCount: candidateUrls.length,
        batchCount: candidateBatches.length,
        runId: expansionRunId,
        expansionSuccesses: expansionSuccesses.length,
        expansionFailures: expansionFailures.length,
        improvedSuccesses: improvedSuccesses.length,
        preferredPathSegment: preferredPathSegment ?? null,
        improvedSamples: rankedImprovedEntries.slice(0, 5).map((entry) => ({
          url: entry.article.url ?? null,
          wordCount: entry.quality.wordCount,
          linkCount: entry.quality.linkCount,
          linkDensity: Number(entry.quality.linkDensity.toFixed(3)),
          publishTimeConfidence: Number(
            (typeof entry.quality.publishTimeConfidence === "number"
              ? entry.quality.publishTimeConfidence
              : 0
            ).toFixed(3),
          ),
          publishTimeSource: entry.quality.publishTimeSource ?? "none",
          mediaDensity: Number(
            (typeof entry.quality.mediaDensity === "number"
              ? entry.quality.mediaDensity
              : 0
            ).toFixed(4),
          ),
          domListRisk: Number(
            (typeof entry.quality.domListRisk === "number"
              ? entry.quality.domListRisk
              : 0
            ).toFixed(3),
          ),
          score: Number(entry.quality.score.toFixed(2)),
          isListLike: entry.quality.isListLike,
        })),
        failureSamples: expansionFailures.slice(0, 5),
      },
    });

    if (improvedSuccesses.length === 0) {
      if (effectiveAllLowSignal) {
        throw new Error(
          `crawl markdown is low-signal/list-like and detail expansion did not produce richer article content (candidates=${candidateUrls.length}, expansionSuccesses=${expansionSuccesses.length}, expansionFailures=${expansionFailures.length})`,
        );
      }
      return null;
    }

    const lowSignalIndexes = new Set(
      effectiveLowSignalAssessments.map((entry) => entry.index),
    );
    const retainedSuccesses = options.successes.filter(
      (_, index) => !lowSignalIndexes.has(index),
    );
    const retainedUrlSet = new Set(
      retainedSuccesses
        .map((entry) => this.normalizeComparableUrl(entry.url))
        .filter((entry): entry is string => Boolean(entry)),
    );

    const dedupedImprovedSuccesses = improvedSuccesses.filter((entry) => {
      const comparable = this.normalizeComparableUrl(entry.url);
      if (!comparable) {
        return true;
      }
      if (retainedUrlSet.has(comparable)) {
        return false;
      }
      retainedUrlSet.add(comparable);
      return true;
    });

    return {
      successes: [...retainedSuccesses, ...dedupedImprovedSuccesses],
      failures: expansionFailures,
      runId: expansionRunId,
    };
  }

  private extractPrimaryPathSegment(url: string): string | undefined {
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      return segments[0]?.toLowerCase();
    } catch {
      return undefined;
    }
  }

  private urlMatchesPrimaryPathSegment(
    url: string | undefined,
    segment: string,
  ): boolean {
    if (!url) {
      return false;
    }
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      return segments[0]?.toLowerCase() === segment;
    } catch {
      return false;
    }
  }

  private assessArticleMarkdownSignal(article: Crawl4aiArticle) {
    return this.qualityStrategy.assessArticleMarkdownSignal(article);
  }

  private isSignificantDetailImprovement(
    quality: CrawlArticleSignal,
    baseScore: number,
    baseWords: number,
    baseLinkDensity: number,
  ): boolean {
    return this.qualityStrategy.isSignificantDetailImprovement(
      quality,
      baseScore,
      baseWords,
      baseLinkDensity,
    );
  }

  private buildDetailExpansionOptions(
    options: CrawlTaskOptions,
    qualityProfile: CrawlQualityProfile,
  ): CrawlTaskOptions {
    const cleanMarkdown = options.cleanMarkdown;
    const qualityWordCountThreshold =
      qualityProfile === "quality_first"
        ? Math.min(options.wordCountThreshold ?? 80, 30)
        : qualityProfile === "speed_first"
          ? Math.min(options.wordCountThreshold ?? 80, 50)
          : Math.min(options.wordCountThreshold ?? 80, 40);
    const contentSource: CrawlMarkdownContentSource =
      qualityProfile === "quality_first"
        ? "cleaned_html"
        : (options.markdownOptions?.contentSource ?? "raw_html");

    const normalized = this.normalizeOptions({
      ...options,
      additionalUrls: undefined,
      multiUrlConfigs: undefined,
      scanFullPage: false,
      scrollDelayMs: undefined,
      virtualScroll: undefined,
      markdownFilter: undefined,
      extractLinks: false,
      wordCountThreshold: qualityWordCountThreshold,
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource,
        citations: options.markdownOptions?.citations ?? true,
      },
      cleanMarkdown: cleanMarkdown
        ? {
            ...cleanMarkdown,
            wordCountThreshold:
              typeof cleanMarkdown.wordCountThreshold === "number"
                ? Math.min(cleanMarkdown.wordCountThreshold, 40)
                : 20,
          }
        : {
            removeOverlayElements: true,
            wordCountThreshold: 20,
          },
      detailExpansion: undefined,
      autoExpandDetails: false,
    });
    return normalized;
  }

  private extractDetailLinkCandidatesFromArticle(
    article: Crawl4aiArticle,
    requireSameDomain: boolean,
    allowExternalLinks?: boolean,
    excludeUrlPatterns?: string[],
    includeUrlPatterns?: string[],
    minPublishTimeConfidence?: number,
    diagnostics?: DetailCandidateDiagnostics,
  ): string[] {
    const baseUrl = this.resolveArticleBaseUrl(article);
    if (!baseUrl) {
      return [];
    }

    const markdownResult = this.resultService.extractMarkdownResult(
      article.markdown,
    );
    const fragments = [
      markdownResult.references,
      markdownResult.citations,
      markdownResult.raw,
      markdownResult.fit,
      markdownResult.primary,
    ]
      .filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
      .join("\n");

    const seedUrls: string[] = [];
    if (fragments) {
      const absoluteMatches =
        fragments.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
      seedUrls.push(...absoluteMatches);

      const inlineMarkdownLinks = Array.from(
        fragments.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
      )
        .map((match) => match[1])
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        );
      seedUrls.push(...inlineMarkdownLinks);

      const referenceDefinitions = Array.from(
        fragments.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm),
      )
        .map((match) => match[1])
        .filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        );
      seedUrls.push(...referenceDefinitions);
    }

    if (
      article.links &&
      typeof article.links === "object" &&
      !Array.isArray(article.links)
    ) {
      const linkCollections = Object.values(
        article.links as Record<string, Crawl4aiLink[] | unknown>,
      );
      for (const collection of linkCollections) {
        if (!Array.isArray(collection)) {
          continue;
        }
        for (const link of collection) {
          if (!link || typeof link !== "object") {
            continue;
          }
          const record = link as Crawl4aiLink;
          if (typeof record.url === "string" && record.url.trim().length > 0) {
            seedUrls.push(record.url);
          }
          if (
            typeof record.href === "string" &&
            record.href.trim().length > 0
          ) {
            seedUrls.push(record.href);
          }
        }
      }
    }

    if (
      article.metadata &&
      typeof article.metadata === "object" &&
      !Array.isArray(article.metadata)
    ) {
      const metadata = article.metadata as Record<string, unknown>;
      const metadataCandidates = [
        this.pickString(metadata, [
          "url",
          "sourceUrl",
          "source_url",
          "canonical",
          "canonicalUrl",
          "canonical_url",
        ]),
        this.pickString(metadata, [
          "og:url",
          "ogUrl",
          "openGraphUrl",
          "open_graph_url",
        ]),
      ];

      const nestedRecords: Record<string, unknown>[] = [];
      for (const key of ["openGraph", "open_graph", "meta", "metadata"]) {
        const value = metadata[key];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          nestedRecords.push(value as Record<string, unknown>);
        }
      }

      for (const record of nestedRecords) {
        metadataCandidates.push(
          this.pickString(record, [
            "url",
            "canonical",
            "canonicalUrl",
            "canonical_url",
            "og:url",
            "ogUrl",
          ]),
        );
      }

      for (const candidate of metadataCandidates) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          seedUrls.push(candidate);
        }
      }
    }

    const seen = new Set<string>();
    const scored: { url: string; score: number }[] = [];
    for (const seedUrl of seedUrls) {
      const normalized = this.normalizeDetailCandidateUrl(seedUrl, baseUrl);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      if (
        !this.isLikelyDetailArticleUrl(
          normalized,
          baseUrl,
          requireSameDomain,
          allowExternalLinks,
        )
      ) {
        continue;
      }
      if (
        this.applyDetailExpansionPatternFilters(
          normalized,
          excludeUrlPatterns,
          includeUrlPatterns,
          diagnostics,
        ) === false
      ) {
        continue;
      }
      const publishConfidence =
        this.estimatePublishTimeConfidenceFromCandidateUrl(normalized);
      if (
        typeof minPublishTimeConfidence === "number" &&
        Number.isFinite(minPublishTimeConfidence)
      ) {
        const prefilterThreshold = Math.max(0, minPublishTimeConfidence - 0.25);
        if (publishConfidence < prefilterThreshold) {
          if (diagnostics) {
            diagnostics.publishConfidenceRejected += 1;
          }
          continue;
        }
      }
      seen.add(normalized);
      const precheckPenalty =
        typeof minPublishTimeConfidence === "number" &&
        Number.isFinite(minPublishTimeConfidence) &&
        publishConfidence < minPublishTimeConfidence
          ? Math.round((minPublishTimeConfidence - publishConfidence) * 120)
          : 0;
      scored.push({
        url: normalized,
        score:
          this.scoreDetailCandidateUrl(normalized, baseUrl) - precheckPenalty,
      });
      if (scored.length >= 30) {
        break;
      }
    }

    return scored
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.url);
  }

  private extractFallbackDetailLinkCandidatesFromArticle(
    article: Crawl4aiArticle,
    requireSameDomain: boolean,
    allowExternalLinks?: boolean,
    excludeUrlPatterns?: string[],
    includeUrlPatterns?: string[],
    minPublishTimeConfidence?: number,
    diagnostics?: DetailCandidateDiagnostics,
  ): string[] {
    const baseUrl = this.resolveArticleBaseUrl(article);
    if (!baseUrl) {
      return [];
    }

    if (
      !article.links ||
      typeof article.links !== "object" ||
      Array.isArray(article.links)
    ) {
      return [];
    }

    const scoreByUrl = new Map<string, number>();
    const linkCollections = Object.values(
      article.links as Record<string, Crawl4aiLink[] | unknown>,
    );

    for (const collection of linkCollections) {
      if (!Array.isArray(collection)) {
        continue;
      }
      for (const link of collection) {
        if (!link || typeof link !== "object") {
          continue;
        }

        const record = link as Crawl4aiLink;
        const rawCandidate =
          (typeof record.url === "string" && record.url.trim().length > 0
            ? record.url
            : undefined) ??
          (typeof record.href === "string" && record.href.trim().length > 0
            ? record.href
            : undefined);
        if (!rawCandidate) {
          continue;
        }

        const normalized = this.normalizeDetailCandidateUrl(
          rawCandidate,
          baseUrl,
        );
        if (!normalized) {
          continue;
        }
        if (
          !this.isLikelyFallbackDetailArticleUrl(
            normalized,
            baseUrl,
            requireSameDomain,
            allowExternalLinks,
          )
        ) {
          continue;
        }
        if (
          this.applyDetailExpansionPatternFilters(
            normalized,
            excludeUrlPatterns,
            includeUrlPatterns,
            diagnostics,
          ) === false
        ) {
          continue;
        }
        const publishConfidence =
          this.estimatePublishTimeConfidenceFromCandidateUrl(normalized);
        if (
          typeof minPublishTimeConfidence === "number" &&
          Number.isFinite(minPublishTimeConfidence)
        ) {
          const prefilterThreshold = Math.max(
            0,
            minPublishTimeConfidence - 0.25,
          );
          if (publishConfidence < prefilterThreshold) {
            if (diagnostics) {
              diagnostics.publishConfidenceRejected += 1;
            }
            continue;
          }
        }
        const precheckPenalty =
          typeof minPublishTimeConfidence === "number" &&
          Number.isFinite(minPublishTimeConfidence) &&
          publishConfidence < minPublishTimeConfidence
            ? Math.round((minPublishTimeConfidence - publishConfidence) * 120)
            : 0;
        const linkText = this.pickString(record, ["text", "title"]);
        const textBonus = this.scoreFallbackLinkText(linkText);
        const score =
          this.scoreDetailCandidateUrl(normalized, baseUrl) +
          textBonus -
          precheckPenalty;
        const current = scoreByUrl.get(normalized);
        if (current === undefined || score > current) {
          scoreByUrl.set(normalized, score);
        }
      }
    }

    return Array.from(scoreByUrl.entries())
      .sort((left, right) => right[1] - left[1])
      .map((entry) => entry[0])
      .slice(0, 40);
  }

  private isLikelyFallbackDetailArticleUrl(
    url: string,
    baseUrl: string,
    requireSameDomain: boolean,
    allowExternalLinks?: boolean,
  ): boolean {
    if (
      this.isLikelyDetailArticleUrl(
        url,
        baseUrl,
        requireSameDomain,
        allowExternalLinks,
      )
    ) {
      return true;
    }

    try {
      const parsed = new URL(url);
      const base = new URL(baseUrl);
      const sameRootDomain =
        this.getRootDomain(parsed.hostname) ===
        this.getRootDomain(base.hostname);
      if (requireSameDomain && !sameRootDomain) {
        return false;
      }
      if (allowExternalLinks === false && !sameRootDomain) {
        return false;
      }

      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      if (segments.length < 2) {
        return false;
      }

      const segmentsLower = segments.map((entry) => entry.toLowerCase());
      if (this.hasBlockedDetailPathSegments(segmentsLower)) {
        return false;
      }

      const joined = segments.join("/").toLowerCase();
      if (
        /(^|\/)(video|videos|photo|photos|gallery|podcast|tag|tags|topic|topics|section|sections|author|authors|archive|latest|live|newsletter|country|special-report|poll-of-polls)(\/|$)/.test(
          joined,
        )
      ) {
        return false;
      }

      const lastSegment = segments[segments.length - 1] ?? "";
      const lastSegmentLower = lastSegment.toLowerCase();
      if (
        lastSegment.length >= 16 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }
      if (
        segments.length >= 2 &&
        lastSegment.length >= 12 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private scoreFallbackLinkText(value?: string): number {
    if (!value) {
      return 0;
    }

    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) {
      return 0;
    }

    const lowered = compact.toLowerCase();
    if (
      /(read more|continue reading|view all|latest news|all stories|newsletter|subscribe|commentary)/.test(
        lowered,
      )
    ) {
      return -40;
    }
    if (compact.length >= 24) {
      return 24;
    }
    if (compact.length >= 12) {
      return 12;
    }
    return 0;
  }

  private resolveMinimumDetailExpansionCandidates(
    maxDetailUrls: number,
    candidateLimit: number,
    allLowSignal: boolean,
    qualityProfile: CrawlQualityProfile,
  ): number {
    const profileBoost =
      qualityProfile === "quality_first"
        ? 2
        : qualityProfile === "balanced"
          ? 1
          : 0;
    const baseMinimum = allLowSignal ? 3 : 2;
    const desired = baseMinimum + profileBoost;

    return Math.max(1, Math.min(maxDetailUrls, candidateLimit, desired));
  }

  private resolveArticleBaseUrl(article: Crawl4aiArticle): string | undefined {
    if (typeof article.url === "string" && article.url.trim().length > 0) {
      return article.url.trim();
    }
    const metadataUrl = this.pickString(
      article.metadata as Record<string, unknown> | undefined,
      ["url", "sourceUrl", "source_url"],
    );
    return metadataUrl?.trim() || undefined;
  }

  private normalizeDetailCandidateUrl(
    rawUrl: string,
    baseUrl: string,
  ): string | undefined {
    const trimmed = rawUrl
      .trim()
      .replace(/^<+|>+$/g, "")
      .replace(/[),.:;!?]+$/g, "");
    if (!trimmed) {
      return undefined;
    }

    try {
      const parsed = new URL(trimmed, baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return undefined;
      }
      parsed.hash = "";
      const paramsToDrop = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "gclid",
        "fbclid",
      ];
      for (const key of paramsToDrop) {
        parsed.searchParams.delete(key);
      }
      const pathnameLower = parsed.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|pdf)$/i.test(pathnameLower)) {
        return undefined;
      }
      return this.normalizeComparableUrl(parsed.toString());
    } catch {
      return undefined;
    }
  }

  private isLikelyDetailArticleUrl(
    url: string,
    baseUrl: string,
    requireSameDomain: boolean,
    allowExternalLinks?: boolean,
  ): boolean {
    try {
      const parsed = new URL(url);
      const base = new URL(baseUrl);
      const sameRootDomain =
        this.getRootDomain(parsed.hostname) ===
        this.getRootDomain(base.hostname);
      if (requireSameDomain && !sameRootDomain) {
        return false;
      }
      if (allowExternalLinks === false && !sameRootDomain) {
        return false;
      }

      const pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/+$/, "");
      const segments = pathname.split("/").filter((entry) => entry.length > 0);
      if (segments.length < 2) {
        return false;
      }
      const segmentsLower = segments.map((entry) => entry.toLowerCase());

      if (this.hasBlockedDetailPathSegments(segmentsLower)) {
        return false;
      }

      const joined = segmentsLower.join("/");
      if (
        /\b(video|videos|photo|photos|pictures|gallery|podcast|graphics)\b/.test(
          joined,
        )
      ) {
        return false;
      }
      if (
        /\b(tag|tags|topic|topics|section|sections|author|authors|archive|latest|live)\b/.test(
          joined,
        )
      ) {
        return false;
      }

      const lastSegment = segments[segments.length - 1]!;
      const lastSegmentLower = lastSegment.toLowerCase();
      const likelySectionTail = new Set([
        "world",
        "business",
        "markets",
        "technology",
        "tech",
        "opinion",
        "sport",
        "sports",
        "news",
        "japan",
        "us",
        "china",
        "europe",
        "ukraine",
        "russia",
        "latest",
        "archive",
      ]);
      const articleDateSuffixPattern = /-\d{4}-\d{2}-\d{2}$/;
      const reutersStyleIdPattern = /[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/;
      const reutersWireIdPattern = /(?:^|-)id[a-z0-9]{7,}$/i;

      if (
        articleDateSuffixPattern.test(lastSegment) ||
        reutersStyleIdPattern.test(lastSegment) ||
        reutersWireIdPattern.test(lastSegment)
      ) {
        return true;
      }

      if (/^\d{4}\/\d{2}\/\d{2}/.test(segments.slice(-3).join("/"))) {
        return true;
      }

      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        return true;
      }

      if (
        segments.length >= 4 &&
        lastSegment.length >= 14 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment)
      ) {
        return true;
      }

      if (
        segments.length >= 2 &&
        lastSegment.length >= 18 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }

      if (segments.length >= 2 && /^\d{7,}$/.test(lastSegment)) {
        return true;
      }

      if (
        segments.length >= 2 &&
        /^[a-z0-9]{8,}$/.test(lastSegmentLower) &&
        !likelySectionTail.has(lastSegmentLower) &&
        !/^\d+$/.test(lastSegmentLower) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }

      if (
        segments.length >= 3 &&
        lastSegment.length >= 24 &&
        /[a-z0-9]/i.test(lastSegment) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }

      if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
        return false;
      }

      return false;
    } catch {
      return false;
    }
  }

  private applyDetailExpansionPatternFilters(
    url: string,
    excludeUrlPatterns?: string[],
    includeUrlPatterns?: string[],
    diagnostics?: DetailCandidateDiagnostics,
  ): boolean {
    const normalizedExclude =
      this.normalizePatternList(excludeUrlPatterns) ?? [];
    const normalizedInclude =
      this.normalizePatternList(includeUrlPatterns) ?? [];

    if (
      normalizedInclude.length > 0 &&
      !this.urlMatchesAnyPattern(url, normalizedInclude)
    ) {
      if (diagnostics) {
        diagnostics.includePatternRejected += 1;
      }
      return false;
    }
    if (
      normalizedExclude.length > 0 &&
      this.urlMatchesAnyPattern(url, normalizedExclude)
    ) {
      if (diagnostics) {
        diagnostics.excludePatternRejected += 1;
      }
      return false;
    }
    return true;
  }

  private createEmptyDetailCandidateDiagnostics(): DetailCandidateDiagnostics {
    return {
      includePatternRejected: 0,
      excludePatternRejected: 0,
      publishConfidenceRejected: 0,
    };
  }

  private combineDetailCandidateDiagnostics(
    primary: DetailCandidateDiagnostics,
    fallback: DetailCandidateDiagnostics,
  ): DetailCandidateDiagnostics {
    return {
      includePatternRejected:
        primary.includePatternRejected + fallback.includePatternRejected,
      excludePatternRejected:
        primary.excludePatternRejected + fallback.excludePatternRejected,
      publishConfidenceRejected:
        primary.publishConfidenceRejected + fallback.publishConfidenceRejected,
    };
  }

  private resolvePublishSignalTopK(
    candidateLimit: number,
    maxDetailUrls: number,
    candidatePoolSize: number,
  ): number {
    if (candidatePoolSize <= 0) {
      return 0;
    }
    const desired = Math.max(
      3,
      Math.min(18, Math.max(candidateLimit + 2, maxDetailUrls)),
    );
    return Math.max(0, Math.min(candidatePoolSize, desired));
  }

  private async getPublishSignalEnrichmentSettings(): Promise<PublishSignalEnrichmentSettings> {
    const fallback: PublishSignalEnrichmentSettings = {
      timeoutMs: this.defaultDetailPublishSignalHeadFetchTimeoutMs,
      concurrency: this.defaultDetailPublishSignalHeadFetchConcurrency,
      maxReadBytes: this.defaultDetailPublishSignalHeadFetchMaxReadBytes,
    };
    try {
      const settings = await this.crawlSettings.getSettings();
      return {
        timeoutMs:
          typeof settings.detailPublishSignalHeadFetchTimeoutMs === "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchTimeoutMs)
            ? settings.detailPublishSignalHeadFetchTimeoutMs
            : fallback.timeoutMs,
        concurrency:
          typeof settings.detailPublishSignalHeadFetchConcurrency ===
            "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchConcurrency)
            ? settings.detailPublishSignalHeadFetchConcurrency
            : fallback.concurrency,
        maxReadBytes:
          typeof settings.detailPublishSignalHeadFetchMaxReadBytes ===
            "number" &&
          Number.isFinite(settings.detailPublishSignalHeadFetchMaxReadBytes)
            ? settings.detailPublishSignalHeadFetchMaxReadBytes
            : fallback.maxReadBytes,
      };
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to load crawl settings for publish-signal enrichment; using defaults",
      );
      return fallback;
    }
  }

  private async enrichCandidatePublishSignals(options: {
    urls: string[];
    requestTimeoutMs?: number;
    settings: PublishSignalEnrichmentSettings;
  }): Promise<PublishSignalEnrichmentResult> {
    const signals = new Map<string, CandidatePublishSignal>();
    const softFailures = this.createEmptyPublishSignalSoftFailureBreakdown();
    const uniqueUrls = Array.from(
      new Set(
        options.urls.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ),
      ),
    );
    const timeoutMs = this.resolvePublishSignalFetchTimeoutMs(
      options.settings.timeoutMs,
      options.requestTimeoutMs,
    );
    const resolvedConcurrency = this.resolvePublishSignalFetchConcurrency(
      options.settings.concurrency,
    );
    const resolvedMaxReadBytes = this.resolvePublishSignalMaxReadBytes(
      options.settings.maxReadBytes,
    );
    const effectiveConcurrency =
      uniqueUrls.length > 0
        ? Math.max(1, Math.min(uniqueUrls.length, resolvedConcurrency))
        : 0;
    if (uniqueUrls.length === 0) {
      return {
        signals,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: false,
        effectiveTimeoutMs: timeoutMs,
        effectiveConcurrency,
        maxReadBytes: resolvedMaxReadBytes,
        truncatedResponses: 0,
        earlyStoppedResponses: 0,
        softFailures,
        softFailureCount: 0,
      };
    }
    if (!this.shouldEnrichCandidatePublishSignals()) {
      return {
        signals,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        effectiveTimeoutMs: timeoutMs,
        effectiveConcurrency,
        maxReadBytes: resolvedMaxReadBytes,
        truncatedResponses: 0,
        earlyStoppedResponses: 0,
        softFailures,
        softFailureCount: 0,
      };
    }
    let cursor = 0;
    let succeeded = 0;
    let failed = 0;
    let truncatedResponses = 0;
    let earlyStoppedResponses = 0;

    const worker = async () => {
      while (cursor < uniqueUrls.length) {
        const index = cursor;
        cursor += 1;
        const url = uniqueUrls[index];
        if (!url) {
          failed += 1;
          continue;
        }
        const fetched = await this.fetchCandidatePublishSignal(
          url,
          timeoutMs,
          resolvedMaxReadBytes,
        );
        if (fetched.truncated) {
          truncatedResponses += 1;
        }
        if (fetched.earlyStopped) {
          earlyStoppedResponses += 1;
        }
        const signal = fetched.signal;
        if (signal && signal.source !== "none") {
          signals.set(url, signal);
          succeeded += 1;
        } else {
          this.incrementPublishSignalSoftFailure(
            softFailures,
            fetched.failureReason ?? "no_publish_signal",
          );
          failed += 1;
        }
      }
    };

    await Promise.all(
      Array.from({ length: effectiveConcurrency }, () => worker()),
    );

    const softFailureCount = this.countPublishSignalSoftFailures(softFailures);
    if (softFailureCount > 0) {
      logger.warn(
        {
          attempted: uniqueUrls.length,
          succeeded,
          failed,
          truncatedResponses,
          earlyStoppedResponses,
          softFailures,
        },
        "Publish-signal enrichment completed with non-blocking soft failures",
      );
    }

    return {
      signals,
      attempted: uniqueUrls.length,
      succeeded,
      failed,
      skipped: false,
      effectiveTimeoutMs: timeoutMs,
      effectiveConcurrency,
      maxReadBytes: resolvedMaxReadBytes,
      truncatedResponses,
      earlyStoppedResponses,
      softFailures,
      softFailureCount,
    };
  }

  private shouldEnrichCandidatePublishSignals(): boolean {
    return process.env.NODE_ENV !== "test";
  }

  private resolvePublishSignalFetchTimeoutMs(
    configuredTimeoutMs: number,
    requestTimeoutMs?: number,
  ): number {
    const fromSettings =
      typeof configuredTimeoutMs === "number" &&
      Number.isFinite(configuredTimeoutMs) &&
      configuredTimeoutMs > 0
        ? Math.max(500, Math.min(10_000, Math.round(configuredTimeoutMs)))
        : this.defaultDetailPublishSignalHeadFetchTimeoutMs;
    if (
      typeof requestTimeoutMs === "number" &&
      Number.isFinite(requestTimeoutMs) &&
      requestTimeoutMs > 0
    ) {
      const requestBound = Math.max(
        500,
        Math.min(10_000, Math.round(requestTimeoutMs)),
      );
      return Math.min(fromSettings, requestBound);
    }
    return fromSettings;
  }

  private resolvePublishSignalFetchConcurrency(
    configuredConcurrency: number,
  ): number {
    if (
      typeof configuredConcurrency !== "number" ||
      !Number.isFinite(configuredConcurrency) ||
      configuredConcurrency <= 0
    ) {
      return this.defaultDetailPublishSignalHeadFetchConcurrency;
    }
    return Math.max(1, Math.min(8, Math.round(configuredConcurrency)));
  }

  private resolvePublishSignalMaxReadBytes(
    configuredMaxReadBytes: number,
  ): number {
    if (
      typeof configuredMaxReadBytes !== "number" ||
      !Number.isFinite(configuredMaxReadBytes) ||
      configuredMaxReadBytes <= 0
    ) {
      return this.defaultDetailPublishSignalHeadFetchMaxReadBytes;
    }
    return Math.max(
      1_048_576,
      Math.min(64_000_000, Math.round(configuredMaxReadBytes)),
    );
  }

  private async fetchCandidatePublishSignal(
    url: string,
    timeoutMs: number,
    maxReadBytes: number,
  ): Promise<CandidatePublishSignalFetchResult> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.ssrfSafeFetch(
          url,
          "GET",
          {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "user-agent":
              "Mozilla/5.0 (compatible; CrawlQualityProbe/1.0; +https://example.com)",
          },
          controller.signal,
        );
        if (!response) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "network_or_timeout",
          };
        }
        if (!response.ok) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "http_status",
          };
        }
        const contentType =
          response.headers.get("content-type")?.toLowerCase() ?? "";
        if (
          contentType.length > 0 &&
          !contentType.includes("text/html") &&
          !contentType.includes("application/xhtml+xml")
        ) {
          return {
            truncated: false,
            earlyStopped: false,
            failureReason: "non_html",
          };
        }
        const readResult = await this.readPublishSignalHtmlWithSoftLimit(
          response,
          maxReadBytes,
        );
        if (!readResult.html || readResult.html.trim().length === 0) {
          return {
            truncated: readResult.truncated,
            earlyStopped: readResult.earlyStopped,
            failureReason: "empty_html",
          };
        }
        const signal = this.extractPublishSignalFromHtml(readResult.html);
        if (!signal || signal.source === "none") {
          return {
            truncated: readResult.truncated,
            earlyStopped: readResult.earlyStopped,
            failureReason: "no_publish_signal",
          };
        }
        return {
          signal,
          truncated: readResult.truncated,
          earlyStopped: readResult.earlyStopped,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return {
        truncated: false,
        earlyStopped: false,
        failureReason: "network_or_timeout",
      };
    }
  }

  private createEmptyPublishSignalSoftFailureBreakdown(): PublishSignalSoftFailureBreakdown {
    return {
      httpStatus: 0,
      nonHtml: 0,
      emptyHtml: 0,
      networkOrTimeout: 0,
      noPublishSignal: 0,
    };
  }

  private incrementPublishSignalSoftFailure(
    breakdown: PublishSignalSoftFailureBreakdown,
    reason: PublishSignalSoftFailureReason,
  ) {
    if (reason === "http_status") {
      breakdown.httpStatus += 1;
      return;
    }
    if (reason === "non_html") {
      breakdown.nonHtml += 1;
      return;
    }
    if (reason === "empty_html") {
      breakdown.emptyHtml += 1;
      return;
    }
    if (reason === "network_or_timeout") {
      breakdown.networkOrTimeout += 1;
      return;
    }
    breakdown.noPublishSignal += 1;
  }

  private countPublishSignalSoftFailures(
    breakdown: PublishSignalSoftFailureBreakdown,
  ): number {
    return (
      breakdown.httpStatus +
      breakdown.nonHtml +
      breakdown.emptyHtml +
      breakdown.networkOrTimeout +
      breakdown.noPublishSignal
    );
  }

  private async readPublishSignalHtmlWithSoftLimit(
    response: Response,
    maxBytes: number,
  ): Promise<{ html: string; truncated: boolean; earlyStopped: boolean }> {
    const limit =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.max(32_768, Math.min(64_000_000, Math.round(maxBytes)))
        : this.defaultDetailPublishSignalHeadFetchMaxReadBytes;
    if (!response.body) {
      const text = await response.text();
      if (text.length <= limit) {
        return { html: text, truncated: false, earlyStopped: false };
      }
      return {
        html: text.slice(0, limit),
        truncated: true,
        earlyStopped: false,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const headProbeBytes = Math.min(limit, 524_288);
    let bytesRead = 0;
    let html = "";
    let truncated = false;
    let earlyStopped = false;
    let shouldProbeHeadSignal = true;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (!value || value.length === 0) {
          continue;
        }
        const remaining = limit - bytesRead;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (value.length > remaining) {
          html += decoder.decode(value.subarray(0, remaining), {
            stream: true,
          });
          bytesRead += remaining;
          truncated = true;
          break;
        }
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (shouldProbeHeadSignal) {
          const hasClosedHead = html.includes("</head>");
          if (hasClosedHead || bytesRead >= headProbeBytes) {
            shouldProbeHeadSignal = false;
            const headSignal = this.extractPublishSignalFromHtml(html, {
              includeTimeTag: false,
            });
            if (
              headSignal &&
              (headSignal.source === "meta" || headSignal.source === "jsonld")
            ) {
              earlyStopped = true;
              break;
            }
          }
        }
      }
      html += decoder.decode();
    } finally {
      if (truncated || earlyStopped) {
        try {
          await reader.cancel();
        } catch {
          // no-op
        }
      } else {
        try {
          reader.releaseLock();
        } catch {
          // no-op
        }
      }
    }
    return { html, truncated, earlyStopped };
  }

  private extractPublishSignalFromHtml(
    html: string,
    options?: { includeTimeTag?: boolean },
  ): CandidatePublishSignal | undefined {
    const $ = load(html);
    const head = $("head");
    const includeTimeTag = options?.includeTimeTag ?? true;
    const parseTimestamp = (value: unknown): number | undefined => {
      if (typeof value !== "string") {
        return undefined;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      const timestamp = Date.parse(trimmed);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return undefined;
      }
      return timestamp;
    };

    const resolveMetaTimestamp = (): number | undefined => {
      const selectors = [
        'meta[property="article:published_time"]',
        'meta[property="og:published_time"]',
        'meta[name="pubdate"]',
        'meta[name="publishdate"]',
        'meta[name="date"]',
        'meta[itemprop="datePublished"]',
      ];
      for (const selector of selectors) {
        const value = head.find(selector).attr("content");
        const timestamp = parseTimestamp(value);
        if (timestamp) {
          return timestamp;
        }
      }
      return undefined;
    };

    const metaTimestamp = resolveMetaTimestamp();
    if (metaTimestamp) {
      return {
        confidence: 0.95,
        source: "meta",
        timestamp: metaTimestamp,
      };
    }

    const scripts = head.find('script[type="application/ld+json"]');
    for (let index = 0; index < scripts.length && index < 8; index += 1) {
      const raw = scripts.eq(index).contents().text().trim();
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        const timestamp = this.findJsonLdPublishTimestamp(parsed);
        if (timestamp) {
          return {
            confidence: 0.92,
            source: "jsonld",
            timestamp,
          };
        }
      } catch {
        continue;
      }
    }

    if (includeTimeTag) {
      const timeValue = $("time[datetime]").first().attr("datetime");
      const timeTimestamp = parseTimestamp(timeValue);
      if (timeTimestamp) {
        return {
          confidence: 0.88,
          source: "time_tag",
          timestamp: timeTimestamp,
        };
      }
    }

    return undefined;
  }

  private findJsonLdPublishTimestamp(value: unknown): number | undefined {
    const parseTimestamp = (candidate: unknown): number | undefined => {
      if (typeof candidate !== "string") {
        return undefined;
      }
      const timestamp = Date.parse(candidate);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return undefined;
      }
      return timestamp;
    };

    if (Array.isArray(value)) {
      for (const item of value) {
        const timestamp = this.findJsonLdPublishTimestamp(item);
        if (timestamp) {
          return timestamp;
        }
      }
      return undefined;
    }

    if (!value || typeof value !== "object") {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const published = parseTimestamp(record.datePublished);
    if (published) {
      return published;
    }
    const created = parseTimestamp(record.dateCreated);
    if (created) {
      return created;
    }
    const modified = parseTimestamp(record.dateModified);
    if (modified) {
      return modified;
    }

    for (const nested of Object.values(record)) {
      const timestamp = this.findJsonLdPublishTimestamp(nested);
      if (timestamp) {
        return timestamp;
      }
    }
    return undefined;
  }

  private resolveCandidatePublishSignal(
    url: string,
    enriched?: CandidatePublishSignal,
  ): CandidatePublishSignal {
    const pathTimestamp = this.parseDateFromUrlPath(url);
    const pathSignal: CandidatePublishSignal = {
      confidence: this.estimatePublishTimeConfidenceFromCandidateUrl(url),
      source: "url_path",
      timestamp: pathTimestamp,
    };
    if (!enriched) {
      return pathSignal;
    }
    return enriched.confidence >= pathSignal.confidence ? enriched : pathSignal;
  }

  private buildDetailCandidateConfidenceBuckets(
    signalByUrl: Map<string, CandidatePublishSignal>,
    candidateUrls: string[],
  ): DetailCandidateConfidenceBuckets {
    const buckets: DetailCandidateConfidenceBuckets = {
      lt04: 0,
      from04To06: 0,
      from06To08: 0,
      gte08: 0,
    };
    for (const url of candidateUrls) {
      const signal = signalByUrl.get(url);
      const confidence =
        signal?.confidence ??
        this.estimatePublishTimeConfidenceFromCandidateUrl(url);
      if (!Number.isFinite(confidence)) {
        continue;
      }
      if (confidence < 0.4) {
        buckets.lt04 += 1;
      } else if (confidence < 0.6) {
        buckets.from04To06 += 1;
      } else if (confidence < 0.8) {
        buckets.from06To08 += 1;
      } else {
        buckets.gte08 += 1;
      }
    }
    return buckets;
  }

  private urlMatchesAnyPattern(url: string, patterns: string[]): boolean {
    return patterns.some((pattern) => this.urlMatchesPattern(url, pattern));
  }

  private urlMatchesPattern(url: string, pattern: string): boolean {
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
      return false;
    }
    const normalizedUrl = url.toLowerCase();
    const loweredPattern = normalizedPattern.toLowerCase();

    if (
      loweredPattern.startsWith("/") &&
      loweredPattern.endsWith("/") &&
      loweredPattern.length > 2
    ) {
      try {
        const regex = new RegExp(
          normalizedPattern.slice(1, normalizedPattern.length - 1),
          "i",
        );
        return regex.test(url);
      } catch {
        return normalizedUrl.includes(loweredPattern);
      }
    }

    if (loweredPattern.includes("*")) {
      const escaped = loweredPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const wildcardRegex = new RegExp(
        "^" + escaped.replace(/\*/g, ".*") + "$",
        "i",
      );
      return wildcardRegex.test(url);
    }
    return normalizedUrl.includes(loweredPattern);
  }

  private estimatePublishTimeConfidenceFromCandidateUrl(url: string): number {
    const fromPath = this.parseDateFromUrlPath(url);
    if (fromPath) {
      return 0.82;
    }
    try {
      const parsed = new URL(url);
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      const lastSegment = (segments[segments.length - 1] ?? "").toLowerCase();
      if (/^\d{7,}$/.test(lastSegment)) {
        return 0.74;
      }
      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        return 0.6;
      }
      if (segments.length >= 3 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        return 0.56;
      }
      return 0.38;
    } catch {
      return 0.3;
    }
  }

  private parseDateFromUrlPath(url: string): number | undefined {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.toLowerCase();
      const toUtcTimestamp = (year: number, month: number, day: number) => {
        if (
          !Number.isFinite(year) ||
          !Number.isFinite(month) ||
          !Number.isFinite(day)
        ) {
          return undefined;
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          return undefined;
        }
        const ts = Date.UTC(year, month - 1, day);
        if (!Number.isFinite(ts)) {
          return undefined;
        }
        const check = new Date(ts);
        if (
          check.getUTCFullYear() !== year ||
          check.getUTCMonth() !== month - 1 ||
          check.getUTCDate() !== day
        ) {
          return undefined;
        }
        return ts;
      };
      const slashDate = /\/(20\d{2})\/([01]\d)\/([0-3]\d)(?:\/|$)/.exec(path);
      if (slashDate) {
        return toUtcTimestamp(
          Number(slashDate[1]),
          Number(slashDate[2]),
          Number(slashDate[3]),
        );
      }
      const dashedDate = /(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)/.exec(path);
      if (dashedDate) {
        return toUtcTimestamp(
          Number(dashedDate[1]),
          Number(dashedDate[2]),
          Number(dashedDate[3]),
        );
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private detailRelevanceToScore(minRelevanceScore: number): number {
    if (minRelevanceScore <= 0) {
      return Number.NEGATIVE_INFINITY;
    }
    return minRelevanceScore * 300 - 120;
  }

  private scoreDetailCandidateUrl(url: string, baseUrl?: string): number {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.replace(/\/+$/, "");
      const segments = pathname.split("/").filter((entry) => entry.length > 0);
      const segmentsLower = segments.map((entry) => entry.toLowerCase());
      const lastSegment = segments[segments.length - 1] ?? "";
      const lastSegmentLower = lastSegment.toLowerCase();
      const hasArticleLeadSegment =
        this.hasArticleLeadPathSegment(segmentsLower);
      const publishTimeConfidence =
        this.estimatePublishTimeConfidenceFromCandidateUrl(url);

      let score = 0;
      score += Math.round(publishTimeConfidence * 80);
      if (this.hasBlockedDetailPathSegments(segmentsLower)) {
        score -= 400;
      }
      if (/-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 220;
      }
      if (/[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 150;
      }
      if (/(?:^|-)id[a-z0-9]{7,}$/i.test(lastSegment)) {
        score += 130;
      }
      if (
        segments.some(
          (segment) => segment === "article" || segment === "articles",
        )
      ) {
        score += 100;
      }
      if (hasArticleLeadSegment) {
        score += 30;
      }
      if (segments.length >= 4 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        score += 80;
      }
      if (
        segments.length >= 2 &&
        lastSegment.length >= 18 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        score += 65;
      }
      if (segments.length >= 2 && /^\d{7,}$/.test(lastSegment)) {
        score += 95;
      }
      if (
        segments.length >= 2 &&
        /^[a-z0-9]{8,}$/.test(lastSegmentLower) &&
        !this.isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        score += 35;
      }
      if (segments.length >= 3) {
        score += 18;
      }
      if (parsed.pathname.toLowerCase().includes("/world/")) {
        score += 16;
      }

      if (baseUrl) {
        try {
          const base = new URL(baseUrl);
          const baseSegments = base.pathname
            .replace(/\/+$/, "")
            .split("/")
            .filter((entry) => entry.length > 0)
            .map((entry) => entry.toLowerCase());
          if (baseSegments[0]) {
            if (baseSegments[0] === segmentsLower[0]) {
              score += 120;
            } else {
              score -= 90;
            }
          }
          if (baseSegments[1] && baseSegments[1] === segmentsLower[1]) {
            score += 30;
          }
        } catch {
          // Ignore scoring hints when base URL is malformed
        }
      }

      const likelySectionTail = new Set([
        "world",
        "business",
        "markets",
        "technology",
        "tech",
        "opinion",
        "sport",
        "sports",
        "news",
        "japan",
        "us",
        "china",
        "europe",
        "ukraine",
        "russia",
        "latest",
        "archive",
      ]);
      if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
        score -= 180;
      }

      if (
        segmentsLower.some((segment) =>
          [
            "video",
            "videos",
            "photos",
            "photo",
            "gallery",
            "graphics",
            "podcast",
            "tag",
            "tags",
            "topic",
            "topics",
            "section",
            "sections",
            "authors",
            "author",
          ].includes(segment),
        )
      ) {
        score -= 150;
      }

      if (parsed.search.length > 0) {
        score -= 12;
      }
      return score;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  }

  private hasArticleLeadPathSegment(segmentsLower: string[]): boolean {
    if (segmentsLower.length === 0) {
      return false;
    }
    return this.articleLeadPathSegments.has(segmentsLower[0] ?? "");
  }

  private hasBlockedDetailPathSegments(segmentsLower: string[]): boolean {
    return segmentsLower.some((segment) =>
      this.isBlockedDetailPathSegment(segment),
    );
  }

  private isBlockedDetailPathSegment(segment: string): boolean {
    if (!segment) {
      return false;
    }
    if (this.blockedDetailPathSegments.has(segment)) {
      return true;
    }

    return (
      segment.endsWith("-newsletter") ||
      segment.endsWith("-newsletters") ||
      segment.endsWith("-special-report") ||
      segment.endsWith("-poll-of-polls") ||
      segment.startsWith("newsletter-") ||
      segment.startsWith("country-")
    );
  }

  private isLikelyPathCategoryToken(value: string): boolean {
    const compact = value.trim().toLowerCase();
    if (!compact) {
      return false;
    }

    return (
      this.blockedDetailPathSegments.has(compact) ||
      compact === "overview" ||
      compact === "all" ||
      compact === "index" ||
      compact.endsWith("-index") ||
      compact.endsWith("-overview")
    );
  }

  private normalizeComparableUrl(url?: string): string | undefined {
    if (!url) {
      return undefined;
    }
    try {
      const parsed = new URL(url);
      parsed.hash = "";
      if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
        parsed.pathname = parsed.pathname.replace(/\/+$/, "");
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private getRootDomain(hostname: string): string {
    const normalized = hostname.trim().toLowerCase();
    const parts = normalized.split(".").filter((entry) => entry.length > 0);
    if (parts.length <= 2) {
      return normalized;
    }
    return parts.slice(-2).join(".");
  }

  private async safeNotifyCrawl(
    task: CrawlTask,
    summary: CrawlExecutionSummary,
    triggeredById: string,
    status: "completed" | "failed",
    errorMessage?: string,
  ) {
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

    await this.safeCreateTaskLog({
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

  private fromJsonArray(value: Prisma.JsonValue | null): string[] {
    if (!value || !Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }

  private buildRequestPayload(
    task: CrawlTask,
    providedOptions?: CrawlTaskOptions,
  ): Crawl4aiRequest {
    const keywords = this.fromJsonArray(task.keywords);
    const options = this.ensureTaskSessionReuse(
      task.id,
      providedOptions ?? this.extractOptions(task.config),
    );
    const urls = this.buildUrlList(task.targetUrl, options);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options,
    };
  }

  private buildRequestPayloadWithUrls(
    task: CrawlTask,
    providedOptions: CrawlTaskOptions,
    urls: string[],
  ): Crawl4aiRequest {
    const keywords = this.fromJsonArray(task.keywords);
    const options = this.ensureTaskSessionReuse(task.id, providedOptions);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options,
    };
  }

  private extractOptions(config: Prisma.JsonValue | null): CrawlTaskOptions {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return this.normalizeOptions();
    }
    const value = config as Record<string, unknown>;
    return this.normalizeOptions({
      includeImages:
        typeof value.includeImages === "boolean"
          ? value.includeImages
          : undefined,
      storeMedia:
        typeof value.storeMedia === "boolean" ? value.storeMedia : undefined,
      onlyMainContent:
        typeof value.onlyMainContent === "boolean"
          ? value.onlyMainContent
          : undefined,
      extractLinks:
        typeof value.extractLinks === "boolean"
          ? value.extractLinks
          : undefined,
      cacheMode:
        typeof value.cacheMode === "string"
          ? (value.cacheMode as CrawlTaskOptions["cacheMode"])
          : undefined,
      prefetch:
        typeof value.prefetch === "boolean" ? value.prefetch : undefined,
      scanFullPage:
        typeof value.scanFullPage === "boolean"
          ? value.scanFullPage
          : undefined,
      adjustViewportToContent:
        typeof value.adjustViewportToContent === "boolean"
          ? value.adjustViewportToContent
          : undefined,
      scrollDelayMs:
        typeof value.scrollDelayMs === "number"
          ? value.scrollDelayMs
          : undefined,
      headless:
        typeof value.headless === "boolean" ? value.headless : undefined,
      enableUndetectedBrowser:
        typeof value.enableUndetectedBrowser === "boolean"
          ? value.enableUndetectedBrowser
          : undefined,
      antiBotMode: this.parseAntiBotMode(value.antiBotMode),
      enableStealthMode:
        typeof value.enableStealthMode === "boolean"
          ? value.enableStealthMode
          : undefined,
      useManagedBrowser:
        typeof value.useManagedBrowser === "boolean"
          ? value.useManagedBrowser
          : undefined,
      userDataDir:
        typeof value.userDataDir === "string" ? value.userDataDir : undefined,
      simulateUser:
        typeof value.simulateUser === "boolean"
          ? value.simulateUser
          : undefined,
      overrideNavigator:
        typeof value.overrideNavigator === "boolean"
          ? value.overrideNavigator
          : undefined,
      sessionId:
        typeof value.sessionId === "string" ? value.sessionId : undefined,
      storageState:
        typeof value.storageState === "string" ? value.storageState : undefined,
      jsCode: this.parseStringArray(value.jsCode),
      jsOnly: typeof value.jsOnly === "boolean" ? value.jsOnly : undefined,
      waitForSelector:
        typeof value.waitForSelector === "string"
          ? value.waitForSelector
          : undefined,
      waitForScript:
        typeof value.waitForScript === "string"
          ? value.waitForScript
          : undefined,
      waitForTimeoutMs:
        typeof value.waitForTimeoutMs === "number"
          ? value.waitForTimeoutMs
          : undefined,
      waitUntil: this.parseWaitUntil(value.waitUntil),
      pageTimeoutMs: this.parseOptionalNumber(value.pageTimeoutMs),
      delayBeforeReturnHtmlMs: this.parseOptionalNumber(
        value.delayBeforeReturnHtmlMs,
      ),
      meanDelayMs: this.parseOptionalNumber(value.meanDelayMs),
      maxDelayRangeMs: this.parseOptionalNumber(value.maxDelayRangeMs),
      semaphoreCount: this.parseOptionalNumber(value.semaphoreCount),
      proxyUrl: typeof value.proxyUrl === "string" ? value.proxyUrl : undefined,
      proxyConfig: this.parseProxyConfig(value.proxyConfig),
      additionalUrls: this.parseUrlArray(value.additionalUrls),
      multiUrlConfigs: this.parseMultiUrlConfigs(value.multiUrlConfigs),
      markdownOptions: this.parseMarkdownOptions(value.markdownOptions),
      markdownFilter: this.parseMarkdownFilter(value.markdownFilter),
      markdownStrategy: this.parseMarkdownStrategy(value.markdownStrategy),
      tableScoreThreshold:
        typeof value.tableScoreThreshold === "number"
          ? value.tableScoreThreshold
          : undefined,
      tableExtraction: this.parseTableExtraction(value.tableExtraction),
      cleanMarkdown: this.parseCleanMarkdownOptions(value.cleanMarkdown),
      scoreLinks:
        typeof value.scoreLinks === "boolean" ? value.scoreLinks : undefined,
      linkPreview: this.parseLinkPreviewOptions(value.linkPreview),
      browserHeaders: this.parseBrowserHeaders(value.browserHeaders),
      browserCookies: this.parseBrowserCookies(value.browserCookies),
      userAgent:
        typeof value.userAgent === "string" ? value.userAgent : undefined,
      userAgentMode: value.userAgentMode === "random" ? "random" : undefined,
      userAgentGenerator: this.parseUserAgentGenerator(
        value.userAgentGenerator,
      ),
      locale: typeof value.locale === "string" ? value.locale : undefined,
      timezoneId:
        typeof value.timezoneId === "string" ? value.timezoneId : undefined,
      geolocation: this.parseGeolocation(value.geolocation),
      wordCountThreshold:
        typeof value.wordCountThreshold === "number"
          ? value.wordCountThreshold
          : undefined,
      excludeExternalLinks:
        typeof value.excludeExternalLinks === "boolean"
          ? value.excludeExternalLinks
          : undefined,
      excludeExternalImages:
        typeof value.excludeExternalImages === "boolean"
          ? value.excludeExternalImages
          : undefined,
      removeOverlayElements:
        typeof value.removeOverlayElements === "boolean"
          ? value.removeOverlayElements
          : undefined,
      processIframes:
        typeof value.processIframes === "boolean"
          ? value.processIframes
          : undefined,
      cssSelector:
        typeof value.cssSelector === "string" ? value.cssSelector : undefined,
      excludedTags: this.coerceStringArray(value.excludedTags),
      textMode:
        typeof value.textMode === "boolean" ? value.textMode : undefined,
      captureScreenshot:
        typeof value.captureScreenshot === "boolean"
          ? value.captureScreenshot
          : undefined,
      virtualScroll: this.parseVirtualScrollConfig(value.virtualScroll),
      waitForImages:
        typeof value.waitForImages === "boolean"
          ? value.waitForImages
          : undefined,
      removeForms:
        typeof value.removeForms === "boolean" ? value.removeForms : undefined,
      pageTypeHint: this.parsePageTypeHint(value.pageTypeHint),
      autoExpandDetails:
        typeof value.autoExpandDetails === "boolean"
          ? value.autoExpandDetails
          : undefined,
      detailExpansion: this.parseDetailExpansionOptions(value.detailExpansion),
      qualityProfile: this.parseQualityProfile(value.qualityProfile),
    });
  }

  public normalizeOptions(
    options?: Partial<CrawlTaskOptions>,
  ): CrawlTaskOptions {
    const includeImages =
      options?.includeImages ?? (options?.storeMedia ? true : false);
    const virtualScroll = this.normalizeVirtualScrollConfig(
      options?.virtualScroll,
    );
    const scanFullPage = virtualScroll
      ? false
      : (options?.scanFullPage ?? false);
    const adjustViewportToContent =
      typeof options?.adjustViewportToContent === "boolean"
        ? options.adjustViewportToContent
        : scanFullPage;
    let scrollDelayMs: number | undefined;
    if (scanFullPage) {
      scrollDelayMs =
        typeof options?.scrollDelayMs === "number"
          ? this.clampScrollDelay(options.scrollDelayMs)
          : 200;
    }
    const headless =
      typeof options?.headless === "boolean" ? options.headless : undefined;
    const antiBotMode = this.parseAntiBotMode(options?.antiBotMode) ?? "auto";
    const enableStealthMode = options?.enableStealthMode ?? false;
    const simulateUser =
      options?.simulateUser ?? (enableStealthMode ? true : false);
    const overrideNavigator =
      options?.overrideNavigator ?? (enableStealthMode ? true : false);
    const userDataDir = this.normalizeUserDataDir(options?.userDataDir);
    const useManagedBrowser =
      options?.useManagedBrowser ?? Boolean(userDataDir);
    const proxyConfig = this.normalizeProxyConfig(options?.proxyConfig);
    const proxyUrl = proxyConfig
      ? undefined
      : this.normalizeProxyUrl(options?.proxyUrl);
    const additionalUrls = this.normalizeUrlList(options?.additionalUrls);
    const multiUrlConfigs = this.normalizeMultiUrlConfigs(
      options?.multiUrlConfigs,
    );
    const qualityProfile =
      this.parseQualityProfile(options?.qualityProfile) ?? "quality_first";
    const markdownOptionsInput = this.normalizeMarkdownOptions(
      options?.markdownOptions,
    );
    const markdownOptions = this.normalizeMarkdownOptions({
      ...(markdownOptionsInput ?? {}),
      contentSource:
        markdownOptionsInput?.contentSource ??
        (qualityProfile === "speed_first" ? "raw_html" : "cleaned_html"),
      citations: markdownOptionsInput?.citations ?? true,
    });
    const markdownFilter = this.normalizeMarkdownFilter(
      options?.markdownFilter,
    );
    const markdownStrategy = this.normalizeMarkdownStrategy(
      options?.markdownStrategy,
    );
    const tableScoreThreshold = this.normalizeTableScore(
      options?.tableScoreThreshold,
    );
    const tableExtraction = this.normalizeTableExtraction(
      options?.tableExtraction,
    );
    const cleanMarkdownInput = this.normalizeCleanMarkdownOptions(
      options?.cleanMarkdown,
    );
    const cleanMarkdown = this.normalizeCleanMarkdownOptions({
      ...(cleanMarkdownInput ?? {}),
      cssSelector: undefined,
      excludedTags: this.mergeSelectorValues(
        cleanMarkdownInput?.excludedTags,
        qualityProfile === "quality_first"
          ? ["nav", "footer", "aside", "script", "style", "noscript", "form"]
          : ["script", "style", "noscript"],
      ),
      removeOverlayElements: cleanMarkdownInput?.removeOverlayElements ?? true,
      wordCountThreshold:
        typeof cleanMarkdownInput?.wordCountThreshold === "number"
          ? cleanMarkdownInput.wordCountThreshold
          : qualityProfile === "quality_first"
            ? 18
            : 12,
    });
    const linkPreview = this.normalizeLinkPreviewOptions(options?.linkPreview);
    const scoreLinks = options?.scoreLinks ?? Boolean(linkPreview);
    const jsCode = this.normalizeScriptList(options?.jsCode);
    const waitForSelector = this.normalizeWaitForSelector(
      options?.waitForSelector,
    );
    const waitForScript = this.normalizeWaitForScript(options?.waitForScript);
    const waitForTimeoutMs = this.normalizeWaitForTimeout(
      options?.waitForTimeoutMs,
    );
    const waitUntil = this.normalizeWaitUntil(options?.waitUntil);
    const normalizedWaitForTimeoutMs =
      waitUntil === "networkidle" && typeof waitForTimeoutMs === "number"
        ? Math.max(5000, waitForTimeoutMs)
        : waitForTimeoutMs;
    const pageTimeoutMs = this.normalizePageTimeoutMs(options?.pageTimeoutMs);
    const delayBeforeReturnHtmlMs = this.normalizeDelayBeforeReturnHtmlMs(
      options?.delayBeforeReturnHtmlMs,
    );
    const meanDelayMs = this.normalizeDelayJitterMs(options?.meanDelayMs);
    const maxDelayRangeMs = this.normalizeDelayJitterMs(
      options?.maxDelayRangeMs,
    );
    const semaphoreCount = this.normalizeSemaphoreCount(
      options?.semaphoreCount,
    );
    const sessionId = this.normalizeSessionId(options?.sessionId);
    const storageState = this.normalizeStorageState(options?.storageState);
    const browserHeaders = this.normalizeBrowserHeaders(
      options?.browserHeaders,
    );
    const browserCookies = this.normalizeBrowserCookies(
      options?.browserCookies,
    );
    const userAgent = this.normalizeUserAgent(options?.userAgent);
    const userAgentMode = userAgent
      ? undefined
      : (this.normalizeUserAgentMode(options?.userAgentMode) ?? "random");
    const userAgentGenerator = userAgent
      ? undefined
      : this.normalizeUserAgentGenerator(options?.userAgentGenerator);
    const locale = this.normalizeLocale(options?.locale);
    const timezoneId = this.normalizeTimezone(options?.timezoneId);
    const geolocation = this.normalizeGeolocation(options?.geolocation);
    const wordCountThreshold = this.normalizeWordCountThreshold(
      options?.wordCountThreshold ?? 80,
    );
    const excludeExternalLinks = options?.excludeExternalLinks ?? true;
    const excludeExternalImages =
      options?.excludeExternalImages ?? (options?.storeMedia ? false : true);
    const removeOverlayElements = options?.removeOverlayElements ?? true;
    const processIframes = options?.processIframes ?? true;
    const textMode = options?.textMode ?? false;
    const captureScreenshot = options?.captureScreenshot ?? false;
    const cssSelector = this.normalizeCssSelector(options?.cssSelector);
    const excludedTags = this.normalizeSelectorList(options?.excludedTags);
    const waitForImages =
      options?.waitForImages ?? (options?.storeMedia ? true : false);
    const removeForms = options?.removeForms ?? false;
    const pageTypeHint = this.parsePageTypeHint(options?.pageTypeHint);
    const autoExpandDetails =
      typeof options?.autoExpandDetails === "boolean"
        ? options.autoExpandDetails
        : true;
    const detailExpansion = this.normalizeDetailExpansionOptions(
      options?.detailExpansion,
    );

    return {
      includeImages,
      storeMedia: options?.storeMedia ?? false,
      onlyMainContent: options?.onlyMainContent ?? true,
      extractLinks: options?.extractLinks ?? false,
      cacheMode: options?.cacheMode ?? "bypass",
      prefetch: options?.prefetch ?? false,
      scanFullPage,
      adjustViewportToContent,
      scrollDelayMs,
      headless,
      enableUndetectedBrowser: options?.enableUndetectedBrowser ?? false,
      antiBotMode,
      enableStealthMode,
      useManagedBrowser,
      userDataDir,
      simulateUser,
      overrideNavigator,
      jsCode,
      jsOnly: options?.jsOnly ?? false,
      waitForSelector,
      waitForScript,
      waitForTimeoutMs: normalizedWaitForTimeoutMs,
      waitUntil,
      pageTimeoutMs,
      delayBeforeReturnHtmlMs,
      meanDelayMs,
      maxDelayRangeMs,
      semaphoreCount,
      proxyConfig,
      proxyUrl,
      additionalUrls,
      multiUrlConfigs,
      markdownOptions,
      markdownFilter,
      markdownStrategy,
      tableScoreThreshold,
      tableExtraction,
      cleanMarkdown,
      scoreLinks,
      linkPreview,
      browserHeaders,
      browserCookies,
      userAgent,
      userAgentMode,
      userAgentGenerator,
      locale,
      timezoneId,
      geolocation,
      sessionId,
      storageState,
      wordCountThreshold,
      excludeExternalLinks,
      removeOverlayElements,
      processIframes,
      textMode,
      captureScreenshot,
      cssSelector,
      excludedTags,
      virtualScroll,
      excludeExternalImages,
      waitForImages,
      removeForms,
      pageTypeHint,
      autoExpandDetails,
      detailExpansion,
      qualityProfile,
    };
  }

  private ensureTaskSessionReuse(
    taskId: string,
    options: CrawlTaskOptions,
  ): CrawlTaskOptions {
    if (options.sessionId) {
      return options;
    }
    const fallbackSessionId = this.buildTaskSessionId(taskId);
    return {
      ...options,
      sessionId: fallbackSessionId,
    };
  }

  private buildTaskSessionId(taskId: string): string {
    const normalizedTaskId = taskId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");
    const seed = normalizedTaskId.length > 0 ? normalizedTaskId : "default";
    return this.normalizeSessionId(`task-${seed}`) ?? "task-session";
  }

  private parsePageTypeHint(value: unknown): CrawlPageTypeHint | undefined {
    if (value === "auto" || value === "list" || value === "detail") {
      return value;
    }
    return undefined;
  }

  private parseAntiBotMode(value: unknown): CrawlAntiBotMode | undefined {
    if (value === "auto" || value === "enabled" || value === "disabled") {
      return value;
    }
    return undefined;
  }

  private parseQualityProfile(value: unknown): CrawlQualityProfile | undefined {
    if (
      value === "balanced" ||
      value === "quality_first" ||
      value === "speed_first"
    ) {
      return value;
    }
    return undefined;
  }

  private parseDetailExpansionOptions(
    value: unknown,
  ): CrawlDetailExpansionOptions | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeDetailExpansionOptions({
      maxDetailUrls:
        typeof record.maxDetailUrls === "number"
          ? Math.round(record.maxDetailUrls)
          : undefined,
      minRelevanceScore:
        typeof record.minRelevanceScore === "number"
          ? record.minRelevanceScore
          : undefined,
      requireSameDomain:
        typeof record.requireSameDomain === "boolean"
          ? record.requireSameDomain
          : undefined,
      allowExternalLinks:
        typeof record.allowExternalLinks === "boolean"
          ? record.allowExternalLinks
          : undefined,
      includeUrlPatterns: this.parsePatternArray(record.includeUrlPatterns),
      excludeUrlPatterns: this.parsePatternArray(record.excludeUrlPatterns),
      minPublishTimeConfidence:
        typeof record.minPublishTimeConfidence === "number"
          ? record.minPublishTimeConfidence
          : undefined,
      preferFitMarkdownForQuality:
        typeof record.preferFitMarkdownForQuality === "boolean"
          ? record.preferFitMarkdownForQuality
          : undefined,
    });
  }

  private normalizeDetailExpansionOptions(
    value?: CrawlDetailExpansionOptions,
  ): CrawlDetailExpansionOptions | undefined {
    if (!value) {
      return undefined;
    }
    const maxDetailUrls =
      typeof value.maxDetailUrls === "number" &&
      Number.isFinite(value.maxDetailUrls)
        ? Math.max(1, Math.min(30, Math.round(value.maxDetailUrls)))
        : undefined;
    const minRelevanceScore =
      typeof value.minRelevanceScore === "number" &&
      Number.isFinite(value.minRelevanceScore)
        ? Math.max(0, Math.min(1, Number(value.minRelevanceScore.toFixed(3))))
        : undefined;
    const requireSameDomain =
      typeof value.requireSameDomain === "boolean"
        ? value.requireSameDomain
        : undefined;
    const allowExternalLinks =
      typeof value.allowExternalLinks === "boolean"
        ? value.allowExternalLinks
        : undefined;
    const includeUrlPatterns = this.normalizePatternList(
      value.includeUrlPatterns,
    );
    const excludeUrlPatterns = this.normalizePatternList(
      value.excludeUrlPatterns,
    );
    const minPublishTimeConfidence =
      typeof value.minPublishTimeConfidence === "number" &&
      Number.isFinite(value.minPublishTimeConfidence)
        ? Math.max(
            0,
            Math.min(1, Number(value.minPublishTimeConfidence.toFixed(3))),
          )
        : undefined;
    const preferFitMarkdownForQuality =
      typeof value.preferFitMarkdownForQuality === "boolean"
        ? value.preferFitMarkdownForQuality
        : undefined;

    if (
      maxDetailUrls === undefined &&
      minRelevanceScore === undefined &&
      requireSameDomain === undefined &&
      allowExternalLinks === undefined &&
      includeUrlPatterns === undefined &&
      excludeUrlPatterns === undefined &&
      minPublishTimeConfidence === undefined &&
      preferFitMarkdownForQuality === undefined
    ) {
      return undefined;
    }

    return {
      maxDetailUrls,
      minRelevanceScore,
      requireSameDomain,
      allowExternalLinks,
      includeUrlPatterns,
      excludeUrlPatterns,
      minPublishTimeConfidence,
      preferFitMarkdownForQuality,
    };
  }

  private clampScrollDelay(value: number) {
    if (Number.isNaN(value)) {
      return 200;
    }
    return Math.max(0, Math.min(5000, Math.round(value)));
  }

  private normalizeProxyUrl(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return translateLocalhostProxyUrlForCrawl4ai(
      trimmed,
      this.env.crawl4aiConfig.baseUrl,
    );
  }

  private normalizeSessionId(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 160);
  }

  private normalizeUserDataDir(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const limit = 512;
    return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
  }

  private normalizeStorageState(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const limit = 12000;
    return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
  }

  private normalizeProxyConfig(
    value?: CrawlProxyConfig | null,
  ): CrawlProxyConfig | undefined {
    if (!value) {
      return undefined;
    }
    const server = typeof value.server === "string" ? value.server.trim() : "";
    if (!server) {
      return undefined;
    }
    const normalizedServer = translateLocalhostProxyUrlForCrawl4ai(
      server,
      this.env.crawl4aiConfig.baseUrl,
    );
    const username =
      typeof value.username === "string" ? value.username.trim() : "";
    const password =
      typeof value.password === "string" ? value.password.trim() : "";
    return {
      server: normalizedServer,
      username: username.length > 0 ? username : undefined,
      password: password.length > 0 ? password : undefined,
    };
  }

  private parseProxyConfig(value: unknown): CrawlProxyConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const server =
      typeof record.server === "string" ? record.server : undefined;
    if (!server) {
      return undefined;
    }
    return this.normalizeProxyConfig({
      server,
      username:
        typeof record.username === "string" ? record.username : undefined,
      password:
        typeof record.password === "string" ? record.password : undefined,
    });
  }

  private normalizeUrlList(urls?: string[] | null): string[] | undefined {
    if (!urls || urls.length === 0) {
      return undefined;
    }
    const normalized = urls
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }
    return Array.from(new Set(normalized));
  }

  private normalizeMultiUrlConfigs(
    configs?: CrawlMultiUrlConfig[] | null,
  ): CrawlMultiUrlConfig[] | undefined {
    if (!configs || configs.length === 0) {
      return undefined;
    }
    const normalized = configs
      .map((config) => this.normalizeMultiUrlConfig(config))
      .filter((entry): entry is CrawlMultiUrlConfig => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeMultiUrlConfig(
    config?: CrawlMultiUrlConfig | null,
  ): CrawlMultiUrlConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const name =
      typeof config.name === "string" ? config.name.trim() : undefined;
    const matcher = this.normalizeMatcher(config.matcher);
    const urls = this.normalizeUrlList(config.urls ?? undefined);
    const options = this.normalizeStrategyOverrides(config.options);
    if (!matcher && (!urls || urls.length === 0)) {
      return undefined;
    }
    return {
      name,
      matcher,
      urls,
      options,
    };
  }

  private normalizeMatcher(
    matcher?: CrawlUrlMatcher | null,
  ): CrawlUrlMatcher | undefined {
    if (!matcher) {
      return undefined;
    }
    const patterns = Array.isArray(matcher.patterns)
      ? matcher.patterns
          .map((pattern) => (typeof pattern === "string" ? pattern.trim() : ""))
          .filter((pattern) => pattern.length > 0)
      : [];
    if (patterns.length === 0) {
      return undefined;
    }
    return {
      matchMode: matcher.matchMode,
      patterns: patterns,
    };
  }

  private normalizeStrategyOverrides(
    overrides?: CrawlStrategyOverrides | null,
  ): CrawlStrategyOverrides | undefined {
    if (!overrides) {
      return undefined;
    }
    const normalized: CrawlStrategyOverrides = {};
    if (overrides.cacheMode) {
      normalized.cacheMode = overrides.cacheMode;
    }
    if (typeof overrides.onlyMainContent === "boolean") {
      normalized.onlyMainContent = overrides.onlyMainContent;
    }
    if (typeof overrides.extractLinks === "boolean") {
      normalized.extractLinks = overrides.extractLinks;
    }
    if (typeof overrides.scanFullPage === "boolean") {
      normalized.scanFullPage = overrides.scanFullPage;
    }
    if (typeof overrides.adjustViewportToContent === "boolean") {
      normalized.adjustViewportToContent = overrides.adjustViewportToContent;
    }
    if (
      typeof overrides.scrollDelayMs === "number" &&
      overrides.scanFullPage === true
    ) {
      normalized.scrollDelayMs = this.clampScrollDelay(overrides.scrollDelayMs);
    }
    if (typeof overrides.simulateUser === "boolean") {
      normalized.simulateUser = overrides.simulateUser;
    }
    if (typeof overrides.overrideNavigator === "boolean") {
      normalized.overrideNavigator = overrides.overrideNavigator;
    }
    const jsCode = this.normalizeScriptList(overrides.jsCode);
    if (jsCode) {
      normalized.jsCode = jsCode;
    }
    if (typeof overrides.jsOnly === "boolean") {
      normalized.jsOnly = overrides.jsOnly;
    }
    const waitForSelector = this.normalizeWaitForSelector(
      overrides.waitForSelector,
    );
    if (waitForSelector) {
      normalized.waitForSelector = waitForSelector;
    }
    const waitForScript = this.normalizeWaitForScript(overrides.waitForScript);
    if (waitForScript) {
      normalized.waitForScript = waitForScript;
    }
    const waitUntil = this.normalizeWaitUntil(overrides.waitUntil);
    if (waitUntil) {
      normalized.waitUntil = waitUntil;
    }
    const waitForTimeoutMs = this.normalizeWaitForTimeout(
      overrides.waitForTimeoutMs,
    );
    if (waitForTimeoutMs !== undefined) {
      normalized.waitForTimeoutMs =
        waitUntil === "networkidle"
          ? Math.max(5000, waitForTimeoutMs)
          : waitForTimeoutMs;
    }
    const pageTimeoutMs = this.normalizePageTimeoutMs(overrides.pageTimeoutMs);
    if (pageTimeoutMs !== undefined) {
      normalized.pageTimeoutMs = pageTimeoutMs;
    }
    const delayBeforeReturnHtmlMs = this.normalizeDelayBeforeReturnHtmlMs(
      overrides.delayBeforeReturnHtmlMs,
    );
    if (delayBeforeReturnHtmlMs !== undefined) {
      normalized.delayBeforeReturnHtmlMs = delayBeforeReturnHtmlMs;
    }
    const meanDelayMs = this.normalizeDelayJitterMs(overrides.meanDelayMs);
    if (meanDelayMs !== undefined) {
      normalized.meanDelayMs = meanDelayMs;
    }
    const maxDelayRangeMs = this.normalizeDelayJitterMs(
      overrides.maxDelayRangeMs,
    );
    if (maxDelayRangeMs !== undefined) {
      normalized.maxDelayRangeMs = maxDelayRangeMs;
    }
    const semaphoreCount = this.normalizeSemaphoreCount(
      overrides.semaphoreCount,
    );
    if (semaphoreCount !== undefined) {
      normalized.semaphoreCount = semaphoreCount;
    }
    if (typeof overrides.removeForms === "boolean") {
      normalized.removeForms = overrides.removeForms;
    }
    const wordCountThreshold = this.normalizeWordCountThreshold(
      overrides.wordCountThreshold,
    );
    if (wordCountThreshold !== undefined) {
      normalized.wordCountThreshold = wordCountThreshold;
    }
    if (typeof overrides.excludeExternalLinks === "boolean") {
      normalized.excludeExternalLinks = overrides.excludeExternalLinks;
    }
    if (typeof overrides.excludeExternalImages === "boolean") {
      normalized.excludeExternalImages = overrides.excludeExternalImages;
    }
    if (typeof overrides.removeOverlayElements === "boolean") {
      normalized.removeOverlayElements = overrides.removeOverlayElements;
    }
    if (typeof overrides.processIframes === "boolean") {
      normalized.processIframes = overrides.processIframes;
    }
    if (typeof overrides.textMode === "boolean") {
      normalized.textMode = overrides.textMode;
    }
    if (typeof overrides.waitForImages === "boolean") {
      normalized.waitForImages = overrides.waitForImages;
    }
    if (typeof overrides.captureScreenshot === "boolean") {
      normalized.captureScreenshot = overrides.captureScreenshot;
    }
    const cssSelector = this.normalizeCssSelector(overrides.cssSelector);
    if (cssSelector) {
      normalized.cssSelector = cssSelector;
    }
    const excludedTags = this.normalizeSelectorList(overrides.excludedTags);
    if (excludedTags) {
      normalized.excludedTags = excludedTags;
    }
    const virtualScroll = this.normalizeVirtualScrollConfig(
      overrides.virtualScroll,
    );
    if (virtualScroll) {
      normalized.virtualScroll = virtualScroll;
      if (normalized.scanFullPage === true) {
        normalized.scanFullPage = false;
        delete normalized.scrollDelayMs;
      }
    }
    const pageTypeHint = this.parsePageTypeHint(overrides.pageTypeHint);
    if (pageTypeHint) {
      normalized.pageTypeHint = pageTypeHint;
    }
    if (typeof overrides.autoExpandDetails === "boolean") {
      normalized.autoExpandDetails = overrides.autoExpandDetails;
    }
    const detailExpansion = this.normalizeDetailExpansionOptions(
      overrides.detailExpansion,
    );
    if (detailExpansion) {
      normalized.detailExpansion = detailExpansion;
    }
    const qualityProfile = this.parseQualityProfile(overrides.qualityProfile);
    if (qualityProfile) {
      normalized.qualityProfile = qualityProfile;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private parseCleanMarkdownOptions(
    value: unknown,
  ): CrawlCleanMarkdownOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeCleanMarkdownOptions({
      cssSelector:
        typeof record.cssSelector === "string" ? record.cssSelector : undefined,
      targetElements: this.coerceStringArray(record.targetElements),
      excludedTags: this.coerceStringArray(record.excludedTags),
      removeOverlayElements:
        typeof record.removeOverlayElements === "boolean"
          ? record.removeOverlayElements
          : undefined,
      wordCountThreshold:
        typeof record.wordCountThreshold === "number"
          ? record.wordCountThreshold
          : undefined,
    });
  }

  private normalizeMarkdownOptions(
    options?: CrawlMarkdownOptions | null,
  ): CrawlMarkdownOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlMarkdownOptions = {};
    if (
      options.contentSource &&
      ["raw_html", "cleaned_html", "fit_html"].includes(options.contentSource)
    ) {
      normalized.contentSource =
        options.contentSource as CrawlMarkdownContentSource;
    }
    if (typeof options.ignoreLinks === "boolean") {
      normalized.ignoreLinks = options.ignoreLinks;
    }
    if (typeof options.escapeHtml === "boolean") {
      normalized.escapeHtml = options.escapeHtml;
    }
    if (typeof options.citations === "boolean") {
      normalized.citations = options.citations;
    }
    if (
      typeof options.bodyWidth === "number" &&
      Number.isFinite(options.bodyWidth)
    ) {
      const clamped = Math.max(
        40,
        Math.min(200, Math.round(options.bodyWidth)),
      );
      normalized.bodyWidth = clamped;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeCleanMarkdownOptions(
    options?: CrawlCleanMarkdownOptions | null,
  ): CrawlCleanMarkdownOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlCleanMarkdownOptions = {};
    if (typeof options.cssSelector === "string") {
      const trimmed = options.cssSelector.trim();
      if (trimmed.length > 0) {
        normalized.cssSelector = trimmed.slice(0, 512);
      }
    }
    const targetElements = this.normalizeSelectorList(options.targetElements);
    if (targetElements) {
      normalized.targetElements = targetElements;
    }
    const excludedTags = this.normalizeSelectorList(options.excludedTags);
    if (excludedTags) {
      normalized.excludedTags = excludedTags;
    }
    if (typeof options.removeOverlayElements === "boolean") {
      normalized.removeOverlayElements = options.removeOverlayElements;
    }
    if (
      typeof options.wordCountThreshold === "number" &&
      Number.isFinite(options.wordCountThreshold)
    ) {
      const clamped = Math.max(
        0,
        Math.min(2000, Math.round(options.wordCountThreshold)),
      );
      normalized.wordCountThreshold = clamped;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private mergeSelectorValues(
    primary?: string[] | null,
    fallback?: string[],
  ): string[] | undefined {
    const merged = [...(primary ?? []), ...(fallback ?? [])];
    return this.normalizeSelectorList(merged);
  }

  private normalizeSelectorList(
    values?: string[] | null,
  ): string[] | undefined {
    if (!values || values.length === 0) {
      return undefined;
    }
    const normalized = values
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value): value is string => Boolean(value))
      .slice(0, 10);
    if (normalized.length === 0) {
      return undefined;
    }
    return Array.from(new Set(normalized));
  }

  private normalizeCssSelector(value?: string | null) {
    if (!value || typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const limit = 512;
    return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
  }

  private normalizeWordCountThreshold(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(5000, Math.round(value)));
    return clamped;
  }

  private normalizeVirtualScrollConfig(
    config?: CrawlVirtualScrollConfig | null,
  ): CrawlVirtualScrollConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const containerSelectorInput =
      (config as Record<string, unknown>).containerSelector ??
      config.containerSelector;
    const containerSelector = this.normalizeCssSelector(
      typeof containerSelectorInput === "string"
        ? containerSelectorInput
        : undefined,
    );
    const scrollCount =
      typeof config.scrollCount === "number" &&
      Number.isFinite(config.scrollCount)
        ? Math.max(1, Math.min(1000, Math.round(config.scrollCount)))
        : undefined;
    const scrollByRaw =
      (config as Record<string, unknown>).scrollBy ?? config.scrollBy;
    const scrollByPixelsRaw = (config as Record<string, unknown>)
      .scrollByPixels;
    const scrollBy = (() => {
      if (scrollByRaw === "container_height") {
        return "container_height";
      }
      if (scrollByRaw === "page_height") {
        return "page_height";
      }
      if (scrollByRaw === "viewport") {
        return "page_height";
      }
      if (scrollByRaw === "pixels") {
        const pixels =
          typeof scrollByPixelsRaw === "number" &&
          Number.isFinite(scrollByPixelsRaw)
            ? Math.max(1, Math.min(20000, Math.round(scrollByPixelsRaw)))
            : 500;
        return pixels;
      }
      if (typeof scrollByRaw === "number" && Number.isFinite(scrollByRaw)) {
        return Math.max(1, Math.min(20000, Math.round(scrollByRaw)));
      }
      if (typeof scrollByRaw === "string") {
        const trimmed = scrollByRaw.trim();
        if (!trimmed) {
          return undefined;
        }
        if (/^\d+$/.test(trimmed)) {
          const parsed = Number.parseInt(trimmed, 10);
          if (Number.isFinite(parsed)) {
            return Math.max(1, Math.min(20000, parsed));
          }
        }
      }
      return undefined;
    })();
    const waitAfterScrollMs =
      typeof config.waitAfterScrollMs === "number" &&
      Number.isFinite(config.waitAfterScrollMs)
        ? Math.max(0, Math.min(60000, Math.round(config.waitAfterScrollMs)))
        : undefined;
    const hasValue =
      Boolean(containerSelector) ||
      typeof scrollCount === "number" ||
      typeof waitAfterScrollMs === "number" ||
      scrollBy !== undefined;
    if (!hasValue) {
      return undefined;
    }
    return {
      containerSelector: containerSelector ?? "body",
      scrollCount,
      scrollBy,
      waitAfterScrollMs,
    };
  }

  private normalizeMarkdownFilter(
    filter?: CrawlMarkdownFilter | null,
  ): CrawlMarkdownFilter | undefined {
    if (!filter) {
      return undefined;
    }
    if (filter.type === "pruning") {
      const normalized: CrawlMarkdownFilter = { type: "pruning" };
      if (
        typeof filter.threshold === "number" &&
        Number.isFinite(filter.threshold)
      ) {
        normalized.threshold = Math.max(0, Math.min(1, filter.threshold));
      }
      if (
        filter.thresholdType === "fixed" ||
        filter.thresholdType === "dynamic"
      ) {
        normalized.thresholdType = filter.thresholdType;
      }
      if (
        typeof filter.minWordThreshold === "number" &&
        Number.isFinite(filter.minWordThreshold)
      ) {
        const clamped = Math.max(
          0,
          Math.min(500, Math.round(filter.minWordThreshold)),
        );
        normalized.minWordThreshold = clamped;
      }
      return normalized;
    }
    if (filter.type === "bm25") {
      const normalized: CrawlMarkdownFilter = { type: "bm25" };
      if (typeof filter.userQuery === "string") {
        const trimmed = filter.userQuery.trim();
        if (trimmed.length > 0) {
          normalized.userQuery = trimmed.slice(0, 240);
        }
      }
      if (
        typeof filter.bm25Threshold === "number" &&
        Number.isFinite(filter.bm25Threshold)
      ) {
        normalized.bm25Threshold = Number(
          Math.max(0, Math.min(20, filter.bm25Threshold)).toFixed(2),
        );
      }
      if (typeof filter.language === "string") {
        const trimmed = filter.language.trim();
        if (trimmed.length > 0) {
          normalized.language = trimmed.slice(0, 32);
        }
      }
      if (!normalized.userQuery) {
        return undefined;
      }
      return normalized;
    }
    return undefined;
  }

  private normalizeMarkdownStrategy(
    strategy?: CrawlMarkdownStrategy | null,
  ): CrawlMarkdownStrategy | undefined {
    if (!strategy || typeof strategy.type !== "string") {
      return undefined;
    }
    const trimmed = strategy.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const normalized: CrawlMarkdownStrategy = {
      type: trimmed.slice(0, 128),
    };
    const params = this.normalizeStrategyParams(strategy.params);
    if (params) {
      normalized.params = params;
    }
    return normalized;
  }

  private normalizeTableScore(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(10, value));
    return Number(clamped.toFixed(2));
  }

  private normalizeTableExtraction(
    strategy?: CrawlTableExtractionStrategy | null,
  ): CrawlTableExtractionStrategy | undefined {
    if (!strategy || typeof strategy.type !== "string") {
      return undefined;
    }
    const trimmed = strategy.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const normalized: CrawlTableExtractionStrategy = {
      type: trimmed.slice(0, 128),
    };
    const params = this.normalizeStrategyParams(strategy.params);
    if (params) {
      normalized.params = params;
    }
    return normalized;
  }

  private normalizeStrategyParams(
    params?: Record<string, unknown> | null,
  ): Record<string, unknown> | undefined {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return undefined;
    }
    try {
      return JSON.parse(JSON.stringify(params));
    } catch {
      return undefined;
    }
  }

  private parseMarkdownStrategy(
    value: unknown,
  ): CrawlMarkdownStrategy | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const params =
      record.params &&
      typeof record.params === "object" &&
      !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    return this.normalizeMarkdownStrategy(
      type
        ? {
            type,
            params,
          }
        : undefined,
    );
  }

  private parseTableExtraction(
    value: unknown,
  ): CrawlTableExtractionStrategy | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const params =
      record.params &&
      typeof record.params === "object" &&
      !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    return this.normalizeTableExtraction(
      type
        ? {
            type,
            params,
          }
        : undefined,
    );
  }

  private parseVirtualScrollConfig(
    value: unknown,
  ): CrawlVirtualScrollConfig | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const scrollBy =
      typeof record.scrollBy === "string" || typeof record.scrollBy === "number"
        ? record.scrollBy
        : undefined;
    const scrollByPixels =
      typeof record.scrollByPixels === "number"
        ? record.scrollByPixels
        : undefined;
    return this.normalizeVirtualScrollConfig({
      containerSelector:
        typeof record.containerSelector === "string"
          ? record.containerSelector
          : undefined,
      scrollCount:
        typeof record.scrollCount === "number" ? record.scrollCount : undefined,
      scrollBy: scrollBy as CrawlVirtualScrollConfig["scrollBy"],
      scrollByPixels,
      waitAfterScrollMs:
        typeof record.waitAfterScrollMs === "number"
          ? record.waitAfterScrollMs
          : undefined,
    } as CrawlVirtualScrollConfig & { scrollByPixels?: number });
  }

  private normalizeLinkPreviewOptions(
    options?: CrawlLinkPreviewOptions | null,
  ): CrawlLinkPreviewOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlLinkPreviewOptions = {};
    if (typeof options.includeInternal === "boolean") {
      normalized.includeInternal = options.includeInternal;
    }
    if (typeof options.includeExternal === "boolean") {
      normalized.includeExternal = options.includeExternal;
    }
    if (typeof options.includeSocial === "boolean") {
      normalized.includeSocial = options.includeSocial;
    }
    if (
      typeof options.maxLinks === "number" &&
      Number.isFinite(options.maxLinks)
    ) {
      normalized.maxLinks = Math.max(
        1,
        Math.min(500, Math.round(options.maxLinks)),
      );
    }
    if (
      typeof options.concurrency === "number" &&
      Number.isFinite(options.concurrency)
    ) {
      normalized.concurrency = Math.max(
        1,
        Math.min(50, Math.round(options.concurrency)),
      );
    }
    if (
      typeof options.timeoutSeconds === "number" &&
      Number.isFinite(options.timeoutSeconds)
    ) {
      normalized.timeoutSeconds = Math.max(
        1,
        Math.min(60, Math.round(options.timeoutSeconds)),
      );
    }
    if (typeof options.query === "string") {
      const trimmed = options.query.trim();
      if (trimmed.length > 0 && trimmed.length <= 160) {
        normalized.query = trimmed;
      }
    }
    if (
      typeof options.scoreThreshold === "number" &&
      Number.isFinite(options.scoreThreshold)
    ) {
      const clamped = Math.max(0, Math.min(1, options.scoreThreshold));
      normalized.scoreThreshold = Number(clamped.toFixed(3));
    }
    if (typeof options.verbose === "boolean") {
      normalized.verbose = options.verbose;
    }
    const includePatterns = this.normalizePatternList(options.includePatterns);
    if (includePatterns) {
      normalized.includePatterns = includePatterns;
    }
    const excludePatterns = this.normalizePatternList(options.excludePatterns);
    if (excludePatterns) {
      normalized.excludePatterns = excludePatterns;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeBrowserHeaders(
    headers?: CrawlBrowserHeader[] | null,
  ): CrawlBrowserHeader[] | undefined {
    if (!headers || headers.length === 0) {
      return undefined;
    }
    const normalized = normalizeSharedBrowserHeaders(
      headers.map((header) => ({
        name: header?.name,
        value: header?.value,
      })),
    ).map((header) => ({
      name: header.name.slice(0, 128),
      value: header.value.slice(0, 512),
    }));
    if (normalized.length === 0) {
      return undefined;
    }
    const seen = new Set<string>();
    const unique: CrawlBrowserHeader[] = [];
    for (const header of normalized) {
      const key = header.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(header);
      if (unique.length >= 20) {
        break;
      }
    }
    return unique;
  }

  private normalizeBrowserCookies(
    cookies?: CrawlBrowserCookie[] | null,
  ): CrawlBrowserCookie[] | undefined {
    if (!cookies || cookies.length === 0) {
      return undefined;
    }
    const normalized = cookies
      .map((cookie) => {
        if (!cookie || typeof cookie !== "object") {
          return undefined;
        }
        const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
        const value =
          typeof cookie.value === "string" ? cookie.value.trim() : "";
        const domain =
          typeof cookie.domain === "string" ? cookie.domain.trim() : "";
        const path = typeof cookie.path === "string" ? cookie.path.trim() : "";
        if (!name || !value || !domain) {
          return undefined;
        }
        return {
          name: name.slice(0, 128),
          value: value.slice(0, 4000),
          domain: domain.slice(0, 255),
          path: path ? path.slice(0, 255) : undefined,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (normalized.length === 0) {
      return undefined;
    }
    const deduped: CrawlBrowserCookie[] = [];
    const seen = new Set<string>();
    for (const cookie of normalized) {
      const key = `${cookie.name.toLowerCase()}|${cookie.domain.toLowerCase()}|${cookie.path ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(cookie);
      if (deduped.length >= 20) {
        break;
      }
    }
    return deduped;
  }

  private normalizeUserAgent(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 768);
  }

  private normalizeUserAgentMode(value?: string | null) {
    if (value === "random") {
      return "random";
    }
    return undefined;
  }

  private normalizeUserAgentGenerator(
    config?: CrawlUserAgentGeneratorConfig | null,
  ): CrawlUserAgentGeneratorConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const normalized: CrawlUserAgentGeneratorConfig = {};
    const platforms = new Set(["windows", "macos", "linux", "android", "ios"]);
    const browsers = new Set(["chrome", "firefox", "safari", "edge"]);
    const deviceTypes = new Set(["desktop", "mobile", "tablet"]);
    if (config.platform && platforms.has(config.platform)) {
      normalized.platform = config.platform;
    }
    if (config.browser && browsers.has(config.browser)) {
      normalized.browser = config.browser;
    }
    if (config.deviceType && deviceTypes.has(config.deviceType)) {
      normalized.deviceType = config.deviceType;
    }
    if (typeof config.locale === "string") {
      const trimmed = config.locale.trim();
      if (trimmed.length > 0) {
        normalized.locale = trimmed.slice(0, 16);
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeLocale(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 16);
  }

  private normalizeTimezone(value?: string | null) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 64);
  }

  private normalizeGeolocation(
    value?: CrawlGeolocationConfig | null,
  ): CrawlGeolocationConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const latitude =
      typeof value.latitude === "number" && Number.isFinite(value.latitude)
        ? value.latitude
        : undefined;
    const longitude =
      typeof value.longitude === "number" && Number.isFinite(value.longitude)
        ? value.longitude
        : undefined;
    if (latitude === undefined || longitude === undefined) {
      return undefined;
    }
    const normalized: CrawlGeolocationConfig = {
      latitude: Math.max(-90, Math.min(90, latitude)),
      longitude: Math.max(-180, Math.min(180, longitude)),
    };
    if (typeof value.accuracy === "number" && Number.isFinite(value.accuracy)) {
      normalized.accuracy = Math.max(1, Math.min(5000, value.accuracy));
    }
    return normalized;
  }

  private parseUrlArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeUrlList(
      value
        .map((entry) => (typeof entry === "string" ? entry : ""))
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  private parseStringArray(value: unknown): string[] | undefined {
    if (typeof value === "string") {
      return this.normalizeScriptList([value]);
    }
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeScriptList(
      value
        .map((entry) => (typeof entry === "string" ? entry : ""))
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  private parseWaitUntil(value: unknown): CrawlTaskOptions["waitUntil"] {
    if (typeof value !== "string") {
      return undefined;
    }
    return this.normalizeWaitUntil(value);
  }

  private parseOptionalNumber(value: unknown): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return value;
  }

  private parsePatternArray(value: unknown): string[] | undefined {
    if (typeof value === "string") {
      return this.normalizePatternList([value]);
    }
    if (!Array.isArray(value)) {
      return undefined;
    }
    const normalized = value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter((entry): entry is string => Boolean(entry));
    return this.normalizePatternList(normalized);
  }

  private coerceStringArray(value: unknown): string[] | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? [trimmed] : undefined;
    }
    if (!Array.isArray(value)) {
      return undefined;
    }
    const normalized = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .slice(0, 10);
    return normalized.length > 0 ? normalized : undefined;
  }

  private parseMultiUrlConfigs(
    value: unknown,
  ): CrawlMultiUrlConfig[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeMultiUrlConfigs(
      value
        .map((entry) =>
          entry && typeof entry === "object"
            ? (entry as CrawlMultiUrlConfig)
            : undefined,
        )
        .filter((entry): entry is CrawlMultiUrlConfig => Boolean(entry)),
    );
  }

  private parseMarkdownOptions(
    value: unknown,
  ): CrawlMarkdownOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeMarkdownOptions({
      contentSource:
        typeof record.contentSource === "string"
          ? (record.contentSource as CrawlMarkdownContentSource)
          : undefined,
      ignoreLinks:
        typeof record.ignoreLinks === "boolean"
          ? record.ignoreLinks
          : undefined,
      escapeHtml:
        typeof record.escapeHtml === "boolean" ? record.escapeHtml : undefined,
      citations:
        typeof record.citations === "boolean" ? record.citations : undefined,
      bodyWidth:
        typeof record.bodyWidth === "number" ? record.bodyWidth : undefined,
    });
  }

  private parseMarkdownFilter(value: unknown): CrawlMarkdownFilter | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const rawType =
      typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (rawType !== "pruning" && rawType !== "bm25") {
      return undefined;
    }
    if (rawType === "bm25") {
      const rawUserQuery =
        typeof record.userQuery === "string"
          ? record.userQuery
          : typeof record.user_query === "string"
            ? (record.user_query as string)
            : undefined;
      const rawThreshold =
        typeof record.bm25Threshold === "number"
          ? record.bm25Threshold
          : typeof record.bm25_threshold === "number"
            ? (record.bm25_threshold as number)
            : undefined;
      const rawLanguage =
        typeof record.language === "string"
          ? record.language
          : typeof record.lang === "string"
            ? (record.lang as string)
            : undefined;
      return this.normalizeMarkdownFilter({
        type: "bm25",
        userQuery: rawUserQuery,
        bm25Threshold: rawThreshold,
        language: rawLanguage,
      });
    }
    const rawThresholdType =
      typeof record.thresholdType === "string"
        ? (record.thresholdType as string)
        : typeof record.threshold_type === "string"
          ? (record.threshold_type as string)
          : undefined;
    const rawMinWords =
      typeof record.minWordThreshold === "number"
        ? record.minWordThreshold
        : typeof record.min_word_threshold === "number"
          ? (record.min_word_threshold as number)
          : undefined;
    return this.normalizeMarkdownFilter({
      type: "pruning",
      threshold:
        typeof record.threshold === "number" ? record.threshold : undefined,
      thresholdType:
        rawThresholdType === "fixed" || rawThresholdType === "dynamic"
          ? (rawThresholdType as "fixed" | "dynamic")
          : undefined,
      minWordThreshold:
        typeof rawMinWords === "number" ? rawMinWords : undefined,
    });
  }

  private parseBrowserHeaders(
    value: unknown,
  ): CrawlBrowserHeader[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeBrowserHeaders(
      value
        .map((entry) =>
          typeof entry === "object" && entry
            ? (entry as CrawlBrowserHeader)
            : undefined,
        )
        .filter((entry): entry is CrawlBrowserHeader => Boolean(entry)),
    );
  }

  private parseBrowserCookies(
    value: unknown,
  ): CrawlBrowserCookie[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeBrowserCookies(
      value
        .map((entry) =>
          typeof entry === "object" && entry
            ? (entry as CrawlBrowserCookie)
            : undefined,
        )
        .filter((entry): entry is CrawlBrowserCookie => Boolean(entry)),
    );
  }

  private parseUserAgentGenerator(
    value: unknown,
  ): CrawlUserAgentGeneratorConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return this.normalizeUserAgentGenerator(
      value as CrawlUserAgentGeneratorConfig,
    );
  }

  private parseGeolocation(value: unknown): CrawlGeolocationConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return this.normalizeGeolocation(value as CrawlGeolocationConfig);
  }

  private normalizePatternList(patterns?: string[]) {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }
    const normalized = patterns
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }
    const unique: string[] = [];
    for (const pattern of normalized) {
      if (!unique.includes(pattern)) {
        unique.push(pattern);
      }
      if (unique.length >= 25) {
        break;
      }
    }
    return unique;
  }

  private normalizeScriptList(entries?: string[] | null): string[] | undefined {
    if (!entries || entries.length === 0) {
      return undefined;
    }
    const normalized = entries
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }
    return normalized.slice(0, 10);
  }

  private normalizeWaitForSelector(
    selector?: string | null,
  ): string | undefined {
    if (!selector) {
      return undefined;
    }
    const trimmed = selector.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 1024);
  }

  private normalizeWaitForScript(script?: string | null): string | undefined {
    if (!script) {
      return undefined;
    }
    const trimmed = script.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, 4000);
  }

  private normalizeWaitForTimeout(value?: number | null): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(500, Math.min(60000, Math.round(value)));
  }

  private normalizeWaitUntil(
    value?: string | null,
  ): CrawlTaskOptions["waitUntil"] {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (
      trimmed === "domcontentloaded" ||
      trimmed === "load" ||
      trimmed === "networkidle" ||
      trimmed === "commit"
    ) {
      return trimmed;
    }
    return undefined;
  }

  private normalizePageTimeoutMs(value?: number | null): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(1000, Math.min(180000, Math.round(value)));
  }

  private normalizeDelayBeforeReturnHtmlMs(
    value?: number | null,
  ): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(0, Math.min(30000, Math.round(value)));
  }

  private normalizeDelayJitterMs(value?: number | null): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(0, Math.min(10000, Math.round(value)));
  }

  private normalizeSemaphoreCount(value?: number | null): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return Math.max(1, Math.min(50, Math.round(value)));
  }

  private parseLinkPreviewOptions(
    value: unknown,
  ): CrawlLinkPreviewOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeLinkPreviewOptions({
      includeInternal:
        typeof record.includeInternal === "boolean"
          ? record.includeInternal
          : undefined,
      includeExternal:
        typeof record.includeExternal === "boolean"
          ? record.includeExternal
          : undefined,
      includeSocial:
        typeof record.includeSocial === "boolean"
          ? record.includeSocial
          : undefined,
      maxLinks:
        typeof record.maxLinks === "number" ? record.maxLinks : undefined,
      concurrency:
        typeof record.concurrency === "number" ? record.concurrency : undefined,
      timeoutSeconds:
        typeof record.timeoutSeconds === "number"
          ? record.timeoutSeconds
          : undefined,
      query: typeof record.query === "string" ? record.query : undefined,
      scoreThreshold:
        typeof record.scoreThreshold === "number"
          ? record.scoreThreshold
          : undefined,
      verbose: typeof record.verbose === "boolean" ? record.verbose : undefined,
      includePatterns: Array.isArray(record.includePatterns)
        ? (record.includePatterns as unknown[])
            .map((entry) => (typeof entry === "string" ? entry : ""))
            .filter(Boolean)
        : undefined,
      excludePatterns: Array.isArray(record.excludePatterns)
        ? (record.excludePatterns as unknown[])
            .map((entry) => (typeof entry === "string" ? entry : ""))
            .filter(Boolean)
        : undefined,
    });
  }

  private buildUrlList(baseUrl: string, options: CrawlTaskOptions): string[] {
    const accumulator = [baseUrl];
    if (options.additionalUrls) {
      accumulator.push(...options.additionalUrls);
    }
    if (options.multiUrlConfigs) {
      for (const config of options.multiUrlConfigs) {
        if (config.urls) {
          accumulator.push(...config.urls);
        }
      }
    }
    return Array.from(
      new Set(
        accumulator.filter(
          (entry) => typeof entry === "string" && entry.length > 0,
        ),
      ),
    );
  }
  private extractMemoryStats(
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

  private partitionCrawlerResults(items?: Crawl4aiArticle[]) {
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

  private classifyResult(item: Crawl4aiArticle): {
    kind: "success" | "failure" | "low_signal";
    hasMarkdown: boolean;
    lowSignalMarkdown: boolean;
    isChallengePage: boolean;
    statusCode?: number;
  } {
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
    const inlineSuccess = this.pickBoolean(item as Record<string, unknown>, [
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
    const metadataSuccess = this.pickBoolean(
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
    classified?: ReturnType<CrawlExecutionService["classifyResult"]>,
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
        this.pickString(item.metadata as Record<string, unknown> | undefined, [
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

  private buildExpansionSeedCandidates(
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
      this.pickNumber(item as Record<string, unknown>, [
        "statusCode",
        "status_code",
      ]) ??
      this.pickNumber(item.metadata as Record<string, unknown> | undefined, [
        "statusCode",
        "status_code",
        "status",
      ])
    );
  }

  private extractErrorMessage(item: Crawl4aiArticle): string | undefined {
    return (
      this.pickString(item as Record<string, unknown>, [
        "error",
        "errorMessage",
        "error_message",
      ]) ??
      this.pickString(item.metadata as Record<string, unknown> | undefined, [
        "error",
        "error_message",
        "message",
      ])
    );
  }

  private isRetryableStatus(
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

  private extractPipelineJobId(config: Prisma.JsonValue | null): string | null {
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

  private extractPipelineSourceId(
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

  private async markSourceFailureState(options: {
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

  private pickNumber(
    source: Record<string, unknown> | undefined,
    keys: string[],
  ): number | undefined {
    if (!source) {
      return undefined;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number") {
        return value;
      }
    }
    return undefined;
  }

  private async syncSourceQueueCounts(orgId: string, sourceId?: string | null) {
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

  private pickString(
    source: Record<string, unknown> | undefined,
    keys: string[],
  ): string | undefined {
    if (!source) {
      return undefined;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private pickBoolean(
    source: Record<string, unknown> | undefined,
    keys: string[],
  ): boolean | undefined {
    if (!source) {
      return undefined;
    }
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") {
        return value;
      }
    }
    return undefined;
  }
}
