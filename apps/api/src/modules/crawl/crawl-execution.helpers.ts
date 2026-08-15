import { createLogger } from "@modular/utils";

import { validateSsrfUrlAsync } from "../../common/validators/ssrf-url.validator";

import type { CrawlTaskOptions } from "./crawl.types";

const logger = createLogger({ name: "crawl-execution-service" });

export const MAX_API_SIDE_REDIRECT_HOPS = 5;

export const BLOCKED_DETAIL_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "video",
  "videos",
  "photo",
  "photos",
  "pictures",
  "gallery",
  "graphics",
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
  "archive",
  "latest",
  "live",
  "newsletter",
  "newsletters",
  "country",
  "countries",
  "special-report",
  "special-reports",
  "europe-poll-of-polls",
  "poll-of-polls",
]);

export const ARTICLE_LEAD_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "article",
  "articles",
  "news",
  "story",
  "stories",
]);

export function pickString(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
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

export function pickNumber(
  source: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
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

export function pickBoolean(
  source: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
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

export function normalizeComparableUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function getRootDomain(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  const parts = normalized.split(".").filter((entry) => entry.length > 0);
  if (parts.length <= 2) {
    return normalized;
  }
  return parts.slice(-2).join(".");
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildUrlList(baseUrl: string, options: CrawlTaskOptions): string[] {
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
  return Array.from(
    new Set(
      accumulator.filter(
        (entry) => typeof entry === "string" && entry.length > 0,
      ),
    ),
  );
}

// Follow redirects manually, validating every hop against the SSRF rules:
// a safe initial URL can still redirect into an internal address or cloud
// metadata endpoint. Returns null when a hop is blocked or the redirect
// chain is invalid/exhausted.
export async function ssrfSafeFetch(
  url: string,
  method: "HEAD" | "GET",
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response | null> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_API_SIDE_REDIRECT_HOPS; hop += 1) {
    const safety = await validateSsrfUrlAsync(currentUrl);
    if (!safety.valid) {
      logger.warn(
        { url: currentUrl, reason: safety.reason ?? "unsafe url" },
        "Blocked SSRF target during API-side fetch",
      );
      return null;
    }
    const response = await fetch(currentUrl, {
      method,
      redirect: "manual",
      signal,
      headers,
    });
    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      const location = response.headers.get("location");
      if (!location) {
        return null;
      }
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        logger.warn(
          { url: currentUrl },
          "Invalid redirect location during API-side fetch",
        );
        return null;
      }
      continue;
    }
    return response;
  }
  logger.warn(
    { url },
    "Too many redirects during API-side fetch",
  );
  return null;
}

export function hasArticleLeadPathSegment(segmentsLower: string[]): boolean {
  if (segmentsLower.length === 0) {
    return false;
  }
  return ARTICLE_LEAD_PATH_SEGMENTS.has(segmentsLower[0] ?? "");
}

export function isBlockedDetailPathSegment(segment: string): boolean {
  if (!segment) {
    return false;
  }
  if (BLOCKED_DETAIL_PATH_SEGMENTS.has(segment)) {
    return true;
  }

  return (
    segment.endsWith("-newsletter") ||
    segment.endsWith("-newsletters") ||
    segment.endsWith("-special-report") ||
    segment.endsWith("-poll-of-polls") ||
    segment.startsWith("newsletter-") ||
    segment.startsWith("country-")
  );
}

export function hasBlockedDetailPathSegments(segmentsLower: string[]): boolean {
  return segmentsLower.some((segment) =>
    isBlockedDetailPathSegment(segment),
  );
}

export function isLikelyPathCategoryToken(value: string): boolean {
  const compact = value.trim().toLowerCase();
  if (!compact) {
    return false;
  }

  return (
    BLOCKED_DETAIL_PATH_SEGMENTS.has(compact) ||
    compact === "overview" ||
    compact === "all" ||
    compact === "index" ||
    compact.endsWith("-index") ||
    compact.endsWith("-overview")
  );
}

export function urlMatchesPattern(url: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return false;
  }
  const normalizedUrl = url.toLowerCase();
  const loweredPattern = normalizedPattern.toLowerCase();

  if (
    loweredPattern.startsWith("/") &&
    loweredPattern.endsWith("/") &&
    loweredPattern.length > 2
  ) {
    try {
      const regex = new RegExp(
        normalizedPattern.slice(1, normalizedPattern.length - 1),
        "i",
      );
      return regex.test(url);
    } catch {
      return normalizedUrl.includes(loweredPattern);
    }
  }

  if (loweredPattern.includes("*")) {
    const escaped = loweredPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const wildcardRegex = new RegExp(
      "^" + escaped.replace(/\*/g, ".*") + "$",
      "i",
    );
    return wildcardRegex.test(url);
  }
  return normalizedUrl.includes(loweredPattern);
}

