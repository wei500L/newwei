export interface CrawlProxyConfigFormValue {
  server?: string;
  username?: string;
  password?: string;
}

export interface CrawlUrlMatcherFormValue {
  matchMode?: string;
  patterns?: string[];
}

export interface CrawlStrategyOverridesFormValue {
  cacheMode?: string;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  waitUntil?: string;
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  virtualScroll?: CrawlVirtualScrollConfigFormValue;
}

export interface CrawlMultiUrlStrategyFormValue {
  name?: string;
  matcher?: CrawlUrlMatcherFormValue;
  urls?: string[];
  options?: CrawlStrategyOverridesFormValue;
}

export interface MarkdownOptionsFormValue {
  contentSource?: string;
  ignoreLinks?: boolean;
  escapeHtml?: boolean;
  citations?: boolean;
  bodyWidth?: number;
}

export interface MarkdownFilterFormValue {
  type?: "pruning" | "bm25";
  threshold?: number;
  thresholdType?: "fixed" | "dynamic";
  minWordThreshold?: number;
  userQuery?: string;
  bm25Threshold?: number;
  language?: string;
}

export interface MarkdownStrategyFormValue {
  type?: string;
  params?: string;
}

export interface TableExtractionFormValue {
  type?: string;
  params?: string;
  minRows?: number;
  minCols?: number;
}

export interface CleanMarkdownFormValue {
  cssSelector?: string;
  targetElements?: string[];
  excludedTags?: string[];
  removeOverlayElements?: boolean;
  wordCountThreshold?: number;
}

