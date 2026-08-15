import { Injectable } from "@nestjs/common";
import type { CrawlTask } from "@prisma/client";

import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { CrawlAntiBotService } from "./crawl-anti-bot.service";
import { CrawlExecutionResultsService } from "./crawl-execution-results.service";
import {
  getRootDomain,
  hasBlockedDetailPathSegments,
  isLikelyDetailArticleUrl,
  isLikelyPathCategoryToken,
  normalizeComparableUrl,
  pickString,
  urlMatchesAnyPattern,
} from "./crawl-execution.helpers";
import type {
  CandidatePublishSignal,
  DetailCandidateDiagnostics,
} from "./crawl-execution.types";
import { CrawlOptionsNormalizerService } from "./crawl-options-normalizer.service";
import { normalizePatternList } from "./crawl-options.helpers";
import { CrawlPublishSignalService } from "./crawl-publish-signal.service";
import {
  CrawlQualityStrategyService,
  type CrawlArticleSignal,
} from "./crawl-quality.strategy";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import type {
  CrawlFailureDetail,
  CrawlMarkdownContentSource,
  CrawlQualityProfile,
  CrawlTaskOptions,
} from "./crawl.types";
import type {
  Crawl4aiArticle,
  Crawl4aiLink,
  Crawl4aiRequest,
} from "./crawl4ai.client";

@Injectable()
export class CrawlDetailExpansionService {
  constructor(
    private readonly qualityStrategy: CrawlQualityStrategyService,
    private readonly resultService: CrawlResultService,
    private readonly antiBot: CrawlAntiBotService,
    private readonly publishSignal: CrawlPublishSignalService,
    private readonly optionsNormalizer: CrawlOptionsNormalizerService,
    private readonly executionResults: CrawlExecutionResultsService,
  ) {}

  async expandListLikeResultsIfNeeded(options: {
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
        .map((entry) => normalizeComparableUrl(entry.url))
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
        const nextScore = this.publishSignal.scoreDetailCandidateUrl(candidate, baseUrl);
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
          this.publishSignal.scoreDetailCandidateUrl(candidate, baseUrl) - 120;
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
    const minCandidateScore = this.publishSignal.detailRelevanceToScore(
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
    const publishSignalTopK = this.publishSignal.resolvePublishSignalTopK(
      candidateLimit,
      detailExpansion.maxDetailUrls,
      sortedPublishSignalPool.length,
    );
    const publishSignalSettings =
      await this.publishSignal.getPublishSignalEnrichmentSettings();
    const publishSignalEnrichment = await this.publishSignal.enrichCandidatePublishSignals({
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
        this.publishSignal.resolveCandidatePublishSignal(
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
        this.publishSignal.estimatePublishTimeConfidenceFromCandidateUrl(url);
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
          this.publishSignal.estimatePublishTimeConfidenceFromCandidateUrl(url);
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
    const publishConfidenceBuckets = this.publishSignal.buildDetailCandidateConfidenceBuckets(
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
      await writeTaskLogBestEffort({
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
        const batchRun = await this.antiBot.runCrawlWithHeadedFallback({
          request: batchRequest,
          options: detailOptions,
          requestTimeoutMs: options.requestTimeoutMs,
          taskId: options.taskId,
          orgId: options.orgId,
          stage: "expansion",
          reason: `detail_batch_${index + 1}`,
        });
        const batchResponse = batchRun.response;
        const partition = this.executionResults.partitionCrawlerResults(batchResponse.results);
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
            retryable: this.executionResults.isRetryableStatus(undefined, errorMessage),
          });
        }
      }
    }

    const improvedByUrl = new Map<
      string,
      {
        article: Crawl4aiArticle;
        quality: ReturnType<
          CrawlQualityStrategyService["assessArticleMarkdownSignal"]
        >;
      }
    >();

    for (const article of expansionSuccesses) {
      const quality = this.assessArticleMarkdownSignal(article);
      const articleUrl = article.url ?? "";
      if (
        !isLikelyDetailArticleUrl(
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

      const normalizedArticleUrl = normalizeComparableUrl(article.url);
      const selectedByExpansionCandidates = normalizedArticleUrl
        ? selectedCandidateSet.has(normalizedArticleUrl)
        : false;
      const detailScore = this.publishSignal.scoreDetailCandidateUrl(
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
        normalizeComparableUrl(article.url) ??
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

    await writeTaskLogBestEffort({
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
        .map((entry) => normalizeComparableUrl(entry.url))
        .filter((entry): entry is string => Boolean(entry)),
    );

    const dedupedImprovedSuccesses = improvedSuccesses.filter((entry) => {
      const comparable = normalizeComparableUrl(entry.url);
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

    const normalized = this.optionsNormalizer.normalizeOptions({
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
        pickString(metadata, [
          "url",
          "sourceUrl",
          "source_url",
          "canonical",
          "canonicalUrl",
          "canonical_url",
        ]),
        pickString(metadata, [
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
          pickString(record, [
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
        !isLikelyDetailArticleUrl(
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
        this.publishSignal.estimatePublishTimeConfidenceFromCandidateUrl(normalized);
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
          this.publishSignal.scoreDetailCandidateUrl(normalized, baseUrl) - precheckPenalty,
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
          this.publishSignal.estimatePublishTimeConfidenceFromCandidateUrl(normalized);
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
        const linkText = pickString(record, ["text", "title"]);
        const textBonus = this.scoreFallbackLinkText(linkText);
        const score =
          this.publishSignal.scoreDetailCandidateUrl(normalized, baseUrl) +
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
      isLikelyDetailArticleUrl(
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
        getRootDomain(parsed.hostname) ===
        getRootDomain(base.hostname);
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
      if (hasBlockedDetailPathSegments(segmentsLower)) {
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
        !isLikelyPathCategoryToken(lastSegmentLower)
      ) {
        return true;
      }
      if (
        segments.length >= 2 &&
        lastSegment.length >= 12 &&
        /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
        !isLikelyPathCategoryToken(lastSegmentLower)
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
    const metadataUrl = pickString(
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
      return normalizeComparableUrl(parsed.toString());
    } catch {
      return undefined;
    }
  }

  private applyDetailExpansionPatternFilters(
    url: string,
    excludeUrlPatterns?: string[],
    includeUrlPatterns?: string[],
    diagnostics?: DetailCandidateDiagnostics,
  ): boolean {
    const normalizedExclude =
      normalizePatternList(excludeUrlPatterns) ?? [];
    const normalizedInclude =
      normalizePatternList(includeUrlPatterns) ?? [];

    if (
      normalizedInclude.length > 0 &&
      !urlMatchesAnyPattern(url, normalizedInclude)
    ) {
      if (diagnostics) {
        diagnostics.includePatternRejected += 1;
      }
      return false;
    }
    if (
      normalizedExclude.length > 0 &&
      urlMatchesAnyPattern(url, normalizedExclude)
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
}
