import { TaskLogModel } from "@modular/mongo";
import { createLogger } from "@modular/utils";
import { Injectable } from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";
import { NotificationType } from "@prisma/client";

import { toPrismaJsonValue } from "../../common/prisma-json";
import { EnvService } from "../config/config.service";
import { PrismaService } from "../config/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

import {
  CrawlTaskConfigEncryptionRequiredError,
  decodeCrawlTaskConfigKey,
  protectCrawlTaskConfigForStorage,
  revealCrawlTaskConfigForExecution
} from "./crawl-config-secrets";
import { CrawlResultService } from "./crawl-result.service";
import { CRAWL_QUEUE_NAME } from "./crawl.constants";
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
import { Crawl4aiClient, Crawl4aiArticle, Crawl4aiRequest, Crawl4aiResponse } from "./crawl4ai.client";
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
      const encryptionKeyRaw = this.env.crawlTaskConfigEncryptionKey;
      const encryptionKey = encryptionKeyRaw ? decodeCrawlTaskConfigKey(encryptionKeyRaw) : undefined;
      const configRecord =
        task.config && typeof task.config === "object" && !Array.isArray(task.config)
          ? (task.config as Record<string, unknown>)
          : null;

      if (configRecord) {
        const protectedResult = protectCrawlTaskConfigForStorage(configRecord, encryptionKey);
        if (protectedResult.didEncrypt && protectedResult.config) {
          await this.prisma.crawlTask.update({
            where: { id: task.id },
            data: { config: toPrismaJsonValue(protectedResult.config) }
          });
        }
      }

      const decryptedConfig = configRecord
        ? revealCrawlTaskConfigForExecution(configRecord, encryptionKey)
        : null;
      const options = this.extractOptions(decryptedConfig as Prisma.JsonValue | null);
      const payload = this.buildRequestPayload(task, options);
      const response = await this.crawlClient.crawl(payload);
      const { successes, failures } = this.partitionCrawlerResults(response.results);
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
        options,
        response.runId ?? undefined,
        this.extractMemoryStats(response)
      );

      if (failures.length > 0) {
        summary.failures = failures;
        summary.retryableFailures = failureRetryableCount;
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
        error instanceof CrawlTaskConfigEncryptionRequiredError
          ? error.message
          : error instanceof Crawl4aiRequestException
            ? error.message
            : error instanceof Error
              ? error.message
              : "crawl job failed";

      const attempt = retryContext?.attempt;
      const maxAttempts = retryContext?.maxAttempts;
      const backoffDelayMs = retryContext?.backoffDelayMs;
      const retryable =
        error instanceof CrawlTaskConfigEncryptionRequiredError
          ? false
          : error instanceof Crawl4aiRequestException
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

      await this.prisma.crawlTask.update({
        where: { id: task.id },
        data: {
          status: shouldRetry ? "queued" : "failed",
          lastError: message
        }
      });
      await TaskLogModel.create({
        queue: CRAWL_QUEUE_NAME,
        jobId: taskId,
        orgId,
        stage: "error",
        status: "failed",
        error: {
          message,
          name: error instanceof Error ? error.name : undefined,
          stack: error instanceof Error ? error.stack : undefined,
          status: error instanceof Crawl4aiRequestException ? error.status : undefined
        },
        data: {
          attempt: attempt ?? null,
          maxAttempts: maxAttempts ?? null,
          backoffDelayMs: backoffDelayMs ?? null,
          retryable,
          willRetry: shouldRetry,
          nextRetryAt: nextRetryAt ? nextRetryAt.toISOString() : null
        }
      });

      if (triggeredById && !shouldRetry) {
        await this.safeNotifyCrawl(
          task,
          { inserted: 0, skipped: 0 },
          triggeredById,
          "failed",
          message
        );
      }
      throw error;
    }
  }

  private async safeNotifyCrawl(
    task: CrawlTask,
    summary: CrawlExecutionSummary,
    triggeredById: string,
    status: "completed" | "failed",
    errorMessage?: string
  ) {
    const lastResultAt = summary.lastFetchedAt ? summary.lastFetchedAt.toISOString() : null;
    const payload = {
      orgId: task.orgId,
      userId: triggeredById,
      type: status === "completed" ? NotificationType.crawl_completed : NotificationType.crawl_failed,
      title: `${status === "completed" ? "Crawl completed" : "Crawl failed"}: ${task.displayName ?? task.targetUrl}`,
      body:
        status === "completed"
          ? `Inserted ${summary.inserted}, skipped ${summary.skipped}${
              summary.retryableFailures ? `, retryable ${summary.retryableFailures}` : ""
            }`
          : errorMessage ?? "Crawl task failed",
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
      scanFullPage: typeof value.scanFullPage === "boolean" ? value.scanFullPage : undefined,
      adjustViewportToContent:
        typeof value.adjustViewportToContent === "boolean" ? value.adjustViewportToContent : undefined,
      scrollDelayMs: typeof value.scrollDelayMs === "number" ? value.scrollDelayMs : undefined,
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
      waitForImages: typeof value.waitForImages === "boolean" ? value.waitForImages : undefined
    });
  }

  public normalizeOptions(options?: Partial<CrawlTaskOptions>): CrawlTaskOptions {
    const includeImages = options?.includeImages ?? (options?.storeMedia ? true : false);
    const scanFullPage = options?.scanFullPage ?? false;
    const adjustViewportToContent = options?.adjustViewportToContent ?? false;
    let scrollDelayMs: number | undefined;
    if (scanFullPage) {
      scrollDelayMs =
        typeof options?.scrollDelayMs === "number"
          ? this.clampScrollDelay(options.scrollDelayMs)
          : 200;
    }
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
    const virtualScroll = this.normalizeVirtualScrollConfig(options?.virtualScroll);
    const waitForImages = options?.waitForImages ?? (options?.storeMedia ? true : false);

    return {
      includeImages,
      storeMedia: options?.storeMedia ?? false,
      onlyMainContent: options?.onlyMainContent ?? true,
      extractLinks: options?.extractLinks ?? false,
      cacheMode: options?.cacheMode ?? "bypass",
      scanFullPage,
      adjustViewportToContent,
      scrollDelayMs,
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
      waitForTimeoutMs,
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
      waitForImages
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
    return trimmed.length > 0 ? trimmed : undefined;
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
    const username = typeof value.username === "string" ? value.username.trim() : "";
    const password = typeof value.password === "string" ? value.password.trim() : "";
    return {
      server,
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
    if (typeof overrides.scrollDelayMs === "number") {
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
    const waitForTimeoutMs = this.normalizeWaitForTimeout(overrides.waitForTimeoutMs);
    if (waitForTimeoutMs) {
      normalized.waitForTimeoutMs = waitForTimeoutMs;
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
    const containerSelector = this.normalizeCssSelector(config.containerSelector);
    const scrollCount =
      typeof config.scrollCount === "number" && Number.isFinite(config.scrollCount)
        ? Math.max(1, Math.min(200, Math.round(config.scrollCount)))
        : undefined;
    const scrollBy =
      config.scrollBy === "container_height" || config.scrollBy === "viewport" || config.scrollBy === "pixels"
        ? config.scrollBy
        : undefined;
    const waitAfterScrollMs =
      typeof config.waitAfterScrollMs === "number" && Number.isFinite(config.waitAfterScrollMs)
        ? Math.max(0, Math.min(10000, Math.round(config.waitAfterScrollMs)))
        : undefined;
    const hasValue =
      Boolean(containerSelector) ||
      typeof scrollCount === "number" ||
      typeof waitAfterScrollMs === "number" ||
      Boolean(scrollBy);
    if (!hasValue) {
      return undefined;
    }
    return {
      containerSelector,
      scrollCount,
      scrollBy,
      waitAfterScrollMs
    };
  }

  private normalizeMarkdownFilter(filter?: CrawlMarkdownFilter | null): CrawlMarkdownFilter | undefined {
    if (!filter || filter.type !== "pruning") {
      return undefined;
    }
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
    const scrollBy = typeof record.scrollBy === "string" ? record.scrollBy : undefined;
    return this.normalizeVirtualScrollConfig({
      containerSelector: typeof record.containerSelector === "string" ? record.containerSelector : undefined,
      scrollCount: typeof record.scrollCount === "number" ? record.scrollCount : undefined,
      scrollBy: scrollBy as CrawlVirtualScrollConfig["scrollBy"],
      waitAfterScrollMs: typeof record.waitAfterScrollMs === "number" ? record.waitAfterScrollMs : undefined
    });
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
      bodyWidth: typeof record.bodyWidth === "number" ? record.bodyWidth : undefined
    });
  }

  private parseMarkdownFilter(value: unknown): CrawlMarkdownFilter | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    if (type !== "pruning") {
      return undefined;
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
    if (typeof item.success === "boolean") {
      return item.success;
    }
    const inlineSuccess = this.pickBoolean(item as Record<string, unknown>, [
      "success",
      "isSuccess",
      "ok"
    ]);
    if (typeof inlineSuccess === "boolean") {
      return inlineSuccess;
    }
    const metadataSuccess = this.pickBoolean(item.metadata as Record<string, unknown> | undefined, [
      "success",
      "isSuccess",
      "ok"
    ]);
    if (typeof metadataSuccess === "boolean") {
      return metadataSuccess;
    }
    const markdownResult = this.resultService.extractMarkdownResult(item.markdown);
    return Boolean(markdownResult.primary);
  }

  private buildFailureDetail(item: Crawl4aiArticle): CrawlFailureDetail {
    const statusCode = this.extractStatusCode(item);
    const errorMessage = this.extractErrorMessage(item);
    return {
      url: item.url ?? this.pickString(item.metadata as Record<string, unknown> | undefined, ["url"]),
      statusCode,
      error: errorMessage ?? "Unknown crawl error",
      retryable: this.isRetryableStatus(statusCode, errorMessage)
    };
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
