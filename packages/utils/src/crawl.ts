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
  bodyWidth?: number;
}

export interface MarkdownFilterFormValue {
  type?: string;
  threshold?: number;
  thresholdType?: "fixed" | "dynamic";
  minWordThreshold?: number;
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

export interface CrawlOptionsFormValues {
  includeImages?: boolean;
  storeMedia?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  excludeExternalImages?: boolean;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
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

export interface CrawlOptionsValue {
  includeImages?: boolean;
  storeMedia?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  excludeExternalImages?: boolean;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
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
}

export const sanitizeStringList = (list?: string[]) =>
  list
    ?.map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && value.length > 0));

export const sanitizeJsCodeList = (list?: string[]) => {
  const sanitized = sanitizeStringList(list);
  return sanitized && sanitized.length ? sanitized.slice(0, 10) : undefined;
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
  if (typeof options.waitForTimeoutMs === "number") {
    cleaned.waitForTimeoutMs = options.waitForTimeoutMs;
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
  if (typeof options.bodyWidth === "number") {
    payload.bodyWidth = options.bodyWidth;
  }
  return Object.keys(payload).length ? payload : undefined;
};

export const sanitizeMarkdownFilter = (filter?: MarkdownFilterFormValue) => {
  if (!filter?.type) {
    return undefined;
  }
  const payload: Record<string, unknown> = { type: filter.type };
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
    waitForTimeoutMs: values.waitForTimeoutMs ?? undefined,
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
  };

  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as CrawlOptionsValue;
};
