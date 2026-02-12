import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync } from "node:zlib";

import { Crawl4aiClient, type Crawl4aiArticle } from "./crawl4ai.client";
import type {
  CrawlMetadataExtractionInput,
  CrawlMetadataResult,
  CrawlMetadataTag,
  CrawlMetadataSource,
  CrawlTaskOptions,
} from "./crawl.types";

const logger = createLogger({ name: "crawl-metadata" });

interface NormalizedMetadataConfig {
  source: CrawlMetadataSource;
  domain?: string;
  urls?: string[];
  patternMatcher?: (url: string) => boolean;
  maxUrls: number;
  includeJsonLd: boolean;
  includeOpenGraph: boolean;
  includeMeta: boolean;
  concurrency: number;
  queryTokens?: string[];
  scoreThreshold: number;
  requestTimeoutMs: number;
}

interface FetchResponse {
  status: number;
  body: string;
}

@Injectable()
export class CrawlMetadataService {
  private static readonly MAX_PATTERN_LENGTH = 512;
  private static readonly MAX_WILDCARDS = 32;
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    allowBooleanAttributes: true,
    trimValues: true,
  });

  constructor(@Optional() private readonly crawl4ai?: Crawl4aiClient) {}

  async extract(
    input: CrawlMetadataExtractionInput,
  ): Promise<CrawlMetadataResult[]> {
    const config = this.normalizeInput(input);
    const urls = await this.resolveUrls(config);
    if (urls.length === 0) {
      return [];
    }

    const results = await this.mapWithConcurrency(
      urls,
      config.concurrency,
      (url) => this.fetchMetadata(url, config),
    );

    const filtered =
      config.scoreThreshold > 0
        ? results.filter(
            (result) => (result.relevanceScore ?? 0) >= config.scoreThreshold,
          )
        : results;

    return filtered.slice(0, config.maxUrls);
  }

  async discoverSitemapUrls(input: {
    domain?: string;
    pattern?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
  }): Promise<string[]> {
    const domain = this.normalizeDomain(input.domain);
    if (!domain) {
      return [];
    }
    const maxUrls = this.clampNumber(input.maxUrls, 1, 200, 50);
    const patternMatcher = this.normalizePattern(input.pattern);
    const requestTimeoutMs =
      typeof input.requestTimeoutMs === "number" &&
      Number.isFinite(input.requestTimeoutMs)
        ? Math.max(1000, Math.round(input.requestTimeoutMs))
        : 15_000;

    return this.discoverFromSitemaps({
      source: "sitemap",
      domain,
      patternMatcher,
      maxUrls,
      includeJsonLd: false,
      includeOpenGraph: false,
      includeMeta: false,
      concurrency: 1,
      scoreThreshold: 0,
      requestTimeoutMs,
    });
  }

  async discoverRssUrls(input: {
    feedUrl?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
  }): Promise<string[]> {
    const feedUrl = this.normalizeUrl(input.feedUrl);
    if (!feedUrl) {
      return [];
    }

    const maxUrls = this.clampNumber(input.maxUrls, 1, 200, 50);
    const requestTimeoutMs =
      typeof input.requestTimeoutMs === "number" &&
      Number.isFinite(input.requestTimeoutMs)
        ? Math.max(1000, Math.round(input.requestTimeoutMs))
        : 15_000;

    const xml = await this.fetchMaybe(feedUrl, requestTimeoutMs);
    if (!xml) {
      return [];
    }

    return this.extractFromRssPayload(xml, feedUrl).slice(0, maxUrls);
  }

  async discoverListUrls(input: {
    url?: string;
    domain?: string;
    pattern?: string;
    maxUrls?: number;
    listMaxPages?: number;
    listPageConcurrency?: number;
    followPagination?: boolean;
    requestTimeoutMs?: number;
    crawlOptions?: Record<string, unknown>;
  }): Promise<string[]> {
    const seedUrl = this.normalizeUrl(input.url);
    if (!seedUrl) {
      return [];
    }

    const normalizedSeedUrl = (() => {
      try {
        const parsed = new URL(seedUrl);
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return seedUrl;
      }
    })();

    const maxUrls = this.clampNumber(input.maxUrls, 1, 2_000, 200);
    const listMaxPages = this.clampNumber(input.listMaxPages, 1, 20, 6);
    const listPageConcurrency = this.clampNumber(
      input.listPageConcurrency,
      1,
      5,
      2,
    );
    const followPagination = input.followPagination !== false;
    const requestTimeoutMs =
      typeof input.requestTimeoutMs === "number" &&
      Number.isFinite(input.requestTimeoutMs)
        ? Math.max(1000, Math.round(input.requestTimeoutMs))
        : 15_000;

    const domain = this.normalizeDomain(input.domain);
    const patternMatcher = this.normalizePattern(input.pattern);
    const crawlOptions = this.normalizeCrawlOptions(input.crawlOptions);

    const discoveredViaCrawl4ai = await this.discoverListUrlsViaCrawl4ai({
      seedUrl,
      domain,
      maxUrls,
      listMaxPages,
      listPageConcurrency,
      followPagination,
      patternMatcher,
      crawlOptions,
    });
    if (discoveredViaCrawl4ai.length > 0) {
      return discoveredViaCrawl4ai;
    }

    const html = await this.fetchMaybe(seedUrl, requestTimeoutMs);
    if (!html) {
      return [];
    }

    let baseOrigin: string | undefined;
    try {
      baseOrigin = new URL(seedUrl).origin.replace(/\/+$/, "");
    } catch {
      baseOrigin = undefined;
    }
    const allowedOrigin = domain ?? baseOrigin;

    const $ = load(html);
    const urls: string[] = [];
    const seen = new Set<string>();

    $("a[href]").each((_index, element) => {
      const href = $(element).attr("href");
      if (!href) {
        return;
      }
      const trimmed = href.trim();
      if (
        !trimmed ||
        trimmed === "#" ||
        trimmed.toLowerCase().startsWith("javascript:")
      ) {
        return;
      }

      let resolved: URL;
      try {
        resolved = new URL(trimmed, seedUrl);
      } catch {
        return;
      }

      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return;
      }

      resolved.hash = "";

      const absolute = resolved.toString();
      if (absolute === normalizedSeedUrl) {
        return;
      }
      if (
        allowedOrigin &&
        !absolute.startsWith(`${allowedOrigin}/`) &&
        absolute !== allowedOrigin
      ) {
        return;
      }
      if (patternMatcher && !patternMatcher(absolute)) {
        return;
      }
      if (seen.has(absolute)) {
        return;
      }

      seen.add(absolute);
      urls.push(absolute);
    });

    return urls.slice(0, maxUrls);
  }

  private async discoverListUrlsViaCrawl4ai(input: {
    seedUrl: string;
    domain?: string;
    patternMatcher?: (url: string) => boolean;
    maxUrls: number;
    listMaxPages: number;
    listPageConcurrency: number;
    followPagination: boolean;
    crawlOptions?: CrawlTaskOptions;
  }): Promise<string[]> {
    if (!this.crawl4ai) {
      return [];
    }

    let allowedOrigin: string | undefined;
    try {
      allowedOrigin = (input.domain ?? new URL(input.seedUrl).origin).replace(
        /\/+$/,
        "",
      );
    } catch {
      allowedOrigin = input.domain?.replace(/\/+$/, "") ?? undefined;
    }

    const normalizedSeedUrl =
      this.normalizeUrlForComparison(input.seedUrl) ?? input.seedUrl;

    try {
      const crawlOptions: CrawlTaskOptions = {
        ...(input.crawlOptions ?? {}),
        extractLinks: true,
        prefetch: true,
      };
      const pendingListPages: string[] = [input.seedUrl];
      const pendingListPageSet = new Set<string>([normalizedSeedUrl]);
      const visitedListPages = new Set<string>();
      const discoveredArticleUrls: string[] = [];
      const discoveredArticleSet = new Set<string>();

      while (
        pendingListPages.length > 0 &&
        visitedListPages.size < input.listMaxPages &&
        discoveredArticleUrls.length < input.maxUrls
      ) {
        const availableSlots = input.listMaxPages - visitedListPages.size;
        const batchSize = Math.max(
          1,
          Math.min(
            input.listPageConcurrency,
            pendingListPages.length,
            availableSlots,
          ),
        );
        const batch = pendingListPages.splice(0, batchSize);
        for (const pageUrl of batch) {
          const normalized = this.normalizeUrlForComparison(pageUrl) ?? pageUrl;
          pendingListPageSet.delete(normalized);
        }

        const batchResults = await this.mapWithConcurrency(
          batch,
          batchSize,
          async (listPageUrl) => {
            const normalizedListPageUrl =
              this.normalizeUrlForComparison(listPageUrl) ?? listPageUrl;
            const response = await this.crawl4ai!.crawl({
              url: listPageUrl,
              options: crawlOptions,
            });

            const article = this.selectDiscoveryResultArticle(
              response.results,
              normalizedListPageUrl,
            );
            if (!article || article.success !== true) {
              return {
                listPageUrl,
                normalizedListPageUrl,
                articleUrls: [] as string[],
                paginationUrls: [] as string[],
              };
            }

            const linksRecord = this.normalizeLinkRecord(article.links);
            if (!linksRecord) {
              return {
                listPageUrl,
                normalizedListPageUrl,
                articleUrls: [] as string[],
                paginationUrls: [] as string[],
              };
            }

            const articleUrls: string[] = [];
            const paginationUrls: string[] = [];
            const seenArticleUrls = new Set<string>();
            const seenPaginationUrls = new Set<string>();
            const values = Object.values(linksRecord).flatMap((value) =>
              Array.isArray(value) ? value : [],
            );

            for (const entry of values) {
              if (!this.isPlainObject(entry)) {
                continue;
              }

              const rawHref =
                typeof entry.href === "string"
                  ? entry.href
                  : typeof entry.url === "string"
                    ? entry.url
                    : "";
              const trimmedHref = rawHref.trim();
              if (
                !trimmedHref ||
                trimmedHref === "#" ||
                trimmedHref.toLowerCase().startsWith("javascript:")
              ) {
                continue;
              }

              let resolved: URL;
              try {
                resolved = new URL(trimmedHref, listPageUrl);
              } catch {
                continue;
              }
              if (
                resolved.protocol !== "http:" &&
                resolved.protocol !== "https:"
              ) {
                continue;
              }
              resolved.hash = "";

              const absolute = resolved.toString();
              if (
                absolute === normalizedListPageUrl ||
                absolute === normalizedSeedUrl
              ) {
                continue;
              }
              if (
                allowedOrigin &&
                !absolute.startsWith(`${allowedOrigin}/`) &&
                absolute !== allowedOrigin
              ) {
                continue;
              }

              const anchorText =
                typeof entry.text === "string"
                  ? entry.text
                  : typeof entry.title === "string"
                    ? entry.title
                    : "";
              const rel = typeof entry.rel === "string" ? entry.rel : "";

              const matchesPattern = input.patternMatcher
                ? input.patternMatcher(absolute)
                : true;
              const isPagination = this.isLikelyPaginationLink({
                candidateUrl: absolute,
                currentPageUrl: listPageUrl,
                anchorText,
                rel,
              });

              if (
                matchesPattern &&
                (!isPagination || !input.followPagination)
              ) {
                if (!seenArticleUrls.has(absolute)) {
                  seenArticleUrls.add(absolute);
                  articleUrls.push(absolute);
                }
                continue;
              }

              if (!input.patternMatcher && !isPagination) {
                if (!seenArticleUrls.has(absolute)) {
                  seenArticleUrls.add(absolute);
                  articleUrls.push(absolute);
                }
                continue;
              }

              if (
                input.followPagination &&
                isPagination &&
                !seenPaginationUrls.has(absolute)
              ) {
                seenPaginationUrls.add(absolute);
                paginationUrls.push(absolute);
              }
            }

            return {
              listPageUrl,
              normalizedListPageUrl,
              articleUrls,
              paginationUrls,
            };
          },
        );

        for (const result of batchResults) {
          visitedListPages.add(result.normalizedListPageUrl);

          for (const articleUrl of result.articleUrls) {
            if (discoveredArticleSet.has(articleUrl)) {
              continue;
            }
            discoveredArticleSet.add(articleUrl);
            discoveredArticleUrls.push(articleUrl);
            if (discoveredArticleUrls.length >= input.maxUrls) {
              break;
            }
          }
          if (discoveredArticleUrls.length >= input.maxUrls) {
            break;
          }

          if (!input.followPagination) {
            continue;
          }

          for (const paginationUrl of result.paginationUrls) {
            if (
              visitedListPages.size + pendingListPages.length >=
              input.listMaxPages
            ) {
              break;
            }
            const normalizedPaginationUrl =
              this.normalizeUrlForComparison(paginationUrl) ?? paginationUrl;
            if (
              visitedListPages.has(normalizedPaginationUrl) ||
              pendingListPageSet.has(normalizedPaginationUrl)
            ) {
              continue;
            }
            pendingListPageSet.add(normalizedPaginationUrl);
            pendingListPages.push(paginationUrl);
          }
        }
      }

      return discoveredArticleUrls.slice(0, input.maxUrls);
    } catch (error) {
      logger.warn(
        { seedUrl: input.seedUrl, error },
        "crawl4ai list discovery failed; falling back to raw HTML parsing",
      );
      return [];
    }
  }

  private isLikelyPaginationLink(input: {
    candidateUrl: string;
    currentPageUrl: string;
    anchorText?: string;
    rel?: string;
  }) {
    const normalizedText = (input.anchorText ?? "").trim().toLowerCase();
    const normalizedRel = (input.rel ?? "").trim().toLowerCase();

    if (normalizedRel.includes("next") || normalizedRel.includes("prev")) {
      return true;
    }

    if (
      /^(next|older|more|load\s*more|next\s*page|previous|prev|newer)\b/.test(
        normalizedText,
      )
    ) {
      return true;
    }

    let candidate: URL;
    let current: URL;
    try {
      candidate = new URL(input.candidateUrl);
      current = new URL(input.currentPageUrl);
    } catch {
      return false;
    }

    if (candidate.origin !== current.origin) {
      return false;
    }

    if (
      candidate.pathname === current.pathname &&
      candidate.search === current.search
    ) {
      return false;
    }

    const combined = `${candidate.pathname.toLowerCase()}${candidate.search.toLowerCase()}`;
    if (
      /(?:^|\/)page(?:\/|=|\?|$)/.test(combined) ||
      /(?:[?&])(page|p|pg|offset|start|cursor)=/.test(combined)
    ) {
      return true;
    }

    if (
      /\/latest(?:\/|$)/.test(candidate.pathname.toLowerCase()) &&
      candidate.search.length > 0
    ) {
      return true;
    }

    return false;
  }

  private normalizeLinkRecord(
    value: unknown,
  ): Record<string, unknown[]> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown[]> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (Array.isArray(entry)) {
        normalized[key] = entry;
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private selectDiscoveryResultArticle(
    results: Crawl4aiArticle[] | undefined,
    normalizedSeedUrl: string,
  ) {
    if (!results || results.length === 0) {
      return undefined;
    }
    const successful = results.filter((entry) => entry.success === true);
    const matched = successful.find(
      (entry) =>
        this.normalizeUrlForComparison(entry.url) === normalizedSeedUrl,
    );
    return matched ?? successful[0] ?? results[0];
  }

  private normalizeUrlForComparison(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private normalizeCrawlOptions(value: unknown): CrawlTaskOptions | undefined {
    const options =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as CrawlTaskOptions)
        : {};
    const waitUntil =
      options.waitUntil === "domcontentloaded" ||
      options.waitUntil === "load" ||
      options.waitUntil === "networkidle" ||
      options.waitUntil === "commit"
        ? options.waitUntil
        : "networkidle";
    const waitForTimeoutMsRaw =
      typeof options.waitForTimeoutMs === "number" &&
      Number.isFinite(options.waitForTimeoutMs)
        ? Math.max(500, Math.min(60000, Math.round(options.waitForTimeoutMs)))
        : 12_000;
    const waitForTimeoutMs =
      waitUntil === "networkidle" && typeof waitForTimeoutMsRaw === "number"
        ? Math.max(5000, waitForTimeoutMsRaw)
        : waitForTimeoutMsRaw;
    const pageTimeoutMs =
      typeof options.pageTimeoutMs === "number" &&
      Number.isFinite(options.pageTimeoutMs)
        ? Math.max(1000, Math.min(180000, Math.round(options.pageTimeoutMs)))
        : 90_000;
    const delayBeforeReturnHtmlMs =
      typeof options.delayBeforeReturnHtmlMs === "number" &&
      Number.isFinite(options.delayBeforeReturnHtmlMs)
        ? Math.max(
            0,
            Math.min(30000, Math.round(options.delayBeforeReturnHtmlMs)),
          )
        : 2_000;
    const meanDelayMs =
      typeof options.meanDelayMs === "number" &&
      Number.isFinite(options.meanDelayMs)
        ? Math.max(0, Math.min(10_000, Math.round(options.meanDelayMs)))
        : 1_000;
    const maxDelayRangeMs =
      typeof options.maxDelayRangeMs === "number" &&
      Number.isFinite(options.maxDelayRangeMs)
        ? Math.max(0, Math.min(10_000, Math.round(options.maxDelayRangeMs)))
        : 2_000;
    const scanVirtualScroll =
      options.virtualScroll && typeof options.virtualScroll === "object"
        ? options.virtualScroll
        : {
            containerSelector: "body",
            scrollCount: 8,
            scrollBy: "page_height" as const,
            waitAfterScrollMs: 700,
          };
    const normalizedUserAgent =
      typeof options.userAgent === "string" &&
      options.userAgent.trim().length > 0
        ? options.userAgent.trim()
        : undefined;
    const enableStealthMode =
      typeof options.enableStealthMode === "boolean"
        ? options.enableStealthMode
        : false;
    const simulateUser =
      typeof options.simulateUser === "boolean"
        ? options.simulateUser
        : enableStealthMode;
    const overrideNavigator =
      typeof options.overrideNavigator === "boolean"
        ? options.overrideNavigator
        : enableStealthMode;
    const userAgentMode = normalizedUserAgent
      ? undefined
      : options.userAgentMode === "random"
        ? "random"
        : undefined;

    return {
      ...options,
      additionalUrls: undefined,
      multiUrlConfigs: undefined,
      extractLinks: true,
      prefetch: true,
      headless:
        typeof options.headless === "boolean" ? options.headless : undefined,
      enableUndetectedBrowser:
        typeof options.enableUndetectedBrowser === "boolean"
          ? options.enableUndetectedBrowser
          : false,
      enableStealthMode,
      simulateUser,
      overrideNavigator,
      userAgent: normalizedUserAgent,
      userAgentMode,
      waitUntil,
      waitForTimeoutMs,
      pageTimeoutMs,
      delayBeforeReturnHtmlMs,
      meanDelayMs,
      maxDelayRangeMs,
      removeOverlayElements:
        typeof options.removeOverlayElements === "boolean"
          ? options.removeOverlayElements
          : true,
      processIframes:
        typeof options.processIframes === "boolean"
          ? options.processIframes
          : true,
      scanFullPage: scanVirtualScroll ? false : options.scanFullPage,
      virtualScroll: scanVirtualScroll,
    };
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  private normalizeInput(
    input: CrawlMetadataExtractionInput,
  ): NormalizedMetadataConfig {
    const source: CrawlMetadataSource =
      input.source === "urls" ? "urls" : "sitemap";
    const domain = this.normalizeDomain(input.domain);
    const urls = this.normalizeUrlList(input.urls);
    const patternMatcher = this.normalizePattern(input.pattern);
    const maxUrls = this.clampNumber(input.maxUrls, 1, 200, 50);
    const includeJsonLd = input.extractJsonLd ?? true;
    const includeOpenGraph = input.extractOpenGraph ?? true;
    const includeMeta = input.extractStandardMeta ?? true;
    const concurrency = this.clampNumber(input.concurrency, 1, 10, 5);
    const queryTokens = this.tokenizeQuery(input.query);
    const scoreThreshold =
      typeof input.scoreThreshold === "number" &&
      Number.isFinite(input.scoreThreshold)
        ? Math.max(0, Math.min(1, Number(input.scoreThreshold.toFixed(3))))
        : 0;

    if (source === "sitemap" && !domain) {
      throw new BadRequestException(
        "domain is required when source is sitemap",
      );
    }
    if (source === "urls" && (!urls || urls.length === 0)) {
      throw new BadRequestException("urls are required when source is urls");
    }

    return {
      source,
      domain,
      urls,
      patternMatcher,
      maxUrls,
      includeJsonLd,
      includeOpenGraph,
      includeMeta,
      concurrency,
      queryTokens,
      scoreThreshold,
      requestTimeoutMs: 15_000,
    };
  }

  private normalizeDomain(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const hasProtocol = /^https?:\/\//i.test(trimmed);
    const candidate = hasProtocol ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(candidate);
      return parsed.origin.replace(/\/+$/, "");
    } catch (error) {
      logger.warn(
        { domain: value, error },
        "Failed to normalize metadata domain",
      );
      return undefined;
    }
  }

  private normalizeUrl(value?: string) {
    if (!value) {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      return new URL(trimmed).toString();
    } catch {
      const withProtocol = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      try {
        return new URL(withProtocol).toString();
      } catch (error) {
        logger.warn({ url: value, error }, "Failed to normalize metadata URL");
        return undefined;
      }
    }
  }

  private normalizeUrlList(urls?: string[]) {
    if (!urls || urls.length === 0) {
      return undefined;
    }
    const normalized = urls
      .map((item) => {
        if (!item) {
          return null;
        }
        try {
          const parsed = new URL(item);
          return parsed.toString();
        } catch {
          return null;
        }
      })
      .filter((item): item is string => Boolean(item));
    const unique = Array.from(new Set(normalized));
    return unique.length > 0 ? unique : undefined;
  }

  private normalizePattern(pattern?: string) {
    if (!pattern) {
      return undefined;
    }
    const trimmed = pattern.trim();
    if (!trimmed) {
      return undefined;
    }

    if (trimmed.length > CrawlMetadataService.MAX_PATTERN_LENGTH) {
      logger.warn(
        { patternLength: trimmed.length },
        "Rejected metadata pattern: exceeds max length",
      );
      return undefined;
    }

    const wildcardCount = (trimmed.match(/[*?]/g) ?? []).length;
    if (wildcardCount > CrawlMetadataService.MAX_WILDCARDS) {
      logger.warn(
        { wildcardCount },
        "Rejected metadata pattern: exceeds max wildcard count",
      );
      return undefined;
    }

    const normalizedPattern = trimmed.toLowerCase();
    return (url: string) =>
      this.wildcardMatch(normalizedPattern, url.toLowerCase());
  }

  private wildcardMatch(pattern: string, input: string) {
    let patternIndex = 0;
    let inputIndex = 0;
    let starIndex = -1;
    let matchIndex = 0;

    while (inputIndex < input.length) {
      const patternChar =
        patternIndex < pattern.length ? pattern[patternIndex] : undefined;

      if (patternChar === "?" || patternChar === input[inputIndex]) {
        patternIndex += 1;
        inputIndex += 1;
        continue;
      }

      if (patternChar === "*") {
        starIndex = patternIndex;
        matchIndex = inputIndex;
        patternIndex += 1;
        continue;
      }

      if (starIndex !== -1) {
        patternIndex = starIndex + 1;
        matchIndex += 1;
        inputIndex = matchIndex;
        continue;
      }

      return false;
    }

    while (patternIndex < pattern.length && pattern[patternIndex] === "*") {
      patternIndex += 1;
    }

    return patternIndex === pattern.length;
  }

  private clampNumber(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  private tokenizeQuery(query?: string) {
    if (!query) {
      return undefined;
    }
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    return tokens.length > 0 ? tokens : undefined;
  }

  private async resolveUrls(config: NormalizedMetadataConfig) {
    if (config.source === "urls" && config.urls) {
      return config.urls.slice(0, config.maxUrls);
    }
    if (!config.domain) {
      return [];
    }
    return this.discoverFromSitemaps(config);
  }

  private async discoverFromSitemaps(config: NormalizedMetadataConfig) {
    if (!config.domain) {
      return [];
    }
    const seeds = ["sitemap.xml", "sitemap_index.xml", "sitemap-index.xml"];
    const collected = new Set<string>();

    for (const seed of seeds) {
      if (collected.size >= config.maxUrls) {
        break;
      }
      const sitemapUrl = this.joinUrl(config.domain, seed);
      const xml = await this.fetchMaybe(sitemapUrl, config.requestTimeoutMs);
      if (!xml) {
        continue;
      }
      await this.extractFromSitemapPayload(xml, config, collected);
    }

    return Array.from(collected).slice(0, config.maxUrls);
  }

  private async extractFromSitemapPayload(
    xml: string,
    config: NormalizedMetadataConfig,
    collected: Set<string>,
  ) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      logger.warn({ error }, "Failed to parse sitemap xml");
      return;
    }
    if (parsed?.urlset) {
      const urlset = parsed.urlset as { url?: unknown } | undefined;
      const urlEntries = urlset?.url;
      const urls = Array.isArray(urlEntries)
        ? urlEntries
        : urlEntries
          ? [urlEntries]
          : [];
      for (const entry of urls) {
        const record =
          entry && typeof entry === "object"
            ? (entry as { loc?: unknown })
            : null;
        if (!record) {
          continue;
        }
        const loc =
          typeof record.loc === "string" ? record.loc.trim() : undefined;
        if (!loc) {
          continue;
        }
        if (
          this.shouldIncludeUrl(loc, config.patternMatcher) &&
          collected.size < config.maxUrls
        ) {
          collected.add(loc);
        }
      }
    }
    const sitemapindex = parsed.sitemapindex as
      | { sitemap?: unknown }
      | undefined;
    const sitemapEntries = sitemapindex?.sitemap;
    if (sitemapEntries) {
      const sites = Array.isArray(sitemapEntries)
        ? sitemapEntries
        : sitemapEntries
          ? [sitemapEntries]
          : [];
      for (const site of sites.slice(0, 5)) {
        const record =
          site && typeof site === "object" ? (site as { loc?: unknown }) : null;
        const loc =
          typeof record?.loc === "string" ? record.loc.trim() : undefined;
        if (!loc) {
          continue;
        }
        if (collected.size >= config.maxUrls) {
          break;
        }
        const xmlChild = await this.fetchMaybe(loc, config.requestTimeoutMs);
        if (xmlChild) {
          await this.extractFromSitemapPayload(xmlChild, config, collected);
        }
      }
    }
  }

  private extractFromRssPayload(xml: string, feedUrl: string): string[] {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      logger.warn({ error }, "Failed to parse RSS xml");
      return [];
    }

    const collected: string[] = [];
    const seen = new Set<string>();

    const toArray = <T>(value: T | T[] | undefined): T[] => {
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    };

    const extractText = (value: unknown): string | undefined => {
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const textCandidate =
          typeof record["#text"] === "string"
            ? record["#text"]
            : typeof record.text === "string"
              ? record.text
              : undefined;
        if (textCandidate) {
          const trimmed = textCandidate.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        const hrefCandidate =
          typeof record.href === "string"
            ? record.href
            : typeof record.url === "string"
              ? record.url
              : undefined;
        if (hrefCandidate) {
          const trimmed = hrefCandidate.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
      }
      return undefined;
    };

    const pushCandidate = (candidate: string | undefined) => {
      if (!candidate) {
        return;
      }
      let resolved: string;
      try {
        resolved = new URL(candidate, feedUrl).toString();
      } catch {
        return;
      }
      if (!/^https?:\/\//i.test(resolved)) {
        return;
      }
      if (seen.has(resolved)) {
        return;
      }
      seen.add(resolved);
      collected.push(resolved);
    };

    // RSS 2.0: rss.channel.item[]
    const rss = parsed.rss as Record<string, unknown> | undefined;
    const channel =
      (rss?.channel as Record<string, unknown> | undefined) ?? undefined;
    const rssItems = toArray(
      (channel?.item as
        | Record<string, unknown>[]
        | Record<string, unknown>
        | undefined) ??
        (rss?.item as
          | Record<string, unknown>[]
          | Record<string, unknown>
          | undefined),
    );

    for (const item of rssItems) {
      const record = item as Record<string, unknown>;
      const link = extractText(record.link);
      if (link) {
        pushCandidate(link);
        continue;
      }
      const guid = extractText(record.guid);
      if (guid && /^https?:\/\//i.test(guid)) {
        pushCandidate(guid);
      }
    }

    // Atom: feed.entry[].link[@href]
    const feed = parsed.feed as Record<string, unknown> | undefined;
    const entries = toArray(
      (feed?.entry as
        | Record<string, unknown>[]
        | Record<string, unknown>
        | undefined) ?? undefined,
    );

    for (const entry of entries) {
      const record = entry as Record<string, unknown>;
      const links = toArray(
        record.link as
          | Record<string, unknown>[]
          | Record<string, unknown>
          | string[]
          | string
          | undefined,
      );

      let picked: string | undefined;
      for (const link of links) {
        if (typeof link === "string") {
          picked = link;
          break;
        }
        if (!link || typeof link !== "object") {
          continue;
        }
        const linkRecord = link as Record<string, unknown>;
        const rel =
          typeof linkRecord.rel === "string" ? linkRecord.rel.trim() : "";
        const href = extractText(linkRecord);
        if (!href) {
          continue;
        }
        if (!rel || rel === "alternate") {
          picked = href;
          break;
        }
      }

      pushCandidate(picked);
    }

    return collected;
  }

  private shouldIncludeUrl(
    url: string,
    patternMatcher?: (url: string) => boolean,
  ) {
    if (!patternMatcher) {
      return true;
    }
    return patternMatcher(url);
  }

  private joinUrl(origin: string, path: string) {
    return `${origin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private async fetchMetadata(
    url: string,
    config: NormalizedMetadataConfig,
  ): Promise<CrawlMetadataResult> {
    try {
      const response = await this.fetchWithStatus(url, config.requestTimeoutMs);
      const parsed = this.parseMetadata(response.body, config);
      const relevanceScore = this.computeRelevance(
        url,
        parsed,
        config.queryTokens,
      );
      return {
        url,
        status: "success",
        httpStatus: response.status,
        fetchedAt: new Date(),
        title: parsed.title,
        description: parsed.description,
        keywords: parsed.keywords,
        author: parsed.author,
        metaTags: parsed.metaTags,
        openGraph: parsed.openGraph,
        jsonLd: parsed.jsonLd,
        relevanceScore,
      };
    } catch (error) {
      logger.warn({ url, error }, "Metadata extraction failed");
      return {
        url,
        status: "failed",
        error:
          error instanceof Error ? error.message : "metadata extraction failed",
        metaTags: [],
        openGraph: [],
        jsonLd: [],
      };
    }
  }

  private parseMetadata(html: string, config: NormalizedMetadataConfig) {
    const $ = load(html);
    const head = $("head");
    const title = head.find("title").first().text().trim() || undefined;
    const metaTags: CrawlMetadataTag[] = [];
    const openGraph: CrawlMetadataTag[] = [];
    let description: string | undefined;
    let keywords: string[] | undefined;
    let author: string | undefined;

    head.find("meta").each((_, element) => {
      const el = $(element);
      const rawName = el.attr("name") || el.attr("property");
      const content = el.attr("content")?.trim();
      if (!rawName || !content) {
        return;
      }
      const name = rawName.trim();
      if (config.includeOpenGraph && /^(og|twitter):/i.test(name)) {
        openGraph.push({ name, value: content });
        return;
      }
      if (config.includeMeta) {
        metaTags.push({ name, value: content });
      }
      const lowered = name.toLowerCase();
      if (lowered === "description" && !description) {
        description = content;
      } else if (lowered === "keywords" && !keywords) {
        keywords = content
          .split(",")
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword.length > 0)
          .slice(0, 15);
      } else if (lowered === "author" && !author) {
        author = content;
      }
    });

    const jsonLd: string[] = [];
    if (config.includeJsonLd) {
      head.find('script[type="application/ld+json"]').each((index, element) => {
        if (jsonLd.length >= 5) {
          return false;
        }
        const raw = $(element).contents().text().trim();
        if (!raw) {
          return true;
        }
        try {
          const parsed = JSON.parse(raw);
          jsonLd.push(JSON.stringify(parsed));
        } catch {
          jsonLd.push(raw);
        }
        return true;
      });
    }

    return {
      title,
      description,
      keywords,
      author,
      metaTags: metaTags.slice(0, 25),
      openGraph: openGraph.slice(0, 25),
      jsonLd,
    };
  }

  private async fetchWithStatus(
    url: string,
    timeoutMs: number,
  ): Promise<FetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent":
            "MetadataBot/1.0 (+https://github.com/unclecode/crawl4ai) crawl-metadata-service",
        },
        signal: controller.signal,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const shouldGunzip =
        url.toLowerCase().endsWith(".gz") ||
        (response.headers
          .get("content-encoding")
          ?.toLowerCase()
          .includes("gzip") ??
          false) ||
        (response.headers.get("content-type")?.toLowerCase().includes("gzip") ??
          false);

      const body = shouldGunzip
        ? this.decodePossiblyGzippedPayload(buffer)
        : buffer.toString("utf8");
      if (!response.ok) {
        throw new Error(
          `Metadata request failed with status ${response.status}`,
        );
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  private decodePossiblyGzippedPayload(buffer: Buffer) {
    try {
      return gunzipSync(buffer).toString("utf8");
    } catch {
      return buffer.toString("utf8");
    }
  }

  private async fetchMaybe(url: string, timeoutMs: number) {
    try {
      const response = await this.fetchWithStatus(url, timeoutMs);
      return response.body;
    } catch (error) {
      logger.debug({ url, error }, "Optional metadata fetch failed");
      return undefined;
    }
  }

  private computeRelevance(
    url: string,
    parsed: ReturnType<typeof this.parseMetadata>,
    tokens?: string[],
  ) {
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    const haystack = [url, parsed.title ?? "", parsed.description ?? ""]
      .join(" ")
      .toLowerCase();
    if (!haystack.trim()) {
      return 0;
    }
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return Number((hits / tokens.length).toFixed(3));
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const limit = Math.max(1, Math.min(concurrency, items.length));

    const runner = async (): Promise<void> => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index]!, index);
      }
    };

    await Promise.all(Array.from({ length: limit }, () => runner()));
    return results;
  }
}
