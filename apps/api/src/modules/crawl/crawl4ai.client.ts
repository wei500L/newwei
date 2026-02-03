import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import type { AxiosError } from "axios";
import { lastValueFrom } from "rxjs";

import { validateSsrfUrl } from "../../common/validators/ssrf-url.validator";
import { EnvService } from "../config/config.service";

import { CrawlSettingsService, type CrawlClientSettings } from "./crawl-settings.service";
import type {
  CrawlTaskOptions,
  CrawlMultiUrlConfig,
  CrawlUrlMatcher,
  CrawlStrategyOverrides,
  CrawlMarkdownOptions,
  CrawlMarkdownFilter,
  Crawl4aiMedia,
  CrawlBrowserHeader,
  CrawlBrowserCookie,
  CrawlUserAgentGeneratorConfig,
  CrawlGeolocationConfig,
  CrawlCleanMarkdownOptions,
  CrawlTableExtractionStrategy,
  Crawl4aiTablePayload,
  CrawlVirtualScrollConfig
} from "./crawl.types";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { translateLocalhostProxyUrlForCrawl4ai } from "./crawl4ai-proxy";
import { validateJsCodeArray } from "./validators/js-code.validator";

export interface Crawl4aiRequest {
  url: string;
  urls?: string[];
  keywords?: string[];
  options?: CrawlTaskOptions;
}

export interface Crawl4aiMarkdownResult {
  raw_markdown?: string;
  rawMarkdown?: string;
  markdown_with_citations?: string;
  markdownWithCitations?: string;
  references_markdown?: string;
  referencesMarkdown?: string;
  fit_markdown?: string;
  fitMarkdown?: string;
  markdown?: string;
  text?: string;
  [key: string]: unknown;
}

export interface Crawl4aiArticle {
  url?: string;
  markdown?: string | Crawl4aiMarkdownResult;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
  links?: Record<string, Crawl4aiLink[]>;
  media?: Crawl4aiMedia;
  tables?: Crawl4aiTablePayload[];
  success?: boolean;
  statusCode?: number;
  status_code?: number;
  error?: string;
  errorMessage?: string;
  error_message?: string;
}

export interface Crawl4aiResponse {
  runId?: string | null;
  nextCursor?: string | null;
  warnings?: string[];
  results: Crawl4aiArticle[];
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  memoryEfficiency?: number;
}

interface Crawl4aiHttpPayload {
  urls: string[];
  keywords?: string[];
  browser_config: {
    type: string;
    params: Record<string, unknown>;
  };
  crawler_config: {
    type: string;
    params: Record<string, unknown>;
  };
  crawler_configurations?: {
    type: string;
    params: Record<string, unknown>;
  }[];
}

@Injectable()
export class Crawl4aiClient {
  private readonly logger = new Logger(Crawl4aiClient.name);
  private lastHealthCheck = 0;

  constructor(
    private readonly http: HttpService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly env: EnvService
  ) {}

