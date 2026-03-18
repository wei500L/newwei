import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import {
  buildAutoBrowserHeadersForCrawlOptions,
  mergeBrowserHeaders,
  normalizeBrowserHeaders,
} from "@modular/utils";
import type { AxiosError } from "axios";
import { lastValueFrom, TimeoutError, timeout } from "rxjs";

import {
  validateSsrfUrl,
  validateSsrfUrlAsync,
} from "../../common/validators/ssrf-url.validator";
import { EnvService } from "../config/config.service";

import {
  CrawlSettingsService,
  type CrawlClientSettings,
} from "./crawl-settings.service";
import type {
  CrawlTaskOptions,
  CrawlMultiUrlConfig,
  CrawlUrlMatcher,
  CrawlStrategyOverrides,
  CrawlMarkdownOptions,
  CrawlMarkdownFilter,
  Crawl4aiMedia,
  CrawlProxyConfig,
  CrawlBrowserHeader,
  CrawlBrowserCookie,
  CrawlUserAgentGeneratorConfig,
  CrawlGeolocationConfig,
  CrawlCleanMarkdownOptions,
  CrawlTableExtractionStrategy,
  Crawl4aiTablePayload,
  CrawlVirtualScrollConfig,
  CrawlDeepCrawlComponent,
} from "./crawl.types";
import { Crawl4aiRequestException } from "./crawl4ai.exception";
import { translateLocalhostProxyUrlForCrawl4ai } from "./crawl4ai-proxy";
import { validateJsCodeArray } from "./validators/js-code.validator";

export interface Crawl4aiRequest {
  url: string;
  urls?: string[];
  keywords?: string[];
  options?: CrawlTaskOptions;
  requestTimeoutMs?: number;
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

interface CrawlScanProfile {
  scanFullPage?: boolean;
  virtualScroll?: {
    type: string;
    params: Record<string, unknown>;
  };
  scrollDelaySeconds?: number;
  delayBeforeReturnHtmlMs?: number;
  waitForTimeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  pageTimeoutMs?: number;
  adjustViewportToContent?: boolean;
}

const CRAWL4AI_SSRF_PROXY_AUTH_USER = "__modular_ssrf_proxy__";

@Injectable()
export class Crawl4aiClient {
  private readonly logger = new Logger(Crawl4aiClient.name);
  private lastHealthCheck = 0;

  constructor(
    private readonly http: HttpService,
    private readonly crawlSettings: CrawlSettingsService,
    private readonly env: EnvService,
  ) {}

