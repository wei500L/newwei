import { Injectable } from "@nestjs/common";
import type { CrawlTask, Prisma } from "@prisma/client";

import { EnvService } from "../config/config.service";

import { buildUrlList } from "./crawl-execution.helpers";
import {
  clampScrollDelay,
  coerceStringArray,
  fromJsonArray,
  normalizeBrowserCookies,
  normalizeBrowserHeaders,
  normalizeCssSelector,
  normalizeDelayBeforeReturnHtmlMs,
  normalizeDelayJitterMs,
  normalizeGeolocation,
  normalizeLocale,
  normalizeMarkdownFilter,
  normalizeMarkdownOptions,
  normalizeMatcher,
  normalizePageTimeoutMs,
  normalizePatternList,
  normalizeScriptList,
  normalizeSelectorList,
  normalizeSemaphoreCount,
  normalizeSessionId,
  normalizeStorageState,
  normalizeStrategyParams,
  normalizeTableScore,
  normalizeTimezone,
  normalizeUrlList,
  normalizeUserAgent,
  normalizeUserAgentGenerator,
  normalizeUserAgentMode,
  normalizeUserDataDir,
  normalizeWaitForScript,
  normalizeWaitForSelector,
  normalizeWaitForTimeout,
  normalizeWaitUntil,
  normalizeWordCountThreshold,
  parseAntiBotMode,
  parseOptionalNumber,
  parsePageTypeHint,
  parseQualityProfile,
} from "./crawl-options.helpers";
import type {
  CrawlBrowserCookie,
  CrawlBrowserHeader,
  CrawlCleanMarkdownOptions,
  CrawlDetailExpansionOptions,
  CrawlGeolocationConfig,
  CrawlLinkPreviewOptions,
  CrawlMarkdownContentSource,
  CrawlMarkdownFilter,
  CrawlMarkdownOptions,
  CrawlMarkdownStrategy,
  CrawlMultiUrlConfig,
  CrawlProxyConfig,
  CrawlStrategyOverrides,
  CrawlTableExtractionStrategy,
  CrawlTaskOptions,
  CrawlUserAgentGeneratorConfig,
  CrawlVirtualScrollConfig,
} from "./crawl.types";
import { translateLocalhostProxyUrlForCrawl4ai } from "./crawl4ai-proxy";
import type { Crawl4aiRequest } from "./crawl4ai.client";

@Injectable()
export class CrawlOptionsNormalizerService {
  constructor(private readonly env: EnvService) {}

