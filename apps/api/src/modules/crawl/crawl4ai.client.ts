import { HttpService } from "@nestjs/axios";
import { Injectable } from "@nestjs/common";
import type { AxiosError } from "axios";
import { lastValueFrom } from "rxjs";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import type {
  CrawlTaskOptions,
  CrawlMultiUrlConfig,
  CrawlUrlMatcher,
  CrawlStrategyOverrides,
  CrawlMarkdownOptions,
  CrawlMarkdownFilter,
  CrawlLinkPreviewOptions,
  Crawl4aiMedia,
  CrawlBrowserHeader,
  CrawlBrowserCookie,
  CrawlUserAgentGeneratorConfig,
  CrawlGeolocationConfig
} from "./crawl.types";

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
  private lastHealthCheck = 0;
  private readonly healthCheckTtlMs = 60_000;

  constructor(private readonly http: HttpService) {}

  async crawl(request: Crawl4aiRequest): Promise<Crawl4aiResponse> {
    await this.ensureHealthy();
    const payload = this.toHttpPayload(request);
    try {
      const response = await lastValueFrom(
        this.http.post<Crawl4aiResponse>("/crawl", payload, {
          headers: {
            "content-type": "application/json"
          }
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
      const axiosError = error as AxiosError<{ message?: string }>;
      const status = axiosError.response?.status;
      const message =
        axiosError.response?.data?.message ||
        axiosError.message ||
        "crawl4ai request failed";
      throw new Crawl4aiRequestException(message, status, error);
    }
  }

  private async ensureHealthy() {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckTtlMs) {
      return;
    }
    try {
      await lastValueFrom(this.http.get("/health"));
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
    const scrollDelay = typeof options.scrollDelayMs === "number" ? options.scrollDelayMs / 1000 : undefined;
    const useManagedBrowser = options.useManagedBrowser ?? false;
    const headless = useManagedBrowser || options.enableUndetectedBrowser || options.enableStealthMode ? false : true;
    const proxyPayload = this.resolveProxyPayload(options);
    const multiConfigurations = this.buildMultiConfigurations(options);
    const markdownGenerator = this.buildMarkdownGenerator(options);
    const linkPreviewConfig = this.buildLinkPreviewConfig(options);
    const shouldScoreLinks = options.scoreLinks ?? Boolean(linkPreviewConfig);
    const headers = this.buildHeaderMap(options.browserHeaders);
    const cookies = this.buildCookieList(options.browserCookies);
    const userAgent = this.normalizeUserAgent(options.userAgent);
    const userAgentGenerator = this.buildUserAgentGenerator(options.userAgentGenerator);
    const geolocation = this.buildGeolocation(options.geolocation);
    const usePersistentContext = useManagedBrowser || Boolean(options.userDataDir);
    const browserConfig = {
      type: "BrowserConfig",
      params: this.compact({
        headless,
        enable_stealth: options.enableStealthMode ?? undefined,
        browser_type: options.enableUndetectedBrowser ? "undetected" : undefined,
        disable_images: options.includeImages === false ? true : undefined,
        emulate_mobile: false,
        use_managed_browser: useManagedBrowser ? true : undefined,
        use_persistent_context: usePersistentContext ? true : undefined,
        user_data_dir: options.userDataDir,
        proxy_config: proxyPayload,
        headers,
        cookies,
        user_agent: userAgent
      })
    };
    const crawlerConfig = {
      type: "CrawlerRunConfig",
      params: this.compact({
        cache_mode: options.cacheMode ?? "bypass",
        only_main_content: options.onlyMainContent ?? true,
        extract_links: options.extractLinks ?? false,
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
        storage_state: this.buildStorageState(options.storageState)
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
      return this.compact({
        server: options.proxyConfig.server,
        username: options.proxyConfig.username ?? undefined,
        password: options.proxyConfig.password ?? undefined
      });
    }
    if (options.proxyUrl) {
      return options.proxyUrl;
    }
    return undefined;
  }

  private buildMarkdownGenerator(options: CrawlTaskOptions) {
    const params = this.compact({
      content_source: options.markdownOptions?.contentSource,
      options: this.buildMarkdownOptionsPayload(options.markdownOptions),
      content_filter: this.buildContentFilterPayload(options.markdownFilter)
    });
    return Object.keys(params).length > 0
      ? {
          type: "DefaultMarkdownGenerator",
          params
        }
      : undefined;
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

  private buildLinkPreviewConfig(options: CrawlTaskOptions) {
    const config = options.linkPreview;
    if (!config) {
      return undefined;
    }
    const params = this.compact({
      include_internal: config.includeInternal,
      include_external: config.includeExternal,
      include_social: config.includeSocial,
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
    const normalized = jsCode
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (normalized.length === 0) {
      return undefined;
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

  private normalizePatternList(patterns?: string[]) {
    if (!patterns || patterns.length === 0) {
      return undefined;
    }
    const normalized = patterns
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    return normalized.length > 0 ? normalized : undefined;
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
          threshold: filter.threshold
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
        const params = this.compact({
          url_matcher: matcher?.pattern,
          match_mode: matcher?.matchMode,
          cache_mode: overrides?.cacheMode,
          only_main_content: overrides?.onlyMainContent,
          extract_links: overrides?.extractLinks,
          scan_full_page: overrides?.scanFullPage,
          adjust_viewport_to_content: overrides?.adjustViewportToContent ? true : undefined,
          scroll_delay:
            typeof overrides?.scrollDelayMs === "number" ? overrides.scrollDelayMs / 1000 : undefined,
          simulate_user: overrides?.simulateUser,
          override_navigator: overrides?.overrideNavigator,
          js_code: this.normalizeJsCode(overrides?.jsCode),
          js_only: overrides?.jsOnly ? true : undefined,
          wait_for: this.buildWaitFor(overrides),
          wait_for_timeout: this.normalizeWaitForTimeout(overrides?.waitForTimeoutMs)
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
