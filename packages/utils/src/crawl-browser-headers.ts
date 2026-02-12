export interface CrawlBrowserHeaderEntry {
  name: string;
  value: string;
}

type ChromiumBrand = "chrome" | "edge" | "chromium";

export interface CrawlBrowserHeaderAutoFillOptions {
  userAgent?: string | null;
  userAgentMode?: string | null;
  userAgentGenerator?: {
    platform?: string | null;
    browser?: string | null;
    deviceType?: string | null;
  } | null;
}

const CHROMIUM_UA_VERSION_REGEX =
  /(?:chrome|crios|chromium|edg|edga|edgios)\/(\d{2,3})/i;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;
const HTTP_HEADER_NAME_REGEX = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_REGEX.test(value);
}

function normalizeHeaderName(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (hasControlChars(normalized)) {
    return undefined;
  }
  if (!HTTP_HEADER_NAME_REGEX.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeHeaderValue(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  if (!normalized) {
    return undefined;
  }
  if (hasControlChars(normalized)) {
    return undefined;
  }
  return normalized;
}

function inferPlatformFromUserAgent(userAgent: string): string {
  const normalized = userAgent.toLowerCase();
  if (normalized.includes("android")) return "Android";
  if (
    normalized.includes("iphone") ||
    normalized.includes("ipad") ||
    normalized.includes("ios")
  ) {
    return "iOS";
  }
  if (normalized.includes("macintosh") || normalized.includes("mac os x"))
    return "macOS";
  if (normalized.includes("linux") || normalized.includes("x11"))
    return "Linux";
  if (normalized.includes("windows")) return "Windows";
  return "Windows";
}

function inferMobileFromUserAgent(userAgent: string): string {
  const normalized = userAgent.toLowerCase();
  if (
    normalized.includes("mobile") ||
    normalized.includes("iphone") ||
    normalized.includes("ipod") ||
    (normalized.includes("android") && normalized.includes("mobile"))
  ) {
    return "?1";
  }
  return "?0";
}

function inferChromiumBrandFromUserAgent(
  userAgent: string,
): ChromiumBrand | undefined {
  const normalized = userAgent.toLowerCase();
  if (
    normalized.includes("edg/") ||
    normalized.includes("edga/") ||
    normalized.includes("edgios/")
  ) {
    return "edge";
  }
  if (normalized.includes("chrome/") || normalized.includes("crios/")) {
    return "chrome";
  }
  if (normalized.includes("chromium")) {
    return "chromium";
  }
  return undefined;
}

function buildSecChUaValue(brand: ChromiumBrand, majorVersion: string): string {
  if (brand === "edge") {
    return (
      `"Chromium";v="${majorVersion}", ` +
      `"Not_A Brand";v="8", ` +
      `"Microsoft Edge";v="${majorVersion}"`
    );
  }
  if (brand === "chrome") {
    return (
      `"Chromium";v="${majorVersion}", ` +
      `"Not_A Brand";v="8", ` +
      `"Google Chrome";v="${majorVersion}"`
    );
  }
  return `"Chromium";v="${majorVersion}", "Not_A Brand";v="8"`;
}

function resolveDeterministicSecChContext(
  options: CrawlBrowserHeaderAutoFillOptions,
):
  | {
      majorVersion: string;
      platform: string;
      mobile: string;
      brand: ChromiumBrand;
    }
  | undefined {
  const userAgent = normalizeString(options.userAgent);

  if (!userAgent) {
    return undefined;
  }

  const brand = inferChromiumBrandFromUserAgent(userAgent);
  const firefoxLike = userAgent.toLowerCase().includes("firefox/");
  const safariLike = userAgent.toLowerCase().includes("safari/") && !brand;
  if (firefoxLike || safariLike || !brand) {
    return undefined;
  }

  const majorVersion = CHROMIUM_UA_VERSION_REGEX.exec(userAgent)?.[1];
  if (!majorVersion) {
    return undefined;
  }

  return {
    majorVersion,
    platform: inferPlatformFromUserAgent(userAgent),
    mobile: inferMobileFromUserAgent(userAgent),
    brand,
  };
}

export function normalizeBrowserHeaders(
  input: unknown,
): CrawlBrowserHeaderEntry[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const entries: CrawlBrowserHeaderEntry[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = normalizeHeaderName(entry.name);
    const value = normalizeHeaderValue(entry.value);
    if (!name || !value) {
      continue;
    }
    entries.push({ name, value });
  }
  return entries;
}

export function buildAutoBrowserHeadersForCrawlOptions(
  options: CrawlBrowserHeaderAutoFillOptions,
): CrawlBrowserHeaderEntry[] {
  const headers: CrawlBrowserHeaderEntry[] = [
    { name: "sec-fetch-site", value: "none" },
    { name: "sec-fetch-mode", value: "navigate" },
  ];

  const secChContext = resolveDeterministicSecChContext(options);
  if (!secChContext) {
    return headers;
  }

  headers.unshift(
    {
      name: "sec-ch-ua",
      value: buildSecChUaValue(secChContext.brand, secChContext.majorVersion),
    },
    { name: "sec-ch-ua-mobile", value: secChContext.mobile },
    { name: "sec-ch-ua-platform", value: `"${secChContext.platform}"` },
  );
  return headers;
}

export function mergeBrowserHeaders(
  existingHeaders: CrawlBrowserHeaderEntry[],
  autoHeaders: CrawlBrowserHeaderEntry[],
): CrawlBrowserHeaderEntry[] {
  const byLowerName = new Map<string, CrawlBrowserHeaderEntry>();
  for (const header of existingHeaders) {
    byLowerName.set(header.name.toLowerCase(), header);
  }
  for (const header of autoHeaders) {
    const key = header.name.toLowerCase();
    if (!byLowerName.has(key)) {
      byLowerName.set(key, header);
    }
  }
  return Array.from(byLowerName.values());
}

export function applyAutoBrowserHeadersToCrawlOptions(
  options: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...options };
  const existing = normalizeBrowserHeaders(next.browserHeaders);
  const auto = buildAutoBrowserHeadersForCrawlOptions({
    userAgent: normalizeString(next.userAgent),
    userAgentMode: normalizeString(next.userAgentMode),
    userAgentGenerator: isRecord(next.userAgentGenerator)
      ? next.userAgentGenerator
      : undefined,
  });
  const merged = mergeBrowserHeaders(existing, auto);
  if (merged.length > 0) {
    next.browserHeaders = merged;
  } else {
    delete next.browserHeaders;
  }
  return next;
}