  async crawl(request: Crawl4aiRequest): Promise<Crawl4aiResponse> {
    const settings = await this.crawlSettings.getSettings();
    const requestTimeoutMs = this.resolveRequestTimeoutMs(request.requestTimeoutMs, settings);
    await this.ensureHealthy(settings);
    await this.validateRequestUrls(request);
    const payload = this.toHttpPayload(request);

    try {
      return await this.sendCrawlRequest(payload, requestTimeoutMs);
    } catch (error) {
      let resolvedError: unknown = error;
      let resolvedPayload: Crawl4aiHttpPayload = payload;
      const compatibilityPayload =
        this.buildPrefetchCompatibilityFallbackPayload(payload, error);
      if (compatibilityPayload) {
        this.logger.warn(
          "crawl4ai server rejected prefetch; retrying without prefetch for compatibility",
        );
        try {
          return await this.sendCrawlRequest(
            compatibilityPayload,
            requestTimeoutMs,
          );
        } catch (retryError) {
          resolvedError = retryError;
          resolvedPayload = compatibilityPayload;
        }
      }

      const scanFallbackPayload = this.buildScanFullPageFallbackPayload(
        request,
        resolvedPayload,
        resolvedError,
      );
      if (scanFallbackPayload) {
        this.logger.warn(
          "scanFullPage failed or timed out; retrying crawl4ai with bounded virtualScroll fallback",
        );
        try {
          return await this.sendCrawlRequest(
            scanFallbackPayload,
            requestTimeoutMs,
          );
        } catch (fallbackError) {
          resolvedError = fallbackError;
        }
      }

      if (resolvedError instanceof TimeoutError) {
        const requestUrl = (request.urls?.[0] ?? request.url ?? "").trim();
        const timeoutMessage = `crawl4ai request timed out after ${requestTimeoutMs}ms`;
        const hints: string[] = [];
        if (request.options?.scanFullPage) {
          hints.push(
            "Hint: scanFullPage can hang on infinite-scroll pages. Consider disabling scanFullPage or switching to virtualScroll (bounded scrollCount).",
          );
        }
        if (
          request.options?.waitForImages ||
          request.options?.includeImages ||
          request.options?.storeMedia
        ) {
          hints.push(
            "Hint: images/media extraction can slow down crawling. Consider disabling waitForImages/includeImages/storeMedia or increasing CRAWL4AI_TIMEOUT_MS.",
          );
        }
        const prefix = requestUrl ? `${requestUrl}: ` : "";
        const messageWithHint =
          hints.length > 0
            ? `${prefix}${timeoutMessage}\n${hints.join("\n")}`
            : `${prefix}${timeoutMessage}`;
        throw new Crawl4aiRequestException(messageWithHint, 408, resolvedError);
      }

      const axiosError = resolvedError as AxiosError<unknown>;
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

      const messageFromPayload = (
        payloadValue: unknown,
      ): string | undefined => {
        if (!payloadValue) {
          return undefined;
        }
        if (typeof payloadValue === "string") {
          return normalizeMessage(payloadValue);
        }
        if (typeof payloadValue !== "object" || Array.isArray(payloadValue)) {
          return undefined;
        }
        const record = payloadValue as Record<string, unknown>;
        const message = normalizeMessage(record.message);
        if (message) {
          return message;
        }
        const detail = normalizeMessage(record.detail);
        if (detail) {
          return detail;
        }
        const inlineError = normalizeMessage(record.error);
        if (inlineError) {
          return inlineError;
        }
        return undefined;
      };

      const payloadMessage = messageFromPayload(responseData);
      const fallback =
        normalizeMessage(axiosError.message) ?? "crawl4ai request failed";
      const normalizedStatus =
        typeof status === "number" && Number.isFinite(status)
          ? Math.round(status)
          : undefined;

      const messageParts = [payloadMessage, fallback].filter(
        (entry): entry is string => Boolean(entry && entry.length > 0),
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
        (normalizedMessage.includes("x11") &&
          normalizedMessage.includes("display"));
      const maybeProxyIssue =
        normalizedMessage.includes("err_proxy_connection_failed") ||
        normalizedMessage.includes("proxy_connection_failed") ||
        normalizedMessage.includes("proxy connection failed") ||
        (normalizedMessage.includes("proxy") &&
          normalizedMessage.includes("connection failed"));
      const hints: string[] = [];
      if (maybeDisplayIssue) {
        hints.push(
          "Hint: crawl4ai may be running with headless=false. Ensure Xvfb/DISPLAY is configured (see infra/docker/docker-compose.yml) or set crawlOptions.headless=true.",
        );
      }
      if (maybeProxyIssue) {
        hints.push(
          "Hint: crawl4ai failed to connect to the proxy. If your proxy is on the Docker host, use host.docker.internal (e.g. http://host.docker.internal:7890) instead of 127.0.0.1/localhost, or disable proxyUrl.",
        );
      }
      const messageWithHint =
        hints.length > 0
          ? `${messageWithStatus}\n${hints.join("\n")}`
          : messageWithStatus;

      throw new Crawl4aiRequestException(
        messageWithHint,
        status,
        resolvedError,
      );
    }
  }

  private resolveRequestTimeoutMs(
    overrideTimeoutMs: number | undefined,
    settings: CrawlClientSettings,
  ) {
    if (
      typeof overrideTimeoutMs === "number" &&
      Number.isFinite(overrideTimeoutMs) &&
      overrideTimeoutMs > 0
    ) {
      return Math.max(1_000, Math.round(overrideTimeoutMs));
    }

    const requestTimeoutNormalMs =
      typeof settings.requestTimeoutNormalMs === "number" &&
      Number.isFinite(settings.requestTimeoutNormalMs) &&
      settings.requestTimeoutNormalMs > 0
        ? settings.requestTimeoutNormalMs
        : settings.requestTimeoutMs;

    return Math.max(1_000, Math.round(requestTimeoutNormalMs));
  }

  private async sendCrawlRequest(
    payload: Crawl4aiHttpPayload,
    requestTimeoutMs: number,
  ): Promise<Crawl4aiResponse> {
    const response = await lastValueFrom(
      this.http
        .post<Crawl4aiResponse>("/crawl", payload, {
          headers: {
            "content-type": "application/json",
          },
          timeout: requestTimeoutMs,
        })
        .pipe(timeout(requestTimeoutMs)),
    );

    return this.normalizeCrawlResponse(response.data);
  }

  private normalizeCrawlResponse(data?: Crawl4aiResponse): Crawl4aiResponse {
    return {
      results: data?.results ?? [],
      nextCursor: data?.nextCursor ?? null,
      runId: data?.runId ?? null,
      warnings: data?.warnings ?? [],
      serverMemoryMb: data?.serverMemoryMb,
      peakMemoryMb: data?.peakMemoryMb,
      memoryEfficiency: data?.memoryEfficiency,
    };
  }

  private buildPrefetchCompatibilityFallbackPayload(
    payload: Crawl4aiHttpPayload,
    error: unknown,
  ): Crawl4aiHttpPayload | null {
    if (!this.isPrefetchFallbackCandidateError(error)) {
      return null;
    }

    const hasPrimaryPrefetch = Object.prototype.hasOwnProperty.call(
      payload.crawler_config.params,
      "prefetch",
    );
    const hasMultiPrefetch =
      payload.crawler_configurations?.some((entry) =>
        Object.prototype.hasOwnProperty.call(entry.params ?? {}, "prefetch"),
      ) ?? false;

    if (!hasPrimaryPrefetch && !hasMultiPrefetch) {
      return null;
    }

    const clonedPayload = this.clonePayload(payload);

    delete (clonedPayload.crawler_config.params as Record<string, unknown>)
      .prefetch;
    if (clonedPayload.crawler_configurations) {
      for (const entry of clonedPayload.crawler_configurations) {
        delete (entry.params as Record<string, unknown>).prefetch;
      }
    }

    return clonedPayload;
  }

  private buildScanFullPageFallbackPayload(
    request: Crawl4aiRequest,
    payload: Crawl4aiHttpPayload,
    error: unknown,
  ): Crawl4aiHttpPayload | null {
    if (!this.isScanFullPageFallbackCandidate(request, payload, error)) {
      return null;
    }

    const clonedPayload = this.clonePayload(payload);
    const crawlerParams = clonedPayload.crawler_config.params as Record<
      string,
      unknown
    >;

    const sourceScrollDelay =
      typeof crawlerParams.scroll_delay === "number" &&
      Number.isFinite(crawlerParams.scroll_delay)
        ? crawlerParams.scroll_delay
        : 0.35;
    const fallbackWaitAfterScroll = Number(
      Math.max(0.2, Math.min(2.5, sourceScrollDelay + 0.15)).toFixed(2),
    );
    const fallbackScrollCount =
      typeof request.options?.virtualScroll?.scrollCount === "number" &&
      Number.isFinite(request.options.virtualScroll.scrollCount)
        ? Math.max(
            4,
            Math.min(60, Math.round(request.options.virtualScroll.scrollCount)),
          )
        : 24;

    crawlerParams.scan_full_page = false;
    delete crawlerParams.scroll_delay;
    crawlerParams.virtual_scroll_config = {
      type: "VirtualScrollConfig",
      params: this.compact({
        container_selector: "body",
        scroll_count: fallbackScrollCount,
        scroll_by: "page_height",
        wait_after_scroll: fallbackWaitAfterScroll,
      }),
    };

    if (typeof crawlerParams.adjust_viewport_to_content !== "boolean") {
      crawlerParams.adjust_viewport_to_content = true;
    }

    if (
      typeof crawlerParams.wait_until !== "string" ||
      crawlerParams.wait_until === "networkidle"
    ) {
      crawlerParams.wait_until = "domcontentloaded";
    }

    const waitForTimeout = crawlerParams.wait_for_timeout;
    if (
      typeof waitForTimeout !== "number" ||
      !Number.isFinite(waitForTimeout)
    ) {
      crawlerParams.wait_for_timeout = 8000;
    } else {
      crawlerParams.wait_for_timeout = Math.max(
        3000,
        Math.min(12000, Math.round(waitForTimeout)),
      );
    }

    const pageTimeout = crawlerParams.page_timeout;
    if (typeof pageTimeout !== "number" || !Number.isFinite(pageTimeout)) {
      crawlerParams.page_timeout = 45000;
    } else {
      crawlerParams.page_timeout = Math.max(
        15000,
        Math.min(90000, Math.round(pageTimeout)),
      );
    }

    return clonedPayload;
  }

  private isScanFullPageFallbackCandidate(
    request: Crawl4aiRequest,
    payload: Crawl4aiHttpPayload,
    error: unknown,
  ): boolean {
    if (
      request.options?.scanFullPage !== true ||
      request.options?.virtualScroll
    ) {
      return false;
    }

    const crawlerParams = payload.crawler_config?.params;
    if (!crawlerParams || typeof crawlerParams !== "object") {
      return false;
    }

    const params = crawlerParams as Record<string, unknown>;
    if (params.scan_full_page !== true) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(params, "virtual_scroll_config")) {
      return false;
    }

    if (error instanceof TimeoutError) {
      return true;
    }

    const normalizedMessage = this.extractErrorText(error);
    return (
      normalizedMessage.includes("timeout") ||
      normalizedMessage.includes("timed out") ||
      (normalizedMessage.includes("navigation") &&
        normalizedMessage.includes("timeout")) ||
      normalizedMessage.includes("execution context was destroyed") ||
      normalizedMessage.includes("target closed")
    );
  }

