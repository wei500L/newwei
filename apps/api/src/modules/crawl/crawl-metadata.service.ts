import { createLogger } from "@modular/utils";
import { BadRequestException, Injectable, Optional } from "@nestjs/common";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { CacheService } from "../cache/cache.service";

import type {
  CrawlMetadataExtractionInput,
  CrawlMetadataResult,
  CrawlMetadataTag,
  CrawlMetadataSource,
  CrawlSeedDiscoveryMode,
  CrawlTaskOptions,
} from "./crawl.types";
import { Crawl4aiClient, type Crawl4aiArticle } from "./crawl4ai.client";

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
  freshnessCutoffTs?: number;
}

interface FetchResponse {
  status: number;
  body?: string;
  etag?: string;
  lastModified?: string;
}

interface DiscoveryHttpState {
  etag?: string;
  lastModified?: string;
  body?: string;
  parsedSitemapPayload?: ParsedSitemapPayload;
  updatedAt: number;
}

export type CrawlDiscoveryTimestampSource = "published" | "crawled" | "none";

export interface CrawlDiscoveryPrefetchedArticle {
  title?: string;
  description?: string;
  author?: string;
  markdown?: string;
  publishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CrawlDiscoveryCandidate {
  url: string;
  relevanceScore?: number;
  publishedAtTs?: number;
  crawledAtTs?: number;
  prefetchedArticle?: CrawlDiscoveryPrefetchedArticle;
}

export type CrawlDiscoveryRssBodySourceStrategy =
  | "content_first"
  | "content_only"
  | "summary_only";

export type CrawlDiscoveryRssNoBodyPolicy = "skip" | "title_description_stub";

export interface CrawlDiscoveryRssFetchOptions {
  requestTimeoutMs?: number;
  bodySourceStrategy?: CrawlDiscoveryRssBodySourceStrategy;
  noBodyPolicy?: CrawlDiscoveryRssNoBodyPolicy;
}

interface RssDiscoveryEntry {
  url: string;
  title?: string;
  description?: string;
  author?: string;
  content?: string;
  publishedAtTs?: number;
}

interface ParsedSitemapUrlEntry {
  loc: string;
  lastmodTs?: number;
  newsPublishedAtTs?: number;
}

interface ParsedSitemapIndexEntry {
  loc: string;
  lastmodTs?: number;
}

interface ParsedSitemapPayload {
  urls: ParsedSitemapUrlEntry[];
  childSitemaps: ParsedSitemapIndexEntry[];
}

interface DeepDiscoveryOptions {
  maxPages: number;
  maxDepth: number;
  timeBudgetSeconds: number;
  pageConcurrency: number;
  scoreThreshold: number;
  candidatePoolSize: number;
  headFetchTopK: number;
  preferPathDate: boolean;
  enableSecondaryHubs: boolean;
  ignoreRobotsTxt: boolean;
}

interface DeepDiscoveryCandidate {
  url: string;
  linkScore: number;
  relevanceScore?: number;
  publishedAtTs?: number;
  crawledAtTs?: number;
}

const DEEP_DISCOVERY_ERROR_CODES = {
  crawl4aiUnavailable: "SEED_DEEP_CRAWL4AI_UNAVAILABLE",
  crawlFailed: "SEED_DEEP_CRAWL_FAILED",
  emptyResult: "SEED_DEEP_EMPTY_RESULT",
  noCandidates: "SEED_DEEP_NO_CANDIDATE",
  noPublishedAt: "SEED_DEEP_NO_PUBLISHED_AT",
} as const;
const DISCOVERY_HTTP_STATE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const DISCOVERY_HTTP_STATE_CACHE_KEY_PREFIX = "crawl:discover:http-state";
const RSS_PREFETCH_MAX_MARKDOWN_CHARS = 20_000;
const RSS_PREFETCH_MAX_TITLE_CHARS = 500;
const RSS_PREFETCH_MAX_AUTHOR_CHARS = 200;
const RSS_PREFETCH_MAX_DESCRIPTION_CHARS = 4_000;
const DEFAULT_SITEMAP_SEEDS = [
  "sitemap.xml",
  "sitemap_index.xml",
  "sitemap-index.xml",
  "sitemap-news.xml",
  "news-sitemap.xml",
  "sitemap_news.xml",
  "sitemap-news-index.xml",
  "news-sitemap-index.xml",
  "wp-sitemap.xml",
  "arc/outboundfeeds/news-sitemap-index/?outputType=xml",
  "arc/outboundfeeds/sitemap-index/?outputType=xml",
] as const;

export interface CrawlSitemapDiscoveryDiagnostics {
  discoveryMode: CrawlSeedDiscoveryMode;
  seedMethod: "robots" | "common_paths" | "none";
  robotsUrl?: string;
  robotsDiscoveredSitemaps: string[];
  attemptedSitemaps: string[];
  fetchedSitemaps: string[];
  parsedSitemaps: number;
  candidateCount: number;
}

export interface CrawlSitemapDiscoveryResult {
  candidates: CrawlDiscoveryCandidate[];
  diagnostics: CrawlSitemapDiscoveryDiagnostics;
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