export function urlMatchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => urlMatchesPattern(url, pattern));
}

export function isLikelyDetailArticleUrl(
  url: string,
  baseUrl: string,
  requireSameDomain: boolean,
  allowExternalLinks?: boolean,
): boolean {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    const sameRootDomain =
      getRootDomain(parsed.hostname) ===
      getRootDomain(base.hostname);
    if (requireSameDomain && !sameRootDomain) {
      return false;
    }
    if (allowExternalLinks === false && !sameRootDomain) {
      return false;
    }

    const pathname = parsed.pathname.replace(/\/+/g, "/").replace(/\/+$/, "");
    const segments = pathname.split("/").filter((entry) => entry.length > 0);
    if (segments.length < 2) {
      return false;
    }
    const segmentsLower = segments.map((entry) => entry.toLowerCase());

    if (hasBlockedDetailPathSegments(segmentsLower)) {
      return false;
    }

    const joined = segmentsLower.join("/");
    if (
      /\b(video|videos|photo|photos|pictures|gallery|podcast|graphics)\b/.test(
        joined,
      )
    ) {
      return false;
    }
    if (
      /\b(tag|tags|topic|topics|section|sections|author|authors|archive|latest|live)\b/.test(
        joined,
      )
    ) {
      return false;
    }

    const lastSegment = segments[segments.length - 1]!;
    const lastSegmentLower = lastSegment.toLowerCase();
    const likelySectionTail = new Set([
      "world",
      "business",
      "markets",
      "technology",
      "tech",
      "opinion",
      "sport",
      "sports",
      "news",
      "japan",
      "us",
      "china",
      "europe",
      "ukraine",
      "russia",
      "latest",
      "archive",
    ]);
    const articleDateSuffixPattern = /-\d{4}-\d{2}-\d{2}$/;
    const reutersStyleIdPattern = /[A-Z0-9]{8,}-\d{4}-\d{2}-\d{2}$/;
    const reutersWireIdPattern = /(?:^|-)id[a-z0-9]{7,}$/i;

    if (
      articleDateSuffixPattern.test(lastSegment) ||
      reutersStyleIdPattern.test(lastSegment) ||
      reutersWireIdPattern.test(lastSegment)
    ) {
      return true;
    }

    if (/^\d{4}\/\d{2}\/\d{2}/.test(segments.slice(-3).join("/"))) {
      return true;
    }

    if (
      segments.some(
        (segment) => segment === "article" || segment === "articles",
      )
    ) {
      return true;
    }

    if (
      segments.length >= 4 &&
      lastSegment.length >= 14 &&
      /[a-z0-9]-[a-z0-9]/i.test(lastSegment)
    ) {
      return true;
    }

    if (
      segments.length >= 2 &&
      lastSegment.length >= 18 &&
      /[a-z0-9]-[a-z0-9]/i.test(lastSegment) &&
      !isLikelyPathCategoryToken(lastSegmentLower)
    ) {
      return true;
    }

    if (segments.length >= 2 && /^\d{7,}$/.test(lastSegment)) {
      return true;
    }

    if (
      segments.length >= 2 &&
      /^[a-z0-9]{8,}$/.test(lastSegmentLower) &&
      !likelySectionTail.has(lastSegmentLower) &&
      !/^\d+$/.test(lastSegmentLower) &&
      !isLikelyPathCategoryToken(lastSegmentLower)
    ) {
      return true;
    }

    if (
      segments.length >= 3 &&
      lastSegment.length >= 24 &&
      /[a-z0-9]/i.test(lastSegment) &&
      !isLikelyPathCategoryToken(lastSegmentLower)
    ) {
      return true;
    }

    if (segments.length <= 3 && likelySectionTail.has(lastSegmentLower)) {
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