export interface LinkPreviewFormValue {
  includeInternal?: boolean;
  includeExternal?: boolean;
  includeSocial?: boolean;
  maxLinks?: number;
  concurrency?: number;
  timeoutSeconds?: number;
  query?: string;
  scoreThreshold?: number;
  verbose?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface BrowserHeaderFormValue {
  name?: string;
  value?: string;
}

export interface BrowserCookieFormValue {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
}

export interface UserAgentGeneratorFormValue {
  platform?: string;
  browser?: string;
  deviceType?: string;
  locale?: string;
}

export interface GeolocationFormValue {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export type CrawlVirtualScrollModeFormValue =
  | "container_height"
  | "page_height"
  | "viewport"
  | "pixels";

export interface CrawlVirtualScrollConfigFormValue {
  enabled?: boolean;
  containerSelector?: string;
  scrollCount?: number;
  scrollBy?: CrawlVirtualScrollModeFormValue;
  scrollByPixels?: number;
  waitAfterScrollMs?: number;
}

export interface CrawlOptionsFormValues {
  includeImages?: boolean;
  storeMedia?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  excludeExternalImages?: boolean;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  headless?: boolean;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  useManagedBrowser?: boolean;
  userDataDir?: string;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  waitUntil?: string;
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  waitForImages?: boolean;
  sessionId?: string;
  storageState?: string;
  proxyUrl?: string;
  proxyConfig?: CrawlProxyConfigFormValue;
  additionalUrls?: string[];
  multiUrlConfigs?: CrawlMultiUrlStrategyFormValue[];
  markdownOptions?: MarkdownOptionsFormValue;
  markdownFilter?: MarkdownFilterFormValue;
  markdownStrategy?: MarkdownStrategyFormValue;
  tableScoreThreshold?: number;
  tableExtraction?: TableExtractionFormValue;
  cleanMarkdown?: CleanMarkdownFormValue;
  scoreLinks?: boolean;
  linkPreview?: LinkPreviewFormValue;
  browserHeaders?: BrowserHeaderFormValue[];
  browserCookies?: BrowserCookieFormValue[];
  userAgent?: string;
  userAgentMode?: "random" | string;
  userAgentGenerator?: UserAgentGeneratorFormValue;
  locale?: string;
  timezoneId?: string;
  geolocation?: GeolocationFormValue;
  virtualScroll?: CrawlVirtualScrollConfigFormValue;
}

export interface CrawlStrategyOverridesValue {
  cacheMode?: string;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  virtualScroll?: CrawlVirtualScrollConfigValue;
}

export interface CrawlMultiUrlStrategyValue {
  name?: string;
  matcher?: {
    matchMode?: string;
    patterns: string[];
  };
  urls?: string[];
  options?: CrawlStrategyOverridesValue;
}

export interface CrawlMarkdownStrategyValue {
  type: string;
  params?: Record<string, unknown>;
}

export interface CrawlTableExtractionValue {
  type: string;
  params?: Record<string, unknown>;
}

export interface CrawlCleanMarkdownValue {
  cssSelector?: string;
  targetElements?: string[];
  excludedTags?: string[];
  removeOverlayElements?: boolean;
  wordCountThreshold?: number;
}

export interface CrawlLinkPreviewValue {
  includeInternal?: boolean;
  includeExternal?: boolean;
  includeSocial?: boolean;
  maxLinks?: number;
  concurrency?: number;
  timeoutSeconds?: number;
  query?: string;
  scoreThreshold?: number;
  verbose?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface CrawlGeolocationValue {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export type CrawlVirtualScrollModeValue = "container_height" | "page_height";
export type CrawlVirtualScrollByValue = CrawlVirtualScrollModeValue | string;

export interface CrawlVirtualScrollConfigValue {
  containerSelector: string;
  scrollCount?: number;
  scrollBy?: CrawlVirtualScrollByValue;
  waitAfterScrollMs?: number;
}

export interface CrawlOptionsValue {
  includeImages?: boolean;
  storeMedia?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  excludeExternalImages?: boolean;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  headless?: boolean;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  useManagedBrowser?: boolean;
  userDataDir?: string;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  waitUntil?: "domcontentloaded" | "load" | "networkidle" | "commit";
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  waitForImages?: boolean;
  sessionId?: string;
  storageState?: string;
  proxyUrl?: string;
  proxyConfig?: {
    server: string;
    username?: string;
    password?: string;
  };
  additionalUrls?: string[];
  multiUrlConfigs?: CrawlMultiUrlStrategyValue[];
  markdownOptions?: MarkdownOptionsFormValue;
  markdownFilter?: MarkdownFilterFormValue;
  markdownStrategy?: CrawlMarkdownStrategyValue;
  tableScoreThreshold?: number;
  tableExtraction?: CrawlTableExtractionValue;
  cleanMarkdown?: CrawlCleanMarkdownValue;
  scoreLinks?: boolean;
  linkPreview?: CrawlLinkPreviewValue;
  browserHeaders?: { name: string; value: string }[];
  browserCookies?: {
    name: string;
    value: string;
    domain: string;
    path?: string;
  }[];
  userAgent?: string;
  userAgentMode?: "random";
  userAgentGenerator?: UserAgentGeneratorFormValue;
  locale?: string;
  timezoneId?: string;
  geolocation?: CrawlGeolocationValue;
  virtualScroll?: CrawlVirtualScrollConfigValue;
}

export const sanitizeStringList = (list?: string[]) =>
  list
    ?.map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && value.length > 0));

export const sanitizeJsCodeList = (list?: string[]) => {
  const sanitized = sanitizeStringList(list);
  return sanitized && sanitized.length ? sanitized.slice(0, 10) : undefined;
};

export const CRAWL4AI_LLM_OPTION_GUARD_MESSAGE =
  "The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead.";

const CRAWL4AI_DISALLOWED_NORMALIZED_KEYS = new Set([
  "extractionstrategy",
  "llmconfig",
]);

const normalizeOptionGuardKey = (key: string) =>
  key.toLowerCase().replace(/[^a-z0-9]/g, "");

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isDisallowedStrategyType = (path: string, value: string) => {
  const normalizedPath = normalizeOptionGuardKey(path);
  const normalizedValue = normalizeOptionGuardKey(value);
  if (!normalizedValue.includes("llm")) {
    return false;
  }
  return (
    normalizedPath.includes("strategy") || normalizedPath.includes("extraction")
  );
};

const findDisallowedCrawl4aiLlmKeys = (
  value: unknown,
  prefix = "",
  seen = new Set<unknown>(),
): string[] => {
  if (!value || typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findDisallowedCrawl4aiLlmKeys(entry, `${prefix}[${index}]`, seen),
    );
  }

  const record = value as Record<string, unknown>;
  const hits: string[] = [];

