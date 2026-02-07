import { TaskLogModel } from "@modular/mongo";
import { createLogger, sanitizeError } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";
import { NotificationType, PipelineJobStatus } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import { translateLocalhostProxyUrlForCrawl4ai } from "./crawl4ai-proxy";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";
import {
  CrawlExecutionSummary,
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
  CrawlMarkdownStrategy,
  CrawlTableExtractionStrategy,
  CrawlVirtualScrollConfig
} from "./crawl.types";
import { Crawl4aiClient, Crawl4aiArticle, Crawl4aiLink, Crawl4aiRequest, Crawl4aiResponse } from "./crawl4ai.client";
import { Crawl4aiRequestException } from "./crawl4ai.exception";


const logger = createLogger({ name: "crawl-execution-service" });

export interface CrawlExecutionRetryContext {
  attempt?: number;
  maxAttempts?: number;
  backoffDelayMs?: number | null;
}

@Injectable()
export class CrawlExecutionService {
  private readonly retryableStatusCodes = new Set([408, 423, 425, 429, 500, 502, 503, 504]);
  private readonly pipelineJobIdMaxLength = 128;

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly crawlClient: Crawl4aiClient,
    private readonly resultService: CrawlResultService,
    private readonly notifications: NotificationsService
  ) {}

  async runTask(
    taskId: string,
    orgId: string,
    triggeredById?: string,
    retryContext?: CrawlExecutionRetryContext
  ): Promise<CrawlExecutionSummary> {
    const task = await this.prisma.crawlTask.findFirst({ where: { id: taskId, orgId } });
    if (!task) {
      logger.warn({ taskId }, "Attempted to run missing crawl task");
      return {
        inserted: 0,
        skipped: 0
      };
    }

    const pipelineJobId = this.extractPipelineJobId(task.config);
    const sourceId = this.extractPipelineSourceId(task.config);

    await this.prisma.crawlTask.update({
      where: { id: task.id },
      data: {
        status: "running",
        lastRunAt: new Date()
      }
    });

    await TaskLogModel.create({
      queue: CRAWL_QUEUE_NAME,
      jobId: taskId,
      orgId,
      stage: "start",
      status: "processing",
      message: "crawl task started",
      data: {
        taskId,
        triggeredById,
        attempt: retryContext?.attempt ?? null,
        maxAttempts: retryContext?.maxAttempts ?? null
      }
	    });

	    try {
	      const configRecord =
	        task.config && typeof task.config === "object" && !Array.isArray(task.config)
	          ? (task.config as Record<string, unknown>)
	          : null;
	      const options = this.extractOptions(configRecord as Prisma.JsonValue | null);
	      assertNoCrawl4aiLlmOptions(options, "task.config.options");
	      const ingestToItems = configRecord?.ingestToItems === true;
	      let effectiveOptions = options;
	      const payload = this.buildRequestPayload(task, effectiveOptions);
	      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "crawler",
        status: "processing",
        message: "crawl4ai request started",
        data: {
          urls: payload.urls?.length ?? 0,
          scanFullPage: effectiveOptions.scanFullPage ?? false,
          scrollDelayMs: effectiveOptions.scrollDelayMs ?? null,
          virtualScroll: effectiveOptions.virtualScroll
            ? {
                containerSelector: effectiveOptions.virtualScroll.containerSelector ?? "body",
                scrollCount: effectiveOptions.virtualScroll.scrollCount ?? null,
                scrollBy: effectiveOptions.virtualScroll.scrollBy ?? null,
                waitAfterScrollMs: effectiveOptions.virtualScroll.waitAfterScrollMs ?? null,
              }
            : null,
          onlyMainContent: effectiveOptions.onlyMainContent ?? null,
          wordCountThreshold: effectiveOptions.wordCountThreshold ?? null,
          includeImages: effectiveOptions.includeImages ?? null,
          storeMedia: effectiveOptions.storeMedia ?? null,
          waitForImages: effectiveOptions.waitForImages ?? null,
        },
      });
      let response = await this.crawlClient.crawl(payload);
      let { successes, failures } = this.partitionCrawlerResults(response.results);

      if (this.shouldAttemptEmptyMarkdownFallback(successes, failures)) {
        const fallbackProfiles = this.buildEmptyMarkdownFallbackProfiles(effectiveOptions);
        const fallbackCandidates: {
          label: string;
          options: CrawlTaskOptions;
          response: Crawl4aiResponse;
          successes: Crawl4aiArticle[];
          failures: CrawlFailureDetail[];
          qualityScore: number;
        }[] = [];

        for (const profile of fallbackProfiles) {
          await TaskLogModel.create({
            queue: CRAWL_QUEUE_NAME,
            jobId: taskId,
            orgId,
            stage: "fallback",
            status: "processing",
            message: `Retrying crawl4ai with markdown fallback profile: ${profile.label}`,
            data: {
              profile: profile.label,
              fallback: profile.summary
            }
          });

          try {
            const fallbackPayload = this.buildRequestPayload(task, profile.options);
            const fallbackResponse = await this.crawlClient.crawl(fallbackPayload);
            const fallbackPartition = this.partitionCrawlerResults(fallbackResponse.results);
            const qualityScore = this.scoreMarkdownQuality(fallbackPartition.successes);

            if (fallbackPartition.successes.length > 0) {
              fallbackCandidates.push({
                label: profile.label,
                options: profile.options,
                response: fallbackResponse,
                successes: fallbackPartition.successes,
                failures: fallbackPartition.failures,
                qualityScore
              });
            }

            await TaskLogModel.create({
              queue: CRAWL_QUEUE_NAME,
              jobId: taskId,
              orgId,
              stage: "fallback",
              status: "completed",
              message:
                fallbackPartition.successes.length > 0
                  ? `Fallback profile ${profile.label} produced crawl results`
                  : `Fallback profile ${profile.label} did not produce markdown`,
              data: {
                profile: profile.label,
                successes: fallbackPartition.successes.length,
                failures: fallbackPartition.failures.length,
                qualityScore,
                failureSamples: fallbackPartition.failures.slice(0, 5)
              }
            });
          } catch (fallbackError) {
            await TaskLogModel.create({
              queue: CRAWL_QUEUE_NAME,
              jobId: taskId,
              orgId,
              stage: "fallback",
              status: "failed",
              message: `Fallback profile ${profile.label} failed`,
              error: sanitizeError(fallbackError, {
                redactSensitive: true
              }),
              data: {
                profile: profile.label
              }
            });
          }
        }

        const bestFallback = fallbackCandidates.sort((left, right) => right.qualityScore - left.qualityScore)[0];
        if (bestFallback) {
          response = bestFallback.response;
          successes = bestFallback.successes;
          failures = bestFallback.failures;
          effectiveOptions = bestFallback.options;

          await TaskLogModel.create({
            queue: CRAWL_QUEUE_NAME,
            jobId: taskId,
            orgId,
            stage: "fallback",
            status: "completed",
            message: `Selected markdown fallback profile: ${bestFallback.label}`,
            data: {
              profile: bestFallback.label,
              qualityScore: bestFallback.qualityScore,
              successes: bestFallback.successes.length,
              failures: bestFallback.failures.length
            }
          });
        }
      }

      const expansionResult = await this.expandListLikeResultsIfNeeded({
        task,
        orgId,
        taskId,
        keywords: payload.keywords ?? [],
        crawlOptions: effectiveOptions,
        successes
      });
      if (expansionResult) {
        successes = expansionResult.successes;
        if (expansionResult.failures.length > 0) {
          failures = [...failures, ...expansionResult.failures];
        }
        if (expansionResult.runId) {
          response = {
            ...response,
            runId: expansionResult.runId
          };
        }
      }

      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "crawler",
        status: "completed",
        data: {
          runId: response.runId ?? null,
          nextCursor: response.nextCursor ?? null,
          totalResults: response.results?.length ?? 0,
          successes: successes.length,
          failures: failures.length,
        },
      });

      let failureRetryableCount = 0;

      if (response.warnings && response.warnings.length > 0) {
        await TaskLogModel.create({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          orgId,
          stage: "crawler",
          status: "completed",
          message: "crawl4ai warnings",
          data: { warnings: response.warnings }
        });
      }

      if (failures.length > 0) {
        failureRetryableCount = failures.filter((failure) => failure.retryable).length;
        await TaskLogModel.create({
          queue: CRAWL_QUEUE_NAME,
          jobId: taskId,
          orgId,
          stage: "crawler",
          status: "completed",
          message: "crawl4ai partial failures",
          data: {
            totalFailures: failures.length,
            retryableFailures: failureRetryableCount,
            samples: failures.slice(0, 10)
          }
        });
      }

      const summary = await this.resultService.persistResults(
        task,
        successes,
        effectiveOptions,
        response.runId ?? undefined,
        this.extractMemoryStats(response),
        ingestToItems
          ? {
              orgId,
              userId: triggeredById ?? task.createdById
            }
          : undefined
      );

      if (failures.length > 0) {
        summary.failures = failures;
        summary.retryableFailures = failureRetryableCount;
      }

      if (summary.inserted === 0 && summary.skipped === 0) {
        const firstFailure = failures[0];
        if (firstFailure) {
          const statusLabel =
            typeof firstFailure.statusCode === "number" && Number.isFinite(firstFailure.statusCode)
              ? `HTTP ${firstFailure.statusCode}`
              : null;
          const urlLabel = firstFailure.url ? `${firstFailure.url}: ` : "";
          const statusPrefix = statusLabel ? `${statusLabel}: ` : "";
          const failureCountLabel = failures.length === 1 ? "1 failure" : `${failures.length} failures`;
          throw new Error(
            `crawl task produced no results (${failureCountLabel}). ${urlLabel}${statusPrefix}${firstFailure.error}`
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
          lastServerMemoryMb: summary.memory?.serverMemoryMb ?? task.lastServerMemoryMb,
          lastPeakMemoryMb: summary.memory?.peakMemoryMb ?? task.lastPeakMemoryMb,
          lastMemoryEfficiency: summary.memory?.efficiencyPercent ?? task.lastMemoryEfficiency
        }
      });

      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "complete",
        status: "completed",
        data: summary
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
        shouldRetry && typeof backoffDelayMs === "number" && Number.isFinite(backoffDelayMs)
          ? new Date(Date.now() + Math.max(0, Math.round(backoffDelayMs)))
          : null;

      const crawlTaskStatus = shouldRetry ? "queued" : "failed";
      try {
        await this.prisma.crawlTask.update({
          where: { id: task.id },
          data: {
            status: crawlTaskStatus,
            lastError: normalizedMessage
          }
        });
      } catch (updateError) {
        const maxVarchar191 = 191;
        const fallbackMessage =
          normalizedMessage.length <= maxVarchar191
            ? normalizedMessage
            : `${normalizedMessage.slice(0, maxVarchar191 - 1).trimEnd()}…`;
        logger.warn(
          { err: updateError, taskId: task.id, orgId },
          "Failed to persist crawl task error; retrying with truncated message"
        );
        await this.prisma.crawlTask
          .update({
            where: { id: task.id },
            data: {
              status: crawlTaskStatus,
              lastError: fallbackMessage
            }
          })
          .catch((fallbackError) => {
            logger.error(
              { err: fallbackError, taskId: task.id, orgId },
              "Failed to persist crawl task error after truncation"
            );
          });
      }
      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "error",
        status: "failed",
        error: sanitizeError(error, {
          redactSensitive: true
        }),
        data: {
          attempt: attempt ?? null,
          maxAttempts: maxAttempts ?? null,
          backoffDelayMs: backoffDelayMs ?? null,
          retryable,
          willRetry: shouldRetry,
          nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null
        }
      });

      if (pipelineJobId) {
        try {
          await this.prisma.pipelineJob.updateMany({
            where: { id: pipelineJobId },
            data: {
              status: shouldRetry ? PipelineJobStatus.delayed : PipelineJobStatus.failed,
              completedAt: shouldRetry ? null : new Date(),
              error: normalizedMessage,
              attempts: typeof attempt === "number" && Number.isFinite(attempt) ? Math.max(0, attempt) : 0,
            }
          });
        } catch (pipelineError) {
          logger.warn(
            { pipelineError, pipelineJobId, taskId: task.id, orgId },
            "Failed to update pipeline job status for crawl failure"
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
            "Failed to update news source failure state for crawl failure"
          );
        }
      }

      if (triggeredById && !shouldRetry) {
        await this.safeNotifyCrawl(
          task,
          { inserted: 0, skipped: 0 },
          triggeredById,
          "failed",
          normalizedMessage
        );
      }
      throw error;
    }
  }

  private isEmptyMarkdownFailure(failure: CrawlFailureDetail): boolean {
    const normalizedError =
      typeof failure.error === "string" ? failure.error.toLowerCase() : "";
    return (
      (failure.statusCode === undefined || failure.statusCode === 200) &&
      normalizedError.includes("empty markdown")
    );
  }

  private shouldAttemptEmptyMarkdownFallback(successes: Crawl4aiArticle[], failures: CrawlFailureDetail[]) {
    return (
      successes.length === 0 &&
      failures.length > 0 &&
      failures.every((failure) => this.isEmptyMarkdownFailure(failure))
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
            wordCountThreshold: 0
          }
        : {
            removeOverlayElements: true,
            wordCountThreshold: 0
          };

    const ensureCitations = options.markdownOptions?.citations ?? true;

    const rawRelaxedOptions = this.normalizeOptions({
      ...options,
      onlyMainContent: false,
      markdownFilter: undefined,
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource: "raw_html",
        citations: ensureCitations
      },
      cleanMarkdown: relaxedCleanMarkdown,
      cssSelector: undefined,
      wordCountThreshold: 10
    });

    const cleanedBalancedOptions = this.normalizeOptions({
      ...options,
      onlyMainContent: false,
      markdownFilter: {
        type: "pruning",
        thresholdType: "dynamic",
        threshold: 0.2,
        minWordThreshold: 5
      },
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource: "cleaned_html",
        citations: ensureCitations
      },
      cleanMarkdown: {
        ...(cleanMarkdown ?? {}),
        removeOverlayElements: cleanMarkdown?.removeOverlayElements ?? true,
        wordCountThreshold:
          typeof cleanMarkdown?.wordCountThreshold === "number"
            ? Math.min(cleanMarkdown.wordCountThreshold, 40)
            : 20
      },
      cssSelector: undefined,
      wordCountThreshold: Math.min(options.wordCountThreshold ?? 80, 40)
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
          contentSource: rawRelaxedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: rawRelaxedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: rawRelaxedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold: rawRelaxedOptions.cleanMarkdown?.wordCountThreshold ?? null
        }
      },
      {
        label: "cleaned_balanced",
        options: cleanedBalancedOptions,
        summary: {
          contentSource: cleanedBalancedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: cleanedBalancedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: cleanedBalancedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold: cleanedBalancedOptions.cleanMarkdown?.wordCountThreshold ?? null
        }
      }
    ];

    const sourceFilter = options.markdownFilter;
    if (sourceFilter?.type === "bm25" && typeof sourceFilter.userQuery === "string" && sourceFilter.userQuery.trim().length > 0) {
      const bm25FocusedOptions = this.normalizeOptions({
        ...options,
        onlyMainContent: false,
        markdownFilter: {
          type: "bm25",
          userQuery: sourceFilter.userQuery,
          bm25Threshold: sourceFilter.bm25Threshold ?? 0.6,
          language: sourceFilter.language
        },
        markdownOptions: {
          ...(options.markdownOptions ?? {}),
          contentSource: "cleaned_html",
          citations: ensureCitations
        },
        cleanMarkdown: relaxedCleanMarkdown,
        cssSelector: undefined,
        wordCountThreshold: Math.min(options.wordCountThreshold ?? 80, 30)
      });
      profiles.push({
        label: "bm25_focus",
        options: bm25FocusedOptions,
        summary: {
          contentSource: bm25FocusedOptions.markdownOptions?.contentSource ?? null,
          markdownFilter: bm25FocusedOptions.markdownFilter?.type ?? null,
          wordCountThreshold: bm25FocusedOptions.wordCountThreshold ?? null,
          cleanMarkdownWordCountThreshold: bm25FocusedOptions.cleanMarkdown?.wordCountThreshold ?? null
        }
      });
    }

    return profiles;
  }

  private scoreMarkdownQuality(successes: Crawl4aiArticle[]): number {
    if (successes.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }
    return successes.reduce((total, item) => total + this.scoreSingleMarkdownQuality(item), 0);
  }

  private scoreSingleMarkdownQuality(item: Crawl4aiArticle): number {
    const markdownResult = this.resultService.extractMarkdownResult(item.markdown);
    const primary = typeof markdownResult.primary === "string" ? markdownResult.primary.trim() : "";
    if (!primary) {
      return -1000;
    }

    const words = primary.split(/\s+/).filter((entry) => entry.length > 0).length;
    const headings = (primary.match(/^#{1,6}\s+/gm) ?? []).length;
    const markdownLinks = (primary.match(/\]\((https?:\/\/|\/)/g) ?? []).length;
    const rawUrls = (primary.match(/https?:\/\/\S+/g) ?? []).length;
    const codeFenceMarkers = (primary.match(/```/g) ?? []).length;
    const codeBlocks = Math.floor(codeFenceMarkers / 2);
    const citationMarks = (primary.match(/\[\^\d+\]/g) ?? []).length;

    const score =
      Math.min(words, 6000) + headings * 8 + citationMarks * 2 - (markdownLinks + rawUrls) * 4 - codeBlocks * 3;
    return Number.isFinite(score) ? score : 0;
  }

  private async expandListLikeResultsIfNeeded(options: {
    task: CrawlTask;
    orgId: string;
    taskId: string;
    keywords: string[];
    crawlOptions: CrawlTaskOptions;
    successes: Crawl4aiArticle[];
  }): Promise<
    | {
        successes: Crawl4aiArticle[];
        failures: CrawlFailureDetail[];
        runId: string | null;
      }
    | null
  > {
    if (options.successes.length === 0) {
      return null
    }

    const assessments = options.successes.map((article, index) => {
      const quality = this.assessArticleMarkdownSignal(article)
      return {
        index,
        article,
        quality,
        linkInventory: this.countArticleLinkInventory(article)
      }
    })

    const lowSignalAssessments = assessments.filter((entry) => {
      const quality = entry.quality
      if (quality.isListLike) {
        return true
      }
      if (quality.linkDensity >= 0.14 && quality.wordCount <= 1600) {
        return true
      }
      if (quality.linkCount >= 12 && quality.wordCount <= 520) {
        return true
      }
      return entry.linkInventory >= 40 && quality.wordCount <= 900
    })
    if (lowSignalAssessments.length === 0) {
      return null
    }

    const allLowSignal = lowSignalAssessments.length === assessments.length
    const maxLowSignalWords = lowSignalAssessments.reduce(
      (maxWords, entry) => Math.max(maxWords, entry.quality.wordCount),
      0
    )
    const minLowSignalWords = lowSignalAssessments.reduce(
      (minWords, entry) => Math.min(minWords, entry.quality.wordCount),
      Number.POSITIVE_INFINITY
    )
    const meanLowSignalWords =
      lowSignalAssessments.reduce((total, entry) => total + entry.quality.wordCount, 0) /
      lowSignalAssessments.length
    const bestLowSignalScore = lowSignalAssessments.reduce(
      (maxScore, entry) => Math.max(maxScore, entry.quality.score),
      Number.NEGATIVE_INFINITY
    )
    const maxLowSignalLinkDensity = lowSignalAssessments.reduce(
      (maxDensity, entry) => Math.max(maxDensity, entry.quality.linkDensity),
      0
    )
    const meanLowSignalLinkDensity =
      lowSignalAssessments.reduce((total, entry) => total + entry.quality.linkDensity, 0) /
      lowSignalAssessments.length

    await TaskLogModel.create({
      queue: CRAWL_QUEUE_NAME,
      jobId: options.taskId,
      orgId: options.orgId,
      stage: 'expansion',
      status: 'processing',
      message: 'Detected low-signal crawl markdown; evaluating detail expansion candidates',
      data: {
        totalSuccesses: assessments.length,
        lowSignalResults: lowSignalAssessments.length,
        allLowSignal,
        lowSignalWords: {
          min: Number.isFinite(minLowSignalWords) ? minLowSignalWords : 0,
          max: maxLowSignalWords,
          avg: Number.isFinite(meanLowSignalWords) ? Number(meanLowSignalWords.toFixed(1)) : 0
        },
        lowSignalLinkDensity: {
          max: Number(maxLowSignalLinkDensity.toFixed(3)),
          avg: Number(meanLowSignalLinkDensity.toFixed(3))
        },
        qualitySamples: lowSignalAssessments.slice(0, 5).map((entry) => ({
          url: entry.article.url ?? null,
          wordCount: entry.quality.wordCount,
          linkCount: entry.quality.linkCount,
          linkDensity: Number(entry.quality.linkDensity.toFixed(3)),
          bulletLines: entry.quality.bulletLines,
          score: Number(entry.quality.score.toFixed(2)),
          linkInventory: entry.linkInventory
        }))
      }
    })

    const existingUrls = new Set(
      options.successes
        .map((entry) => this.normalizeComparableUrl(entry.url))
        .filter((entry): entry is string => Boolean(entry))
    )

    const candidateScoreMap = new Map<string, number>()
    for (const entry of lowSignalAssessments) {
      const baseUrl = this.resolveArticleBaseUrl(entry.article) ?? options.task.targetUrl
      const candidates = this.extractDetailLinkCandidatesFromArticle(entry.article)
      for (const candidate of candidates) {
        if (existingUrls.has(candidate)) {
          continue
        }
        const nextScore = this.scoreDetailCandidateUrl(candidate, baseUrl)
        const currentScore = candidateScoreMap.get(candidate)
        if (currentScore === undefined || nextScore > currentScore) {
          candidateScoreMap.set(candidate, nextScore)
        }
      }
    }

    const candidateLimit = allLowSignal ? 14 : 8
    const candidateUrls = Array.from(candidateScoreMap.entries())
      .filter((entry) => Number.isFinite(entry[1]))
      .sort((left, right) => right[1] - left[1])
      .map((entry) => entry[0])
      .slice(0, candidateLimit)

    if (candidateUrls.length === 0) {
      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: options.taskId,
        orgId: options.orgId,
        stage: 'expansion',
        status: 'failed',
        message: 'Low-signal markdown detected but no detail candidate URLs were extracted',
        data: {
          allLowSignal,
          lowSignalResults: lowSignalAssessments.length,
          lowSignalWords: {
            min: Number.isFinite(minLowSignalWords) ? minLowSignalWords : 0,
            max: maxLowSignalWords,
            avg: Number.isFinite(meanLowSignalWords) ? Number(meanLowSignalWords.toFixed(1)) : 0
          },
          maxLowSignalLinkDensity: Number(maxLowSignalLinkDensity.toFixed(3))
        }
      })

      if (allLowSignal) {
        throw new Error(
          'crawl markdown is low-signal/list-like and no detail candidate URLs were extracted from the page content'
        )
      }
      return null
    }

    const detailOptions = this.buildDetailExpansionOptions(options.crawlOptions)
    const candidateBatchSize = 3
    const candidateBatches = Array.from({ length: Math.ceil(candidateUrls.length / candidateBatchSize) }, (_, index) =>
      candidateUrls.slice(index * candidateBatchSize, (index + 1) * candidateBatchSize)
    )

    const expansionSuccesses: Crawl4aiArticle[] = []
    const expansionFailures: CrawlFailureDetail[] = []
    let expansionRunId: string | null = null

    for (let index = 0; index < candidateBatches.length; index += 1) {
      const batchUrls = candidateBatches[index] ?? []
      if (batchUrls.length === 0) {
        continue
      }

      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: options.taskId,
        orgId: options.orgId,
        stage: 'expansion',
        status: 'processing',
        message: `Detail expansion batch ${index + 1}/${candidateBatches.length} started`,
        data: {
          batchIndex: index + 1,
          batchCount: candidateBatches.length,
          urls: batchUrls
        }
      })

      try {
        const batchResponse = await this.crawlClient.crawl({
          url: options.task.targetUrl,
          urls: batchUrls,
          keywords: options.keywords,
          options: detailOptions
        })
        const partition = this.partitionCrawlerResults(batchResponse.results)
        expansionRunId = expansionRunId ?? batchResponse.runId ?? null
        expansionSuccesses.push(...partition.successes)
        if (partition.failures.length > 0) {
          expansionFailures.push(...partition.failures)
        }

        await TaskLogModel.create({
          queue: CRAWL_QUEUE_NAME,
          jobId: options.taskId,
          orgId: options.orgId,
          stage: 'expansion',
          status: 'completed',
          message: `Detail expansion batch ${index + 1}/${candidateBatches.length} finished`,
          data: {
            batchIndex: index + 1,
            batchCount: candidateBatches.length,
            urls: batchUrls,
            successes: partition.successes.length,
            failures: partition.failures.length,
            failureSamples: partition.failures.slice(0, 3)
          }
        })
      } catch (error) {
        const errorMessage =
          error instanceof Error && error.message.trim().length > 0
            ? error.message.trim()
            : 'detail expansion batch failed'
        for (const candidateUrl of batchUrls) {
          expansionFailures.push({
            url: candidateUrl,
            error: errorMessage,
            retryable: this.isRetryableStatus(undefined, errorMessage)
          })
        }

        await TaskLogModel.create({
          queue: CRAWL_QUEUE_NAME,
          jobId: options.taskId,
          orgId: options.orgId,
          stage: 'expansion',
          status: 'failed',
          message: `Detail expansion batch ${index + 1}/${candidateBatches.length} failed`,
          error: sanitizeError(error, {
            redactSensitive: true
          }),
          data: {
            batchIndex: index + 1,
            batchCount: candidateBatches.length,
            urls: batchUrls
          }
        })
      }
    }

    const improvedByUrl = new Map<
      string,
      {
        article: Crawl4aiArticle;
        quality: ReturnType<CrawlExecutionService['assessArticleMarkdownSignal']>;
      }
    >()

    for (const article of expansionSuccesses) {
      const quality = this.assessArticleMarkdownSignal(article)
      const isImproved = this.isSignificantDetailImprovement(
        quality,
        bestLowSignalScore,
        maxLowSignalWords,
        maxLowSignalLinkDensity
      )
      if (!isImproved) {
        continue
      }

      const comparableUrl = this.normalizeComparableUrl(article.url) ?? article.url ?? `__missing_url_${improvedByUrl.size}`
      const current = improvedByUrl.get(comparableUrl)
      if (!current || quality.score > current.quality.score) {
        improvedByUrl.set(comparableUrl, {
          article,
          quality
        })
      }
    }

    const improvedEntries = Array.from(improvedByUrl.values()).sort(
      (left, right) =>
        right.quality.score - left.quality.score ||
        right.quality.wordCount - left.quality.wordCount ||
        left.quality.linkDensity - right.quality.linkDensity
    )

    const preferredPathSegment = this.extractPrimaryPathSegment(options.task.targetUrl)
    const rankedImprovedEntries = (() => {
      if (!preferredPathSegment) {
        return improvedEntries
      }

      const preferredEntries = improvedEntries.filter((entry) =>
        this.urlMatchesPrimaryPathSegment(entry.article.url, preferredPathSegment)
      )
      if (preferredEntries.length === 0) {
        return improvedEntries
      }

      if (preferredEntries.length >= Math.min(3, improvedEntries.length)) {
        return preferredEntries
      }

      const nonPreferredEntries = improvedEntries.filter(
        (entry) => !this.urlMatchesPrimaryPathSegment(entry.article.url, preferredPathSegment)
      )
      return [...preferredEntries, ...nonPreferredEntries]
    })()

    const maxImprovedResults = allLowSignal ? 8 : 5
    const improvedSuccesses = rankedImprovedEntries.slice(0, maxImprovedResults).map((entry) => entry.article)

    await TaskLogModel.create({
      queue: CRAWL_QUEUE_NAME,
      jobId: options.taskId,
      orgId: options.orgId,
      stage: 'expansion',
      status: 'completed',
      message:
        improvedSuccesses.length > 0
          ? `Detail expansion selected ${improvedSuccesses.length} richer article result(s)`
          : 'Detail expansion did not produce richer markdown',
      data: {
        allLowSignal,
        candidateCount: candidateUrls.length,
        batchCount: candidateBatches.length,
        expansionSuccesses: expansionSuccesses.length,
        expansionFailures: expansionFailures.length,
        improvedSuccesses: improvedSuccesses.length,
        preferredPathSegment: preferredPathSegment ?? null,
        improvedSamples: rankedImprovedEntries.slice(0, 5).map((entry) => ({
          url: entry.article.url ?? null,
          wordCount: entry.quality.wordCount,
          linkCount: entry.quality.linkCount,
          linkDensity: Number(entry.quality.linkDensity.toFixed(3)),
          score: Number(entry.quality.score.toFixed(2)),
          isListLike: entry.quality.isListLike
        })),
        failureSamples: expansionFailures.slice(0, 5)
      }
    })

    if (improvedSuccesses.length === 0) {
      if (allLowSignal) {
        throw new Error(
          `crawl markdown is low-signal/list-like and detail expansion did not produce richer article content (candidates=${candidateUrls.length}, expansionSuccesses=${expansionSuccesses.length}, expansionFailures=${expansionFailures.length})`
        )
      }
      return null
    }

    const lowSignalIndexes = new Set(lowSignalAssessments.map((entry) => entry.index))
    const retainedSuccesses = options.successes.filter((_, index) => !lowSignalIndexes.has(index))
    const retainedUrlSet = new Set(
      retainedSuccesses
        .map((entry) => this.normalizeComparableUrl(entry.url))
        .filter((entry): entry is string => Boolean(entry))
    )

    const dedupedImprovedSuccesses = improvedSuccesses.filter((entry) => {
      const comparable = this.normalizeComparableUrl(entry.url)
      if (!comparable) {
        return true
      }
      if (retainedUrlSet.has(comparable)) {
        return false
      }
      retainedUrlSet.add(comparable)
      return true
    })

    return {
      successes: [...retainedSuccesses, ...dedupedImprovedSuccesses],
      failures: expansionFailures,
      runId: expansionRunId
    }
  }

  private extractPrimaryPathSegment(url: string): string | undefined {
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname
        .replace(/\/+$/, '')
        .split('/')
        .filter((entry) => entry.length > 0)
      return segments[0]?.toLowerCase()
    } catch {
      return undefined
    }
  }

  private urlMatchesPrimaryPathSegment(url: string | undefined, segment: string): boolean {
    if (!url) {
      return false
    }
    try {
      const parsed = new URL(url)
      const segments = parsed.pathname
        .replace(/\/+$/, '')
        .split('/')
        .filter((entry) => entry.length > 0)
      return segments[0]?.toLowerCase() === segment
    } catch {
      return false
    }
  }

  private countArticleLinkInventory(article: Crawl4aiArticle): number {
    if (!article.links || typeof article.links !== 'object' || Array.isArray(article.links)) {
      return 0
    }

    const collections = Object.values(article.links as Record<string, unknown>)
    let total = 0
    for (const collection of collections) {
      if (Array.isArray(collection)) {
        total += collection.length
      }
    }
    return total
  }

  private assessArticleMarkdownSignal(article: Crawl4aiArticle) {
    const markdownResult = this.resultService.extractMarkdownResult(article.markdown)
    const markdown = typeof markdownResult.primary === 'string' ? markdownResult.primary.trim() : ''
    if (!markdown) {
      return {
        wordCount: 0,
        paragraphCount: 0,
        headingCount: 0,
        linkCount: 0,
        linkDensity: 0,
        bulletLines: 0,
        score: Number.NEGATIVE_INFINITY,
        isListLike: false
      }
    }

    const { scoreWordCount, densityWordCount } = this.estimateMarkdownWordUnits(markdown)
    const wordCount = densityWordCount
    const paragraphCount = markdown
      .split(/\n\s*\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0).length
    const headingCount = (markdown.match(/^#{1,6}\s+/gm) ?? []).length
    const markdownLinkCount = (markdown.match(/\]\((https?:\/\/|\/)/g) ?? []).length
    const rawUrlCount = (markdown.match(/https?:\/\/\S+/g) ?? []).length
    const linkCount = markdownLinkCount + rawUrlCount
    const bulletLines = markdown
      .split(/\n/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('- ') || entry.startsWith('* ') || entry.startsWith('• ')).length
    const linkDensity = wordCount > 0 ? linkCount / wordCount : linkCount

    const listLikeSignals =
      (linkCount >= 16 && wordCount <= 1500) ||
      (bulletLines >= 10 && linkCount >= 10) ||
      (linkDensity >= 0.09 && wordCount <= 1200)
    const hasArticleLikeBody = paragraphCount >= 8 && wordCount >= 260 && linkDensity <= 0.22
    const isListLike = listLikeSignals && !hasArticleLikeBody

    const score =
      Math.min(scoreWordCount, 12_000) +
      Math.min(paragraphCount, 220) * 6 +
      headingCount * 3 -
      linkCount * 6 -
      bulletLines * 2

    return {
      wordCount,
      paragraphCount,
      headingCount,
      linkCount,
      linkDensity,
      bulletLines,
      score,
      isListLike
    }
  }

  private estimateMarkdownWordUnits(markdown: string): { scoreWordCount: number; densityWordCount: number } {
    const whitespaceWords = markdown.split(/\s+/).filter((entry) => entry.length > 0).length;
    const cjkChars = markdown.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu);
    const cjkCount = cjkChars ? cjkChars.length : 0;

    return {
      scoreWordCount: whitespaceWords + Math.round(cjkCount / 2),
      densityWordCount: whitespaceWords + Math.round(cjkCount / 6)
    };
  }

  private isSignificantDetailImprovement(
    quality: {
      wordCount: number;
      paragraphCount: number;
      headingCount: number;
      linkCount: number;
      linkDensity: number;
      score: number;
      isListLike: boolean;
    },
    baseScore: number,
    baseWords: number,
    baseLinkDensity: number
  ): boolean {
    if (quality.wordCount <= 0) {
      return false
    }

    const densityTarget = Math.max(baseLinkDensity * 0.65, 0.08)
    if (
      quality.isListLike &&
      quality.wordCount < Math.max(baseWords + 80, 180) &&
      quality.linkDensity >= Math.max(densityTarget * 0.9, 0.12)
    ) {
      return false
    }

    if (
      !quality.isListLike &&
      quality.paragraphCount >= 3 &&
      quality.wordCount >= 120 &&
      quality.linkDensity <= densityTarget
    ) {
      return true
    }

    if (quality.score >= baseScore + 120 && quality.linkDensity <= Math.max(baseLinkDensity * 0.8, 0.2)) {
      return true
    }

    if (quality.wordCount >= baseWords + 100 && quality.linkDensity <= Math.max(baseLinkDensity * 0.85, 0.22)) {
      return true
    }

    if (
      !quality.isListLike &&
      quality.wordCount >= Math.max(Math.floor(baseWords * 0.6), 140) &&
      quality.linkCount <= Math.max(Math.floor(quality.wordCount * 0.12), 35)
    ) {
      return true
    }

    return !quality.isListLike && quality.wordCount >= 180 && quality.headingCount >= 1 && quality.linkDensity <= 0.12
  }

  private buildDetailExpansionOptions(options: CrawlTaskOptions): CrawlTaskOptions {
    const cleanMarkdown = options.cleanMarkdown;
    return this.normalizeOptions({
      ...options,
      additionalUrls: undefined,
      multiUrlConfigs: undefined,
      scanFullPage: false,
      scrollDelayMs: undefined,
      virtualScroll: undefined,
      markdownFilter: undefined,
      extractLinks: false,
      wordCountThreshold: Math.min(options.wordCountThreshold ?? 80, 40),
      markdownOptions: {
        ...(options.markdownOptions ?? {}),
        contentSource: options.markdownOptions?.contentSource ?? "raw_html",
        citations: options.markdownOptions?.citations ?? true
      },
      cleanMarkdown: cleanMarkdown
        ? {
            ...cleanMarkdown,
            wordCountThreshold:
              typeof cleanMarkdown.wordCountThreshold === "number"
                ? Math.min(cleanMarkdown.wordCountThreshold, 40)
                : 20
          }
        : {
            removeOverlayElements: true,
            wordCountThreshold: 20
          }
    });
  }

  private extractDetailLinkCandidatesFromArticle(article: Crawl4aiArticle): string[] {
    const baseUrl = this.resolveArticleBaseUrl(article);
    if (!baseUrl) {
      return [];
    }

    const markdownResult = this.resultService.extractMarkdownResult(article.markdown);
    const fragments = [
      markdownResult.references,
      markdownResult.citations,
      markdownResult.raw,
      markdownResult.fit,
      markdownResult.primary
    ]
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .join("\n");

    const seedUrls: string[] = [];
    if (fragments) {
      const absoluteMatches = fragments.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [];
      seedUrls.push(...absoluteMatches);

      const inlineMarkdownLinks = Array.from(
        fragments.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)
      ).map((match) => match[1]);
      seedUrls.push(...inlineMarkdownLinks);

      const referenceDefinitions = Array.from(fragments.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)).map(
        (match) => match[1]
      );
      seedUrls.push(...referenceDefinitions);
    }

    if (article.links && typeof article.links === "object" && !Array.isArray(article.links)) {
      const linkCollections = Object.values(article.links as Record<string, Crawl4aiLink[] | unknown>);
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
          if (typeof record.href === "string" && record.href.trim().length > 0) {
            seedUrls.push(record.href);
          }
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
      if (!this.isLikelyDetailArticleUrl(normalized, baseUrl)) {
        continue;
      }
      seen.add(normalized);
      scored.push({
        url: normalized,
        score: this.scoreDetailCandidateUrl(normalized, baseUrl)
      });
      if (scored.length >= 30) {
        break;
      }
    }

    return scored.sort((left, right) => right.score - left.score).map((entry) => entry.url);
  }

  private resolveArticleBaseUrl(article: Crawl4aiArticle): string | undefined {
    if (typeof article.url === "string" && article.url.trim().length > 0) {
      return article.url.trim();
    }
    const metadataUrl = this.pickString(article.metadata as Record<string, unknown> | undefined, [
      "url",
      "sourceUrl",
      "source_url"
    ]);
    return metadataUrl?.trim() || undefined;
  }

  private normalizeDetailCandidateUrl(rawUrl: string, baseUrl: string): string | undefined {
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
      const paramsToDrop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
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

  private isLikelyDetailArticleUrl(url: string, baseUrl: string): boolean {
    try {
      const parsed = new URL(url)
      const base = new URL(baseUrl)
      if (this.getRootDomain(parsed.hostname) !== this.getRootDomain(base.hostname)) {
        return false
      }

      const pathname = parsed.pathname.replace(/\/+/g, '/').replace(/\/+$/, '')
      const segments = pathname.split('/').filter((entry) => entry.length > 0)
      if (segments.length < 2) {
        return false
      }

      const joined = segments.join('/').toLowerCase()
      if (/\b(video|videos|photo|photos|pictures|gallery|podcast|graphics)\b/.test(joined)) {
        return false
      }
      if (/\b(tag|tags|topic|topics|section|sections|author|authors|archive|latest|live)\b/.test(joined)) {
        return false
      }

      const lastSegment = segments[segments.length - 1]!
      const lastSegmentLower = lastSegment.toLowerCase()
      const articleDateSuffixPattern = /-\d{4}-\d{2}-\d{2}$/
      const reutersStyleIdPattern = /[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/
      const reutersWireIdPattern = /(?:^|-)id[a-z0-9]{7,}$/i

      if (
        articleDateSuffixPattern.test(lastSegment) ||
        reutersStyleIdPattern.test(lastSegment) ||
        reutersWireIdPattern.test(lastSegment)
      ) {
        return true
      }

      if (/^\d{4}\/\d{2}\/\d{2}/.test(segments.slice(-3).join('/'))) {
        return true
      }

      if (segments.some((segment) => segment === 'article' || segment === 'articles')) {
        return true
      }

      if (segments.length >= 4 && lastSegment.length >= 14 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        return true
      }

      if (segments.length >= 3 && lastSegment.length >= 24 && /[a-z0-9]/i.test(lastSegment)) {
        return true
      }

      const likelySectionTail = new Set([
        'world',
        'business',
        'markets',
        'technology',
        'tech',
        'opinion',
        'sport',
        'sports',
        'news',
        'japan',
        'us',
        'china',
        'europe',
        'ukraine',
        'russia',
        'latest',
        'archive'
      ])
      if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
        return false
      }

      return false
    } catch {
      return false
    }
  }

  private scoreDetailCandidateUrl(url: string, baseUrl?: string): number {
    try {
      const parsed = new URL(url)
      const pathname = parsed.pathname.replace(/\/+$/, '')
      const segments = pathname.split('/').filter((entry) => entry.length > 0)
      const segmentsLower = segments.map((entry) => entry.toLowerCase())
      const lastSegment = segments[segments.length - 1] ?? ''
      const lastSegmentLower = lastSegment.toLowerCase()

      let score = 0
      if (/-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 220
      }
      if (/[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/.test(lastSegment)) {
        score += 150
      }
      if (/(?:^|-)id[a-z0-9]{7,}$/i.test(lastSegment)) {
        score += 130
      }
      if (segments.some((segment) => segment === 'article' || segment === 'articles')) {
        score += 100
      }
      if (segments.length >= 4 && /[a-z0-9]-[a-z0-9]/i.test(lastSegment)) {
        score += 80
      }
      if (segments.length >= 3) {
        score += 18
      }
      if (parsed.pathname.toLowerCase().includes('/world/')) {
        score += 16
      }

      if (baseUrl) {
        try {
          const base = new URL(baseUrl)
          const baseSegments = base.pathname
            .replace(/\/+$/, '')
            .split('/')
            .filter((entry) => entry.length > 0)
            .map((entry) => entry.toLowerCase())
          if (baseSegments[0]) {
            if (baseSegments[0] === segmentsLower[0]) {
              score += 120
            } else {
              score -= 90
            }
          }
          if (baseSegments[1] && baseSegments[1] === segmentsLower[1]) {
            score += 30
          }
        } catch {
          // Ignore scoring hints when base URL is malformed
        }
      }

      const likelySectionTail = new Set([
        'world',
        'business',
        'markets',
        'technology',
        'tech',
        'opinion',
        'sport',
        'sports',
        'news',
        'japan',
        'us',
        'china',
        'europe',
        'ukraine',
        'russia',
        'latest',
        'archive'
      ])
      if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
        score -= 180
      }

      if (
        segmentsLower.some((segment) =>
          ['video', 'videos', 'photos', 'photo', 'gallery', 'graphics', 'podcast', 'tag', 'tags', 'topic', 'topics', 'section', 'sections', 'authors', 'author'].includes(segment)
        )
      ) {
        score -= 150
      }

      if (parsed.search.length > 0) {
        score -= 12
      }
      return score
    } catch {
      return Number.NEGATIVE_INFINITY
    }
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
    errorMessage?: string
  ) {
    const truncateVarchar191 = (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length <= 191) {
        return trimmed;
      }
      return `${trimmed.slice(0, 190).trimEnd()}…`;
    };

    const lastResultAt = summary.lastFetchedAt ? summary.lastFetchedAt.toISOString() : null;
    const title = truncateVarchar191(
      `${status === "completed" ? "Crawl completed" : "Crawl failed"}: ${task.displayName ?? task.targetUrl}`
    );
    const body =
      status === "completed"
        ? truncateVarchar191(
            `Inserted ${summary.inserted}, skipped ${summary.skipped}${
              summary.retryableFailures ? `, retryable ${summary.retryableFailures}` : ""
            }`
          )
        : errorMessage
          ? truncateVarchar191(errorMessage)
          : "Crawl task failed";

    const payload = {
      orgId: task.orgId,
      userId: triggeredById,
      type: status === "completed" ? NotificationType.crawl_completed : NotificationType.crawl_failed,
      title,
      body,
      data: {
        taskId: task.id,
        status,
        lastResultAt
      }
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
          "Failed to send crawl notification, retrying"
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    logger.error(
      { taskId: task.id, attempts: maxAttempts, error: lastError },
      "Failed to send crawl notification after retries"
    );

    try {
      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: task.id,
        orgId: task.orgId,
        stage: "notify",
        status: "failed",
        message: "crawl notification delivery failed",
        data: {
          taskId: task.id,
          status,
          notificationType: payload.type
        },
        error: {
          message: lastError instanceof Error ? lastError.message : String(lastError)
        }
      });
    } catch (error) {
      logger.error({ taskId: task.id, error }, "Failed to persist crawl notification failure log");
    }
  }

  private fromJsonArray(value: Prisma.JsonValue | null): string[] {
    if (!value || !Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => (typeof entry === "string" ? entry : null))
      .filter((entry): entry is string => Boolean(entry));
  }

  private buildRequestPayload(task: CrawlTask, providedOptions?: CrawlTaskOptions): Crawl4aiRequest {
    const keywords = this.fromJsonArray(task.keywords);
    const options = providedOptions ?? this.extractOptions(task.config);
    const urls = this.buildUrlList(task.targetUrl, options);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options
    };
  }

  private extractOptions(config: Prisma.JsonValue | null): CrawlTaskOptions {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return this.normalizeOptions();
    }
    const value = config as Record<string, unknown>;
    return this.normalizeOptions({
      includeImages: typeof value.includeImages === "boolean" ? value.includeImages : undefined,
      storeMedia: typeof value.storeMedia === "boolean" ? value.storeMedia : undefined,
      onlyMainContent: typeof value.onlyMainContent === "boolean" ? value.onlyMainContent : undefined,
      extractLinks: typeof value.extractLinks === "boolean" ? value.extractLinks : undefined,
      cacheMode: typeof value.cacheMode === "string" ? (value.cacheMode as CrawlTaskOptions["cacheMode"]) : undefined,
      prefetch: typeof value.prefetch === "boolean" ? value.prefetch : undefined,
      scanFullPage: typeof value.scanFullPage === "boolean" ? value.scanFullPage : undefined,
      adjustViewportToContent:
        typeof value.adjustViewportToContent === "boolean" ? value.adjustViewportToContent : undefined,
      scrollDelayMs: typeof value.scrollDelayMs === "number" ? value.scrollDelayMs : undefined,
      headless: typeof value.headless === "boolean" ? value.headless : undefined,
      enableUndetectedBrowser:
        typeof value.enableUndetectedBrowser === "boolean" ? value.enableUndetectedBrowser : undefined,
      enableStealthMode: typeof value.enableStealthMode === "boolean" ? value.enableStealthMode : undefined,
      useManagedBrowser: typeof value.useManagedBrowser === "boolean" ? value.useManagedBrowser : undefined,
      userDataDir: typeof value.userDataDir === "string" ? value.userDataDir : undefined,
      simulateUser: typeof value.simulateUser === "boolean" ? value.simulateUser : undefined,
      overrideNavigator: typeof value.overrideNavigator === "boolean" ? value.overrideNavigator : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      storageState: typeof value.storageState === "string" ? value.storageState : undefined,
      jsCode: this.parseStringArray(value.jsCode),
      jsOnly: typeof value.jsOnly === "boolean" ? value.jsOnly : undefined,
      waitForSelector: typeof value.waitForSelector === "string" ? value.waitForSelector : undefined,
      waitForScript: typeof value.waitForScript === "string" ? value.waitForScript : undefined,
      waitForTimeoutMs: typeof value.waitForTimeoutMs === "number" ? value.waitForTimeoutMs : undefined,
      waitUntil: this.parseWaitUntil(value.waitUntil),
      pageTimeoutMs: this.parseOptionalNumber(value.pageTimeoutMs),
      delayBeforeReturnHtmlMs: this.parseOptionalNumber(value.delayBeforeReturnHtmlMs),
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
        typeof value.tableScoreThreshold === "number" ? value.tableScoreThreshold : undefined,
      tableExtraction: this.parseTableExtraction(value.tableExtraction),
      cleanMarkdown: this.parseCleanMarkdownOptions(value.cleanMarkdown),
      scoreLinks: typeof value.scoreLinks === "boolean" ? value.scoreLinks : undefined,
      linkPreview: this.parseLinkPreviewOptions(value.linkPreview),
      browserHeaders: this.parseBrowserHeaders(value.browserHeaders),
      browserCookies: this.parseBrowserCookies(value.browserCookies),
      userAgent: typeof value.userAgent === "string" ? value.userAgent : undefined,
      userAgentMode: value.userAgentMode === "random" ? "random" : undefined,
      userAgentGenerator: this.parseUserAgentGenerator(value.userAgentGenerator),
      locale: typeof value.locale === "string" ? value.locale : undefined,
      timezoneId: typeof value.timezoneId === "string" ? value.timezoneId : undefined,
      geolocation: this.parseGeolocation(value.geolocation),
      wordCountThreshold: typeof value.wordCountThreshold === "number" ? value.wordCountThreshold : undefined,
      excludeExternalLinks:
        typeof value.excludeExternalLinks === "boolean" ? value.excludeExternalLinks : undefined,
      excludeExternalImages:
        typeof value.excludeExternalImages === "boolean" ? value.excludeExternalImages : undefined,
      removeOverlayElements:
        typeof value.removeOverlayElements === "boolean" ? value.removeOverlayElements : undefined,
      processIframes: typeof value.processIframes === "boolean" ? value.processIframes : undefined,
      cssSelector: typeof value.cssSelector === "string" ? value.cssSelector : undefined,
      excludedTags: this.coerceStringArray(value.excludedTags),
      textMode: typeof value.textMode === "boolean" ? value.textMode : undefined,
      captureScreenshot: typeof value.captureScreenshot === "boolean" ? value.captureScreenshot : undefined,
      virtualScroll: this.parseVirtualScrollConfig(value.virtualScroll),
      waitForImages: typeof value.waitForImages === "boolean" ? value.waitForImages : undefined,
      removeForms: typeof value.removeForms === "boolean" ? value.removeForms : undefined
    });
  }

  public normalizeOptions(options?: Partial<CrawlTaskOptions>): CrawlTaskOptions {
    const includeImages = options?.includeImages ?? (options?.storeMedia ? true : false);
    const virtualScroll = this.normalizeVirtualScrollConfig(options?.virtualScroll);
    const scanFullPage = virtualScroll ? false : (options?.scanFullPage ?? false);
    const adjustViewportToContent = options?.adjustViewportToContent ?? false;
    let scrollDelayMs: number | undefined;
    if (scanFullPage) {
      scrollDelayMs =
        typeof options?.scrollDelayMs === "number"
          ? this.clampScrollDelay(options.scrollDelayMs)
          : 200;
    }
    const headless = typeof options?.headless === "boolean" ? options.headless : undefined;
    const simulateUser =
      options?.simulateUser ??
      (options?.enableStealthMode ? true : false);
    const overrideNavigator =
      options?.overrideNavigator ??
      (options?.enableStealthMode ? true : false);
    const userDataDir = this.normalizeUserDataDir(options?.userDataDir);
    const useManagedBrowser = options?.useManagedBrowser ?? Boolean(userDataDir);
    const proxyConfig = this.normalizeProxyConfig(options?.proxyConfig);
    const proxyUrl = proxyConfig ? undefined : this.normalizeProxyUrl(options?.proxyUrl);
    const additionalUrls = this.normalizeUrlList(options?.additionalUrls);
    const multiUrlConfigs = this.normalizeMultiUrlConfigs(options?.multiUrlConfigs);
    const markdownOptions = this.normalizeMarkdownOptions(options?.markdownOptions);
    const markdownFilter = this.normalizeMarkdownFilter(options?.markdownFilter);
    const markdownStrategy = this.normalizeMarkdownStrategy(options?.markdownStrategy);
    const tableScoreThreshold = this.normalizeTableScore(options?.tableScoreThreshold);
    const tableExtraction = this.normalizeTableExtraction(options?.tableExtraction);
    const cleanMarkdown = this.normalizeCleanMarkdownOptions(options?.cleanMarkdown);
    const linkPreview = this.normalizeLinkPreviewOptions(options?.linkPreview);
    const scoreLinks = options?.scoreLinks ?? Boolean(linkPreview);
    const jsCode = this.normalizeScriptList(options?.jsCode);
    const waitForSelector = this.normalizeWaitForSelector(options?.waitForSelector);
    const waitForScript = this.normalizeWaitForScript(options?.waitForScript);
    const waitForTimeoutMs = this.normalizeWaitForTimeout(options?.waitForTimeoutMs);
    const waitUntil = this.normalizeWaitUntil(options?.waitUntil);
    const normalizedWaitForTimeoutMs =
      waitUntil === "networkidle" && typeof waitForTimeoutMs === "number"
        ? Math.max(5000, waitForTimeoutMs)
        : waitForTimeoutMs;
    const pageTimeoutMs = this.normalizePageTimeoutMs(options?.pageTimeoutMs);
    const delayBeforeReturnHtmlMs = this.normalizeDelayBeforeReturnHtmlMs(options?.delayBeforeReturnHtmlMs);
    const meanDelayMs = this.normalizeDelayJitterMs(options?.meanDelayMs);
    const maxDelayRangeMs = this.normalizeDelayJitterMs(options?.maxDelayRangeMs);
    const semaphoreCount = this.normalizeSemaphoreCount(options?.semaphoreCount);
    const sessionId = this.normalizeSessionId(options?.sessionId);
    const storageState = this.normalizeStorageState(options?.storageState);
    const browserHeaders = this.normalizeBrowserHeaders(options?.browserHeaders);
    const browserCookies = this.normalizeBrowserCookies(options?.browserCookies);
    const userAgent = this.normalizeUserAgent(options?.userAgent);
    const userAgentMode = this.normalizeUserAgentMode(options?.userAgentMode);
    const userAgentGenerator = this.normalizeUserAgentGenerator(options?.userAgentGenerator);
    const locale = this.normalizeLocale(options?.locale);
    const timezoneId = this.normalizeTimezone(options?.timezoneId);
    const geolocation = this.normalizeGeolocation(options?.geolocation);
    const wordCountThreshold = this.normalizeWordCountThreshold(
      options?.wordCountThreshold ?? 80
    );
    const excludeExternalLinks = options?.excludeExternalLinks ?? true;
    const excludeExternalImages = options?.excludeExternalImages ?? (options?.storeMedia ? false : true);
    const removeOverlayElements = options?.removeOverlayElements ?? true;
    const processIframes = options?.processIframes ?? true;
    const textMode = options?.textMode ?? false;
    const captureScreenshot = options?.captureScreenshot ?? false;
    const cssSelector = this.normalizeCssSelector(options?.cssSelector);
    const excludedTags = this.normalizeSelectorList(options?.excludedTags);
    const waitForImages = options?.waitForImages ?? (options?.storeMedia ? true : false);
    const removeForms = options?.removeForms ?? false;

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
      enableStealthMode: options?.enableStealthMode ?? false,
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
      removeForms
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
    return translateLocalhostProxyUrlForCrawl4ai(trimmed, this.env.crawl4aiConfig.baseUrl);
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

  private normalizeProxyConfig(value?: CrawlProxyConfig | null): CrawlProxyConfig | undefined {
    if (!value) {
      return undefined;
    }
    const server = typeof value.server === "string" ? value.server.trim() : "";
    if (!server) {
      return undefined;
    }
    const normalizedServer = translateLocalhostProxyUrlForCrawl4ai(server, this.env.crawl4aiConfig.baseUrl);
    const username = typeof value.username === "string" ? value.username.trim() : "";
    const password = typeof value.password === "string" ? value.password.trim() : "";
    return {
      server: normalizedServer,
      username: username.length > 0 ? username : undefined,
      password: password.length > 0 ? password : undefined
    };
  }

  private parseProxyConfig(value: unknown): CrawlProxyConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const server = typeof record.server === "string" ? record.server : undefined;
    if (!server) {
      return undefined;
    }
    return this.normalizeProxyConfig({
      server,
      username: typeof record.username === "string" ? record.username : undefined,
      password: typeof record.password === "string" ? record.password : undefined
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

  private normalizeMultiUrlConfigs(configs?: CrawlMultiUrlConfig[] | null): CrawlMultiUrlConfig[] | undefined {
    if (!configs || configs.length === 0) {
      return undefined;
    }
    const normalized = configs
      .map((config) => this.normalizeMultiUrlConfig(config))
      .filter((entry): entry is CrawlMultiUrlConfig => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeMultiUrlConfig(config?: CrawlMultiUrlConfig | null): CrawlMultiUrlConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const name = typeof config.name === "string" ? config.name.trim() : undefined;
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
      options
    };
  }

  private normalizeMatcher(matcher?: CrawlUrlMatcher | null): CrawlUrlMatcher | undefined {
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
      patterns: patterns
    };
  }

  private normalizeStrategyOverrides(
    overrides?: CrawlStrategyOverrides | null
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
    if (typeof overrides.scrollDelayMs === "number" && overrides.scanFullPage === true) {
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
    const waitForSelector = this.normalizeWaitForSelector(overrides.waitForSelector);
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
    const waitForTimeoutMs = this.normalizeWaitForTimeout(overrides.waitForTimeoutMs);
    if (waitForTimeoutMs !== undefined) {
      normalized.waitForTimeoutMs =
        waitUntil === "networkidle" ? Math.max(5000, waitForTimeoutMs) : waitForTimeoutMs;
    }
    const pageTimeoutMs = this.normalizePageTimeoutMs(overrides.pageTimeoutMs);
    if (pageTimeoutMs !== undefined) {
      normalized.pageTimeoutMs = pageTimeoutMs;
    }
    const delayBeforeReturnHtmlMs = this.normalizeDelayBeforeReturnHtmlMs(overrides.delayBeforeReturnHtmlMs);
    if (delayBeforeReturnHtmlMs !== undefined) {
      normalized.delayBeforeReturnHtmlMs = delayBeforeReturnHtmlMs;
    }
    const meanDelayMs = this.normalizeDelayJitterMs(overrides.meanDelayMs);
    if (meanDelayMs !== undefined) {
      normalized.meanDelayMs = meanDelayMs;
    }
    const maxDelayRangeMs = this.normalizeDelayJitterMs(overrides.maxDelayRangeMs);
    if (maxDelayRangeMs !== undefined) {
      normalized.maxDelayRangeMs = maxDelayRangeMs;
    }
    const semaphoreCount = this.normalizeSemaphoreCount(overrides.semaphoreCount);
    if (semaphoreCount !== undefined) {
      normalized.semaphoreCount = semaphoreCount;
    }
    if (typeof overrides.removeForms === "boolean") {
      normalized.removeForms = overrides.removeForms;
    }
    const wordCountThreshold = this.normalizeWordCountThreshold(overrides.wordCountThreshold);
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
    const virtualScroll = this.normalizeVirtualScrollConfig(overrides.virtualScroll);
    if (virtualScroll) {
      normalized.virtualScroll = virtualScroll;
      if (normalized.scanFullPage === true) {
        normalized.scanFullPage = false;
        delete normalized.scrollDelayMs;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private parseCleanMarkdownOptions(value: unknown): CrawlCleanMarkdownOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeCleanMarkdownOptions({
      cssSelector: typeof record.cssSelector === "string" ? record.cssSelector : undefined,
      targetElements: this.coerceStringArray(record.targetElements),
      excludedTags: this.coerceStringArray(record.excludedTags),
      removeOverlayElements:
        typeof record.removeOverlayElements === "boolean" ? record.removeOverlayElements : undefined,
      wordCountThreshold:
        typeof record.wordCountThreshold === "number" ? record.wordCountThreshold : undefined
    });
  }

  private normalizeMarkdownOptions(
    options?: CrawlMarkdownOptions | null
  ): CrawlMarkdownOptions | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlMarkdownOptions = {};
    if (
      options.contentSource &&
      ["raw_html", "cleaned_html", "fit_html"].includes(options.contentSource)
    ) {
      normalized.contentSource = options.contentSource as CrawlMarkdownContentSource;
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
    if (typeof options.bodyWidth === "number" && Number.isFinite(options.bodyWidth)) {
      const clamped = Math.max(40, Math.min(200, Math.round(options.bodyWidth)));
      normalized.bodyWidth = clamped;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeCleanMarkdownOptions(
    options?: CrawlCleanMarkdownOptions | null
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
    if (typeof options.wordCountThreshold === "number" && Number.isFinite(options.wordCountThreshold)) {
      const clamped = Math.max(0, Math.min(2000, Math.round(options.wordCountThreshold)));
      normalized.wordCountThreshold = clamped;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private normalizeSelectorList(values?: string[] | null): string[] | undefined {
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
    config?: CrawlVirtualScrollConfig | null
  ): CrawlVirtualScrollConfig | undefined {
    if (!config || typeof config !== "object") {
      return undefined;
    }
    const containerSelectorInput =
      (config as Record<string, unknown>).containerSelector ?? config.containerSelector;
    const containerSelector = this.normalizeCssSelector(
      typeof containerSelectorInput === "string" ? containerSelectorInput : undefined
    );
    const scrollCount =
      typeof config.scrollCount === "number" && Number.isFinite(config.scrollCount)
        ? Math.max(1, Math.min(1000, Math.round(config.scrollCount)))
        : undefined;
    const scrollByRaw = (config as Record<string, unknown>).scrollBy ?? config.scrollBy;
    const scrollByPixelsRaw = (config as Record<string, unknown>).scrollByPixels;
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
          typeof scrollByPixelsRaw === "number" && Number.isFinite(scrollByPixelsRaw)
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
      typeof config.waitAfterScrollMs === "number" && Number.isFinite(config.waitAfterScrollMs)
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
      waitAfterScrollMs
    };
  }

  private normalizeMarkdownFilter(filter?: CrawlMarkdownFilter | null): CrawlMarkdownFilter | undefined {
    if (!filter) {
      return undefined;
    }
    if (filter.type === "pruning") {
      const normalized: CrawlMarkdownFilter = { type: "pruning" };
      if (typeof filter.threshold === "number" && Number.isFinite(filter.threshold)) {
        normalized.threshold = Math.max(0, Math.min(1, filter.threshold));
      }
      if (filter.thresholdType === "fixed" || filter.thresholdType === "dynamic") {
        normalized.thresholdType = filter.thresholdType;
      }
      if (typeof filter.minWordThreshold === "number" && Number.isFinite(filter.minWordThreshold)) {
        const clamped = Math.max(0, Math.min(500, Math.round(filter.minWordThreshold)));
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
      if (typeof filter.bm25Threshold === "number" && Number.isFinite(filter.bm25Threshold)) {
        normalized.bm25Threshold = Number(Math.max(0, Math.min(20, filter.bm25Threshold)).toFixed(2));
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
    strategy?: CrawlMarkdownStrategy | null
  ): CrawlMarkdownStrategy | undefined {
    if (!strategy || typeof strategy.type !== "string") {
      return undefined;
    }
    const trimmed = strategy.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const normalized: CrawlMarkdownStrategy = {
      type: trimmed.slice(0, 128)
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
    strategy?: CrawlTableExtractionStrategy | null
  ): CrawlTableExtractionStrategy | undefined {
    if (!strategy || typeof strategy.type !== "string") {
      return undefined;
    }
    const trimmed = strategy.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const normalized: CrawlTableExtractionStrategy = {
      type: trimmed.slice(0, 128)
    };
    const params = this.normalizeStrategyParams(strategy.params);
    if (params) {
      normalized.params = params;
    }
    return normalized;
  }

  private normalizeStrategyParams(
    params?: Record<string, unknown> | null
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

  private parseMarkdownStrategy(value: unknown): CrawlMarkdownStrategy | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const params =
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    return this.normalizeMarkdownStrategy(
      type
        ? {
            type,
            params
          }
        : undefined
    );
  }

  private parseTableExtraction(value: unknown): CrawlTableExtractionStrategy | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const params =
      record.params && typeof record.params === "object" && !Array.isArray(record.params)
        ? (record.params as Record<string, unknown>)
        : undefined;
    return this.normalizeTableExtraction(
      type
        ? {
            type,
            params
        }
        : undefined
    );
  }

  private parseVirtualScrollConfig(value: unknown): CrawlVirtualScrollConfig | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const scrollBy =
      typeof record.scrollBy === "string" || typeof record.scrollBy === "number"
        ? record.scrollBy
        : undefined;
    const scrollByPixels =
      typeof record.scrollByPixels === "number" ? record.scrollByPixels : undefined;
    return this.normalizeVirtualScrollConfig({
      containerSelector: typeof record.containerSelector === "string" ? record.containerSelector : undefined,
      scrollCount: typeof record.scrollCount === "number" ? record.scrollCount : undefined,
      scrollBy: scrollBy as CrawlVirtualScrollConfig["scrollBy"],
      scrollByPixels,
      waitAfterScrollMs: typeof record.waitAfterScrollMs === "number" ? record.waitAfterScrollMs : undefined
    } as CrawlVirtualScrollConfig & { scrollByPixels?: number });
  }

  private normalizeLinkPreviewOptions(
    options?: CrawlLinkPreviewOptions | null
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
    if (typeof options.maxLinks === "number" && Number.isFinite(options.maxLinks)) {
      normalized.maxLinks = Math.max(1, Math.min(500, Math.round(options.maxLinks)));
    }
    if (typeof options.concurrency === "number" && Number.isFinite(options.concurrency)) {
      normalized.concurrency = Math.max(1, Math.min(50, Math.round(options.concurrency)));
    }
    if (typeof options.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)) {
      normalized.timeoutSeconds = Math.max(1, Math.min(60, Math.round(options.timeoutSeconds)));
    }
    if (typeof options.query === "string") {
      const trimmed = options.query.trim();
      if (trimmed.length > 0 && trimmed.length <= 160) {
        normalized.query = trimmed;
      }
    }
    if (typeof options.scoreThreshold === "number" && Number.isFinite(options.scoreThreshold)) {
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

  private normalizeBrowserHeaders(headers?: CrawlBrowserHeader[] | null): CrawlBrowserHeader[] | undefined {
    if (!headers || headers.length === 0) {
      return undefined;
    }
    const normalized = headers
      .map((header) => {
        if (!header || typeof header !== "object") {
          return undefined;
        }
        const name = typeof header.name === "string" ? header.name.trim() : "";
        const value = typeof header.value === "string" ? header.value.trim() : "";
        if (!name || !value) {
          return undefined;
        }
        return {
          name: name.slice(0, 128),
          value: value.slice(0, 512)
        };
      })
      .filter((entry): entry is CrawlBrowserHeader => Boolean(entry));
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

  private normalizeBrowserCookies(cookies?: CrawlBrowserCookie[] | null): CrawlBrowserCookie[] | undefined {
    if (!cookies || cookies.length === 0) {
      return undefined;
    }
    const normalized = cookies
      .map((cookie) => {
        if (!cookie || typeof cookie !== "object") {
          return undefined;
        }
        const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
        const value = typeof cookie.value === "string" ? cookie.value.trim() : "";
        const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
        const path = typeof cookie.path === "string" ? cookie.path.trim() : "";
        if (!name || !value || !domain) {
          return undefined;
        }
        return {
          name: name.slice(0, 128),
          value: value.slice(0, 4000),
          domain: domain.slice(0, 255),
          path: path ? path.slice(0, 255) : undefined
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
    config?: CrawlUserAgentGeneratorConfig | null
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

  private normalizeGeolocation(value?: CrawlGeolocationConfig | null): CrawlGeolocationConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const latitude = typeof value.latitude === "number" && Number.isFinite(value.latitude) ? value.latitude : undefined;
    const longitude =
      typeof value.longitude === "number" && Number.isFinite(value.longitude) ? value.longitude : undefined;
    if (latitude === undefined || longitude === undefined) {
      return undefined;
    }
    const normalized: CrawlGeolocationConfig = {
      latitude: Math.max(-90, Math.min(90, latitude)),
      longitude: Math.max(-180, Math.min(180, longitude))
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
      value.map((entry) => (typeof entry === "string" ? entry : "")).filter((entry): entry is string => Boolean(entry))
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
      value.map((entry) => (typeof entry === "string" ? entry : "")).filter((entry): entry is string => Boolean(entry))
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

  private parseMultiUrlConfigs(value: unknown): CrawlMultiUrlConfig[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeMultiUrlConfigs(
      value
        .map((entry) => (entry && typeof entry === "object" ? (entry as CrawlMultiUrlConfig) : undefined))
        .filter((entry): entry is CrawlMultiUrlConfig => Boolean(entry))
    );
  }

  private parseMarkdownOptions(value: unknown): CrawlMarkdownOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeMarkdownOptions({
      contentSource: typeof record.contentSource === "string" ? (record.contentSource as CrawlMarkdownContentSource) : undefined,
      ignoreLinks: typeof record.ignoreLinks === "boolean" ? record.ignoreLinks : undefined,
      escapeHtml: typeof record.escapeHtml === "boolean" ? record.escapeHtml : undefined,
      citations: typeof record.citations === "boolean" ? record.citations : undefined,
      bodyWidth: typeof record.bodyWidth === "number" ? record.bodyWidth : undefined
    });
  }

  private parseMarkdownFilter(value: unknown): CrawlMarkdownFilter | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const rawType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
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
        language: rawLanguage
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
      threshold: typeof record.threshold === "number" ? record.threshold : undefined,
      thresholdType:
        rawThresholdType === "fixed" || rawThresholdType === "dynamic" ? (rawThresholdType as "fixed" | "dynamic") : undefined,
      minWordThreshold: typeof rawMinWords === "number" ? rawMinWords : undefined
    });
  }

  private parseBrowserHeaders(value: unknown): CrawlBrowserHeader[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeBrowserHeaders(
      value
        .map((entry) => (typeof entry === "object" && entry ? (entry as CrawlBrowserHeader) : undefined))
        .filter((entry): entry is CrawlBrowserHeader => Boolean(entry))
    );
  }

  private parseBrowserCookies(value: unknown): CrawlBrowserCookie[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return this.normalizeBrowserCookies(
      value
        .map((entry) => (typeof entry === "object" && entry ? (entry as CrawlBrowserCookie) : undefined))
        .filter((entry): entry is CrawlBrowserCookie => Boolean(entry))
    );
  }

  private parseUserAgentGenerator(value: unknown): CrawlUserAgentGeneratorConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return this.normalizeUserAgentGenerator(value as CrawlUserAgentGeneratorConfig);
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

  private normalizeWaitForSelector(selector?: string | null): string | undefined {
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

  private normalizeWaitUntil(value?: string | null): CrawlTaskOptions["waitUntil"] {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "domcontentloaded" || trimmed === "load" || trimmed === "networkidle" || trimmed === "commit") {
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

  private normalizeDelayBeforeReturnHtmlMs(value?: number | null): number | undefined {
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

  private parseLinkPreviewOptions(value: unknown): CrawlLinkPreviewOptions | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return this.normalizeLinkPreviewOptions({
      includeInternal: typeof record.includeInternal === "boolean" ? record.includeInternal : undefined,
      includeExternal: typeof record.includeExternal === "boolean" ? record.includeExternal : undefined,
      includeSocial: typeof record.includeSocial === "boolean" ? record.includeSocial : undefined,
      maxLinks: typeof record.maxLinks === "number" ? record.maxLinks : undefined,
      concurrency: typeof record.concurrency === "number" ? record.concurrency : undefined,
      timeoutSeconds: typeof record.timeoutSeconds === "number" ? record.timeoutSeconds : undefined,
      query: typeof record.query === "string" ? record.query : undefined,
      scoreThreshold: typeof record.scoreThreshold === "number" ? record.scoreThreshold : undefined,
      verbose: typeof record.verbose === "boolean" ? record.verbose : undefined,
      includePatterns: Array.isArray(record.includePatterns)
        ? (record.includePatterns as unknown[]).map((entry) => (typeof entry === "string" ? entry : "")).filter(Boolean)
        : undefined,
      excludePatterns: Array.isArray(record.excludePatterns)
        ? (record.excludePatterns as unknown[]).map((entry) => (typeof entry === "string" ? entry : "")).filter(Boolean)
        : undefined
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
    return Array.from(new Set(accumulator.filter((entry) => typeof entry === "string" && entry.length > 0)));
  }
  private extractMemoryStats(response: Crawl4aiResponse): CrawlMemoryStats | undefined {
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
      efficiencyPercent: response.memoryEfficiency
    };
  }

  private partitionCrawlerResults(items?: Crawl4aiArticle[]) {
    const successes: Crawl4aiArticle[] = [];
    const failures: CrawlFailureDetail[] = [];

    if (!items || items.length === 0) {
      return { successes, failures };
    }

    for (const item of items) {
      if (this.isResultSuccessful(item)) {
        successes.push(item);
      } else {
        failures.push(this.buildFailureDetail(item));
      }
    }

    return { successes, failures };
  }

  private isResultSuccessful(item: Crawl4aiArticle): boolean {
    const markdownResult = this.resultService.extractMarkdownResult(item.markdown);
    const markdownPrimary = markdownResult.primary;
    const hasMarkdown =
      typeof markdownPrimary === "string" ? markdownPrimary.trim().length > 0 : false;
    const statusCode = this.extractStatusCode(item);
    const isChallengePage =
      typeof markdownPrimary === "string" && this.resultService.isLikelyBotChallengeMarkdown(markdownPrimary);

    if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= 400) {
      return false;
    }

    if (isChallengePage) {
      return false;
    }

    if (typeof item.success === "boolean") {
      return item.success && hasMarkdown;
    }
    const inlineSuccess = this.pickBoolean(item as Record<string, unknown>, [
      "success",
      "isSuccess",
      "ok"
    ]);
    if (typeof inlineSuccess === "boolean") {
      return inlineSuccess && hasMarkdown;
    }
    const metadataSuccess = this.pickBoolean(item.metadata as Record<string, unknown> | undefined, [
      "success",
      "isSuccess",
      "ok"
    ]);
    if (typeof metadataSuccess === "boolean") {
      return metadataSuccess && hasMarkdown;
    }
    return hasMarkdown;
  }

  private buildFailureDetail(item: Crawl4aiArticle): CrawlFailureDetail {
    const statusCode = this.extractStatusCode(item);
    const errorMessage = this.extractErrorMessage(item);
    const markdownResult = this.resultService.extractMarkdownResult(item.markdown);
    const markdownPrimary = markdownResult.primary;
    const hasMarkdown =
      typeof markdownPrimary === "string" ? markdownPrimary.trim().length > 0 : false;
    const isChallengePage =
      typeof markdownPrimary === "string" && this.resultService.isLikelyBotChallengeMarkdown(markdownPrimary);
    const fallbackMessage = this.buildDefaultFailureMessage(hasMarkdown, statusCode, isChallengePage);
    return {
      url: item.url ?? this.pickString(item.metadata as Record<string, unknown> | undefined, ["url"]),
      statusCode,
      error: errorMessage ?? fallbackMessage,
      retryable: this.isRetryableStatus(statusCode, errorMessage ?? fallbackMessage)
    };
  }

  private buildDefaultFailureMessage(
    hasMarkdown: boolean,
    statusCode?: number,
    isChallengePage = false
  ): string {
    if (isChallengePage) {
      if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
        return `crawl4ai received HTTP ${statusCode} and captured an anti-bot verification page instead of article content.`;
      }
      return "crawl4ai captured an anti-bot verification page instead of article content.";
    }

    if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= 400) {
      if (statusCode === 401 || statusCode === 403) {
        return `crawl4ai received HTTP ${statusCode}; target may be blocked by anti-bot or require verification/login.`;
      }
      return `crawl4ai received HTTP ${statusCode} from target URL.`;
    }

    if (hasMarkdown) {
      return "Unknown crawl error";
    }

    return "crawl4ai returned an empty markdown result. Check wordCountThreshold/cssSelector/cleanMarkdown and pruning settings.";
  }

  private extractStatusCode(item: Crawl4aiArticle): number | undefined {
    return (
      this.pickNumber(item as Record<string, unknown>, ["statusCode", "status_code"]) ??
      this.pickNumber(item.metadata as Record<string, unknown> | undefined, [
        "statusCode",
        "status_code",
        "status"
      ])
    );
  }

  private extractErrorMessage(item: Crawl4aiArticle): string | undefined {
    return (
      this.pickString(item as Record<string, unknown>, ["error", "errorMessage", "error_message"]) ??
      this.pickString(item.metadata as Record<string, unknown> | undefined, ["error", "error_message", "message"])
    );
  }

  private isRetryableStatus(statusCode?: number, errorMessage?: string): boolean {
    if (statusCode && this.retryableStatusCodes.has(statusCode)) {
      return true;
    }
    if (!errorMessage) {
      return false;
    }
    const normalized = errorMessage.toLowerCase();
    return ["timeout", "temporarily", "rate limit", "connection reset", "connection refused"].some((needle) =>
      normalized.includes(needle)
    );
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

  private extractPipelineSourceId(config: Prisma.JsonValue | null): string | null {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return null;
    }
    const record = config as Record<string, unknown>;
    const directSourceIdRaw = record.sourceId;
    const directSourceId = typeof directSourceIdRaw === "string" ? directSourceIdRaw.trim() : "";
    if (directSourceId) {
      return directSourceId;
    }

    const itemPayload = record.itemPayload;
    if (!itemPayload || typeof itemPayload !== "object" || Array.isArray(itemPayload)) {
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

  private computeExponentialBackoffDelayMs(baseDelayMs: number, attempt: number, maxDelayMs: number) {
    const normalizedAttempt = Math.max(1, Math.floor(attempt));
    const exponential = baseDelayMs * 2 ** Math.max(0, normalizedAttempt - 1);
    const capped = Math.min(exponential, maxDelayMs);
    const jitterFactor = 0.75 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
  }

  private async markSourceFailureState(options: { sourceId: string; failureAt: Date }) {
    const cfg = this.env.newsSourceSchedulerConfig;
    const threshold = Math.max(0, Math.floor(cfg.circuitBreakerThreshold));
    const autoDisableThresholdRaw = cfg.autoDisableThreshold;
    const autoDisableThreshold = Number.isFinite(autoDisableThresholdRaw)
      ? Math.max(0, Math.floor(autoDisableThresholdRaw))
      : 0;

    const { notifyCircuitOpen, notifyAutoDisable } = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.newsSource.findUnique({
        where: { id: options.sourceId },
        select: { consecutiveFailures: true, isActive: true, orgId: true, name: true },
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
        circuitOpenUntil = new Date(options.failureAt.getTime() + circuitDelayMs);
      }

      let notifyCircuitOpen: { orgId: string; name: string; circuitOpenUntil: Date } | null = null;
      if (threshold > 0 && consecutiveFailures === threshold && circuitOpenUntil) {
        notifyCircuitOpen = {
          orgId: existing.orgId,
          name: existing.name,
          circuitOpenUntil
        };
      }

      const nextRunAt =
        circuitOpenUntil && circuitOpenUntil.getTime() > retryAt.getTime()
          ? circuitOpenUntil
          : retryAt;

      const shouldDisable = autoDisableThreshold > 0 && consecutiveFailures >= autoDisableThreshold;
      let notifyAutoDisable: { orgId: string; name: string; failures: number } | null = null;
      if (shouldDisable && consecutiveFailures === autoDisableThreshold) {
        notifyAutoDisable = {
          orgId: existing.orgId,
          name: existing.name,
          failures: consecutiveFailures
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
            consecutiveFailures: threshold,
            circuitOpenUntil: notifyCircuitOpen.circuitOpenUntil.toISOString()
          }
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
            consecutiveFailures: notifyAutoDisable.failures
          }
        });
      } catch (error) {
        logger.warn(
          { error, sourceId: options.sourceId, orgId: notifyAutoDisable.orgId },
          "Failed to notify auto-disable for news source",
        );
      }
    }
  }

  private pickNumber(source: Record<string, unknown> | undefined, keys: string[]): number | undefined {
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

  private pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
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

  private pickBoolean(source: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
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