  async crawl(request: Crawl4aiRequest): Promise<Crawl4aiResponse> {
    const settings = await this.crawlSettings.getSettings();
    await this.ensureHealthy(settings);
    const payload = this.toHttpPayload(request);
    try {
      const response = await lastValueFrom(
        this.http.post<Crawl4aiResponse>("/crawl", payload, {
          headers: {
            "content-type": "application/json"
          },
          timeout: settings.requestTimeoutMs
        })
      );
      return {
        results: response.data?.results ?? [],
        nextCursor: response.data?.nextCursor ?? null,
        runId: response.data?.runId ?? null,
        warnings: response.data?.warnings ?? [],
        serverMemoryMb: response.data?.serverMemoryMb,
        peakMemoryMb: response.data?.peakMemoryMb,
        memoryEfficiency: response.data?.memoryEfficiency
      };
    } catch (error) {
      const axiosError = error as AxiosError<unknown>;
      const status = axiosError.response?.status;
      const responseData = axiosError.response?.data;

      const normalizeMessage = (value: unknown): string | undefined => {
        if (!value) {
          return undefined;
        }
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (Array.isArray(value)) {
          const parts = value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          return parts.length > 0 ? parts.join("; ") : undefined;
        }
        return undefined;
      };

      const messageFromPayload = (payload: unknown): string | undefined => {
        if (!payload) {
          return undefined;
        }
        if (typeof payload === "string") {
          return normalizeMessage(payload);
        }
        if (typeof payload !== "object" || Array.isArray(payload)) {
          return undefined;
        }
        const record = payload as Record<string, unknown>;
        const message = normalizeMessage(record.message);
        if (message) {
          return message;
        }
        const detail = normalizeMessage(record.detail);
        if (detail) {
          return detail;
        }
        const error = normalizeMessage(record.error);
        if (error) {
          return error;
        }
        return undefined;
      };

      const payloadMessage = messageFromPayload(responseData);
      const fallback = normalizeMessage(axiosError.message) ?? "crawl4ai request failed";
      const normalizedStatus =
        typeof status === "number" && Number.isFinite(status) ? Math.round(status) : undefined;

      const messageParts = [payloadMessage, fallback].filter(
        (entry): entry is string => Boolean(entry && entry.length > 0)
      );
      const messageWithStatus =
        normalizedStatus !== undefined
          ? `${messageParts.join("\n")}\n(status ${normalizedStatus})`
          : messageParts.join("\n");

      const normalizedMessage = messageWithStatus.toLowerCase();
      const maybeDisplayIssue =
        normalizedMessage.includes("cannot open display") ||
        normalizedMessage.includes("missing x server") ||
        normalizedMessage.includes("xvfb") ||
        (normalizedMessage.includes("x11") && normalizedMessage.includes("display"));
      const maybeProxyIssue =
        normalizedMessage.includes("err_proxy_connection_failed") ||
        normalizedMessage.includes("proxy_connection_failed") ||
        normalizedMessage.includes("proxy connection failed") ||
        (normalizedMessage.includes("proxy") && normalizedMessage.includes("connection failed"));
      const hints: string[] = [];
      if (maybeDisplayIssue) {
        hints.push(
          "Hint: crawl4ai may be running with headless=false. Ensure Xvfb/DISPLAY is configured (see infra/docker/docker-compose.yml) or set crawlOptions.headless=true."
        );
      }
      if (maybeProxyIssue) {
        hints.push(
          "Hint: crawl4ai failed to connect to the proxy. If your proxy is on the Docker host, use host.docker.internal (e.g. http://host.docker.internal:7890) instead of 127.0.0.1/localhost, or disable proxyUrl."
        );
      }
      const messageWithHint = hints.length > 0 ? `${messageWithStatus}\n${hints.join("\n")}` : messageWithStatus;

      throw new Crawl4aiRequestException(messageWithHint, status, error);
    }
  }

  private async ensureHealthy(settings: CrawlClientSettings) {
    const now = Date.now();
    if (now - this.lastHealthCheck < settings.healthCheckTtlMs) {
      return;
    }
    try {
      await lastValueFrom(
        this.http.get("/health", {
          timeout: settings.requestTimeoutMs
        })
      );
      this.lastHealthCheck = now;
    } catch (error) {
      throw new Crawl4aiRequestException("crawl4ai health check failed", undefined, error);
    }
  }