  buildRequestPayload(
    task: CrawlTask,
    providedOptions?: CrawlTaskOptions,
  ): Crawl4aiRequest {
    const keywords = fromJsonArray(task.keywords);
    const options = this.ensureTaskSessionReuse(
      task.id,
      providedOptions ?? this.extractOptions(task.config),
    );
    const urls = buildUrlList(task.targetUrl, options);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options,
    };
  }

  buildRequestPayloadWithUrls(
    task: CrawlTask,
    providedOptions: CrawlTaskOptions,
    urls: string[],
  ): Crawl4aiRequest {
    const keywords = fromJsonArray(task.keywords);
    const options = this.ensureTaskSessionReuse(task.id, providedOptions);
    return {
      url: task.targetUrl,
      urls,
      keywords,
      options,
    };
  }

  extractOptions(config: Prisma.JsonValue | null): CrawlTaskOptions {
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
      antiBotMode: parseAntiBotMode(value.antiBotMode),
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
      pageTimeoutMs: parseOptionalNumber(value.pageTimeoutMs),
      delayBeforeReturnHtmlMs: parseOptionalNumber(
        value.delayBeforeReturnHtmlMs,
      ),
      meanDelayMs: parseOptionalNumber(value.meanDelayMs),
      maxDelayRangeMs: parseOptionalNumber(value.maxDelayRangeMs),
      semaphoreCount: parseOptionalNumber(value.semaphoreCount),
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
      excludedTags: coerceStringArray(value.excludedTags),
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
      pageTypeHint: parsePageTypeHint(value.pageTypeHint),
      autoExpandDetails:
        typeof value.autoExpandDetails === "boolean"
          ? value.autoExpandDetails
          : undefined,
      detailExpansion: this.parseDetailExpansionOptions(value.detailExpansion),
      qualityProfile: parseQualityProfile(value.qualityProfile),
    });
  }

  normalizeOptions(
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
          ? clampScrollDelay(options.scrollDelayMs)
          : 200;
    }
    const headless =
      typeof options?.headless === "boolean" ? options.headless : undefined;
    const antiBotMode = parseAntiBotMode(options?.antiBotMode) ?? "auto";
    const enableStealthMode = options?.enableStealthMode ?? false;
    const simulateUser =
      options?.simulateUser ?? (enableStealthMode ? true : false);
    const overrideNavigator =
      options?.overrideNavigator ?? (enableStealthMode ? true : false);
    const userDataDir = normalizeUserDataDir(options?.userDataDir);
    const useManagedBrowser =
      options?.useManagedBrowser ?? Boolean(userDataDir);
    const proxyConfig = this.normalizeProxyConfig(options?.proxyConfig);
    const proxyUrl = proxyConfig
      ? undefined
      : this.normalizeProxyUrl(options?.proxyUrl);
    const additionalUrls = normalizeUrlList(options?.additionalUrls);
    const multiUrlConfigs = this.normalizeMultiUrlConfigs(
      options?.multiUrlConfigs,
    );
    const qualityProfile =
      parseQualityProfile(options?.qualityProfile) ?? "quality_first";
    const markdownOptionsInput = normalizeMarkdownOptions(
      options?.markdownOptions,
    );
    const markdownOptions = normalizeMarkdownOptions({
      ...(markdownOptionsInput ?? {}),
      contentSource:
        markdownOptionsInput?.contentSource ??
        (qualityProfile === "speed_first" ? "raw_html" : "cleaned_html"),
      citations: markdownOptionsInput?.citations ?? true,
    });
    const markdownFilter = normalizeMarkdownFilter(
      options?.markdownFilter,
    );
    const markdownStrategy = this.normalizeMarkdownStrategy(
      options?.markdownStrategy,
    );
    const tableScoreThreshold = normalizeTableScore(
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
    const jsCode = normalizeScriptList(options?.jsCode);
    const waitForSelector = normalizeWaitForSelector(
      options?.waitForSelector,
    );
    const waitForScript = normalizeWaitForScript(options?.waitForScript);
    const waitForTimeoutMs = normalizeWaitForTimeout(
      options?.waitForTimeoutMs,
    );
    const waitUntil = normalizeWaitUntil(options?.waitUntil);
    const normalizedWaitForTimeoutMs =
      waitUntil === "networkidle" && typeof waitForTimeoutMs === "number"
        ? Math.max(5000, waitForTimeoutMs)
        : waitForTimeoutMs;
    const pageTimeoutMs = normalizePageTimeoutMs(options?.pageTimeoutMs);
    const delayBeforeReturnHtmlMs = normalizeDelayBeforeReturnHtmlMs(
      options?.delayBeforeReturnHtmlMs,
    );
    const meanDelayMs = normalizeDelayJitterMs(options?.meanDelayMs);
    const maxDelayRangeMs = normalizeDelayJitterMs(
      options?.maxDelayRangeMs,
    );
    const semaphoreCount = normalizeSemaphoreCount(
      options?.semaphoreCount,
    );
    const sessionId = normalizeSessionId(options?.sessionId);
    const storageState = normalizeStorageState(options?.storageState);
    const browserHeaders = normalizeBrowserHeaders(
      options?.browserHeaders,
    );
    const browserCookies = normalizeBrowserCookies(
      options?.browserCookies,
    );
    const userAgent = normalizeUserAgent(options?.userAgent);
    const userAgentMode = userAgent
      ? undefined
      : (normalizeUserAgentMode(options?.userAgentMode) ?? "random");
    const userAgentGenerator = userAgent
      ? undefined
      : normalizeUserAgentGenerator(options?.userAgentGenerator);
    const locale = normalizeLocale(options?.locale);
    const timezoneId = normalizeTimezone(options?.timezoneId);
    const geolocation = normalizeGeolocation(options?.geolocation);
    const wordCountThreshold = normalizeWordCountThreshold(
      options?.wordCountThreshold ?? 80,
    );
    const excludeExternalLinks = options?.excludeExternalLinks ?? true;
    const excludeExternalImages =
      options?.excludeExternalImages ?? (options?.storeMedia ? false : true);
    const removeOverlayElements = options?.removeOverlayElements ?? true;
    const processIframes = options?.processIframes ?? true;
    const textMode = options?.textMode ?? false;
    const captureScreenshot = options?.captureScreenshot ?? false;
    const cssSelector = normalizeCssSelector(options?.cssSelector);
    const excludedTags = normalizeSelectorList(options?.excludedTags);
    const waitForImages =
      options?.waitForImages ?? (options?.storeMedia ? true : false);
    const removeForms = options?.removeForms ?? false;
    const pageTypeHint = parsePageTypeHint(options?.pageTypeHint);
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

  ensureTaskSessionReuse(
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
    return normalizeSessionId(`task-${seed}`) ?? "task-session";
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
    const includeUrlPatterns = normalizePatternList(
      value.includeUrlPatterns,
    );
    const excludeUrlPatterns = normalizePatternList(
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
    const matcher = normalizeMatcher(config.matcher);
    const urls = normalizeUrlList(config.urls ?? undefined);
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
      normalized.scrollDelayMs = clampScrollDelay(overrides.scrollDelayMs);
    }
    if (typeof overrides.simulateUser === "boolean") {
      normalized.simulateUser = overrides.simulateUser;
    }
    if (typeof overrides.overrideNavigator === "boolean") {
      normalized.overrideNavigator = overrides.overrideNavigator;
    }
    const jsCode = normalizeScriptList(overrides.jsCode);
    if (jsCode) {
      normalized.jsCode = jsCode;
    }
    if (typeof overrides.jsOnly === "boolean") {
      normalized.jsOnly = overrides.jsOnly;
    }
    const waitForSelector = normalizeWaitForSelector(
      overrides.waitForSelector,
    );
    if (waitForSelector) {
      normalized.waitForSelector = waitForSelector;
    }
    const waitForScript = normalizeWaitForScript(overrides.waitForScript);
    if (waitForScript) {
      normalized.waitForScript = waitForScript;
    }
    const waitUntil = normalizeWaitUntil(overrides.waitUntil);
    if (waitUntil) {
      normalized.waitUntil = waitUntil;
    }
    const waitForTimeoutMs = normalizeWaitForTimeout(
      overrides.waitForTimeoutMs,
    );
    if (waitForTimeoutMs !== undefined) {
      normalized.waitForTimeoutMs =
        waitUntil === "networkidle"
          ? Math.max(5000, waitForTimeoutMs)
          : waitForTimeoutMs;
    }
    const pageTimeoutMs = normalizePageTimeoutMs(overrides.pageTimeoutMs);
    if (pageTimeoutMs !== undefined) {
      normalized.pageTimeoutMs = pageTimeoutMs;
    }
    const delayBeforeReturnHtmlMs = normalizeDelayBeforeReturnHtmlMs(
      overrides.delayBeforeReturnHtmlMs,
    );
    if (delayBeforeReturnHtmlMs !== undefined) {
      normalized.delayBeforeReturnHtmlMs = delayBeforeReturnHtmlMs;
    }
    const meanDelayMs = normalizeDelayJitterMs(overrides.meanDelayMs);
    if (meanDelayMs !== undefined) {
      normalized.meanDelayMs = meanDelayMs;
    }
    const maxDelayRangeMs = normalizeDelayJitterMs(
      overrides.maxDelayRangeMs,
    );
    if (maxDelayRangeMs !== undefined) {
      normalized.maxDelayRangeMs = maxDelayRangeMs;
    }
    const semaphoreCount = normalizeSemaphoreCount(
      overrides.semaphoreCount,
    );
    if (semaphoreCount !== undefined) {
      normalized.semaphoreCount = semaphoreCount;
    }
    if (typeof overrides.removeForms === "boolean") {
      normalized.removeForms = overrides.removeForms;
    }
    const wordCountThreshold = normalizeWordCountThreshold(
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
    const cssSelector = normalizeCssSelector(overrides.cssSelector);
    if (cssSelector) {
      normalized.cssSelector = cssSelector;
    }
    const excludedTags = normalizeSelectorList(overrides.excludedTags);
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
    const pageTypeHint = parsePageTypeHint(overrides.pageTypeHint);
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
    const qualityProfile = parseQualityProfile(overrides.qualityProfile);
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
      targetElements: coerceStringArray(record.targetElements),
      excludedTags: coerceStringArray(record.excludedTags),
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
    const targetElements = normalizeSelectorList(options.targetElements);
    if (targetElements) {
      normalized.targetElements = targetElements;
    }
    const excludedTags = normalizeSelectorList(options.excludedTags);
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
    return normalizeSelectorList(merged);
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
    const containerSelector = normalizeCssSelector(
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
    const params = normalizeStrategyParams(strategy.params);
    if (params) {
      normalized.params = params;
    }
    return normalized;
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
    const params = normalizeStrategyParams(strategy.params);
    if (params) {
      normalized.params = params;
    }
    return normalized;
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
    const includePatterns = normalizePatternList(options.includePatterns);
    if (includePatterns) {
      normalized.includePatterns = includePatterns;
    }
    const excludePatterns = normalizePatternList(options.excludePatterns);
    if (excludePatterns) {
      normalized.excludePatterns = excludePatterns;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private parseUrlArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return normalizeUrlList(
      value
        .map((entry) => (typeof entry === "string" ? entry : ""))
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  private parseStringArray(value: unknown): string[] | undefined {
    if (typeof value === "string") {
      return normalizeScriptList([value]);
    }
    if (!Array.isArray(value)) {
      return undefined;
    }
    return normalizeScriptList(
      value
        .map((entry) => (typeof entry === "string" ? entry : ""))
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  private parseWaitUntil(value: unknown): CrawlTaskOptions["waitUntil"] {
    if (typeof value !== "string") {
      return undefined;
    }
    return normalizeWaitUntil(value);
  }

  private parsePatternArray(value: unknown): string[] | undefined {
    if (typeof value === "string") {
      return normalizePatternList([value]);
    }
    if (!Array.isArray(value)) {
      return undefined;
    }
    const normalized = value
      .map((entry) => (typeof entry === "string" ? entry : ""))
      .filter((entry): entry is string => Boolean(entry));
    return normalizePatternList(normalized);
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
    return normalizeMarkdownOptions({
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
      return normalizeMarkdownFilter({
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
    return normalizeMarkdownFilter({
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
    return normalizeBrowserHeaders(
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
    return normalizeBrowserCookies(
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
    return normalizeUserAgentGenerator(
      value as CrawlUserAgentGeneratorConfig,
    );
  }

  private parseGeolocation(value: unknown): CrawlGeolocationConfig | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    return normalizeGeolocation(value as CrawlGeolocationConfig);
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
}
