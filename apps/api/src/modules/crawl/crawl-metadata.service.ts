import { BadRequestException, Injectable } from "@nestjs/common";
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { createLogger } from "@modular/utils";
import type {
  CrawlMetadataExtractionInput,
  CrawlMetadataResult,
  CrawlMetadataTag,
  CrawlMetadataSource
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
    trimValues: true
  });

  async extract(input: CrawlMetadataExtractionInput): Promise<CrawlMetadataResult[]> {
    const config = this.normalizeInput(input);
    const urls = await this.resolveUrls(config);
    if (urls.length === 0) {
      return [];
    }

    const results = await this.mapWithConcurrency(urls, config.concurrency, (url) =>
      this.fetchMetadata(url, config)
    );

    const filtered = config.scoreThreshold > 0
      ? results.filter((result) => (result.relevanceScore ?? 0) >= config.scoreThreshold)
      : results;

    return filtered.slice(0, config.maxUrls);
  }

  private normalizeInput(input: CrawlMetadataExtractionInput): NormalizedMetadataConfig {
    const source: CrawlMetadataSource = input.source === "urls" ? "urls" : "sitemap";
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
      typeof input.scoreThreshold === "number" && Number.isFinite(input.scoreThreshold)
        ? Math.max(0, Math.min(1, Number(input.scoreThreshold.toFixed(3))))
        : 0;

    if (source === "sitemap" && !domain) {
      throw new BadRequestException("domain is required when source is sitemap");
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
      requestTimeoutMs: 15_000
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
      logger.warn({ domain: value, error }, "Failed to normalize metadata domain");
      return undefined;
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
        "Rejected metadata pattern: exceeds max length"
      );
      return undefined;
    }

    const wildcardCount = (trimmed.match(/[\*\?]/g) ?? []).length;
    if (wildcardCount > CrawlMetadataService.MAX_WILDCARDS) {
      logger.warn(
        { wildcardCount },
        "Rejected metadata pattern: exceeds max wildcard count"
      );
      return undefined;
    }

    const normalizedPattern = trimmed.toLowerCase();
    return (url: string) => this.wildcardMatch(normalizedPattern, url.toLowerCase());
  }

  private wildcardMatch(pattern: string, input: string) {
    let patternIndex = 0;
    let inputIndex = 0;
    let starIndex = -1;
    let matchIndex = 0;

    while (inputIndex < input.length) {
      const patternChar = patternIndex < pattern.length ? pattern[patternIndex] : undefined;

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

  private clampNumber(value: number | undefined, min: number, max: number, fallback: number) {
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
    collected: Set<string>
  ) {
    let parsed: any;
    try {
      parsed = this.parser.parse(xml);
    } catch (error) {
      logger.warn({ error }, "Failed to parse sitemap xml");
      return;
    }
    if (parsed?.urlset) {
      const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
      for (const entry of urls) {
        if (!entry) {
          continue;
        }
        const loc = typeof entry.loc === "string" ? entry.loc.trim() : undefined;
        if (!loc) {
          continue;
        }
        if (this.shouldIncludeUrl(loc, config.patternMatcher) && collected.size < config.maxUrls) {
          collected.add(loc);
        }
      }
    }
    if (parsed?.sitemapindex?.sitemap) {
      const sites = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];
      for (const site of sites.slice(0, 5)) {
        const loc = typeof site?.loc === "string" ? site.loc.trim() : undefined;
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

  private shouldIncludeUrl(url: string, patternMatcher?: (url: string) => boolean) {
    if (!patternMatcher) {
      return true;
    }
    return patternMatcher(url);
  }

  private joinUrl(origin: string, path: string) {
    return `${origin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  }

  private async fetchMetadata(url: string, config: NormalizedMetadataConfig): Promise<CrawlMetadataResult> {
    try {
      const response = await this.fetchWithStatus(url, config.requestTimeoutMs);
      const parsed = this.parseMetadata(response.body, config);
      const relevanceScore = this.computeRelevance(url, parsed, config.queryTokens);
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
        relevanceScore
      };
    } catch (error) {
      logger.warn({ url, error }, "Metadata extraction failed");
      return {
        url,
        status: "failed",
        error: error instanceof Error ? error.message : "metadata extraction failed",
        metaTags: [],
        openGraph: [],
        jsonLd: []
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
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          jsonLd.push(JSON.stringify(parsed));
        } catch {
          jsonLd.push(raw);
        }
      });
    }

    return {
      title,
      description,
      keywords,
      author,
      metaTags: metaTags.slice(0, 25),
      openGraph: openGraph.slice(0, 25),
      jsonLd
    };
  }

  private async fetchWithStatus(url: string, timeoutMs: number): Promise<FetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent":
            "MetadataBot/1.0 (+https://github.com/unclecode/crawl4ai) crawl-metadata-service"
        },
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Metadata request failed with status ${response.status}`);
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
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
    tokens?: string[]
  ) {
    if (!tokens || tokens.length === 0) {
      return undefined;
    }
    const haystack = [url, parsed.title ?? "", parsed.description ?? ""].join(" ").toLowerCase();
    if (!haystack.trim()) {
      return 0;
    }
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return Number((hits / tokens.length).toFixed(3));
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const limit = Math.max(1, Math.min(concurrency, items.length));

    const runner = async (): Promise<void> => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) {
          return;
        }
        results[index] = await worker(items[index], index);
      }
    };

    await Promise.all(Array.from({ length: limit }, () => runner()));
    return results;
  }
}