  private toHttpPayload(request: Crawl4aiRequest): Crawl4aiHttpPayload {
    const options = request.options ?? {};
    const urls = (request.urls && request.urls.length > 0 ? request.urls : [request.url]).map((entry) =>
      entry.trim()
    );

    // Defense-in-depth: Runtime SSRF validation
    for (const url of urls) {
      const result = validateSsrfUrl(url);
      if (!result.valid) {
        this.logger.warn(`SSRF blocked: ${url} - ${result.reason}`);
        throw new Crawl4aiRequestException(`URL blocked by SSRF protection: ${result.reason}`, 400);
      }
    }

    const scrollDelay = typeof options.scrollDelayMs === "number" ? options.scrollDelayMs / 1000 : undefined;
    const useManagedBrowser = options.useManagedBrowser ?? false;
    const headless = typeof options.headless === "boolean" ? options.headless : undefined;
    const proxyPayload = this.resolveProxyPayload(options);
    const multiConfigurations = this.buildMultiConfigurations(options);
    const markdownGenerator = this.buildMarkdownGenerator(options);
    const cleanMarkdown = this.buildCleanMarkdownOptions(options.cleanMarkdown);
    const linkPreviewConfig = this.buildLinkPreviewConfig(options);
    const shouldScoreLinks = options.scoreLinks ?? Boolean(linkPreviewConfig);
    const headers = this.buildHeaderMap(options.browserHeaders);
    const cookies = this.buildCookieList(options.browserCookies);
    const userAgent = this.normalizeUserAgent(options.userAgent);
    const userAgentGenerator = this.buildUserAgentGenerator(options.userAgentGenerator);
    const geolocation = this.buildGeolocation(options.geolocation);
    const virtualScroll = this.buildVirtualScrollConfig(options.virtualScroll);
    const wordCountThreshold = this.normalizeWordCountThreshold(options.wordCountThreshold ?? 80);
    const excludeExternalLinks = options.excludeExternalLinks ?? true;
    const removeOverlayElements = options.removeOverlayElements ?? true;
    const processIframes = options.processIframes ?? true;
    const cssSelector = this.normalizeCssSelector(options.cssSelector);
    const excludedTags = this.normalizeSelectorList(options.excludedTags);
    const textMode = options.textMode ?? false;
    const captureScreenshot = options.captureScreenshot ?? false;
    const waitForImages = options.waitForImages ?? false;
    const excludeExternalImages = options.excludeExternalImages ?? false;
    const usePersistentContext = useManagedBrowser || Boolean(options.userDataDir);
    const browserConfig = {
      type: "BrowserConfig",
      params: this.compact({
        headless,
        enable_stealth: options.enableStealthMode ?? undefined,
        browser_type: options.enableUndetectedBrowser ? "undetected" : undefined,
        light_mode: options.includeImages === false ? true : undefined,
        use_managed_browser: useManagedBrowser ? true : undefined,
        use_persistent_context: usePersistentContext ? true : undefined,
        user_data_dir: options.userDataDir,
        proxy_config: proxyPayload,
        headers,
        cookies,
        user_agent: userAgent,
        user_agent_mode: options.userAgentMode,
        user_agent_generator_config: userAgentGenerator,
        storage_state: this.buildStorageState(options.storageState)
      })
    };
    const crawlerConfig = {
      type: "CrawlerRunConfig",
      params: this.compact({
        cache_mode: options.cacheMode ?? "bypass",
        prefetch: options.prefetch ? true : undefined,
        scan_full_page: options.scanFullPage ?? false,
        adjust_viewport_to_content: options.adjustViewportToContent ? true : undefined,
        scroll_delay: scrollDelay,
        simulate_user: options.simulateUser ?? undefined,
        override_navigator: options.overrideNavigator ?? undefined,
        magic: options.enableStealthMode ?? undefined,
        markdown_generator: markdownGenerator,
        score_links: shouldScoreLinks ? true : undefined,
        link_preview_config: linkPreviewConfig,
        user_agent: userAgent,
        user_agent_mode: options.userAgentMode,
        user_agent_generator_config: userAgentGenerator,
        locale: options.locale,
        timezone_id: options.timezoneId,
        geolocation,
        js_code: this.normalizeJsCode(options.jsCode),
        js_only: options.jsOnly ? true : undefined,
        wait_for: this.buildWaitFor(options),
        wait_for_timeout: this.normalizeWaitForTimeout(options.waitForTimeoutMs),
        session_id: options.sessionId,
        table_score_threshold: this.normalizeTableScore(options.tableScoreThreshold),
        table_extraction: this.buildTableExtraction(options.tableExtraction),
        word_count_threshold: wordCountThreshold,
        exclude_external_links: excludeExternalLinks,
        exclude_external_images: excludeExternalImages,
        remove_overlay_elements: removeOverlayElements,
        process_iframes: processIframes,
        css_selector: cssSelector,
        excluded_tags: excludedTags,
        wait_for_images: waitForImages ? true : undefined,
        only_text: textMode ? true : undefined,
        screenshot: captureScreenshot ? true : undefined,
        virtual_scroll_config: virtualScroll,
        ...(cleanMarkdown ?? {})
      })
    };
    return {
      urls,
      keywords: request.keywords && request.keywords.length > 0 ? request.keywords : undefined,
      browser_config: browserConfig,
      crawler_config: crawlerConfig,
      crawler_configurations: multiConfigurations && multiConfigurations.length > 0 ? multiConfigurations : undefined
    };
  }

