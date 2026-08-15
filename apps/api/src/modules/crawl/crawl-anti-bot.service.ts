import { Injectable } from "@nestjs/common";
import type { CrawlTask } from "@prisma/client";

import { writeTaskLogBestEffort } from "../observability/task-log.writer";

import { CrawlExecutionResultsService } from "./crawl-execution-results.service";
import {
  BLOCKED_DETAIL_PATH_SEGMENTS,
  isLikelyDetailArticleUrl,
  normalizeComparableUrl,
  sleep,
} from "./crawl-execution.helpers";
import type { CrawlRetryCandidate, CrawlRetryResult } from "./crawl-execution.types";
import { CrawlOptionsNormalizerService } from "./crawl-options-normalizer.service";
import { CrawlQualityStrategyService } from "./crawl-quality.strategy";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
import type {
  CrawlFailureDetail,
  CrawlPageTypeHint,
  CrawlTaskOptions,
} from "./crawl.types";
import {
  Crawl4aiClient,
  type Crawl4aiArticle,
  type Crawl4aiRequest,
  type Crawl4aiResponse,
} from "./crawl4ai.client";
import { Crawl4aiRequestException } from "./crawl4ai.exception";

@Injectable()
export class CrawlAntiBotService {
  private readonly antiBotRetryAttempts = 3;
  private readonly antiBotWarmupUrlLimit = 4;

  constructor(
    private readonly crawlClient: Crawl4aiClient,
    private readonly qualityStrategy: CrawlQualityStrategyService,
    private readonly optionsNormalizer: CrawlOptionsNormalizerService,
    private readonly executionResults: CrawlExecutionResultsService,
  ) {}

  async runCrawlWithHeadedFallback(options: {
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

      const fallbackOptions = this.optionsNormalizer.normalizeOptions({
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

  extractCrawlErrorMessage(error: unknown): string | undefined {
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

  shouldAttemptEmptyMarkdownFallback(
    successes: Crawl4aiArticle[],
    failures: CrawlFailureDetail[],
  ) {
    return (
      successes.length === 0 &&
      failures.length > 0 &&
      failures.every((failure) => this.isEmptyMarkdownFailure(failure))
    );
  }

  async retryForBotChallengeIfNeeded(options: {
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
        const retryPayload = this.optionsNormalizer.buildRequestPayload(
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
        const partition = this.executionResults.partitionCrawlerResults(retryResponse.results);
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
          await sleep(this.resolveAntiBotAttemptDelayMs(attempt));
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
          await sleep(this.resolveAntiBotAttemptDelayMs(attempt));
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
    await writeTaskLogBestEffort({
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

    return this.optionsNormalizer.normalizeOptions({
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

    return this.optionsNormalizer.normalizeOptions({
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

    const warmupOptions = this.optionsNormalizer.normalizeOptions({
      ...options.options,
      cacheMode: "bypass",
      waitForScript: undefined,
      waitForSelector: "main",
      pageTypeHint: "list",
    });

    try {
      const warmupPayload = this.optionsNormalizer.buildRequestPayloadWithUrls(
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
      const partition = this.executionResults.partitionCrawlerResults(warmupResponse.results);
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
      normalizeComparableUrl(targetUrl) ?? targetUrl;
    if (
      isLikelyDetailArticleUrl(
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
      const targetNormalized = normalizeComparableUrl(parsed.toString());
      const segments = parsed.pathname
        .replace(/\/+$/, "")
        .split("/")
        .filter((entry) => entry.length > 0);
      const candidates: string[] = [];
      const addCandidate = (value: string) => {
        const normalized = normalizeComparableUrl(value);
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
    if (BLOCKED_DETAIL_PATH_SEGMENTS.has(normalized)) {
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

  buildEmptyMarkdownFallbackProfiles(options: CrawlTaskOptions): {
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

    const rawRelaxedOptions = this.optionsNormalizer.normalizeOptions({
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

    const cleanedBalancedOptions = this.optionsNormalizer.normalizeOptions({
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
        options: this.optionsNormalizer.normalizeOptions({
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
      const bm25FocusedOptions = this.optionsNormalizer.normalizeOptions({
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

  scoreMarkdownQuality(successes: Crawl4aiArticle[]): number {
    return this.qualityStrategy.scoreMarkdownQuality(successes);
  }
}
