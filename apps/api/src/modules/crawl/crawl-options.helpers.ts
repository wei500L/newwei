import { normalizeBrowserHeaders as normalizeSharedBrowserHeaders } from "@modular/utils";
import type { Prisma } from "@prisma/client";

import type {
  CrawlAntiBotMode,
  CrawlBrowserCookie,
  CrawlBrowserHeader,
  CrawlGeolocationConfig,
  CrawlMarkdownContentSource,
  CrawlMarkdownFilter,
  CrawlMarkdownOptions,
  CrawlPageTypeHint,
  CrawlQualityProfile,
  CrawlTaskOptions,
  CrawlUrlMatcher,
  CrawlUserAgentGeneratorConfig,
} from "./crawl.types";

export function fromJsonArray(value: Prisma.JsonValue | null): string[] {
  if (!value || !Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry : null))
    .filter((entry): entry is string => Boolean(entry));
}

export function parsePageTypeHint(value: unknown): CrawlPageTypeHint | undefined {
  if (value === "auto" || value === "list" || value === "detail") {
    return value;
  }
  return undefined;
}

export function parseAntiBotMode(value: unknown): CrawlAntiBotMode | undefined {
  if (value === "auto" || value === "enabled" || value === "disabled") {
    return value;
  }
  return undefined;
}

export function parseQualityProfile(value: unknown): CrawlQualityProfile | undefined {
  if (
    value === "balanced" ||
    value === "quality_first" ||
    value === "speed_first"
  ) {
    return value;
  }
  return undefined;
}

export function clampScrollDelay(value: number) {
  if (Number.isNaN(value)) {
    return 200;
  }
  return Math.max(0, Math.min(5000, Math.round(value)));
}

export function normalizeSessionId(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 160);
}