  private compact(record: Record<string, unknown>) {
    return Object.entries(record).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  private resolveProxyPayload(options: CrawlTaskOptions) {
    if (options.proxyConfig) {
      const normalizedServer = translateLocalhostProxyUrlForCrawl4ai(
        options.proxyConfig.server,
        this.env.crawl4aiConfig.baseUrl
      );
      return this.compact({
        server: normalizedServer,
        username: options.proxyConfig.username ?? undefined,
        password: options.proxyConfig.password ?? undefined
      });
    }
    if (options.proxyUrl) {
      return translateLocalhostProxyUrlForCrawl4ai(options.proxyUrl, this.env.crawl4aiConfig.baseUrl);
    }
    return undefined;
  }

  private buildMarkdownGenerator(options: CrawlTaskOptions) {
    const customStrategy = options.markdownStrategy;
    if (customStrategy && typeof customStrategy.type === "string") {
      const params = this.normalizeCustomParams(customStrategy.params);
      return params && Object.keys(params).length > 0
        ? {
            type: customStrategy.type,
            params
          }
        : {
            type: customStrategy.type
          };
    }
    const contentFilter: CrawlMarkdownFilter | undefined =
      options.markdownFilter ??
      (options.onlyMainContent
        ? {
            type: "pruning",
            thresholdType: "dynamic",
            minWordThreshold:
              typeof options.wordCountThreshold === "number" ? options.wordCountThreshold : undefined
          }
        : undefined);
    const params = this.compact({
      content_source: options.markdownOptions?.contentSource,
      options: this.buildMarkdownOptionsPayload(options.markdownOptions),
      content_filter: this.buildContentFilterPayload(contentFilter)
    });
    return Object.keys(params).length > 0
      ? {
          type: "DefaultMarkdownGenerator",
          params
        }
      : undefined;
  }

  private buildTableExtraction(strategy?: CrawlTableExtractionStrategy) {
    if (!strategy || typeof strategy.type !== "string") {
      return undefined;
    }
    const trimmed = strategy.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const params = this.normalizeCustomParams(strategy.params);
    return params && Object.keys(params).length > 0
      ? {
          type: trimmed,
          params
        }
      : {
          type: trimmed
        };
  }

  private buildMarkdownOptionsPayload(markdownOptions?: CrawlMarkdownOptions) {
    if (!markdownOptions) {
      return undefined;
    }
    const payload = this.compact({
      ignore_links: markdownOptions.ignoreLinks,
      escape_html: markdownOptions.escapeHtml,
      body_width: markdownOptions.bodyWidth
    });
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private normalizeCustomParams(value?: Record<string, unknown>) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  private buildCleanMarkdownOptions(options?: CrawlCleanMarkdownOptions) {
    if (!options) {
      return undefined;
    }
    const payload = this.compact({
      css_selector: options.cssSelector,
      target_elements: options.targetElements && options.targetElements.length > 0 ? options.targetElements : undefined,
      excluded_tags: options.excludedTags && options.excludedTags.length > 0 ? options.excludedTags : undefined,
      remove_overlay_elements: options.removeOverlayElements,
      word_count_threshold: options.wordCountThreshold
    });
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private buildVirtualScrollConfig(config?: CrawlVirtualScrollConfig) {
    if (!config) {
      return undefined;
    }
    const params = this.compact({
      container_selector: this.normalizeCssSelector(config.containerSelector),
      scroll_count:
        typeof config.scrollCount === "number" && Number.isFinite(config.scrollCount)
          ? Math.max(1, Math.min(200, Math.round(config.scrollCount)))
          : undefined,
      scroll_by: this.normalizeScrollBy(config.scrollBy),
      wait_after_scroll: this.normalizeWaitAfterScroll(config.waitAfterScrollMs)
    });
    return Object.keys(params).length > 0
      ? {
          type: "VirtualScrollConfig",
          params
        }
      : undefined;
  }

  private buildLinkPreviewConfig(options: CrawlTaskOptions) {
    const config = options.linkPreview;
    if (!config) {
      return undefined;
    }
    const params = this.compact({
      include_internal: config.includeInternal,
      include_external: config.includeExternal,
      max_links: config.maxLinks,
      concurrency: config.concurrency,
      timeout: config.timeoutSeconds,
      query: this.normalizeQuery(config.query),
      score_threshold: typeof config.scoreThreshold === "number" ? parseFloat(config.scoreThreshold.toFixed(3)) : undefined,
      verbose: config.verbose,
      include_patterns: this.normalizePatternList(config.includePatterns),
      exclude_patterns: this.normalizePatternList(config.excludePatterns)
    });
    if (Object.keys(params).length === 0) {
      return undefined;
    }
    return {
      type: "LinkPreviewConfig",
      params
    };
  }

  private normalizeJsCode(jsCode?: string[]) {
    if (!jsCode || jsCode.length === 0) {
      return undefined;
    }

    // Check if jsCode feature is enabled
    if (!this.env.crawl4aiConfig.jsCodeEnabled) {
      this.logger.warn("jsCode feature is disabled, ignoring jsCode parameter");
      return undefined;
    }

    const normalized = jsCode
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
    }

    // Defense-in-depth: Runtime jsCode validation
    const validationResult = validateJsCodeArray(normalized);
    if (!validationResult.valid) {
      const blockedPatterns = validationResult.blockedPatterns.slice(0, 5).join("; ");
      this.logger.warn(`jsCode blocked: ${blockedPatterns}`);
      throw new Crawl4aiRequestException(
        `jsCode contains blocked patterns: ${blockedPatterns}. Only safe DOM operations are allowed.`,
        400
      );
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      this.logger.warn(`jsCode warnings: ${validationResult.warnings.join("; ")}`);
    }

    return normalized.length === 1 ? normalized[0] : normalized;
  }

  private buildStorageState(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  private buildWaitFor(
    source?: {
      waitForScript?: string;
      waitForSelector?: string;
    } | null
  ) {
    if (!source) {
      return undefined;
    }
    const script = typeof source.waitForScript === "string" ? source.waitForScript.trim() : "";
    if (script.length > 0) {
      return script.startsWith("js:") ? script : `js:${script}`;
    }
    const selector = typeof source.waitForSelector === "string" ? source.waitForSelector.trim() : "";
    if (selector.length > 0) {
      if (
        selector.startsWith("css:") ||
        selector.startsWith("js:") ||
        selector.startsWith("xpath:")
      ) {
        return selector;
      }
      return `css:${selector}`;
    }
    return undefined;
  }

  private normalizeWaitForTimeout(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    return value;
  }

  private normalizeTableScore(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(10, value));
    return Number(clamped.toFixed(2));
  }

  private normalizePatternList(patterns?: string[]) {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }
    const normalized = patterns
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizeSelectorList(values?: string[]) {
    if (!values || values.length === 0) {
      return undefined;
    }
    const normalized = values
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0)
      .slice(0, 10);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
  }

  private normalizeCssSelector(value?: string) {
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

  private normalizeWordCountThreshold(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(5000, Math.round(value)));
    return clamped;
  }

  private normalizeScrollBy(value?: string) {
    if (value === "container_height" || value === "viewport" || value === "pixels") {
      return value;
    }
    return undefined;
  }

  private normalizeWaitAfterScroll(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(10000, value));
    return Number((clamped / 1000).toFixed(2));
  }