  private clonePayload(payload: Crawl4aiHttpPayload): Crawl4aiHttpPayload {
    return {
      ...payload,
      crawler_config: {
        ...payload.crawler_config,
        params: { ...payload.crawler_config.params },
      },
      crawler_configurations: payload.crawler_configurations
        ? payload.crawler_configurations.map((entry) => ({
            ...entry,
            params: { ...entry.params },
          }))
        : undefined,
    };
  }

  private extractErrorText(error: unknown): string {
    if (!error) {
      return "";
    }
    if (typeof error === "string") {
      return error.toLowerCase();
    }

    const parts: string[] = [];

    if (error instanceof Error && error.message.trim().length > 0) {
      parts.push(error.message.trim());
    }

    if (typeof error === "object") {
      const axiosError = error as AxiosError<unknown>;
      if (
        typeof axiosError.message === "string" &&
        axiosError.message.trim().length > 0
      ) {
        parts.push(axiosError.message.trim());
      }
      const responseData = axiosError.response?.data;
      if (typeof responseData === "string" && responseData.trim().length > 0) {
        parts.push(responseData.trim());
      } else if (
        responseData &&
        typeof responseData === "object" &&
        !Array.isArray(responseData)
      ) {
        const record = responseData as Record<string, unknown>;
        for (const key of ["message", "detail", "error"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim().length > 0) {
            parts.push(value.trim());
          }
        }
      }
    }

    return parts.join("\n").toLowerCase();
  }

  private isPrefetchFallbackCandidateError(error: unknown): boolean {
    if (this.isPrefetchCompatibilityError(error)) {
      return true;
    }

    if (!error || typeof error !== "object") {
      return false;
    }

    const axiosError = error as AxiosError<unknown>;
    return axiosError.response?.status === 500;
  }

  private isPrefetchCompatibilityError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
      return false;
    }

    const axiosError = error as AxiosError<unknown>;
    const messageParts: string[] = [];

    if (
      typeof axiosError.message === "string" &&
      axiosError.message.trim().length > 0
    ) {
      messageParts.push(axiosError.message.trim());
    }

    const responseData = axiosError.response?.data;
    if (typeof responseData === "string" && responseData.trim().length > 0) {
      messageParts.push(responseData.trim());
    } else if (
      responseData &&
      typeof responseData === "object" &&
      !Array.isArray(responseData)
    ) {
      const record = responseData as Record<string, unknown>;
      for (const key of ["message", "detail", "error"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          messageParts.push(value.trim());
        }
      }
    }

