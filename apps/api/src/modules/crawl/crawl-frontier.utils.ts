import type {
  CrawlFrontierPageType,
  CrawlPriorityClass,
  CrawlSiteProfileConfig,
} from "./crawl.types";
import { assertNoCrawl4aiLlmOptions } from "./crawl4ai-llm.guard";

const ARTICLE_SIGNAL_PATTERN =
  /\/(20\d{2}\/\d{2}\/\d{2}\/|article\/|articles\/|story\/|stories\/|content\/)/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function wildcardToRegex(pattern: string) {
  const normalized = pattern.trim();
  const body = escapeRegex(normalized).replace(/\*/g, ".*");
  return new RegExp(`^${body}$`, "i");
}

function toStringList(value: unknown, max = 100): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    return undefined;
  }
  return Array.from(new Set(normalized)).slice(0, max);
}

function toObjectRecord(
  value: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) {
      normalized[key] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toPositiveInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function toScore(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(parsed.toFixed(3))));
}

export function normalizeCrawlSiteProfileConfig(
  raw: unknown,
): CrawlSiteProfileConfig {
  const value = isPlainObject(raw) ? raw : {};
  assertNoCrawl4aiLlmOptions(value, "crawlSiteProfile.config");

  return {
    keywords: toStringList(value.keywords, 100),
    blockedDomains: toStringList(value.blockedDomains, 200),
    urlQueryParamAllowlist: toStringList(value.urlQueryParamAllowlist, 50),
    urlPatterns: (() => {
      if (!isPlainObject(value.urlPatterns)) {
        return undefined;
      }
      const patterns: Partial<
        Record<CrawlFrontierPageType | "exclude", string[]>
      > = {};
      for (const key of ["home", "category", "list", "article", "exclude"] as const) {
        const normalized = toStringList(value.urlPatterns[key], 100);
        if (normalized) {
          patterns[key] = normalized;
        }
      }
      return Object.keys(patterns).length > 0 ? patterns : undefined;
    })(),
    pageRules: (() => {
      const rules = toObjectRecord(value.pageRules);
      if (!rules) {
        return undefined;
      }
      const normalized: Partial<
        Record<CrawlFrontierPageType, Record<string, unknown>>
      > = {};
      for (const key of ["home", "category", "list", "article"] as const) {
        if (rules[key]) {
          assertNoCrawl4aiLlmOptions(
            rules[key],
            `crawlSiteProfile.config.pageRules.${key}`,
          );
          normalized[key] = rules[key];
        }
      }
      return Object.keys(normalized).length > 0 ? normalized : undefined;
    })(),
    layeredOptions: (() => {
      if (!isPlainObject(value.layeredOptions)) {
        return undefined;
      }
      return {
        maxDepth: toPositiveInt(value.layeredOptions.maxDepth, 1, 8, 3),
        maxPages: toPositiveInt(value.layeredOptions.maxPages, 1, 500, 60),
        maxChildrenPerNode: toPositiveInt(
          value.layeredOptions.maxChildrenPerNode,
          1,
          200,
          24,
        ),
        paginationKeepCount: toPositiveInt(
          value.layeredOptions.paginationKeepCount,
          1,
          10,
          3,
        ),
        scoreThreshold: toScore(value.layeredOptions.scoreThreshold, 0.35),
      };
    })(),
    nativeOptions: (() => {
      if (!isPlainObject(value.nativeOptions)) {
        return undefined;
      }
      return {
        deepCrawlStrategy: isPlainObject(value.nativeOptions.deepCrawlStrategy)
          ? (value.nativeOptions.deepCrawlStrategy as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        filterChain: isPlainObject(value.nativeOptions.filterChain)
          ? (value.nativeOptions.filterChain as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        urlScorer: isPlainObject(value.nativeOptions.urlScorer)
          ? (value.nativeOptions.urlScorer as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        adaptiveCrawling: isPlainObject(value.nativeOptions.adaptiveCrawling)
          ? (value.nativeOptions.adaptiveCrawling as {
              type: string;
              params?: Record<string, unknown>;
            })
          : undefined,
        stream:
          typeof value.nativeOptions.stream === "boolean"
            ? value.nativeOptions.stream
            : undefined,
      };
    })(),
    crawlOptions: (() => {
      if (!isPlainObject(value.crawlOptions)) {
        return undefined;
      }
      assertNoCrawl4aiLlmOptions(value.crawlOptions, "crawlSiteProfile.config.crawlOptions");
      return value.crawlOptions;
    })(),
  };
}

export function matchHostPattern(pattern: string, host: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedHost = host.trim().toLowerCase();
  if (!normalizedPattern || !normalizedHost) {
    return false;
  }
  if (normalizedPattern === normalizedHost) {
    return true;
  }
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix);
  }
  if (normalizedPattern.includes("*")) {
    return wildcardToRegex(normalizedPattern).test(normalizedHost);
  }
  return normalizedHost === normalizedPattern;
}

export function matchUrlPattern(pattern: string, url: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  return wildcardToRegex(normalizedPattern).test(url);
}

export function matchesAnyPattern(
  patterns: string[] | undefined,
  url: string,
): boolean {
  return Boolean(patterns?.some((pattern) => matchUrlPattern(pattern, url)));
}

export function inferFrontierPageType(options: {
  url: string;
  parentPageType: CrawlFrontierPageType;
  config: CrawlSiteProfileConfig;
}): CrawlFrontierPageType {
  const url = options.url;
  const patterns = options.config.urlPatterns;
  if (matchesAnyPattern(patterns?.article, url)) {
    return "article";
  }
  if (matchesAnyPattern(patterns?.list, url)) {
    return "list";
  }
  if (matchesAnyPattern(patterns?.category, url)) {
    return "category";
  }
  if (matchesAnyPattern(patterns?.home, url)) {
    return "home";
  }
  if (ARTICLE_SIGNAL_PATTERN.test(url)) {
    return "article";
  }
  if (options.parentPageType === "home") {
    return "category";
  }
  if (options.parentPageType === "category") {
    return "list";
  }
  return "article";
}

export function scoreFrontierCandidate(options: {
  url: string;
  pageType: CrawlFrontierPageType;
  config: CrawlSiteProfileConfig;
  rawScore?: number;
  linkText?: string;
}): number {
  let score = typeof options.rawScore === "number" ? options.rawScore : 0;
  if (options.pageType === "article") {
    score += 0.35;
  } else if (options.pageType === "list") {
    score += 0.2;
  } else if (options.pageType === "category") {
    score += 0.1;
  }
  if (matchesAnyPattern(options.config.urlPatterns?.exclude, options.url)) {
    score -= 1;
  }
  const text = options.linkText?.trim().toLowerCase() ?? "";
  for (const keyword of options.config.keywords ?? []) {
    if (text.includes(keyword.toLowerCase()) || options.url.toLowerCase().includes(keyword.toLowerCase())) {
      score += 0.05;
    }
  }
  return Number(score.toFixed(4));
}

export function resolveNodeQueueClass(options: {
  pageType: CrawlFrontierPageType;
  freshnessScore?: number;
}): CrawlPriorityClass {
  if (options.pageType === "home" || options.pageType === "category") {
    return "hot";
  }
  if (options.pageType === "list") {
    return "hot";
  }
  if ((options.freshnessScore ?? 0) >= 0.7) {
    return "hot";
  }
  return "normal";
}

export function estimateFreshnessScore(url: string): number {
  const now = new Date();
  const match = url.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  if (!match) {
    return 0;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  const ageHours = (now.getTime() - parsed.getTime()) / (1000 * 60 * 60);
  if (ageHours <= 24) {
    return 1;
  }
  if (ageHours <= 24 * 7) {
    return 0.75;
  }
  if (ageHours <= 24 * 30) {
    return 0.4;
  }
  return 0.1;
}

export function shouldRejectFrontierUrl(options: {
  url: string;
  config: CrawlSiteProfileConfig;
  requireSameDomainHost?: string;
}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    return "invalid_url";
  }
  const host = parsed.hostname.toLowerCase();
  if (
    options.requireSameDomainHost &&
    host !== options.requireSameDomainHost.toLowerCase()
  ) {
    return "cross_domain";
  }
  for (const blockedDomain of options.config.blockedDomains ?? []) {
    const normalized = blockedDomain.toLowerCase();
    if (host === normalized || host.endsWith(`.${normalized}`)) {
      return "blocked_domain";
    }
  }
  if (matchesAnyPattern(options.config.urlPatterns?.exclude, options.url)) {
    return "excluded_pattern";
  }
  return null;
}