  for (const [key, entry] of Object.entries(record)) {
    const normalized = normalizeOptionGuardKey(key);
    const path = prefix ? `${prefix}.${key}` : key;

    if (CRAWL4AI_DISALLOWED_NORMALIZED_KEYS.has(normalized)) {
      hits.push(path);
    }

    if (
      normalized === "type" &&
      typeof entry === "string" &&
      isDisallowedStrategyType(path, entry)
    ) {
      hits.push(path);
    }

    if (isPlainRecord(entry) || Array.isArray(entry)) {
      hits.push(...findDisallowedCrawl4aiLlmKeys(entry, path, seen));
    }
  }

  return hits;
};

export const assertNoCrawl4aiLlmOptions = (
  options: unknown,
  label = "crawlOptions",
) => {
  const blocked = findDisallowedCrawl4aiLlmKeys(options);
  if (blocked.length === 0) {
    return;
  }
  const keys = blocked.slice(0, 5).join(", ");
  const suffix = blocked.length > 5 ? ` (+${blocked.length - 5} more)` : "";
  throw new Error(
    `${label} contains crawl4ai LLM extraction settings (${keys}${suffix}). ${CRAWL4AI_LLM_OPTION_GUARD_MESSAGE}`,
  );
};


export const sanitizeStrategyOptions = (
  options?: CrawlStrategyOverridesFormValue,
): CrawlStrategyOverridesValue | undefined => {
  if (!options) {
    return undefined;
  }
  const cleaned: CrawlStrategyOverridesValue = {};
  if (options.cacheMode) {
    cleaned.cacheMode = options.cacheMode;
  }
  if (typeof options.scanFullPage === "boolean") {
    cleaned.scanFullPage = options.scanFullPage;
  }
  if (typeof options.adjustViewportToContent === "boolean") {
    cleaned.adjustViewportToContent = options.adjustViewportToContent;
  }
  if (typeof options.scrollDelayMs === "number") {
    cleaned.scrollDelayMs = options.scrollDelayMs;
  }
  if (typeof options.onlyMainContent === "boolean") {
    cleaned.onlyMainContent = options.onlyMainContent;
  }
  if (typeof options.extractLinks === "boolean") {
    cleaned.extractLinks = options.extractLinks;
  }
  if (typeof options.simulateUser === "boolean") {
    cleaned.simulateUser = options.simulateUser;
  }
  if (typeof options.overrideNavigator === "boolean") {
    cleaned.overrideNavigator = options.overrideNavigator;
  }
  const jsCode = sanitizeJsCodeList(options.jsCode);
  if (jsCode) {
    cleaned.jsCode = jsCode;
  }
  if (typeof options.jsOnly === "boolean") {
    cleaned.jsOnly = options.jsOnly;
  }
  const waitForSelector = options.waitForSelector?.trim();
  if (waitForSelector) {
    cleaned.waitForSelector = waitForSelector;
  }
  const waitForScript = options.waitForScript?.trim();
  if (waitForScript) {
    cleaned.waitForScript = waitForScript;
  }
  const waitForTimeoutMs =
    typeof options.waitForTimeoutMs === "number"
      ? Math.max(500, Math.min(60000, Math.round(options.waitForTimeoutMs)))
      : undefined;
  if (waitForTimeoutMs !== undefined) {
    cleaned.waitForTimeoutMs = waitForTimeoutMs;
  }
  if (
    options.waitUntil === "domcontentloaded" ||
    options.waitUntil === "load" ||
    options.waitUntil === "networkidle" ||
    options.waitUntil === "commit"
  ) {
    cleaned.waitUntil = options.waitUntil;
    if (cleaned.waitUntil === "networkidle" && typeof cleaned.waitForTimeoutMs === "number") {
      cleaned.waitForTimeoutMs = Math.max(5000, cleaned.waitForTimeoutMs);
    }
  }
  if (typeof options.pageTimeoutMs === "number") {
    cleaned.pageTimeoutMs = Math.max(1000, Math.min(180000, Math.round(options.pageTimeoutMs)));
  }
  if (typeof options.delayBeforeReturnHtmlMs === "number") {
    cleaned.delayBeforeReturnHtmlMs = Math.max(0, Math.min(30000, Math.round(options.delayBeforeReturnHtmlMs)));
  }
  if (typeof options.meanDelayMs === "number") {
    cleaned.meanDelayMs = Math.max(0, Math.min(10000, Math.round(options.meanDelayMs)));
  }
  if (typeof options.maxDelayRangeMs === "number") {
    cleaned.maxDelayRangeMs = Math.max(0, Math.min(10000, Math.round(options.maxDelayRangeMs)));
  }
  if (typeof options.semaphoreCount === "number") {
    cleaned.semaphoreCount = Math.max(1, Math.min(50, Math.round(options.semaphoreCount)));
  }
  if (typeof options.removeForms === "boolean") {
    cleaned.removeForms = options.removeForms;
  }
  const virtualScroll = sanitizeVirtualScrollConfig(options.virtualScroll);
  if (virtualScroll) {
    cleaned.virtualScroll = virtualScroll;
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
};

export const sanitizeMultiUrlConfigs = (
  configs?: CrawlMultiUrlStrategyFormValue[],
): CrawlMultiUrlStrategyValue[] | undefined => {
  if (!configs) {
    return undefined;
  }
  const normalized = configs
    .map((config) => {
      const name = config.name?.trim();
      const matcherPatterns = sanitizeStringList(config.matcher?.patterns);
      const matcher =
        matcherPatterns && matcherPatterns.length
          ? {
              matchMode: config.matcher?.matchMode || undefined,
              patterns: matcherPatterns,
            }
          : undefined;
      const urls = sanitizeStringList(config.urls);
      const options = sanitizeStrategyOptions(config.options);
      if (!matcher && (!urls || urls.length === 0)) {
        return null;
      }
      return {
        name: name || undefined,
        matcher,
        urls: urls && urls.length ? urls : undefined,
        options,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return normalized.length ? normalized : undefined;
};

export const sanitizeMarkdownOptions = (options?: MarkdownOptionsFormValue) => {
  if (!options) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  if (options.contentSource) {
    payload.contentSource = options.contentSource;
  }
  if (typeof options.ignoreLinks === "boolean") {
    payload.ignoreLinks = options.ignoreLinks;
  }
  if (typeof options.escapeHtml === "boolean") {
    payload.escapeHtml = options.escapeHtml;
  }
  if (typeof options.citations === "boolean") {
    payload.citations = options.citations;
  }
  if (typeof options.bodyWidth === "number") {
    payload.bodyWidth = options.bodyWidth;
  }
  return Object.keys(payload).length ? payload : undefined;
};

export const sanitizeMarkdownFilter = (filter?: MarkdownFilterFormValue) => {
  if (!filter?.type) {
    return undefined;
  }
  if (filter.type === "pruning") {
    const payload: Record<string, unknown> = { type: "pruning" };
    if (typeof filter.threshold === "number") {
      payload.threshold = filter.threshold;
    }
    if (filter.thresholdType === "fixed" || filter.thresholdType === "dynamic") {
      payload.thresholdType = filter.thresholdType;
    }
    if (typeof filter.minWordThreshold === "number") {
      payload.minWordThreshold = filter.minWordThreshold;
    }
    return payload;
  }
  if (filter.type === "bm25") {
    const payload: Record<string, unknown> = { type: "bm25" };
    if (typeof filter.userQuery === "string" && filter.userQuery.trim().length > 0) {
      payload.userQuery = filter.userQuery.trim();
    }
    if (typeof filter.bm25Threshold === "number") {
      payload.bm25Threshold = filter.bm25Threshold;
    }
    if (typeof filter.language === "string" && filter.language.trim().length > 0) {
      payload.language = filter.language.trim();
    }
    return payload;
  }
  return undefined;
};

export const sanitizeMarkdownStrategy = (
  strategy?: MarkdownStrategyFormValue,
): CrawlMarkdownStrategyValue | undefined => {
  if (!strategy?.type) {
    return undefined;
  }
  const trimmedType = strategy.type.trim();
  if (!trimmedType) {
    return undefined;
  }
  let params: Record<string, unknown> | undefined;
  if (strategy.params && strategy.params.trim().length) {
    try {
      const parsed = JSON.parse(strategy.params);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(
          "Custom Markdown strategy params must be a JSON object",
        );
      }
      params = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        (error as Error).message ??
          "Custom Markdown strategy params must be valid JSON",
      );
    }
  }
  const normalizedType = trimmedType.slice(0, 128);
  return params ? { type: normalizedType, params } : { type: normalizedType };
};

export const sanitizeTableExtraction = (
  strategy?: TableExtractionFormValue,
): CrawlTableExtractionValue | undefined => {
  const hasCustomParams =
    (strategy?.params && strategy.params.trim().length > 0) ||
    typeof strategy?.minRows === "number" ||
    typeof strategy?.minCols === "number";
  if (!strategy?.type && !hasCustomParams) {
    return undefined;
  }
  const rawType =
    strategy?.type?.trim() ?? (hasCustomParams ? "DefaultTableExtraction" : "");
  if (!rawType) {
    return undefined;
  }
  const trimmedType = rawType;
  let params: Record<string, unknown> | undefined;
  if (strategy.params && strategy.params.trim().length) {
    try {
      const parsed = JSON.parse(strategy.params);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Table extraction params must be a JSON object");
      }
      params = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        (error as Error).message ??
          "Table extraction params must be valid JSON",
      );
    }
  }
  const normalizedParams: Record<string, unknown> = params ? { ...params } : {};
  if (typeof strategy.minRows === "number") {
    normalizedParams.min_rows = strategy.minRows;
  }
  if (typeof strategy.minCols === "number") {
    normalizedParams.min_cols = strategy.minCols;
  }
  const normalizedType = trimmedType.slice(0, 128);
  return Object.keys(normalizedParams).length
    ? { type: normalizedType, params: normalizedParams }
    : { type: normalizedType };
};

export const sanitizeCleanMarkdown = (
  options?: CleanMarkdownFormValue,
): CrawlCleanMarkdownValue | undefined => {
  if (!options) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  if (
    typeof options.cssSelector === "string" &&
    options.cssSelector.trim().length
  ) {
    payload.cssSelector = options.cssSelector.trim();
  }
  const targetElements = sanitizeStringList(options.targetElements)?.slice(
    0,
    10,
  );
  if (targetElements?.length) {
    payload.targetElements = targetElements;
  }
  const excludedTags = sanitizeStringList(options.excludedTags)?.slice(0, 10);
  if (excludedTags?.length) {
    payload.excludedTags = excludedTags;
  }
  if (typeof options.removeOverlayElements === "boolean") {
    payload.removeOverlayElements = options.removeOverlayElements;
  }
  if (typeof options.wordCountThreshold === "number") {
    payload.wordCountThreshold = options.wordCountThreshold;
  }
  return Object.keys(payload).length
    ? (payload as CrawlCleanMarkdownValue)
    : undefined;
};

export const sanitizeLinkPreview = (
  preview?: LinkPreviewFormValue,
): CrawlLinkPreviewValue | undefined => {
  if (!preview) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  if (typeof preview.includeInternal === "boolean") {
    payload.includeInternal = preview.includeInternal;
  }
  if (typeof preview.includeExternal === "boolean") {
    payload.includeExternal = preview.includeExternal;
  }
  if (typeof preview.includeSocial === "boolean") {
    payload.includeSocial = preview.includeSocial;
  }
  if (typeof preview.maxLinks === "number") {
    payload.maxLinks = preview.maxLinks;
  }
  if (typeof preview.concurrency === "number") {
    payload.concurrency = preview.concurrency;
  }
  if (typeof preview.timeoutSeconds === "number") {
    payload.timeoutSeconds = preview.timeoutSeconds;
  }
  if (typeof preview.query === "string" && preview.query.trim().length > 0) {
    payload.query = preview.query.trim();
  }
  if (typeof preview.scoreThreshold === "number") {
    payload.scoreThreshold = preview.scoreThreshold;
  }
  if (typeof preview.verbose === "boolean") {
    payload.verbose = preview.verbose;
  }
  const includePatterns = sanitizeStringList(preview.includePatterns);
  if (includePatterns?.length) {
    payload.includePatterns = includePatterns;
  }
  const excludePatterns = sanitizeStringList(preview.excludePatterns);
  if (excludePatterns?.length) {
    payload.excludePatterns = excludePatterns;
  }
  return Object.keys(payload).length
    ? (payload as CrawlLinkPreviewValue)
    : undefined;
};

export const sanitizeBrowserHeaders = (headers?: BrowserHeaderFormValue[]) => {
  if (!headers || headers.length === 0) {
    return undefined;
  }
  const normalized = headers
    .map((header) => ({
      name: header?.name?.trim() ?? "",
      value: header?.value?.trim() ?? "",
    }))
    .filter((entry) => entry.name.length && entry.value.length)
    .slice(0, 20);
  return normalized.length ? normalized : undefined;
};

export const sanitizeBrowserCookies = (cookies?: BrowserCookieFormValue[]) => {
  if (!cookies || cookies.length === 0) {
    return undefined;
  }
  const normalized = cookies
    .map((cookie) => ({
      name: cookie?.name?.trim() ?? "",
      value: cookie?.value?.trim() ?? "",
      domain: cookie?.domain?.trim() ?? "",
      path: cookie?.path?.trim() || undefined,
    }))
    .filter(
      (entry) => entry.name.length && entry.value.length && entry.domain.length,
    )
    .slice(0, 20);
  return normalized.length ? normalized : undefined;
};

export const sanitizeUserAgentGenerator = (
  generator?: UserAgentGeneratorFormValue,
) => {
  if (!generator) {
    return undefined;
  }
  const normalized: UserAgentGeneratorFormValue = {};
  const platforms = ["windows", "macos", "linux", "android", "ios"];
  const browsers = ["chrome", "firefox", "safari", "edge"];
  const deviceTypes = ["desktop", "mobile", "tablet"];
  if (generator.platform && platforms.includes(generator.platform)) {
    normalized.platform = generator.platform;
  }
  if (generator.browser && browsers.includes(generator.browser)) {
    normalized.browser = generator.browser;
  }
  if (generator.deviceType && deviceTypes.includes(generator.deviceType)) {
    normalized.deviceType = generator.deviceType;
  }
  if (generator.locale) {
    const trimmed = generator.locale.trim();
    if (trimmed.length) {
      normalized.locale = trimmed.slice(0, 16);
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
};

export const sanitizeGeolocation = (
  geo?: GeolocationFormValue,
): CrawlGeolocationValue | undefined => {
  if (!geo) {
    return undefined;
  }
  const latitude = typeof geo.latitude === "number" ? geo.latitude : undefined;
  const longitude =
    typeof geo.longitude === "number" ? geo.longitude : undefined;
  if (latitude == null || longitude == null) {
    return undefined;
  }
  const normalized: CrawlGeolocationValue = {
    latitude: Math.max(-90, Math.min(90, Number(latitude.toFixed(6)))),
    longitude: Math.max(-180, Math.min(180, Number(longitude.toFixed(6)))),
  };
  if (typeof geo.accuracy === "number" && !Number.isNaN(geo.accuracy)) {
    normalized.accuracy = Math.max(1, Math.min(5000, Math.round(geo.accuracy)));
  }
  return normalized;
};

export const sanitizeVirtualScrollConfig = (
  config?: CrawlVirtualScrollConfigFormValue,
): CrawlVirtualScrollConfigValue | undefined => {
  if (!config) {
    return undefined;
  }

  const enabled = config.enabled === true;
  const containerSelectorRaw = config.containerSelector?.trim();
  const scrollCount =
    typeof config.scrollCount === "number" && Number.isFinite(config.scrollCount)
      ? Math.max(1, Math.min(1000, Math.round(config.scrollCount)))
      : undefined;
  const waitAfterScrollMs =
    typeof config.waitAfterScrollMs === "number" &&
    Number.isFinite(config.waitAfterScrollMs)
      ? Math.max(0, Math.min(60000, Math.round(config.waitAfterScrollMs)))
      : undefined;
  const scrollByPixels =
    typeof config.scrollByPixels === "number" && Number.isFinite(config.scrollByPixels)
      ? Math.max(1, Math.min(20000, Math.round(config.scrollByPixels)))
      : undefined;

  const scrollByRaw = config.scrollBy;
  const scrollBy =
    scrollByRaw === "container_height"
      ? "container_height"
      : scrollByRaw === "page_height"
        ? "page_height"
        : scrollByRaw === "viewport"
          ? "page_height"
          : scrollByRaw === "pixels" && typeof scrollByPixels === "number"
            ? String(scrollByPixels)
          : undefined;

  const hasValue =
    enabled ||
    Boolean(containerSelectorRaw) ||
    typeof scrollCount === "number" ||
    typeof waitAfterScrollMs === "number" ||
    typeof scrollByPixels === "number" ||
    Boolean(scrollBy);
  if (!hasValue) {
    return undefined;
  }

  const containerSelector =
    containerSelectorRaw && containerSelectorRaw.length
      ? containerSelectorRaw.slice(0, 512)
      : "body";

  const payload: CrawlVirtualScrollConfigValue = {
    containerSelector
  };
  if (typeof scrollCount === "number") {
    payload.scrollCount = scrollCount;
  }
  if (scrollBy) {
    payload.scrollBy = scrollBy;
  }
  if (typeof waitAfterScrollMs === "number") {
    payload.waitAfterScrollMs = waitAfterScrollMs;
  }

  return payload;
};

export const sanitizeCrawlOptions = (
  values: CrawlOptionsFormValues,
): CrawlOptionsValue => {
  const proxyConfigInput = values.proxyConfig;
  const proxyServer = proxyConfigInput?.server?.trim();
  const proxyConfig = proxyServer
    ? {
        server: proxyServer,
        username: proxyConfigInput?.username?.trim() || undefined,
        password: proxyConfigInput?.password?.trim() || undefined,
      }
    : undefined;
  const proxyUrl = proxyConfig ? undefined : values.proxyUrl?.trim();
  const additionalUrls = sanitizeStringList(values.additionalUrls);
  const multiUrlConfigs = sanitizeMultiUrlConfigs(values.multiUrlConfigs);
  const markdownOptions = sanitizeMarkdownOptions(values.markdownOptions);
  const markdownFilter = sanitizeMarkdownFilter(values.markdownFilter);
  const markdownStrategy = sanitizeMarkdownStrategy(values.markdownStrategy);
  const tableExtraction = sanitizeTableExtraction(values.tableExtraction);
  const cleanMarkdown = sanitizeCleanMarkdown(values.cleanMarkdown);
  const linkPreview = sanitizeLinkPreview(values.linkPreview);
  const jsCode = sanitizeJsCodeList(values.jsCode);
  const waitForSelector = values.waitForSelector?.trim();
  const waitForScript = values.waitForScript?.trim();
  const waitUntilRaw = values.waitUntil?.trim().toLowerCase();
  const waitUntil =
    waitUntilRaw === "domcontentloaded" ||
    waitUntilRaw === "load" ||
    waitUntilRaw === "networkidle" ||
    waitUntilRaw === "commit"
      ? waitUntilRaw
      : undefined;
  const waitForTimeoutMsRaw =
    typeof values.waitForTimeoutMs === "number"
      ? Math.max(500, Math.min(60000, Math.round(values.waitForTimeoutMs)))
      : undefined;
  const waitForTimeoutMs =
    waitUntil === "networkidle" && typeof waitForTimeoutMsRaw === "number"
      ? Math.max(5000, waitForTimeoutMsRaw)
      : waitForTimeoutMsRaw;
  const sessionId = values.sessionId?.trim();
  const storageState = values.storageState?.trim();
  const userDataDir = values.userDataDir?.trim();
  const browserHeaders = sanitizeBrowserHeaders(values.browserHeaders);
  const browserCookies = sanitizeBrowserCookies(values.browserCookies);
  const userAgent = values.userAgent?.trim();
  const userAgentMode =
    values.userAgentMode === "random" ? "random" : undefined;
  const userAgentGenerator = sanitizeUserAgentGenerator(
    values.userAgentGenerator,
  );
  const locale = values.locale?.trim();
  const timezoneId = values.timezoneId?.trim();
  const geolocation = sanitizeGeolocation(values.geolocation);
  const virtualScroll = sanitizeVirtualScrollConfig(values.virtualScroll);
  const tableScoreThreshold =
    typeof values.tableScoreThreshold === "number"
      ? Number(Math.max(0, Math.min(10, values.tableScoreThreshold)).toFixed(2))
      : undefined;

  const options: CrawlOptionsValue = {
    includeImages: values.includeImages ?? undefined,
    storeMedia:
      typeof values.storeMedia === "boolean" ? values.storeMedia : undefined,
    onlyMainContent: values.onlyMainContent ?? undefined,
    extractLinks: values.extractLinks ?? undefined,
    excludeExternalImages:
      typeof values.excludeExternalImages === "boolean"
        ? values.excludeExternalImages
        : undefined,
    scanFullPage: values.scanFullPage ?? undefined,
    adjustViewportToContent:
      typeof values.adjustViewportToContent === "boolean"
        ? values.adjustViewportToContent
        : undefined,
    scrollDelayMs: values.scrollDelayMs ?? undefined,
    headless: typeof values.headless === "boolean" ? values.headless : undefined,
    enableUndetectedBrowser: values.enableUndetectedBrowser ?? undefined,
    enableStealthMode: values.enableStealthMode ?? undefined,
    useManagedBrowser:
      typeof values.useManagedBrowser === "boolean"
        ? values.useManagedBrowser
        : undefined,
    userDataDir: userDataDir && userDataDir.length ? userDataDir : undefined,
    simulateUser: values.simulateUser ?? undefined,
    overrideNavigator: values.overrideNavigator ?? undefined,
    jsCode: jsCode ?? undefined,
    jsOnly: typeof values.jsOnly === "boolean" ? values.jsOnly : undefined,
    waitForSelector: waitForSelector ? waitForSelector : undefined,
    waitForScript: waitForScript ? waitForScript : undefined,
    waitForTimeoutMs: waitForTimeoutMs ?? undefined,
    waitUntil: waitUntil ?? undefined,
    pageTimeoutMs:
      typeof values.pageTimeoutMs === "number"
        ? Math.max(1000, Math.min(180000, Math.round(values.pageTimeoutMs)))
        : undefined,
    delayBeforeReturnHtmlMs:
      typeof values.delayBeforeReturnHtmlMs === "number"
        ? Math.max(0, Math.min(30000, Math.round(values.delayBeforeReturnHtmlMs)))
        : undefined,
    meanDelayMs:
      typeof values.meanDelayMs === "number"
        ? Math.max(0, Math.min(10000, Math.round(values.meanDelayMs)))
        : undefined,
    maxDelayRangeMs:
      typeof values.maxDelayRangeMs === "number"
        ? Math.max(0, Math.min(10000, Math.round(values.maxDelayRangeMs)))
        : undefined,
    semaphoreCount:
      typeof values.semaphoreCount === "number"
        ? Math.max(1, Math.min(50, Math.round(values.semaphoreCount)))
        : undefined,
    removeForms:
      typeof values.removeForms === "boolean"
        ? values.removeForms
        : undefined,
    waitForImages:
      typeof values.waitForImages === "boolean"
        ? values.waitForImages
        : undefined,
    sessionId: sessionId ? sessionId : undefined,
    storageState:
      storageState && storageState.length ? storageState : undefined,
    proxyUrl: proxyUrl ? proxyUrl : undefined,
    proxyConfig: proxyConfig ?? undefined,
    additionalUrls:
      additionalUrls && additionalUrls.length ? additionalUrls : undefined,
    multiUrlConfigs,
    markdownOptions: markdownOptions ?? undefined,
    markdownFilter: markdownFilter ?? undefined,
    markdownStrategy: markdownStrategy ?? undefined,
    tableScoreThreshold,
    tableExtraction: tableExtraction ?? undefined,
    cleanMarkdown: cleanMarkdown ?? undefined,
    scoreLinks:
      typeof values.scoreLinks === "boolean" ? values.scoreLinks : undefined,
    linkPreview: linkPreview ?? undefined,
    browserHeaders: browserHeaders ?? undefined,
    browserCookies: browserCookies ?? undefined,
    userAgent: userAgent?.length ? userAgent : undefined,
    userAgentMode: userAgentMode ?? undefined,
    userAgentGenerator: userAgentGenerator ?? undefined,
    locale: locale?.length ? locale : undefined,
    timezoneId: timezoneId?.length ? timezoneId : undefined,
    geolocation: geolocation ?? undefined,
    virtualScroll: virtualScroll ?? undefined,
  };

  const normalizedOptions = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as CrawlOptionsValue;

  assertNoCrawl4aiLlmOptions(normalizedOptions, "crawlOptions");

  return normalizedOptions;
};