    const normalized = messageParts.join("\n").toLowerCase();
    return (
      normalized.includes("unexpected keyword argument") &&
      normalized.includes("prefetch")
    );
  }

  private async ensureHealthy(settings: CrawlClientSettings) {
    const healthTimeoutMs = Math.max(
      1_000,
      Math.round(settings.requestTimeoutNormalMs ?? settings.requestTimeoutMs),
    );
    const now = Date.now();
    if (now - this.lastHealthCheck < settings.healthCheckTtlMs) {
      return;
    }
    try {
      await lastValueFrom(
        this.http
          .get("/health", {
            timeout: healthTimeoutMs,
          })
          .pipe(timeout(healthTimeoutMs)),
      );
      this.lastHealthCheck = now;
    } catch (error) {
      throw new Crawl4aiRequestException(
        "crawl4ai health check failed",
        undefined,
        error,
      );
    }
  }

  private resolveScanProfile(
    options:
      | Pick<
          CrawlTaskOptions,
          | "virtualScroll"
          | "scanFullPage"
          | "scrollDelayMs"
          | "waitUntil"
          | "waitForTimeoutMs"
          | "pageTimeoutMs"
          | "delayBeforeReturnHtmlMs"
          | "adjustViewportToContent"
        >
      | CrawlStrategyOverrides
      | undefined,
    mode: "primary" | "override",
  ): CrawlScanProfile {
    if (!options) {
      return mode === "primary"
        ? {
            scanFullPage: false,
            adjustViewportToContent: false,
          }
        : {};
    }

    const virtualScroll = this.buildVirtualScrollConfig(options.virtualScroll);
    const explicitScanFullPage =
      typeof options.scanFullPage === "boolean"
        ? options.scanFullPage
        : undefined;
    const scanFullPage = virtualScroll
      ? false
      : (explicitScanFullPage ?? (mode === "primary" ? false : undefined));

    const waitUntil =
      options.waitUntil === "domcontentloaded" ||
      options.waitUntil === "load" ||
      options.waitUntil === "networkidle" ||
      options.waitUntil === "commit"
        ? options.waitUntil
        : undefined;

    if (scanFullPage !== true) {
      return {
        scanFullPage,
        virtualScroll,
        waitUntil,
        waitForTimeoutMs: options.waitForTimeoutMs,
        pageTimeoutMs: options.pageTimeoutMs,
        delayBeforeReturnHtmlMs: options.delayBeforeReturnHtmlMs,
        adjustViewportToContent:
          typeof options.adjustViewportToContent === "boolean"
            ? options.adjustViewportToContent
            : mode === "primary"
              ? false
              : undefined,
      };
    }

    const scrollDelayMs =
      typeof options.scrollDelayMs === "number" &&
      Number.isFinite(options.scrollDelayMs)
        ? Math.max(50, Math.min(5000, Math.round(options.scrollDelayMs)))
        : 350;
    const resolvedWaitUntil = waitUntil ?? "domcontentloaded";
    const waitForTimeoutMs =
      typeof options.waitForTimeoutMs === "number" &&
      Number.isFinite(options.waitForTimeoutMs)
        ? Math.max(
            resolvedWaitUntil === "networkidle" ? 5000 : 1000,
            Math.min(60000, Math.round(options.waitForTimeoutMs)),
          )
        : resolvedWaitUntil === "networkidle"
          ? 9000
          : 8000;
    const pageTimeoutMs =
      typeof options.pageTimeoutMs === "number" &&
      Number.isFinite(options.pageTimeoutMs)
        ? Math.max(1000, Math.min(180000, Math.round(options.pageTimeoutMs)))
        : 45000;
    const delayBeforeReturnHtmlMs =
      typeof options.delayBeforeReturnHtmlMs === "number" &&
      Number.isFinite(options.delayBeforeReturnHtmlMs)
        ? Math.max(
            0,
            Math.min(30000, Math.round(options.delayBeforeReturnHtmlMs)),
          )
        : 600;

    return {
      scanFullPage,
      virtualScroll,
      scrollDelaySeconds: Number((scrollDelayMs / 1000).toFixed(2)),
      waitUntil: resolvedWaitUntil,
      waitForTimeoutMs,
      pageTimeoutMs,
      delayBeforeReturnHtmlMs,
      adjustViewportToContent: options.adjustViewportToContent ?? true,
    };
  }

  private async validateRequestUrls(request: Crawl4aiRequest): Promise<void> {
    const urls = (
      request.urls && request.urls.length > 0 ? request.urls : [request.url]
    ).map((entry) => entry.trim());

    for (const url of urls) {
      const syncResult = validateSsrfUrl(url);
      if (!syncResult.valid) {
        this.logger.warn(`SSRF blocked: ${url} - ${syncResult.reason}`);
        throw new Crawl4aiRequestException(
          `URL blocked by SSRF protection: ${syncResult.reason}`,
          400,
        );
      }

      const asyncResult = await validateSsrfUrlAsync(url);
      if (!asyncResult.valid) {
        this.logger.warn(`SSRF blocked after DNS validation: ${url} - ${asyncResult.reason}`);
        throw new Crawl4aiRequestException(
          `URL blocked by SSRF protection: ${asyncResult.reason}`,
          400,
        );
      }
    }
  }

  private toHttpPayload(request: Crawl4aiRequest): Crawl4aiHttpPayload {
    const options = request.options ?? {};
    const urls = (
      request.urls && request.urls.length > 0 ? request.urls : [request.url]
    ).map((entry) => entry.trim());

    // Defense-in-depth: Runtime SSRF validation
    for (const url of urls) {
      const result = validateSsrfUrl(url);
      if (!result.valid) {
        this.logger.warn(`SSRF blocked: ${url} - ${result.reason}`);
        throw new Crawl4aiRequestException(
          `URL blocked by SSRF protection: ${result.reason}`,
          400,
        );
      }
    }

    const useManagedBrowser = options.useManagedBrowser ?? false;
    const headless =
      typeof options.headless === "boolean" ? options.headless : undefined;
    const { proxy, proxyConfig } = this.resolveBrowserProxy(options);
    const multiConfigurations = this.buildMultiConfigurations(options);
    const markdownGenerator = this.buildMarkdownGenerator(options);
    const cleanMarkdown = this.buildCleanMarkdownOptions(options.cleanMarkdown);
    const linkPreviewConfig = this.buildLinkPreviewConfig(options);
    const shouldScoreLinks = options.scoreLinks ?? Boolean(linkPreviewConfig);
    const headers = this.buildHeaderMap(options.browserHeaders, options);
    const cookies = this.buildCookieList(options.browserCookies);
    const userAgent = this.normalizeUserAgent(options.userAgent);
    const userAgentGenerator = this.buildUserAgentGenerator(
      options.userAgentGenerator,
    );
    const geolocation = this.buildGeolocation(options.geolocation);
    const scanProfile = this.resolveScanProfile(options, "primary");
    const virtualScroll = scanProfile.virtualScroll;
    const scanFullPage = scanProfile.scanFullPage ?? false;
    const scrollDelay = scanProfile.scrollDelaySeconds;
    const delayBeforeReturnHtml =
      typeof scanProfile.delayBeforeReturnHtmlMs === "number"
        ? Number(
            (
              Math.max(
                0,
                Math.min(30000, scanProfile.delayBeforeReturnHtmlMs),
              ) / 1000
            ).toFixed(2),
          )
        : undefined;
    const meanDelay =
      typeof options.meanDelayMs === "number"
        ? Number(
            (Math.max(0, Math.min(10000, options.meanDelayMs)) / 1000).toFixed(
              2,
            ),
          )
        : undefined;
    const maxRange =
      typeof options.maxDelayRangeMs === "number"
        ? Number(
            (
              Math.max(0, Math.min(10000, options.maxDelayRangeMs)) / 1000
            ).toFixed(2),
          )
        : undefined;
    const semaphoreCount =
      typeof options.semaphoreCount === "number" &&
      Number.isFinite(options.semaphoreCount)
        ? Math.max(1, Math.min(50, Math.round(options.semaphoreCount)))
        : undefined;
    const pageTimeout =
      typeof scanProfile.pageTimeoutMs === "number" &&
      Number.isFinite(scanProfile.pageTimeoutMs)
        ? Math.max(
            1000,
            Math.min(180000, Math.round(scanProfile.pageTimeoutMs)),
          )
        : undefined;
    const waitUntil = scanProfile.waitUntil;
    const wordCountThreshold = this.normalizeWordCountThreshold(
      options.wordCountThreshold ?? 80,
    );
    const excludeExternalLinks = options.excludeExternalLinks ?? true;
    const removeOverlayElements = options.removeOverlayElements ?? true;
    const processIframes = options.processIframes ?? true;
    const cssSelector = this.normalizeCssSelector(options.cssSelector);
    const excludedTags = this.normalizeSelectorList(options.excludedTags);
    const textMode = options.textMode ?? false;
    const captureScreenshot = options.captureScreenshot ?? false;
    const waitForImages = options.waitForImages ?? false;
    const excludeExternalImages = options.excludeExternalImages ?? false;
    const usePersistentContext =
      useManagedBrowser || Boolean(options.userDataDir);
    const browserConfig = {
      type: "BrowserConfig",
      params: this.compact({
        headless,
        enable_stealth: options.enableStealthMode ?? undefined,
        browser_type: options.enableUndetectedBrowser
          ? "undetected"
          : undefined,
        light_mode: options.includeImages === false ? true : undefined,
        use_managed_browser: useManagedBrowser ? true : undefined,
        use_persistent_context: usePersistentContext ? true : undefined,
        user_data_dir: options.userDataDir,
        proxy,
        proxy_config: proxyConfig,
        headers,
        cookies,
        user_agent: userAgent,
        user_agent_mode: options.userAgentMode,
        user_agent_generator_config: userAgentGenerator,
        storage_state: this.buildStorageState(options.storageState),
      }),
    };
    const deepCrawlStrategy = this.buildDeepCrawlStrategyPayload(options);
    const crawlerConfig = {
      type: "CrawlerRunConfig",
      params: this.compact({
        cache_mode: options.cacheMode ?? "bypass",
        prefetch: options.prefetch ? true : undefined,
        scan_full_page: scanFullPage,
        adjust_viewport_to_content: scanProfile.adjustViewportToContent
          ? true
          : undefined,
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
        wait_for_timeout: this.normalizeWaitForTimeout(
          scanProfile.waitForTimeoutMs,
          waitUntil,
        ),
        wait_until: waitUntil,
        page_timeout: pageTimeout,
        delay_before_return_html: delayBeforeReturnHtml,
        mean_delay: meanDelay,
        max_range: maxRange,
        semaphore_count: semaphoreCount,
        check_robots_txt: false,
        remove_forms: options.removeForms ? true : undefined,
        session_id: options.sessionId,
        table_score_threshold: this.normalizeTableScore(
          options.tableScoreThreshold,
        ),
        table_extraction: this.buildTableExtraction(options.tableExtraction),
        deep_crawl_strategy: deepCrawlStrategy,
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
        ...(cleanMarkdown ?? {}),
      }),
    };
    return {
      urls,
      keywords:
        request.keywords && request.keywords.length > 0
          ? request.keywords
          : undefined,
      browser_config: browserConfig,
      crawler_config: crawlerConfig,
      crawler_configurations:
        multiConfigurations && multiConfigurations.length > 0
          ? multiConfigurations
          : undefined,
    };
  }

  private compact(record: Record<string, unknown>) {
    return Object.entries(record).reduce<Record<string, unknown>>(
      (acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      },
      {},
    );
  }

  private resolveProxyConfig(options: CrawlTaskOptions) {
    if (!options.proxyConfig) {
      return undefined;
    }
    const normalizedServer = translateLocalhostProxyUrlForCrawl4ai(
      options.proxyConfig.server,
      this.env.crawl4aiConfig.baseUrl,
    );
    return {
      server: normalizedServer,
      username: options.proxyConfig.username ?? undefined,
      password: options.proxyConfig.password ?? undefined,
    } satisfies CrawlProxyConfig;
  }

  private resolveProxyUrl(options: CrawlTaskOptions) {
    if (options.proxyConfig) {
      return undefined;
    }
    if (!options.proxyUrl) {
      return undefined;
    }
    return translateLocalhostProxyUrlForCrawl4ai(
      options.proxyUrl,
      this.env.crawl4aiConfig.baseUrl,
    );
  }

  private resolveBrowserProxy(options: CrawlTaskOptions) {
    const directProxyConfig = this.resolveProxyConfig(options);
    const directProxyUrl = this.resolveProxyUrl(options);
    const ssrfProxyUrl = this.normalizeSsrfProxyUrl(
      this.env.crawl4aiConfig.ssrfProxyUrl,
    );

    if (!ssrfProxyUrl) {
      return {
        proxy: directProxyUrl,
        proxyConfig: directProxyConfig,
      };
    }

    const encodedUpstream = this.encodeSsrfProxyUpstream(
      directProxyConfig ??
        (directProxyUrl ? { server: directProxyUrl } : undefined),
    );

    return {
      proxy: undefined,
      proxyConfig: this.compact({
        server: ssrfProxyUrl,
        username: encodedUpstream
          ? CRAWL4AI_SSRF_PROXY_AUTH_USER
          : undefined,
        password: encodedUpstream,
      }),
    };
  }

  private normalizeSsrfProxyUrl(proxyUrl?: string) {
    const normalized = proxyUrl?.trim();
    return normalized && /^https?:\/\//i.test(normalized) ? normalized : undefined;
  }

  private encodeSsrfProxyUpstream(proxyConfig?: CrawlProxyConfig) {
    if (!proxyConfig) {
      return undefined;
    }
    return Buffer.from(JSON.stringify(proxyConfig), "utf8").toString("base64url");
  }

  private buildMarkdownGenerator(options: CrawlTaskOptions) {
    const customStrategy = options.markdownStrategy;
    if (customStrategy && typeof customStrategy.type === "string") {
      const params = this.normalizeCustomParams(customStrategy.params);
      return params && Object.keys(params).length > 0
        ? {
            type: customStrategy.type,
            params,
          }
        : {
            type: customStrategy.type,
          };
    }
    const contentFilter: CrawlMarkdownFilter | undefined =
      options.markdownFilter ??
      (options.onlyMainContent
        ? {
            type: "pruning",
            thresholdType: "dynamic",
            minWordThreshold:
              typeof options.wordCountThreshold === "number"
                ? options.wordCountThreshold
                : undefined,
          }
        : undefined);
    const params = this.compact({
      content_source: options.markdownOptions?.contentSource,
      options: this.buildMarkdownOptionsPayload(options.markdownOptions),
      content_filter: this.buildContentFilterPayload(contentFilter),
    });
    return Object.keys(params).length > 0
      ? {
          type: "DefaultMarkdownGenerator",
          params,
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
          params,
        }
      : {
          type: trimmed,
        };
  }

  private buildDeepCrawlComponent(component?: CrawlDeepCrawlComponent) {
    if (!component || typeof component.type !== "string") {
      return undefined;
    }
    const trimmed = component.type.trim();
    if (!trimmed) {
      return undefined;
    }
    const params = this.normalizeCustomParams(component.params);
    return params && Object.keys(params).length > 0
      ? {
          type: trimmed,
          params,
        }
      : {
          type: trimmed,
        };
  }

  private buildDeepCrawlStrategyPayload(options: CrawlTaskOptions) {
    const strategy = this.buildDeepCrawlComponent(options.deepCrawlStrategy);
    if (!strategy) {
      return undefined;
    }
    const params =
      strategy.params && typeof strategy.params === "object"
        ? { ...strategy.params }
        : {};
    const filterChain = this.buildDeepCrawlComponent(options.filterChain);
    const urlScorer = this.buildDeepCrawlComponent(options.urlScorer);
    const adaptiveCrawling = this.buildDeepCrawlComponent(
      options.adaptiveCrawling,
    );
    if (filterChain && params.filter_chain === undefined) {
      params.filter_chain = filterChain;
    }
    if (urlScorer && params.url_scorer === undefined) {
      params.url_scorer = urlScorer;
    }
    if (adaptiveCrawling && params.adaptive_crawling === undefined) {
      params.adaptive_crawling = adaptiveCrawling;
    }
    return Object.keys(params).length > 0
      ? {
          type: strategy.type,
          params,
        }
      : {
          type: strategy.type,
        };
  }

  private buildMarkdownOptionsPayload(markdownOptions?: CrawlMarkdownOptions) {
    if (!markdownOptions) {
      return undefined;
    }
    const payload = this.compact({
      ignore_links: markdownOptions.ignoreLinks,
      escape_html: markdownOptions.escapeHtml,
      citations: markdownOptions.citations,
      body_width: markdownOptions.bodyWidth,
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
      target_elements:
        options.targetElements && options.targetElements.length > 0
          ? options.targetElements
          : undefined,
      excluded_tags:
        options.excludedTags && options.excludedTags.length > 0
          ? options.excludedTags
          : undefined,
      remove_overlay_elements: options.removeOverlayElements,
      word_count_threshold: options.wordCountThreshold,
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
        typeof config.scrollCount === "number" &&
        Number.isFinite(config.scrollCount)
          ? Math.max(1, Math.min(1000, Math.round(config.scrollCount)))
          : undefined,
      scroll_by: this.normalizeScrollBy(config.scrollBy),
      wait_after_scroll: this.normalizeWaitAfterScroll(
        config.waitAfterScrollMs,
      ),
    });
    return Object.keys(params).length > 0
      ? {
          type: "VirtualScrollConfig",
          params,
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
      score_threshold:
        typeof config.scoreThreshold === "number"
          ? parseFloat(config.scoreThreshold.toFixed(3))
          : undefined,
      verbose: config.verbose,
      include_patterns: this.normalizePatternList(config.includePatterns),
      exclude_patterns: this.normalizePatternList(config.excludePatterns),
    });
    if (Object.keys(params).length === 0) {
      return undefined;
    }
    return {
      type: "LinkPreviewConfig",
      params,
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
      const blockedPatterns = validationResult.blockedPatterns
        .slice(0, 5)
        .join("; ");
      this.logger.warn(`jsCode blocked: ${blockedPatterns}`);
      throw new Crawl4aiRequestException(
        `jsCode contains blocked patterns: ${blockedPatterns}. Only safe DOM operations are allowed.`,
        400,
      );
    }

    // Log warnings if any
    if (validationResult.warnings.length > 0) {
      this.logger.warn(
        `jsCode warnings: ${validationResult.warnings.join("; ")}`,
      );
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
    } | null,
  ) {
    if (!source) {
      return undefined;
    }
    const script =
      typeof source.waitForScript === "string"
        ? source.waitForScript.trim()
        : "";
    if (script.length > 0) {
      return script.startsWith("js:") ? script : `js:${script}`;
    }
    const selector =
      typeof source.waitForSelector === "string"
        ? source.waitForSelector.trim()
        : "";
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

  private normalizeWaitForTimeout(
    value?: number,
    waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit",
  ) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(500, Math.min(60000, Math.round(value)));
    if (waitUntil === "networkidle") {
      return Math.max(5000, clamped);
    }
    return clamped;
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

  private normalizeScrollBy(value?: unknown) {
    if (value === "container_height" || value === "page_height") {
      return value;
    }
    if (value === "viewport") {
      return "page_height";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.min(20000, Math.round(value)));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
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
  }

  private normalizeWaitAfterScroll(value?: number) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return undefined;
    }
    const clamped = Math.max(0, Math.min(60000, value));
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
          min_word_threshold: filter.minWordThreshold,
        }),
      });
    }
    if (filter.type === "bm25") {
      const query =
        typeof filter.userQuery === "string" ? filter.userQuery.trim() : "";
      if (!query) {
        return undefined;
      }
      return this.compact({
        type: "BM25ContentFilter",
        params: this.compact({
          user_query: query,
          bm25_threshold: filter.bm25Threshold,
          language: filter.language,
        }),
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
        const wordCount = this.normalizeWordCountThreshold(
          overrides?.wordCountThreshold,
        );
        const cssSelector = this.normalizeCssSelector(overrides?.cssSelector);
        const excludedTags = this.normalizeSelectorList(
          overrides?.excludedTags,
        );
        const scanProfile = this.resolveScanProfile(overrides, "override");
        const virtualScroll = scanProfile.virtualScroll;
        const scanFullPage = scanProfile.scanFullPage;
        const delayBeforeReturnHtml =
          typeof scanProfile.delayBeforeReturnHtmlMs === "number"
            ? Number(
                (
                  Math.max(
                    0,
                    Math.min(30000, scanProfile.delayBeforeReturnHtmlMs),
                  ) / 1000
                ).toFixed(2),
              )
            : undefined;
        const pageTimeout =
          typeof scanProfile.pageTimeoutMs === "number" &&
          Number.isFinite(scanProfile.pageTimeoutMs)
            ? Math.max(
                1000,
                Math.min(180000, Math.round(scanProfile.pageTimeoutMs)),
              )
            : undefined;
        const waitUntil = scanProfile.waitUntil;
        const meanDelay =
          typeof overrides?.meanDelayMs === "number"
            ? Number(
                (
                  Math.max(0, Math.min(10000, overrides.meanDelayMs)) / 1000
                ).toFixed(2),
              )
            : undefined;
        const maxRange =
          typeof overrides?.maxDelayRangeMs === "number"
            ? Number(
                (
                  Math.max(0, Math.min(10000, overrides.maxDelayRangeMs)) / 1000
                ).toFixed(2),
              )
            : undefined;
        const semaphoreCount =
          typeof overrides?.semaphoreCount === "number" &&
          Number.isFinite(overrides.semaphoreCount)
            ? Math.max(1, Math.min(50, Math.round(overrides.semaphoreCount)))
            : undefined;
        const params = this.compact({
          url_matcher: matcher?.pattern,
          match_mode: matcher?.matchMode,
          cache_mode: overrides?.cacheMode,
          scan_full_page: scanFullPage,
          adjust_viewport_to_content: scanProfile.adjustViewportToContent
            ? true
            : undefined,
          scroll_delay: scanProfile.scrollDelaySeconds,
          simulate_user: overrides?.simulateUser,
          override_navigator: overrides?.overrideNavigator,
          js_code: this.normalizeJsCode(overrides?.jsCode),
          js_only: overrides?.jsOnly ? true : undefined,
          wait_for: this.buildWaitFor(overrides),
          wait_for_timeout: this.normalizeWaitForTimeout(
            scanProfile.waitForTimeoutMs,
            waitUntil,
          ),
          wait_until: waitUntil,
          page_timeout: pageTimeout,
          delay_before_return_html: delayBeforeReturnHtml,
          mean_delay: meanDelay,
          max_range: maxRange,
          semaphore_count: semaphoreCount,
          check_robots_txt: false,
          remove_forms: overrides?.removeForms ? true : undefined,
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
          virtual_scroll_config: virtualScroll,
        });
        if (Object.keys(params).length === 0) {
          return undefined;
        }
        return {
          type: "CrawlerRunConfig",
          params,
        };
      })
      .filter(
        (entry): entry is { type: string; params: Record<string, unknown> } =>
          Boolean(entry),
      );
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
      matchMode: matcher.matchMode,
    };
  }

  private normalizeStrategyOverrides(
    options?: CrawlStrategyOverrides,
  ): CrawlStrategyOverrides | undefined {
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
    const jsCode = this.normalizeJsCode(options.jsCode);
    if (typeof jsCode === "string") {
      normalized.jsCode = [jsCode];
    } else if (Array.isArray(jsCode) && jsCode.length > 0) {
      normalized.jsCode = jsCode;
    }
    if (typeof options.jsOnly === "boolean") {
      normalized.jsOnly = options.jsOnly;
    }
    if (typeof options.waitForSelector === "string") {
      const waitForSelector = options.waitForSelector.trim();
      if (waitForSelector.length > 0) {
        normalized.waitForSelector = waitForSelector.slice(0, 1024);
      }
    }
    if (typeof options.waitForScript === "string") {
      const waitForScript = options.waitForScript.trim();
      if (waitForScript.length > 0) {
        normalized.waitForScript = waitForScript.slice(0, 4000);
      }
    }
    if (typeof options.wordCountThreshold === "number") {
      const wordCount = this.normalizeWordCountThreshold(
        options.wordCountThreshold,
      );
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
    if (
      options.waitUntil === "domcontentloaded" ||
      options.waitUntil === "load" ||
      options.waitUntil === "networkidle" ||
      options.waitUntil === "commit"
    ) {
      normalized.waitUntil = options.waitUntil;
    }
    const waitForTimeoutMs = this.normalizeWaitForTimeout(
      options.waitForTimeoutMs,
      normalized.waitUntil,
    );
    if (waitForTimeoutMs !== undefined) {
      normalized.waitForTimeoutMs = waitForTimeoutMs;
    }
    if (
      typeof options.pageTimeoutMs === "number" &&
      Number.isFinite(options.pageTimeoutMs)
    ) {
      normalized.pageTimeoutMs = Math.max(
        1000,
        Math.min(180000, Math.round(options.pageTimeoutMs)),
      );
    }
    if (
      typeof options.delayBeforeReturnHtmlMs === "number" &&
      Number.isFinite(options.delayBeforeReturnHtmlMs)
    ) {
      normalized.delayBeforeReturnHtmlMs = Math.max(
        0,
        Math.min(30000, Math.round(options.delayBeforeReturnHtmlMs)),
      );
    }
    if (
      typeof options.meanDelayMs === "number" &&
      Number.isFinite(options.meanDelayMs)
    ) {
      normalized.meanDelayMs = Math.max(
        0,
        Math.min(10000, Math.round(options.meanDelayMs)),
      );
    }
    if (
      typeof options.maxDelayRangeMs === "number" &&
      Number.isFinite(options.maxDelayRangeMs)
    ) {
      normalized.maxDelayRangeMs = Math.max(
        0,
        Math.min(10000, Math.round(options.maxDelayRangeMs)),
      );
    }
    if (
      typeof options.semaphoreCount === "number" &&
      Number.isFinite(options.semaphoreCount)
    ) {
      normalized.semaphoreCount = Math.max(
        1,
        Math.min(50, Math.round(options.semaphoreCount)),
      );
    }
    if (typeof options.removeForms === "boolean") {
      normalized.removeForms = options.removeForms;
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
      const virtualScroll = this.buildVirtualScrollConfig(
        options.virtualScroll,
      );
      if (virtualScroll) {
        normalized.virtualScroll = options.virtualScroll;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private buildHeaderMap(
    headers?: CrawlBrowserHeader[],
    options?: CrawlTaskOptions,
  ) {
    const normalizedInputHeaders = normalizeBrowserHeaders(
      (headers ?? []).map((header) => ({
        name: header?.name,
        value: header?.value,
      })),
    );
    const autoHeaders = buildAutoBrowserHeadersForCrawlOptions({
      userAgent: options?.userAgent,
      userAgentMode: options?.userAgentMode,
      userAgentGenerator: options?.userAgentGenerator,
    });
    const mergedHeaders = mergeBrowserHeaders(
      normalizedInputHeaders,
      autoHeaders,
    );
    if (mergedHeaders.length === 0) {
      return undefined;
    }
    return mergedHeaders.reduce<Record<string, string>>((acc, header) => {
      acc[header.name] = header.value;
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
          path: cookie.path,
        }),
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
    const browser = this.normalizeUserAgentGeneratorBrowser(config.browser);
    const operatingSystem = this.normalizeUserAgentGeneratorOs(config.platform);
    const devicePlatform = this.normalizeUserAgentGeneratorPlatform(
      config.deviceType,
    );
    const payload = this.compact({
      browsers: browser ? [browser] : undefined,
      os: operatingSystem ? [operatingSystem] : undefined,
      platforms: devicePlatform ? [devicePlatform] : undefined,
    });
    return Object.keys(payload).length > 0 ? payload : undefined;
  }

  private normalizeUserAgentGeneratorBrowser(
    value?: CrawlUserAgentGeneratorConfig["browser"],
  ) {
    if (!value) {
      return undefined;
    }
    const browserMap: Record<
      NonNullable<CrawlUserAgentGeneratorConfig["browser"]>,
      string
    > = {
      chrome: "Chrome",
      firefox: "Firefox",
      safari: "Safari",
      edge: "Edge",
    };
    return browserMap[value];
  }

  private normalizeUserAgentGeneratorOs(
    value?: CrawlUserAgentGeneratorConfig["platform"],
  ) {
    if (!value) {
      return undefined;
    }
    const platformMap: Record<
      NonNullable<CrawlUserAgentGeneratorConfig["platform"]>,
      string
    > = {
      windows: "Windows",
      macos: "Mac OS X",
      linux: "Linux",
      android: "Android",
      ios: "iOS",
    };
    return platformMap[value];
  }

  private normalizeUserAgentGeneratorPlatform(
    value?: CrawlUserAgentGeneratorConfig["deviceType"],
  ) {
    if (!value) {
      return undefined;
    }
    if (value === "desktop" || value === "mobile" || value === "tablet") {
      return value;
    }
    return undefined;
  }

  private buildGeolocation(config?: CrawlGeolocationConfig) {
    if (!config) {
      return undefined;
    }
    const payload = this.compact({
      latitude: config.latitude,
      longitude: config.longitude,
      accuracy: config.accuracy,
    });
    if (Object.keys(payload).length === 0) {
      return undefined;
    }
    return {
      type: "GeolocationConfig",
      params: payload,
    };
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