export function normalizeUserDataDir(value?: string | null) {
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

export function normalizeStorageState(value?: string | null) {
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

export function normalizeUrlList(urls?: string[] | null): string[] | undefined {
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

export function normalizeMatcher(
  matcher?: CrawlUrlMatcher | null,
): CrawlUrlMatcher | undefined {
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
    patterns: patterns,
  };
}

export function normalizeMarkdownOptions(
  options?: CrawlMarkdownOptions | null,
): CrawlMarkdownOptions | undefined {
  if (!options) {
    return undefined;
  }
  const normalized: CrawlMarkdownOptions = {};
  if (
    options.contentSource &&
    ["raw_html", "cleaned_html", "fit_html"].includes(options.contentSource)
  ) {
    normalized.contentSource =
      options.contentSource as CrawlMarkdownContentSource;
  }
  if (typeof options.ignoreLinks === "boolean") {
    normalized.ignoreLinks = options.ignoreLinks;
  }
  if (typeof options.escapeHtml === "boolean") {
    normalized.escapeHtml = options.escapeHtml;
  }
  if (typeof options.citations === "boolean") {
    normalized.citations = options.citations;
  }
  if (
    typeof options.bodyWidth === "number" &&
    Number.isFinite(options.bodyWidth)
  ) {
    const clamped = Math.max(
      40,
      Math.min(200, Math.round(options.bodyWidth)),
    );
    normalized.bodyWidth = clamped;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeSelectorList(
  values?: string[] | null,
): string[] | undefined {
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

export function normalizeCssSelector(value?: string | null) {
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

export function normalizeWordCountThreshold(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(5000, Math.round(value)));
  return clamped;
}

export function normalizeMarkdownFilter(
  filter?: CrawlMarkdownFilter | null,
): CrawlMarkdownFilter | undefined {
  if (!filter) {
    return undefined;
  }
  if (filter.type === "pruning") {
    const normalized: CrawlMarkdownFilter = { type: "pruning" };
    if (
      typeof filter.threshold === "number" &&
      Number.isFinite(filter.threshold)
    ) {
      normalized.threshold = Math.max(0, Math.min(1, filter.threshold));
    }
    if (
      filter.thresholdType === "fixed" ||
      filter.thresholdType === "dynamic"
    ) {
      normalized.thresholdType = filter.thresholdType;
    }
    if (
      typeof filter.minWordThreshold === "number" &&
      Number.isFinite(filter.minWordThreshold)
    ) {
      const clamped = Math.max(
        0,
        Math.min(500, Math.round(filter.minWordThreshold)),
      );
      normalized.minWordThreshold = clamped;
    }
    return normalized;
  }
  if (filter.type === "bm25") {
    const normalized: CrawlMarkdownFilter = { type: "bm25" };
    if (typeof filter.userQuery === "string") {
      const trimmed = filter.userQuery.trim();
      if (trimmed.length > 0) {
        normalized.userQuery = trimmed.slice(0, 240);
      }
    }
    if (
      typeof filter.bm25Threshold === "number" &&
      Number.isFinite(filter.bm25Threshold)
    ) {
      normalized.bm25Threshold = Number(
        Math.max(0, Math.min(20, filter.bm25Threshold)).toFixed(2),
      );
    }
    if (typeof filter.language === "string") {
      const trimmed = filter.language.trim();
      if (trimmed.length > 0) {
        normalized.language = trimmed.slice(0, 32);
      }
    }
    if (!normalized.userQuery) {
      return undefined;
    }
    return normalized;
  }
  return undefined;
}

export function normalizeTableScore(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  const clamped = Math.max(0, Math.min(10, value));
  return Number(clamped.toFixed(2));
}

export function normalizeStrategyParams(
  params?: Record<string, unknown> | null,
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

export function normalizeBrowserHeaders(
  headers?: CrawlBrowserHeader[] | null,
): CrawlBrowserHeader[] | undefined {
  if (!headers || headers.length === 0) {
    return undefined;
  }
  const normalized = normalizeSharedBrowserHeaders(
    headers.map((header) => ({
      name: header?.name,
      value: header?.value,
    })),
  ).map((header) => ({
    name: header.name.slice(0, 128),
    value: header.value.slice(0, 512),
  }));
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

export function normalizeBrowserCookies(
  cookies?: CrawlBrowserCookie[] | null,
): CrawlBrowserCookie[] | undefined {
  if (!cookies || cookies.length === 0) {
    return undefined;
  }
  const normalized = cookies
    .map((cookie) => {
      if (!cookie || typeof cookie !== "object") {
        return undefined;
      }
      const name = typeof cookie.name === "string" ? cookie.name.trim() : "";
      const value =
        typeof cookie.value === "string" ? cookie.value.trim() : "";
      const domain =
        typeof cookie.domain === "string" ? cookie.domain.trim() : "";
      const path = typeof cookie.path === "string" ? cookie.path.trim() : "";
      if (!name || !value || !domain) {
        return undefined;
      }
      return {
        name: name.slice(0, 128),
        value: value.slice(0, 4000),
        domain: domain.slice(0, 255),
        path: path ? path.slice(0, 255) : undefined,
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

export function normalizeUserAgent(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 768);
}

export function normalizeUserAgentMode(value?: string | null) {
  if (value === "random") {
    return "random";
  }
  return undefined;
}

export function normalizeUserAgentGenerator(
  config?: CrawlUserAgentGeneratorConfig | null,
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

export function normalizeLocale(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 16);
}

export function normalizeTimezone(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 64);
}

export function normalizeGeolocation(
  value?: CrawlGeolocationConfig | null,
): CrawlGeolocationConfig | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const latitude =
    typeof value.latitude === "number" && Number.isFinite(value.latitude)
      ? value.latitude
      : undefined;
  const longitude =
    typeof value.longitude === "number" && Number.isFinite(value.longitude)
      ? value.longitude
      : undefined;
  if (latitude === undefined || longitude === undefined) {
    return undefined;
  }
  const normalized: CrawlGeolocationConfig = {
    latitude: Math.max(-90, Math.min(90, latitude)),
    longitude: Math.max(-180, Math.min(180, longitude)),
  };
  if (typeof value.accuracy === "number" && Number.isFinite(value.accuracy)) {
    normalized.accuracy = Math.max(1, Math.min(5000, value.accuracy));
  }
  return normalized;
}

export function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return value;
}

export function coerceStringArray(value: unknown): string[] | undefined {
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

export function normalizePatternList(patterns?: string[]) {
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

export function normalizeScriptList(entries?: string[] | null): string[] | undefined {
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

export function normalizeWaitForSelector(
  selector?: string | null,
): string | undefined {
  if (!selector) {
    return undefined;
  }
  const trimmed = selector.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 1024);
}

export function normalizeWaitForScript(script?: string | null): string | undefined {
  if (!script) {
    return undefined;
  }
  const trimmed = script.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 4000);
}

export function normalizeWaitForTimeout(value?: number | null): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(500, Math.min(60000, Math.round(value)));
}

export function normalizeWaitUntil(
  value?: string | null,
): CrawlTaskOptions["waitUntil"] {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (
    trimmed === "domcontentloaded" ||
    trimmed === "load" ||
    trimmed === "networkidle" ||
    trimmed === "commit"
  ) {
    return trimmed;
  }
  return undefined;
}

export function normalizePageTimeoutMs(value?: number | null): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(1000, Math.min(180000, Math.round(value)));
}

export function normalizeDelayBeforeReturnHtmlMs(
  value?: number | null,
): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(30000, Math.round(value)));
}

export function normalizeDelayJitterMs(value?: number | null): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(10000, Math.round(value)));
}

export function normalizeSemaphoreCount(value?: number | null): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(50, Math.round(value)));
}