  private normalizeQuery(query?: string) {
    if (!query) {
      return undefined;
    }
    const trimmed = query.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildContentFilterPayload(filter?: CrawlMarkdownFilter) {
    if (!filter) {
      return undefined;
    }
    if (filter.type === "pruning") {
      return this.compact({
        type: "PruningContentFilter",
        params: this.compact({
          threshold: filter.threshold,
          threshold_type: filter.thresholdType,
          min_word_threshold: filter.minWordThreshold
        })
      });
    }
    return undefined;
  }

  private buildMultiConfigurations(options: CrawlTaskOptions) {
    const configs: CrawlMultiUrlConfig[] | undefined = options.multiUrlConfigs;
    if (!configs || configs.length === 0) {
      return undefined;
    }
    const configurations = configs
      .map((config) => {
        const matcher = this.normalizeMatcher(config.matcher);
        const overrides = this.normalizeStrategyOverrides(config.options);
        const wordCount = this.normalizeWordCountThreshold(overrides?.wordCountThreshold);
        const cssSelector = this.normalizeCssSelector(overrides?.cssSelector);
        const excludedTags = this.normalizeSelectorList(overrides?.excludedTags);
        const virtualScroll = this.buildVirtualScrollConfig(overrides?.virtualScroll);
        const params = this.compact({
          url_matcher: matcher?.pattern,
          match_mode: matcher?.matchMode,
          cache_mode: overrides?.cacheMode,
          scan_full_page: overrides?.scanFullPage,
          adjust_viewport_to_content: overrides?.adjustViewportToContent ? true : undefined,
          scroll_delay:
            typeof overrides?.scrollDelayMs === "number" ? overrides.scrollDelayMs / 1000 : undefined,
          simulate_user: overrides?.simulateUser,
          override_navigator: overrides?.overrideNavigator,
          js_code: this.normalizeJsCode(overrides?.jsCode),
          js_only: overrides?.jsOnly ? true : undefined,
          wait_for: this.buildWaitFor(overrides),
          wait_for_timeout: this.normalizeWaitForTimeout(overrides?.waitForTimeoutMs),
          word_count_threshold: wordCount,
          exclude_external_links: overrides?.excludeExternalLinks,
          exclude_external_images: overrides?.excludeExternalImages,
          remove_overlay_elements: overrides?.removeOverlayElements,
          process_iframes: overrides?.processIframes,
          css_selector: cssSelector,
          excluded_tags: excludedTags,
          wait_for_images: overrides?.waitForImages ? true : undefined,
          only_text: overrides?.textMode ? true : undefined,
          screenshot: overrides?.captureScreenshot ? true : undefined,
          virtual_scroll_config: virtualScroll
        });
        if (Object.keys(params).length === 0) {
          return undefined;
        }
        return {
          type: "CrawlerRunConfig",
          params
        };
      })
      .filter((entry): entry is { type: string; params: Record<string, unknown> } => Boolean(entry));
    return configurations.length > 0 ? configurations : undefined;
  }

  private normalizeMatcher(matcher?: CrawlUrlMatcher) {
    if (!matcher || !matcher.patterns || matcher.patterns.length === 0) {
      return undefined;
    }
    const patterns = matcher.patterns
      .map((pattern) => (typeof pattern === "string" ? pattern.trim() : ""))
      .filter((pattern) => pattern.length > 0);
    if (patterns.length === 0) {
      return undefined;
    }
    return {
      pattern: patterns.length === 1 ? patterns[0] : patterns,
      matchMode: matcher.matchMode
    };
  }

  private normalizeStrategyOverrides(options?: CrawlStrategyOverrides): CrawlStrategyOverrides | undefined {
    if (!options) {
      return undefined;
    }
    const normalized: CrawlStrategyOverrides = {};
    if (options.cacheMode) {
      normalized.cacheMode = options.cacheMode;
    }
    if (typeof options.onlyMainContent === "boolean") {
      normalized.onlyMainContent = options.onlyMainContent;
    }
    if (typeof options.extractLinks === "boolean") {
      normalized.extractLinks = options.extractLinks;
    }
    if (typeof options.scanFullPage === "boolean") {
      normalized.scanFullPage = options.scanFullPage;
    }
    if (typeof options.adjustViewportToContent === "boolean") {
      normalized.adjustViewportToContent = options.adjustViewportToContent;
    }
    if (typeof options.scrollDelayMs === "number") {
      normalized.scrollDelayMs = options.scrollDelayMs;
    }
    if (typeof options.simulateUser === "boolean") {
      normalized.simulateUser = options.simulateUser;
    }
    if (typeof options.overrideNavigator === "boolean") {
      normalized.overrideNavigator = options.overrideNavigator;
    }
    if (typeof options.wordCountThreshold === "number") {
      const wordCount = this.normalizeWordCountThreshold(options.wordCountThreshold);
      if (wordCount !== undefined) {
        normalized.wordCountThreshold = wordCount;
      }
    }
    if (typeof options.excludeExternalLinks === "boolean") {
      normalized.excludeExternalLinks = options.excludeExternalLinks;
    }
    if (typeof options.excludeExternalImages === "boolean") {
      normalized.excludeExternalImages = options.excludeExternalImages;
    }
    if (typeof options.removeOverlayElements === "boolean") {
      normalized.removeOverlayElements = options.removeOverlayElements;
    }
    if (typeof options.processIframes === "boolean") {
      normalized.processIframes = options.processIframes;
    }
    if (typeof options.textMode === "boolean") {
      normalized.textMode = options.textMode;
    }
    if (typeof options.waitForImages === "boolean") {
      normalized.waitForImages = options.waitForImages;
    }
    if (typeof options.captureScreenshot === "boolean") {
      normalized.captureScreenshot = options.captureScreenshot;
    }
    if (typeof options.cssSelector === "string") {
      const cssSelector = this.normalizeCssSelector(options.cssSelector);
      if (cssSelector) {
        normalized.cssSelector = cssSelector;
      }
    }
    const excludedTags = this.normalizeSelectorList(options.excludedTags);
    if (excludedTags) {
      normalized.excludedTags = excludedTags;
    }
    if (options.virtualScroll) {
      const virtualScroll = this.buildVirtualScrollConfig(options.virtualScroll);
      if (virtualScroll) {
        normalized.virtualScroll = options.virtualScroll;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private buildHeaderMap(headers?: CrawlBrowserHeader[]) {
    if (!headers || headers.length === 0) {
      return undefined;
    }
    return headers.reduce<Record<string, string>>((acc, header) => {
      if (header.name && header.value) {
        acc[header.name] = header.value;
      }
      return acc;
    }, {});
  }

  private buildCookieList(cookies?: CrawlBrowserCookie[]) {
    if (!cookies || cookies.length === 0) {
      return undefined;
    }
    const payload = cookies
      .map((cookie) =>
        this.compact({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path
        })
      )
      .filter((entry) => entry.name && entry.value && entry.domain);
    return payload.length > 0 ? payload : undefined;
  }

  private normalizeUserAgent(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private buildUserAgentGenerator(config?: CrawlUserAgentGeneratorConfig) {
    if (!config) {
      return undefined;
    }
    const payload = this.compact({
      platform: config.platform,
      browser: config.browser,
      device_type: config.deviceType,
      locale: config.locale
    });
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private buildGeolocation(config?: CrawlGeolocationConfig) {
    if (!config) {
      return undefined;
    }
    const payload = this.compact({
      latitude: config.latitude,
      longitude: config.longitude,
      accuracy: config.accuracy
    });
    return Object.keys(payload).length > 0 ? payload : undefined;
  }
}
export interface Crawl4aiLink {
  href?: string;
  url?: string;
  text?: string;
  title?: string;
  base_domain?: string;
  baseDomain?: string;
  rel?: string;
  intrinsic_score?: number;
  intrinsicScore?: number;
  contextual_score?: number;
  contextualScore?: number;
  total_score?: number;
  totalScore?: number;
  [key: string]: unknown;
}