  constructor(
    @Optional() private readonly crawl4ai?: Crawl4aiClient,
    @Optional() private readonly cache?: CacheService,
  ) {}

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
    discoveryMode?: CrawlSeedDiscoveryMode;
  }): Promise<string[]> {
    const discovered = await this.discoverSitemap(input);
    return discovered.candidates.map((candidate) => candidate.url);
  }

  async discoverSitemapCandidates(input: {
    domain?: string;
    pattern?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
    freshnessCutoffTs?: number;
    discoveryMode?: CrawlSeedDiscoveryMode;
  }): Promise<CrawlDiscoveryCandidate[]> {
    const discovered = await this.discoverSitemap(input);
    return discovered.candidates;
  }

  async discoverSitemap(input: {
    domain?: string;
    pattern?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
    freshnessCutoffTs?: number;
    discoveryMode?: CrawlSeedDiscoveryMode;
  }): Promise<CrawlSitemapDiscoveryResult> {
    const domain = this.normalizeDomain(input.domain);
    if (!domain) {
      return {
        candidates: [],
        diagnostics: {
          discoveryMode: this.normalizeSitemapDiscoveryMode(input.discoveryMode),
          seedMethod: "none",
          robotsDiscoveredSitemaps: [],
          attemptedSitemaps: [],
          fetchedSitemaps: [],
          parsedSitemaps: 0,
          candidateCount: 0,
        },
      };
    }
    const maxUrls = this.clampNumber(input.maxUrls, 1, 200, 50);
    const patternMatcher = this.normalizePattern(input.pattern);
    const requestTimeoutMs =
      typeof input.requestTimeoutMs === "number" &&
      Number.isFinite(input.requestTimeoutMs)
        ? Math.max(1000, Math.round(input.requestTimeoutMs))
        : 15_000;
    const freshnessCutoffTs =
      typeof input.freshnessCutoffTs === "number" &&
      Number.isFinite(input.freshnessCutoffTs)
        ? Math.max(0, Math.floor(input.freshnessCutoffTs))
        : undefined;
    const discoveryMode = this.normalizeSitemapDiscoveryMode(input.discoveryMode);
    const diagnostics: CrawlSitemapDiscoveryDiagnostics = {
      discoveryMode,
      seedMethod: "none",
      robotsDiscoveredSitemaps: [],
      attemptedSitemaps: [],
      fetchedSitemaps: [],
      parsedSitemaps: 0,
      candidateCount: 0,
    };

    const candidates = await this.discoverFromSitemapsCandidates(
      {
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
        freshnessCutoffTs,
      },
      {
        discoveryMode,
        diagnostics,
      },
    );

    diagnostics.candidateCount = candidates.length;
    return {
      candidates,
      diagnostics,
    };
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

    return this.extractFromRssPayload(xml, feedUrl)
      .map((entry) => entry.url)
      .slice(0, maxUrls);
  }

  async discoverRssCandidates(input: {
    feedUrl?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
    rssFetch?: CrawlDiscoveryRssFetchOptions;
  }): Promise<CrawlDiscoveryCandidate[]> {
    const crawledAtTs = Date.now();
    const feedUrl = this.normalizeUrl(input.feedUrl);
    if (!feedUrl) {
      return [];
    }

    const maxUrls = this.clampNumber(input.maxUrls, 1, 200, 50);
    const rssFetchOptions = this.normalizeRssFetchOptions(input.rssFetch);
    const requestTimeoutMs =
      typeof input.rssFetch?.requestTimeoutMs === "number" &&
      Number.isFinite(input.rssFetch.requestTimeoutMs)
        ? rssFetchOptions.requestTimeoutMs
        : typeof input.requestTimeoutMs === "number" &&
            Number.isFinite(input.requestTimeoutMs)
          ? Math.max(1000, Math.round(input.requestTimeoutMs))
          : rssFetchOptions.requestTimeoutMs;

    const xml = await this.fetchMaybe(feedUrl, requestTimeoutMs);
    if (!xml) {
      return [];
    }

    return this.extractFromRssPayload(xml, feedUrl)
      .slice(0, maxUrls)
      .map((entry) => {
        const publishedAtTs =
          entry.publishedAtTs ?? this.parsePublishedAtFromUrl(entry.url);
        const prefetchedContent = this.resolveRssPrefetchedContent(
          entry,
          rssFetchOptions,
        );
        return {
          url: entry.url,
          publishedAtTs,
          crawledAtTs,
          prefetchedArticle: prefetchedContent.markdown
            ? {
                title: this.truncateText(
                  entry.title,
                  RSS_PREFETCH_MAX_TITLE_CHARS,
                ),
                description: this.truncateText(
                  entry.description,
                  RSS_PREFETCH_MAX_DESCRIPTION_CHARS,
                ),
                author: this.truncateText(
                  entry.author,
                  RSS_PREFETCH_MAX_AUTHOR_CHARS,
                ),
                markdown: prefetchedContent.markdown,
                publishedAt: this.toIsoTimestamp(publishedAtTs),
                metadata: {
                  source: "rss",
                  markdownSource: prefetchedContent.markdownSource,
                },
              }
            : undefined,
        } satisfies CrawlDiscoveryCandidate;
      });
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
    const candidates = await this.discoverListCandidates(input);
    return candidates.map((candidate) => candidate.url);
  }

  async discoverListCandidates(input: {
    url?: string;
    domain?: string;
    pattern?: string;
    maxUrls?: number;
    listMaxPages?: number;
    listPageConcurrency?: number;
    followPagination?: boolean;
    requestTimeoutMs?: number;
    crawlOptions?: Record<string, unknown>;
  }): Promise<CrawlDiscoveryCandidate[]> {
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
      const crawledAtTs = Date.now();
      return discoveredViaCrawl4ai.map((url) => ({
        url,
        publishedAtTs: this.parsePublishedAtFromUrl(url),
        crawledAtTs,
      }));
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
    const urls: CrawlDiscoveryCandidate[] = [];
    const seen = new Set<string>();
    const crawledAtTs = Date.now();

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
      urls.push({
        url: absolute,
        publishedAtTs: this.parsePublishedAtFromUrl(absolute),
        crawledAtTs,
      });
    });

    return urls.slice(0, maxUrls);
  }

  async discoverDeepUrls(input: {
    url?: string;
    domain?: string;
    pattern?: string;
    query?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
    crawlOptions?: Record<string, unknown>;
    deep?: Partial<DeepDiscoveryOptions> | null;
  }): Promise<string[]> {
    const candidates = await this.discoverDeepCandidates(input);
    return candidates.map((candidate) => candidate.url);
  }

  async discoverDeepCandidates(input: {
    url?: string;
    domain?: string;
    pattern?: string;
    query?: string;
    maxUrls?: number;
    requestTimeoutMs?: number;
    crawlOptions?: Record<string, unknown>;
    deep?: Partial<DeepDiscoveryOptions> | null;
  }): Promise<CrawlDiscoveryCandidate[]> {
    const seedUrl = this.normalizeUrl(input.url);
    if (!seedUrl) {
      return [];
    }

    const maxUrls = this.clampNumber(input.maxUrls, 1, 2_000, 200);
    const requestTimeoutMs =
      typeof input.requestTimeoutMs === "number" &&
      Number.isFinite(input.requestTimeoutMs)
        ? Math.max(1000, Math.round(input.requestTimeoutMs))
        : 15_000;
    const domain = this.normalizeDomain(input.domain);
    const patternMatcher = this.normalizePattern(input.pattern);
    const queryTokens = this.tokenizeQuery(input.query);
    const crawlOptions = this.normalizeCrawlOptions(input.crawlOptions);
    const deep = this.normalizeDeepDiscoveryOptions(input.deep);
    if (!this.crawl4ai) {
      this.throwDeepDiscoveryError(
        DEEP_DISCOVERY_ERROR_CODES.crawl4aiUnavailable,
        "Deep discovery requires crawl4ai service, but crawl4ai client is unavailable.",
      );
    }

    const viaCrawl4ai = await this.discoverDeepCandidatesViaCrawl4ai({
      seedUrl,
      domain,
      maxUrls,
      patternMatcher,
      queryTokens,
      requestTimeoutMs,
      crawlOptions,
      deep,
    });
    if (viaCrawl4ai.length > 0) {
      return viaCrawl4ai;
    }

    this.throwDeepDiscoveryError(
      DEEP_DISCOVERY_ERROR_CODES.emptyResult,
      "Deep discovery did not produce article URLs.",
      "Adjust seed.deep.pattern/maxPages/maxDepth/headFetchTopK and retry.",
    );
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

  private normalizeDeepDiscoveryOptions(
    input?: Partial<DeepDiscoveryOptions> | null,
  ): DeepDiscoveryOptions {
    const value =
      input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const scoreThresholdRaw =
      typeof value.scoreThreshold === "number" &&
      Number.isFinite(value.scoreThreshold)
        ? value.scoreThreshold
        : 0.2;
    return {
      maxPages: this.clampNumber(value.maxPages, 5, 300, 80),
      maxDepth: this.clampNumber(value.maxDepth, 1, 4, 2),
      timeBudgetSeconds: this.clampNumber(value.timeBudgetSeconds, 10, 180, 60),
      pageConcurrency: this.clampNumber(value.pageConcurrency, 1, 6, 2),
      scoreThreshold: Math.max(
        0,
        Math.min(1, Number(scoreThresholdRaw.toFixed(3))),
      ),
      candidatePoolSize: this.clampNumber(
        value.candidatePoolSize,
        20,
        400,
        120,
      ),
      headFetchTopK: this.clampNumber(value.headFetchTopK, 10, 120, 40),
      preferPathDate:
        typeof value.preferPathDate === "boolean" ? value.preferPathDate : true,
      enableSecondaryHubs:
        typeof value.enableSecondaryHubs === "boolean"
          ? value.enableSecondaryHubs
          : true,
      // Crawl4AI client always sends check_robots_txt=false. Keep this hard-locked.
      ignoreRobotsTxt: true,
    };
  }

  private async discoverDeepCandidatesViaCrawl4ai(input: {
    seedUrl: string;
    domain?: string;
    patternMatcher?: (url: string) => boolean;
    queryTokens?: string[];
    requestTimeoutMs: number;
    maxUrls: number;
    crawlOptions?: CrawlTaskOptions;
    deep: DeepDiscoveryOptions;
  }): Promise<CrawlDiscoveryCandidate[]> {
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
    const startedAtMs = Date.now();
    const timeBudgetMs = input.deep.timeBudgetSeconds * 1000;
    const pendingPages: {
      url: string;
      depth: number;
      priority: number;
    }[] = [{ url: input.seedUrl, depth: 0, priority: 1 }];
    const pendingPageSet = new Set<string>([normalizedSeedUrl]);
    const visitedPages = new Set<string>();
    const candidates = new Map<string, DeepDiscoveryCandidate>();
    let pagesCrawled = 0;

    const crawlOptions: CrawlTaskOptions = {
      ...(input.crawlOptions ?? {}),
      extractLinks: true,
      prefetch: true,
      scoreLinks:
        typeof input.crawlOptions?.scoreLinks === "boolean"
          ? input.crawlOptions.scoreLinks
          : true,
    };

    try {
      while (
        pendingPages.length > 0 &&
        pagesCrawled < input.deep.maxPages &&
        Date.now() - startedAtMs < timeBudgetMs
      ) {
        pendingPages.sort((a, b) => b.priority - a.priority);
        const remainingPageBudget = input.deep.maxPages - pagesCrawled;
        const batchSize = Math.max(
          1,
          Math.min(
            input.deep.pageConcurrency,
            pendingPages.length,
            remainingPageBudget,
          ),
        );
        const batch = pendingPages.splice(0, batchSize);
        for (const item of batch) {
          const normalized =
            this.normalizeUrlForComparison(item.url) ?? item.url;
          pendingPageSet.delete(normalized);
        }

        const batchResults = await this.mapWithConcurrency(
          batch,
          batchSize,
          async (current) => {
            const normalizedCurrentUrl =
              this.normalizeUrlForComparison(current.url) ?? current.url;
            const response = await this.crawl4ai!.crawl({
              url: current.url,
              options: crawlOptions,
            });
            const crawledAtTs = Date.now();
            const article = this.selectDiscoveryResultArticle(
              response.results,
              normalizedCurrentUrl,
            );
            if (!article || article.success !== true) {
              return {
                normalizedCurrentUrl,
                nextPages: [] as {
                  url: string;
                  depth: number;
                  priority: number;
                }[],
                discoveredCandidates: [] as DeepDiscoveryCandidate[],
              };
            }

            const linksRecord = this.normalizeLinkRecord(article.links);
            if (!linksRecord) {
              return {
                normalizedCurrentUrl,
                nextPages: [] as {
                  url: string;
                  depth: number;
                  priority: number;
                }[],
                discoveredCandidates: [] as DeepDiscoveryCandidate[],
              };
            }

            const nextPages: {
              url: string;
              depth: number;
              priority: number;
            }[] = [];
            const discoveredCandidates: DeepDiscoveryCandidate[] = [];
            const seenNextPages = new Set<string>();
            const seenCandidates = new Set<string>();
            const values = Object.values(linksRecord).flatMap((value) =>
              Array.isArray(value) ? value : [],
            );

            for (const value of values) {
              if (!this.isPlainObject(value)) {
                continue;
              }
              const normalized = this.normalizeDeepDiscoveryLink(
                value,
                current.url,
              );
              if (!normalized) {
                continue;
              }

              const { url, anchorText, rel, linkScore } = normalized;
              if (url === normalizedSeedUrl || url === normalizedCurrentUrl) {
                continue;
              }
              if (
                allowedOrigin &&
                !url.startsWith(`${allowedOrigin}/`) &&
                url !== allowedOrigin
              ) {
                continue;
              }

              const matchesPattern = input.patternMatcher
                ? input.patternMatcher(url)
                : undefined;
              const isPagination = this.isLikelyPaginationLink({
                candidateUrl: url,
                currentPageUrl: current.url,
                anchorText,
                rel,
              });
              const isHub =
                input.deep.enableSecondaryHubs &&
                this.isLikelySecondaryHubLink(url, anchorText);
              const articleLike =
                typeof matchesPattern === "boolean"
                  ? matchesPattern
                  : this.isLikelyArticleUrl(url);
              const relevanceScore = this.computeLinkRelevance(
                url,
                anchorText,
                input.queryTokens,
              );

              if (articleLike && !seenCandidates.has(url)) {
                seenCandidates.add(url);
                const publishedAtTs = input.deep.preferPathDate
                  ? this.parsePublishedAtFromUrl(url)
                  : undefined;
                discoveredCandidates.push({
                  url,
                  linkScore,
                  relevanceScore,
                  publishedAtTs,
                  crawledAtTs,
                });
              }

              if (
                current.depth >= input.deep.maxDepth ||
                (!isPagination && !isHub)
              ) {
                continue;
              }

              if (seenNextPages.has(url)) {
                continue;
              }
              seenNextPages.add(url);
              nextPages.push({
                url,
                depth: current.depth + 1,
                priority: linkScore + (relevanceScore ?? 0),
              });
            }

            return { normalizedCurrentUrl, nextPages, discoveredCandidates };
          },
        );

        pagesCrawled += batch.length;
        for (const result of batchResults) {
          visitedPages.add(result.normalizedCurrentUrl);

          for (const candidate of result.discoveredCandidates) {
            const existing = candidates.get(candidate.url);
            if (!existing) {
              candidates.set(candidate.url, candidate);
              continue;
            }
            candidates.set(candidate.url, {
              url: candidate.url,
              linkScore: Math.max(existing.linkScore, candidate.linkScore),
              relevanceScore: Math.max(
                existing.relevanceScore ?? 0,
                candidate.relevanceScore ?? 0,
              ),
              publishedAtTs: this.resolveBetterTimestamp(
                existing.publishedAtTs,
                candidate.publishedAtTs,
              ),
              crawledAtTs: this.resolveBetterTimestamp(
                existing.crawledAtTs,
                candidate.crawledAtTs,
              ),
            });
          }

          for (const nextPage of result.nextPages) {
            if (
              visitedPages.size + pendingPages.length >=
              input.deep.maxPages
            ) {
              break;
            }
            const normalizedNext =
              this.normalizeUrlForComparison(nextPage.url) ?? nextPage.url;
            if (
              visitedPages.has(normalizedNext) ||
              pendingPageSet.has(normalizedNext)
            ) {
              continue;
            }
            pendingPageSet.add(normalizedNext);
            pendingPages.push(nextPage);
          }
        }

        if (candidates.size > input.deep.candidatePoolSize * 2) {
          this.trimDeepCandidates(candidates, input.deep.candidatePoolSize);
        }
      }
    } catch (error) {
      logger.warn(
        { seedUrl: input.seedUrl, error },
        "crawl4ai deep discovery failed",
      );
      const reason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : String(error);
      this.throwDeepDiscoveryError(
        DEEP_DISCOVERY_ERROR_CODES.crawlFailed,
        `Deep discovery crawl failed: ${reason}`,
      );
    }

    let ranked = Array.from(candidates.values())
      .filter((candidate) =>
        typeof candidate.publishedAtTs === "number"
          ? true
          : candidate.linkScore >= input.deep.scoreThreshold,
      )
      .sort((a, b) => this.compareDeepCandidates(a, b))
      .slice(0, input.deep.candidatePoolSize);

    if (ranked.length === 0) {
      this.throwDeepDiscoveryError(
        DEEP_DISCOVERY_ERROR_CODES.noCandidates,
        "Deep discovery found no article candidates.",
        "Refine seed URL/pattern or increase discovery limits.",
      );
    }

    const headTargets = ranked
      .filter((candidate) => candidate.publishedAtTs === undefined)
      .slice(0, input.deep.headFetchTopK);
    if (headTargets.length > 0) {
      const publishTimestamps = await this.mapWithConcurrency(
        headTargets,
        Math.max(1, Math.min(input.deep.pageConcurrency, 5)),
        async (candidate) =>
          this.fetchPublishedAtTimestamp(candidate.url, input.requestTimeoutMs),
      );

      for (let index = 0; index < headTargets.length; index += 1) {
        const target = headTargets[index];
        const publishedAtTs = publishTimestamps[index];
        if (!target || !publishedAtTs) {
          continue;
        }
        const existing = candidates.get(target.url);
        if (!existing) {
          continue;
        }
        candidates.set(target.url, {
          ...existing,
          publishedAtTs,
        });
      }

      ranked = Array.from(candidates.values())
        .filter((candidate) =>
          typeof candidate.publishedAtTs === "number"
            ? true
            : candidate.linkScore >= input.deep.scoreThreshold,
        )
        .sort((a, b) => this.compareDeepCandidates(a, b))
        .slice(0, input.deep.candidatePoolSize);
    }

    return ranked.slice(0, input.maxUrls).map((candidate) => ({
      url: candidate.url,
      relevanceScore: candidate.relevanceScore,
      publishedAtTs: candidate.publishedAtTs,
      crawledAtTs: candidate.crawledAtTs,
    }));
  }

  private throwDeepDiscoveryError(
    code: string,
    message: string,
    detail?: string,
  ): never {
    const suffix =
      detail && detail.trim().length > 0 ? ` ${detail.trim()}` : "";
    throw new BadRequestException(`[${code}] ${message}${suffix}`);
  }

  private normalizeDeepDiscoveryLink(
    entry: Record<string, unknown>,
    baseUrl: string,
  ) {
    const hrefRaw =
      typeof entry.href === "string"
        ? entry.href
        : typeof entry.url === "string"
          ? entry.url
          : "";
    const href = hrefRaw.trim();
    if (!href || href === "#" || href.toLowerCase().startsWith("javascript:")) {
      return undefined;
    }

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return undefined;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return undefined;
    }
    resolved.hash = "";

    const anchorText =
      typeof entry.text === "string"
        ? entry.text
        : typeof entry.title === "string"
          ? entry.title
          : "";
    const rel = typeof entry.rel === "string" ? entry.rel : "";
    const linkScore = this.extractDeepLinkScore(entry);
    return {
      url: resolved.toString(),
      anchorText,
      rel,
      linkScore,
    };
  }

  private extractDeepLinkScore(entry: Record<string, unknown>) {
    const raw =
      (typeof entry.total_score === "number" &&
      Number.isFinite(entry.total_score)
        ? entry.total_score
        : undefined) ??
      (typeof entry.totalScore === "number" && Number.isFinite(entry.totalScore)
        ? entry.totalScore
        : undefined) ??
      (typeof entry.contextual_score === "number" &&
      Number.isFinite(entry.contextual_score)
        ? entry.contextual_score
        : undefined) ??
      (typeof entry.contextualScore === "number" &&
      Number.isFinite(entry.contextualScore)
        ? entry.contextualScore
        : undefined) ??
      (typeof entry.intrinsic_score === "number" &&
      Number.isFinite(entry.intrinsic_score)
        ? entry.intrinsic_score
        : undefined) ??
      (typeof entry.intrinsicScore === "number" &&
      Number.isFinite(entry.intrinsicScore)
        ? entry.intrinsicScore
        : undefined);
    if (typeof raw !== "number") {
      return 0;
    }
    if (raw <= 0) {
      return 0;
    }
    if (raw <= 1) {
      return Number(raw.toFixed(3));
    }
    if (raw <= 10) {
      return Number((raw / 10).toFixed(3));
    }
    return 1;
  }

  private computeLinkRelevance(url: string, text: string, tokens?: string[]) {
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    const haystack = `${url} ${text}`.toLowerCase();
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return Number((hits / tokens.length).toFixed(3));
  }

  private trimDeepCandidates(
    candidates: Map<string, DeepDiscoveryCandidate>,
    limit: number,
  ) {
    if (candidates.size <= limit) {
      return;
    }
    const top = Array.from(candidates.values())
      .sort((a, b) => this.compareDeepCandidates(a, b))
      .slice(0, limit);
    candidates.clear();
    for (const candidate of top) {
      candidates.set(candidate.url, candidate);
    }
  }

  private compareDeepCandidates(
    a: DeepDiscoveryCandidate,
    b: DeepDiscoveryCandidate,
  ) {
    const aTs = this.resolveEffectiveTimestamp(a);
    const bTs = this.resolveEffectiveTimestamp(b);
    if (aTs !== bTs) {
      return bTs - aTs;
    }
    if (a.linkScore !== b.linkScore) {
      return b.linkScore - a.linkScore;
    }
    const aRel = a.relevanceScore ?? 0;
    const bRel = b.relevanceScore ?? 0;
    if (aRel !== bRel) {
      return bRel - aRel;
    }
    return a.url.localeCompare(b.url);
  }

  private mergeDiscoveryCandidates(
    existing: CrawlDiscoveryCandidate | undefined,
    incoming: CrawlDiscoveryCandidate,
  ): CrawlDiscoveryCandidate {
    if (!existing) {
      return incoming;
    }
    const maxRelevanceScore = Math.max(
      existing.relevanceScore ?? Number.NEGATIVE_INFINITY,
      incoming.relevanceScore ?? Number.NEGATIVE_INFINITY,
    );
    return {
      url: incoming.url,
      relevanceScore:
        maxRelevanceScore === Number.NEGATIVE_INFINITY
          ? undefined
          : maxRelevanceScore,
      publishedAtTs: this.resolveBetterTimestamp(
        existing.publishedAtTs,
        incoming.publishedAtTs,
      ),
      crawledAtTs: this.resolveBetterTimestamp(
        existing.crawledAtTs,
        incoming.crawledAtTs,
      ),
    };
  }

  private resolveBetterTimestamp(
    first?: number,
    second?: number,
  ): number | undefined {
    const normalizedFirst = this.normalizeTimestamp(first);
    const normalizedSecond = this.normalizeTimestamp(second);
    if (normalizedFirst === undefined) {
      return normalizedSecond;
    }
    if (normalizedSecond === undefined) {
      return normalizedFirst;
    }
    return Math.max(normalizedFirst, normalizedSecond);
  }

  private resolveEffectiveTimestamp(
    candidate: Pick<CrawlDiscoveryCandidate, "publishedAtTs" | "crawledAtTs">,
  ) {
    const publishedAtTs = this.normalizeTimestamp(candidate.publishedAtTs);
    if (typeof publishedAtTs === "number") {
      return publishedAtTs;
    }
    const crawledAtTs = this.normalizeTimestamp(candidate.crawledAtTs);
    if (typeof crawledAtTs === "number") {
      return crawledAtTs;
    }
    return -1;
  }

  private normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    const now = Date.now();
    const normalized = Math.floor(value);
    return normalized > now ? now : normalized;
  }

  private isLikelySecondaryHubLink(url: string, anchorText?: string) {
    if (this.isLikelyArticleUrl(url)) {
      return false;
    }
    const normalizedText = (anchorText ?? "").trim().toLowerCase();
    if (
      /^(latest|news|more|world|politics|business|economy)\b/.test(
        normalizedText,
      )
    ) {
      return true;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    const path = parsed.pathname.toLowerCase();
    const segments = path
      .split("/")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (segments.length === 0 || segments.length > 3) {
      return false;
    }

    const hubTokens = new Set([
      "latest",
      "news",
      "world",
      "politics",
      "business",
      "economy",
      "markets",
      "finance",
      "technology",
      "tech",
      "science",
      "opinion",
      "analysis",
      "europe",
      "international",
      "archive",
      "section",
      "sections",
      "topic",
      "topics",
    ]);
    return segments.some((segment) => hubTokens.has(segment));
  }

  private isLikelyArticleUrl(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    const path = parsed.pathname.toLowerCase();
    if (!path || path === "/") {
      return false;
    }
    if (
      /\.(?:jpg|jpeg|png|gif|webp|svg|pdf|xml|rss|atom|mp4|mp3|zip)$/i.test(
        path,
      )
    ) {
      return false;
    }

    const segments = path
      .split("/")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (segments.length === 0) {
      return false;
    }

    const leadSegments = new Set([
      "article",
      "articles",
      "news",
      "story",
      "stories",
    ]);
    if (segments.some((segment) => leadSegments.has(segment))) {
      return true;
    }
    if (this.parsePublishedAtFromUrl(url)) {
      return true;
    }

    const blockedSegments = new Set([
      "video",
      "videos",
      "photo",
      "photos",
      "gallery",
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
      "newsletter",
      "newsletters",
      "live",
      "latest",
      "archive",
      "category",
      "categories",
    ]);
    if (segments.some((segment) => blockedSegments.has(segment))) {
      return false;
    }

    const slug = segments[segments.length - 1] ?? "";
    const slugParts = slug.split("-").filter((entry) => entry.length > 0);
    return slug.length >= 18 && slugParts.length >= 3;
  }

  private parsePublishedAtFromUrl(url: string) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    const path = parsed.pathname;

    const toUtcTimestamp = (year: number, month: number, day: number) => {
      if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day)
      ) {
        return undefined;
      }
      if (month < 1 || month > 12) {
        return undefined;
      }
      if (day < 1 || day > 31) {
        return undefined;
      }
      const ts = Date.UTC(year, month - 1, day);
      if (!Number.isFinite(ts)) {
        return undefined;
      }
      // Reject rollover values (e.g. 2026-00-99).
      const check = new Date(ts);
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day
      ) {
        return undefined;
      }
      return this.normalizeTimestamp(ts);
    };

    const slashDate = /\/(20\d{2})\/([01]\d)\/([0-3]\d)(?:\/|$)/.exec(path);
    if (slashDate) {
      const year = Number(slashDate[1]);
      const month = Number(slashDate[2]);
      const day = Number(slashDate[3]);
      const ts = toUtcTimestamp(year, month, day);
      if (ts) {
        return ts;
      }
    }
    const dashedDate = /(20\d{2})[-_/.]([01]\d)[-_/.]([0-3]\d)/.exec(path);
    if (dashedDate) {
      const year = Number(dashedDate[1]);
      const month = Number(dashedDate[2]);
      const day = Number(dashedDate[3]);
      const ts = toUtcTimestamp(year, month, day);
      if (ts) {
        return ts;
      }
    }
    return undefined;
  }

  private async fetchPublishedAtTimestamp(url: string, timeoutMs: number) {
    try {
      const response = await this.fetchWithStatus(url, timeoutMs);
      if (typeof response.body !== "string") {
        return undefined;
      }
      return this.extractPublishedAtTimestampFromHtml(response.body);
    } catch {
      return undefined;
    }
  }

  private extractPublishedAtTimestampFromHtml(html: string) {
    const $ = load(html);
    const head = $("head");
    const candidateStrings: string[] = [];
    const pushMeta = (selector: string) => {
      const value = head.find(selector).attr("content");
      if (typeof value === "string" && value.trim().length > 0) {
        candidateStrings.push(value.trim());
      }
    };

    pushMeta('meta[property="article:published_time"]');
    pushMeta('meta[property="og:published_time"]');
    pushMeta('meta[name="pubdate"]');
    pushMeta('meta[name="publishdate"]');
    pushMeta('meta[name="date"]');
    pushMeta('meta[itemprop="datePublished"]');

    const timeTag = $("time[datetime]").first().attr("datetime");
    if (typeof timeTag === "string" && timeTag.trim().length > 0) {
      candidateStrings.push(timeTag.trim());
    }

    const parseTimestamp = (value: string) => {
      return this.normalizeTimestamp(Date.parse(value));
    };
    for (const candidate of candidateStrings) {
      const ts = parseTimestamp(candidate);
      if (ts) {
        return ts;
      }
    }

    const scripts = head.find('script[type="application/ld+json"]');
    for (let index = 0; index < scripts.length && index < 8; index += 1) {
      const raw = scripts.eq(index).contents().text().trim();
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        const found = this.findJsonLdDate(parsed);
        if (found) {
          return found;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private findJsonLdDate(value: unknown): number | undefined {
    const parseTimestamp = (candidate: unknown) => {
      if (typeof candidate !== "string") {
        return undefined;
      }
      return this.normalizeTimestamp(Date.parse(candidate));
    };

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findJsonLdDate(item);
        if (found) {
          return found;
        }
      }
      return undefined;
    }
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const direct = parseTimestamp(record.datePublished);
    if (direct) {
      return direct;
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
      const found = this.findJsonLdDate(nested);
      if (found) {
        return found;
      }
    }
    return undefined;
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
    const candidates = await this.discoverFromSitemapsCandidates(config);
    return candidates.map((candidate) => candidate.url);
  }

  private async discoverFromSitemapsCandidates(
    config: NormalizedMetadataConfig,
    options?: {
      discoveryMode?: CrawlSeedDiscoveryMode;
      diagnostics?: CrawlSitemapDiscoveryDiagnostics;
    },
  ) {
    if (!config.domain) {
      return [];
    }
    const discoveryMode =
      options?.discoveryMode ?? this.normalizeSitemapDiscoveryMode(undefined);
    const diagnostics = options?.diagnostics;
    const sitemapSeeds = await this.resolveSitemapSeedUrls(
      config.domain,
      config.requestTimeoutMs,
      discoveryMode,
      diagnostics,
    );
    const collected = new Map<string, CrawlDiscoveryCandidate>();
    const visitedSitemapUrls = new Set<string>();

    for (const sitemapUrl of sitemapSeeds) {
      if (collected.size >= config.maxUrls) {
        break;
      }
      if (visitedSitemapUrls.has(sitemapUrl)) {
        continue;
      }
      visitedSitemapUrls.add(sitemapUrl);
      diagnostics?.attemptedSitemaps.push(sitemapUrl);
      const xml = await this.fetchMaybe(sitemapUrl, config.requestTimeoutMs);
      if (!xml) {
        continue;
      }
      diagnostics?.fetchedSitemaps.push(sitemapUrl);
      await this.extractFromSitemapPayload(
        sitemapUrl,
        xml,
        config,
        collected,
        visitedSitemapUrls,
        diagnostics,
      );
    }

    return Array.from(collected.values()).slice(0, config.maxUrls);
  }

  private async extractFromSitemapPayload(
    sitemapUrl: string,
    xml: string,
    config: NormalizedMetadataConfig,
    collected: Map<string, CrawlDiscoveryCandidate>,
    visitedSitemapUrls: Set<string>,
    diagnostics?: CrawlSitemapDiscoveryDiagnostics,
  ) {
    const parsed = await this.parseSitemapPayload(sitemapUrl, xml);
    if (!parsed) {
      return;
    }
    if (diagnostics) {
      diagnostics.parsedSitemaps += 1;
    }
    const crawledAtTs = Date.now();

    for (const entry of parsed.urls) {
      if (collected.size >= config.maxUrls) {
        break;
      }
      const normalizedLoc = this.normalizeUrl(entry.loc) ?? entry.loc;
      if (!this.shouldIncludeUrl(normalizedLoc, config.patternMatcher)) {
        continue;
      }

      const publishedAtTs = this.resolveSitemapEntryPublishedAt(entry);
      if (
        typeof config.freshnessCutoffTs === "number" &&
        Number.isFinite(config.freshnessCutoffTs) &&
        typeof publishedAtTs === "number" &&
        Number.isFinite(publishedAtTs) &&
        publishedAtTs < config.freshnessCutoffTs
      ) {
        continue;
      }

      const existing = collected.get(normalizedLoc);
      const candidate: CrawlDiscoveryCandidate = {
        url: normalizedLoc,
        publishedAtTs,
        crawledAtTs,
      };
      collected.set(
        normalizedLoc,
        this.mergeDiscoveryCandidates(existing, candidate),
      );
    }

    for (const child of parsed.childSitemaps) {
      if (collected.size >= config.maxUrls) {
        break;
      }
      if (
        typeof config.freshnessCutoffTs === "number" &&
        Number.isFinite(config.freshnessCutoffTs) &&
        typeof child.lastmodTs === "number" &&
        Number.isFinite(child.lastmodTs) &&
        child.lastmodTs < config.freshnessCutoffTs
      ) {
        continue;
      }

      const normalizedLoc = this.normalizeUrl(child.loc) ?? child.loc;
      if (visitedSitemapUrls.has(normalizedLoc)) {
        continue;
      }
      visitedSitemapUrls.add(normalizedLoc);
      const xmlChild = await this.fetchMaybe(
        normalizedLoc,
        config.requestTimeoutMs,
      );
      if (xmlChild) {
        diagnostics?.attemptedSitemaps.push(normalizedLoc);
        diagnostics?.fetchedSitemaps.push(normalizedLoc);
        await this.extractFromSitemapPayload(
          normalizedLoc,
          xmlChild,
          config,
          collected,
          visitedSitemapUrls,
          diagnostics,
        );
      }
    }
  }

  private normalizeSitemapDiscoveryMode(
    value: unknown,
  ): CrawlSeedDiscoveryMode {
    if (typeof value !== "string") {
      return "robots";
    }
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "robots" ||
      normalized === "common_paths" ||
      normalized === "sitemap_only" ||
      normalized === "disabled"
    ) {
      return normalized;
    }
    return "robots";
  }

  private async resolveSitemapSeedUrls(
    origin: string,
    timeoutMs: number,
    discoveryMode: CrawlSeedDiscoveryMode,
    diagnostics?: CrawlSitemapDiscoveryDiagnostics,
  ) {
    if (discoveryMode === "disabled") {
      return [];
    }
    const robotsUrl = this.joinUrl(origin, "robots.txt");
    if (diagnostics) {
      diagnostics.robotsUrl = robotsUrl;
    }
    const robotsDiscovered =
      discoveryMode === "robots" || discoveryMode === "sitemap_only"
        ? await this.discoverRobotsSitemapUrls(robotsUrl, timeoutMs)
        : [];
    if (robotsDiscovered.length > 0) {
      if (diagnostics) {
        diagnostics.seedMethod = "robots";
      }
      diagnostics?.robotsDiscoveredSitemaps.push(...robotsDiscovered);
      return robotsDiscovered;
    }
    const fallbackSeeds = DEFAULT_SITEMAP_SEEDS.map((seed) =>
      this.joinUrl(origin, seed),
    );
    if (diagnostics) {
      diagnostics.seedMethod = "common_paths";
    }
    return fallbackSeeds;
  }

  private async discoverRobotsSitemapUrls(
    robotsUrl: string,
    timeoutMs: number,
  ) {
    const body = await this.fetchMaybe(robotsUrl, timeoutMs);
    if (typeof body !== "string" || body.trim().length === 0) {
      return [];
    }
    const discovered: string[] = [];
    const seen = new Set<string>();
    for (const line of body.split(/\r?\n/)) {
      const match = line.match(/^\s*Sitemap:\s*(\S+)\s*$/i);
      if (!match) {
        continue;
      }
      const normalized = this.normalizeUrl(match[1]);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      discovered.push(normalized);
      if (discovered.length >= 256) {
        break;
      }
    }
    return discovered;
  }

  private async parseSitemapPayload(sitemapUrl: string, xml: string) {
    const state = await this.readDiscoveryHttpState(sitemapUrl);
    const cachedParsed = this.normalizeParsedSitemapPayload(
      state?.parsedSitemapPayload,
    );
    if (cachedParsed && state?.body === xml) {
      return cachedParsed;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      logger.warn({ sitemapUrl, error }, "Failed to parse sitemap xml");
      return null;
    }

    const toArray = <T>(value: T | T[] | undefined): T[] => {
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    };

    const urls: ParsedSitemapUrlEntry[] = [];
    const urlset = parsed.urlset as { url?: unknown } | undefined;
    for (const entry of toArray(urlset?.url)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const loc = this.extractSitemapText(record.loc);
      if (!loc) {
        continue;
      }
      const lastmodTs = this.parseSitemapTimestamp(record.lastmod);
      const newsPublishedAtTs = this.extractNewsPublicationTimestamp(record);
      urls.push({
        loc,
        lastmodTs,
        newsPublishedAtTs,
      });
    }

    const childSitemaps: ParsedSitemapIndexEntry[] = [];
    const sitemapindex = parsed.sitemapindex as
      | { sitemap?: unknown }
      | undefined;
    for (const entry of toArray(sitemapindex?.sitemap)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const loc = this.extractSitemapText(record.loc);
      if (!loc) {
        continue;
      }
      childSitemaps.push({
        loc,
        lastmodTs: this.parseSitemapTimestamp(record.lastmod),
      });
    }

    const normalized: ParsedSitemapPayload = { urls, childSitemaps };
    await this.writeDiscoveryHttpState(sitemapUrl, {
      etag: state?.etag,
      lastModified: state?.lastModified,
      body: xml,
      parsedSitemapPayload: normalized,
      updatedAt: Date.now(),
    });
    return normalized;
  }

  private normalizeParsedSitemapPayload(
    value: unknown,
  ): ParsedSitemapPayload | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.urls) || !Array.isArray(record.childSitemaps)) {
      return null;
    }

    const urls: ParsedSitemapUrlEntry[] = [];
    for (const item of record.urls) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const entry = item as Record<string, unknown>;
      const loc = typeof entry.loc === "string" ? entry.loc.trim() : "";
      if (!loc) {
        continue;
      }
      urls.push({
        loc,
        lastmodTs: this.normalizeTimestamp(entry.lastmodTs),
        newsPublishedAtTs: this.normalizeTimestamp(entry.newsPublishedAtTs),
      });
    }

    const childSitemaps: ParsedSitemapIndexEntry[] = [];
    for (const item of record.childSitemaps) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const entry = item as Record<string, unknown>;
      const loc = typeof entry.loc === "string" ? entry.loc.trim() : "";
      if (!loc) {
        continue;
      }
      childSitemaps.push({
        loc,
        lastmodTs: this.normalizeTimestamp(entry.lastmodTs),
      });
    }

    return { urls, childSitemaps };
  }

  private extractSitemapText(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const candidate =
        typeof record["#text"] === "string"
          ? record["#text"]
          : typeof record.text === "string"
            ? record.text
            : undefined;
      if (typeof candidate === "string") {
        const trimmed = candidate.trim();
        return trimmed.length > 0 ? trimmed : undefined;
      }
    }
    return undefined;
  }

  private parseSitemapTimestamp(value: unknown): number | undefined {
    const candidate = this.extractSitemapText(value);
    if (!candidate) {
      return undefined;
    }
    return this.normalizeTimestamp(Date.parse(candidate));
  }

  private extractNewsPublicationTimestamp(
    urlEntry: Record<string, unknown>,
  ): number | undefined {
    const newsNode = urlEntry["news:news"];
    const candidates = Array.isArray(newsNode)
      ? newsNode
      : newsNode
        ? [newsNode]
        : [];
    for (const candidate of candidates) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        continue;
      }
      const publicationDate = this.findNewsPublicationDateValue(candidate);
      const ts = this.parseSitemapTimestamp(publicationDate);
      if (typeof ts === "number" && Number.isFinite(ts)) {
        return ts;
      }
    }
    return undefined;
  }

  private findNewsPublicationDateValue(value: unknown): unknown {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findNewsPublicationDateValue(item);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }

    const record = value as Record<string, unknown>;
    if (record["news:publication_date"] !== undefined) {
      return record["news:publication_date"];
    }
    if (record.publication_date !== undefined) {
      return record.publication_date;
    }
    if (record.publicationDate !== undefined) {
      return record.publicationDate;
    }

    for (const nested of Object.values(record)) {
      const found = this.findNewsPublicationDateValue(nested);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  private resolveSitemapEntryPublishedAt(entry: ParsedSitemapUrlEntry) {
    if (
      typeof entry.newsPublishedAtTs === "number" &&
      Number.isFinite(entry.newsPublishedAtTs)
    ) {
      return entry.newsPublishedAtTs;
    }
    if (
      typeof entry.lastmodTs === "number" &&
      Number.isFinite(entry.lastmodTs)
    ) {
      return entry.lastmodTs;
    }
    return undefined;
  }

  private extractFromRssPayload(
    xml: string,
    feedUrl: string,
  ): RssDiscoveryEntry[] {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = this.parser.parse(xml) as Record<string, unknown>;
    } catch (error) {
      logger.warn({ error }, "Failed to parse RSS xml");
      return [];
    }

    const collected: RssDiscoveryEntry[] = [];
    const seen = new Set<string>();

    // RSS 2.0: rss.channel.item[]
    const rss = parsed.rss as Record<string, unknown> | undefined;
    const channel =
      (rss?.channel as Record<string, unknown> | undefined) ?? undefined;
    const rssItems = this.toArray(
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
      const linkRaw =
        this.extractRssText(record.link) ?? this.extractRssText(record.guid);
      this.pushRssDiscoveryEntry({
        feedUrl,
        seen,
        collected,
        rawUrl: linkRaw,
        title: this.extractRssText(record.title),
        description:
          this.extractRssText(record.description) ??
          this.extractRssText(record.summary),
        content:
          this.extractRssText(record["content:encoded"]) ??
          this.extractRssText(record.content),
        author:
          this.extractRssAuthor(record.author) ??
          this.extractRssText(record["dc:creator"]),
        publishedAtTs: this.parseRssTimestamp(
          record.pubDate ??
            record.published ??
            record.updated ??
            record.created ??
            record.issued ??
            record["dc:date"],
        ),
      });
    }

    // Atom: feed.entry[].link[@href]
    const feed = parsed.feed as Record<string, unknown> | undefined;
    const entries = this.toArray(
      (feed?.entry as
        | Record<string, unknown>[]
        | Record<string, unknown>
        | undefined) ?? undefined,
    );

    for (const entry of entries) {
      const record = entry as Record<string, unknown>;
      const links = this.toArray(
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
        const href = this.extractRssText(linkRecord);
        if (!href) {
          continue;
        }
        if (!rel || rel === "alternate") {
          picked = href;
          break;
        }
      }

      this.pushRssDiscoveryEntry({
        feedUrl,
        seen,
        collected,
        rawUrl: picked,
        title: this.extractRssText(record.title),
        description:
          this.extractRssText(record.summary) ??
          this.extractRssText(record.description),
        content: this.extractRssText(record.content),
        author:
          this.extractRssAuthor(record.author) ??
          this.extractRssText(record["dc:creator"]),
        publishedAtTs: this.parseRssTimestamp(
          record.published ??
            record.updated ??
            record.created ??
            record.issued ??
            record["dc:date"],
        ),
      });
    }

    return collected;
  }

  private toArray<T>(value: T | T[] | undefined): T[] {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  private extractRssText(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    const textCandidate =
      typeof record["#text"] === "string"
        ? record["#text"]
        : typeof record.text === "string"
          ? record.text
          : typeof record["#cdata-section"] === "string"
            ? record["#cdata-section"]
            : undefined;
    if (textCandidate) {
      const trimmed = textCandidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
    const hrefCandidate =
      typeof record.href === "string"
        ? record.href
        : typeof record.url === "string"
          ? record.url
          : undefined;
    if (!hrefCandidate) {
      return undefined;
    }
    const trimmed = hrefCandidate.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private extractRssAuthor(value: unknown): string | undefined {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const author = this.extractRssAuthor(entry);
        if (author) {
          return author;
        }
      }
      return undefined;
    }
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    return (
      this.extractRssText(record.name) ??
      this.extractRssText(record["dc:creator"]) ??
      this.extractRssText(record.author)
    );
  }

  private parseRssTimestamp(value: unknown): number | undefined {
    const raw = this.extractRssText(value);
    if (!raw) {
      return undefined;
    }
    return this.normalizeTimestamp(Date.parse(raw));
  }

  private toIsoTimestamp(value?: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    return new Date(value).toISOString();
  }

  private normalizeRssFetchOptions(
    options?: CrawlDiscoveryRssFetchOptions | null,
  ) {
    const requestTimeoutMs =
      typeof options?.requestTimeoutMs === "number" &&
      Number.isFinite(options.requestTimeoutMs)
        ? Math.max(1000, Math.round(options.requestTimeoutMs))
        : 15_000;
    const bodySourceStrategy =
      options?.bodySourceStrategy === "content_only" ||
      options?.bodySourceStrategy === "summary_only"
        ? options.bodySourceStrategy
        : "content_first";
    const noBodyPolicy =
      options?.noBodyPolicy === "title_description_stub"
        ? options.noBodyPolicy
        : "skip";

    return {
      requestTimeoutMs,
      bodySourceStrategy,
      noBodyPolicy,
    } satisfies Required<CrawlDiscoveryRssFetchOptions>;
  }

  private resolveRssPrefetchedContent(
    entry: RssDiscoveryEntry,
    options: Required<CrawlDiscoveryRssFetchOptions>,
  ): {
    markdown?: string;
    markdownSource?: "content" | "description" | "stub";
  } {
    const contentMarkdown = this.toPrefetchedMarkdown(entry.content);
    const descriptionMarkdown = this.toPrefetchedMarkdown(entry.description);

    if (options.bodySourceStrategy === "content_only") {
      if (contentMarkdown) {
        return { markdown: contentMarkdown, markdownSource: "content" };
      }
    } else if (options.bodySourceStrategy === "summary_only") {
      if (descriptionMarkdown) {
        return { markdown: descriptionMarkdown, markdownSource: "description" };
      }
    } else {
      if (contentMarkdown) {
        return { markdown: contentMarkdown, markdownSource: "content" };
      }
      if (descriptionMarkdown) {
        return { markdown: descriptionMarkdown, markdownSource: "description" };
      }
    }

    if (options.noBodyPolicy === "title_description_stub") {
      const stubMarkdown = this.buildRssStubMarkdown({
        title: entry.title,
        description: entry.description,
      });
      if (stubMarkdown) {
        return { markdown: stubMarkdown, markdownSource: "stub" };
      }
    }

    return {};
  }

  private buildRssStubMarkdown(input: {
    title?: string;
    description?: string;
  }) {
    const title = this.truncateText(input.title, RSS_PREFETCH_MAX_TITLE_CHARS);
    const description = this.toPrefetchedMarkdown(input.description);
    if (!title && !description) {
      return undefined;
    }

    const sections: string[] = [];
    if (title) {
      sections.push(`# ${title}`);
    }
    if (description) {
      sections.push(description);
    }
    return sections.join("\n\n").trim() || undefined;
  }

  private toPrefetchedMarkdown(value?: string) {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalizedInput = value.replace(/\r\n?/g, "\n").trim();
    if (!normalizedInput) {
      return undefined;
    }

    let normalized = normalizedInput;
    if (/<[a-z][\s\S]*>/i.test(normalizedInput)) {
      const $ = load(`<body>${normalizedInput}</body>`);
      normalized = $("body").text();
    }

    const collapsed = normalized
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!collapsed) {
      return undefined;
    }

    if (collapsed.length <= RSS_PREFETCH_MAX_MARKDOWN_CHARS) {
      return collapsed;
    }
    return `${collapsed.slice(0, RSS_PREFETCH_MAX_MARKDOWN_CHARS - 1).trimEnd()}…`;
  }

  private truncateText(value: string | undefined, maxChars: number) {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return undefined;
    }
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
  }

  private pushRssDiscoveryEntry(input: {
    feedUrl: string;
    seen: Set<string>;
    collected: RssDiscoveryEntry[];
    rawUrl?: string;
    title?: string;
    description?: string;
    content?: string;
    author?: string;
    publishedAtTs?: number;
  }) {
    if (!input.rawUrl) {
      return;
    }
    let resolved: string;
    try {
      resolved = new URL(input.rawUrl, input.feedUrl).toString();
    } catch {
      return;
    }
    if (!/^https?:\/\//i.test(resolved)) {
      return;
    }
    if (input.seen.has(resolved)) {
      return;
    }
    input.seen.add(resolved);
    input.collected.push({
      url: resolved,
      title: this.truncateText(input.title, RSS_PREFETCH_MAX_TITLE_CHARS),
      description: this.truncateText(
        input.description,
        RSS_PREFETCH_MAX_DESCRIPTION_CHARS,
      ),
      content: input.content,
      author: this.truncateText(input.author, RSS_PREFETCH_MAX_AUTHOR_CHARS),
      publishedAtTs: input.publishedAtTs,
    });
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
      if (typeof response.body !== "string") {
        throw new Error("Metadata response body missing");
      }
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
    additionalHeaders?: Record<string, string>,
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
          ...(additionalHeaders ?? {}),
        },
        signal: controller.signal,
      });
      const etag = response.headers.get("etag")?.trim() || undefined;
      const lastModified =
        response.headers.get("last-modified")?.trim() || undefined;
      if (response.status === 304) {
        return { status: response.status, etag, lastModified };
      }
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
      return { status: response.status, body, etag, lastModified };
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
      const state = await this.readDiscoveryHttpState(url);
      const conditionalHeaders: Record<string, string> = {};
      if (state?.etag) {
        conditionalHeaders["if-none-match"] = state.etag;
      }
      if (state?.lastModified) {
        conditionalHeaders["if-modified-since"] = state.lastModified;
      }

      const response = await this.fetchWithStatus(
        url,
        timeoutMs,
        Object.keys(conditionalHeaders).length > 0
          ? conditionalHeaders
          : undefined,
      );

      if (response.status === 304) {
        if (state?.body) {
          await this.writeDiscoveryHttpState(url, {
            etag: response.etag ?? state.etag,
            lastModified: response.lastModified ?? state.lastModified,
            body: state.body,
            parsedSitemapPayload: state.parsedSitemapPayload,
            updatedAt: Date.now(),
          });
          return state.body;
        }

        const refreshed = await this.fetchWithStatus(url, timeoutMs);
        if (typeof refreshed.body === "string") {
          await this.writeDiscoveryHttpState(url, {
            etag: refreshed.etag,
            lastModified: refreshed.lastModified,
            body: refreshed.body,
            parsedSitemapPayload:
              state?.body === refreshed.body
                ? state.parsedSitemapPayload
                : undefined,
            updatedAt: Date.now(),
          });
        }
        return refreshed.body;
      }

      if (typeof response.body === "string") {
        await this.writeDiscoveryHttpState(url, {
          etag: response.etag,
          lastModified: response.lastModified,
          body: response.body,
          parsedSitemapPayload:
            state?.body === response.body
              ? state.parsedSitemapPayload
              : undefined,
          updatedAt: Date.now(),
        });
      }
      return response.body;
    } catch (error) {
      logger.debug({ url, error }, "Optional metadata fetch failed");
      return undefined;
    }
  }

  private discoveryHttpStateCacheKey(url: string) {
    const digest = createHash("sha1").update(url).digest("hex");
    return `${DISCOVERY_HTTP_STATE_CACHE_KEY_PREFIX}:${digest}`;
  }

  private async readDiscoveryHttpState(url: string) {
    if (!this.cache) {
      return null;
    }
    try {
      return this.cache.get<DiscoveryHttpState>(
        this.discoveryHttpStateCacheKey(url),
      );
    } catch (error) {
      logger.debug(
        { url, error },
        "Failed to read conditional discovery state cache",
      );
      return null;
    }
  }

  private async writeDiscoveryHttpState(
    url: string,
    state: DiscoveryHttpState,
  ) {
    if (!this.cache) {
      return;
    }
    try {
      await this.cache.set(
        this.discoveryHttpStateCacheKey(url),
        state,
        DISCOVERY_HTTP_STATE_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      logger.debug(
        { url, error },
        "Failed to write conditional discovery state cache",
      );
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
