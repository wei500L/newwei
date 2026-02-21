import type { CrawlTaskStatus } from "@prisma/client";

export interface CrawlJobData {
  taskId: string;
  orgId: string;
  triggeredById?: string;
  traceId?: string;
  memoryPressureRequeues?: number;
}

export interface CrawlExecutionSummary {
  inserted: number;
  skipped: number;
  itemsQueued?: number;
  itemsQueueFailed?: number;
  lastFetchedAt?: Date;
  runId?: string;
  memory?: CrawlMemoryStats;
  failures?: CrawlFailureDetail[];
  retryableFailures?: number;
}

export interface CrawlIngestBatchSummary {
  taskId: string;
  scanned: number;
  attempted: number;
  ingested: number;
  skippedExisting: number;
  failed: number;
  nextCursor?: string | null;
  hasMore: boolean;
}

export interface CrawlFailureDetail {
  url?: string;
  statusCode?: number;
  error?: string;
  retryable: boolean;
}

export type CrawlCacheMode = "bypass" | "prefer_cache" | "force_cache";

export type CrawlPageTypeHint = "auto" | "list" | "detail";

export type CrawlQualityProfile = "balanced" | "quality_first" | "speed_first";

export type CrawlAntiBotMode = "auto" | "enabled" | "disabled";

export interface CrawlDetailExpansionOptions {
  maxDetailUrls?: number;
  minRelevanceScore?: number;
  requireSameDomain?: boolean;
  allowExternalLinks?: boolean;
}

export type CrawlUrlMatchMode = "glob" | "regex" | "substring" | "prefix";

export type CrawlMarkdownContentSource = "raw_html" | "cleaned_html" | "fit_html";

export interface CrawlProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface CrawlBrowserHeader {
  name: string;
  value: string;
}

export interface CrawlBrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export type CrawlUserAgentMode = "random";

export type CrawlWaitUntil = "domcontentloaded" | "load" | "networkidle" | "commit";

export interface CrawlUserAgentGeneratorConfig {
  platform?: "windows" | "macos" | "linux" | "android" | "ios";
  browser?: "chrome" | "firefox" | "safari" | "edge";
  deviceType?: "desktop" | "mobile" | "tablet";
  locale?: string;
}

export interface CrawlGeolocationConfig {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export interface CrawlUrlMatcher {
  matchMode?: CrawlUrlMatchMode;
  patterns?: string[];
}

export interface CrawlStrategyOverrides {
  cacheMode?: CrawlCacheMode;
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
  waitUntil?: CrawlWaitUntil;
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  wordCountThreshold?: number;
  excludeExternalLinks?: boolean;
  excludeExternalImages?: boolean;
  removeOverlayElements?: boolean;
  processIframes?: boolean;
  cssSelector?: string;
  excludedTags?: string[];
  textMode?: boolean;
  waitForImages?: boolean;
  captureScreenshot?: boolean;
  virtualScroll?: CrawlVirtualScrollConfig;
  pageTypeHint?: CrawlPageTypeHint;
  autoExpandDetails?: boolean;
  detailExpansion?: CrawlDetailExpansionOptions;
  qualityProfile?: CrawlQualityProfile;
}

export interface CrawlMultiUrlConfig {
  name?: string;
  urls?: string[];
  matcher?: CrawlUrlMatcher;
  options?: CrawlStrategyOverrides;
}

export interface CrawlMarkdownOptions {
  contentSource?: CrawlMarkdownContentSource;
  ignoreLinks?: boolean;
  escapeHtml?: boolean;
  citations?: boolean;
  bodyWidth?: number;
}

export interface CrawlPruningMarkdownFilter {
  type: "pruning";
  threshold?: number;
  thresholdType?: "fixed" | "dynamic";
  minWordThreshold?: number;
}

export interface CrawlBm25MarkdownFilter {
  type: "bm25";
  userQuery?: string;
  bm25Threshold?: number;
  language?: string;
}

export type CrawlMarkdownFilter = CrawlPruningMarkdownFilter | CrawlBm25MarkdownFilter;

export interface CrawlMarkdownStrategy {
  type: string;
  params?: Record<string, unknown>;
}

export interface CrawlTableExtractionStrategy {
  type: string;
  params?: Record<string, unknown>;
}

export type CrawlVirtualScrollMode = "container_height" | "page_height" | "viewport";
export type CrawlVirtualScrollBy = CrawlVirtualScrollMode | number;

export interface CrawlVirtualScrollConfig {
  containerSelector?: string;
  scrollCount?: number;
  scrollBy?: CrawlVirtualScrollBy;
  waitAfterScrollMs?: number;
}

export interface CrawlCleanMarkdownOptions {
  cssSelector?: string;
  targetElements?: string[];
  excludedTags?: string[];
  removeOverlayElements?: boolean;
  wordCountThreshold?: number;
}

export interface CrawlLinkPreviewOptions {
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

export interface CrawlLinkAnalysisLink {
  href: string;
  text?: string;
  title?: string;
  baseDomain?: string;
  rel?: string;
  type?: string;
  intrinsicScore?: number;
  contextualScore?: number;
  totalScore?: number;
}

export interface CrawlLinkAnalysisStats {
  totalLinks: number;
  internalLinks: number;
  externalLinks: number;
  averageIntrinsicScore?: number;
  highQualityLinks?: number;
  lowQualityLinks?: number;
}

export interface CrawlLinkAnalysisBucket {
  kind: string;
  links: CrawlLinkAnalysisLink[];
}

export interface CrawlLinkAnalysis {
  stats: CrawlLinkAnalysisStats;
  buckets: CrawlLinkAnalysisBucket[];
  topLinks: CrawlLinkAnalysisLink[];
  lowQualityLinks: CrawlLinkAnalysisLink[];
}

export interface CrawlMediaSource {
  src?: string;
  srcset?: string;
  type?: string;
  media?: string;
  sizes?: string;
}

export interface CrawlMediaItem {
  src?: string;
  alt?: string;
  title?: string;
  desc?: string;
  type?: string;
  format?: string;
  width?: number;
  height?: number;
  score?: number;
  poster?: string;
  sizes?: string;
  srcset?: string[];
  pictureSources?: CrawlMediaSource[];
  responsiveSources?: CrawlMediaSource[];
  raw?: Record<string, unknown>;
}

export type CrawlMediaCollection = Record<string, CrawlMediaItem[]>;

export type Crawl4aiMediaEntry = Record<string, unknown>;

export type Crawl4aiMedia = Record<string, Crawl4aiMediaEntry[]>;

export interface CrawlStoredMediaAsset {
  id: string;
  kind: string;
  sourceUrl: string;
  bytes: number;
  contentType?: string;
  storageProvider?: "mysql" | "s3";
  storageKey?: string;
  previewUrl?: string;
  downloadUrl?: string;
  dataUri?: string;
  width?: number;
  height?: number;
  alt?: string;
  title?: string;
  desc?: string;
  poster?: string;
  format?: string;
  metadata?: Record<string, unknown>;
}

export type CrawlTableCell = string | number | boolean | null;

export type CrawlResultTableRecord = Record<string, CrawlTableCell>;

export interface CrawlResultTable {
  id: string;
  caption?: string;
  headers: string[];
  rows: CrawlTableCell[][];
  rowCount: number;
  columnCount: number;
  source?: string;
  metadata?: Record<string, unknown>;
  dataFrame: {
    columns: string[];
    rows: CrawlResultTableRecord[];
  };
}

export interface Crawl4aiTablePayload {
  id?: string;
  caption?: string;
  headers?: string[];
  rows?: CrawlTableCell[][];
  data?: Record<string, CrawlTableCell>[];
  metadata?: Record<string, unknown>;
  source_xpath?: string;
  sourceXPath?: string;
}

export interface CrawlTaskOptions {
  includeImages?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  storeMedia?: boolean;
  cacheMode?: CrawlCacheMode;
  prefetch?: boolean;
  sessionId?: string;
  storageState?: string;
  scanFullPage?: boolean;
  adjustViewportToContent?: boolean;
  scrollDelayMs?: number;
  headless?: boolean;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  antiBotMode?: CrawlAntiBotMode;
  useManagedBrowser?: boolean;
  userDataDir?: string;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  waitUntil?: CrawlWaitUntil;
  pageTimeoutMs?: number;
  delayBeforeReturnHtmlMs?: number;
  meanDelayMs?: number;
  maxDelayRangeMs?: number;
  semaphoreCount?: number;
  removeForms?: boolean;
  proxyUrl?: string;
  proxyConfig?: CrawlProxyConfig;
  additionalUrls?: string[];
  multiUrlConfigs?: CrawlMultiUrlConfig[];
  markdownOptions?: CrawlMarkdownOptions;
  markdownFilter?: CrawlMarkdownFilter;
  markdownStrategy?: CrawlMarkdownStrategy;
  tableScoreThreshold?: number;
  tableExtraction?: CrawlTableExtractionStrategy;
  cleanMarkdown?: CrawlCleanMarkdownOptions;
  scoreLinks?: boolean;
  linkPreview?: CrawlLinkPreviewOptions;
  browserHeaders?: CrawlBrowserHeader[];
  browserCookies?: CrawlBrowserCookie[];
  userAgent?: string;
  userAgentMode?: CrawlUserAgentMode;
  userAgentGenerator?: CrawlUserAgentGeneratorConfig;
  locale?: string;
  timezoneId?: string;
  geolocation?: CrawlGeolocationConfig;
  wordCountThreshold?: number;
  excludeExternalLinks?: boolean;
  removeOverlayElements?: boolean;
  processIframes?: boolean;
  cssSelector?: string;
  excludedTags?: string[];
  textMode?: boolean;
  captureScreenshot?: boolean;
  virtualScroll?: CrawlVirtualScrollConfig;
  excludeExternalImages?: boolean;
  waitForImages?: boolean;
  pageTypeHint?: CrawlPageTypeHint;
  autoExpandDetails?: boolean;
  detailExpansion?: CrawlDetailExpansionOptions;
  qualityProfile?: CrawlQualityProfile;
}

export interface CrawlMemoryStats {
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  efficiencyPercent?: number;
}

export interface CrawlTaskResult {
  id: string;
  sourceUrl: string;
  fetchedAt: Date;
  markdown: string;
  itemId?: string | null;
  itemStatus?: string | null;
  metadata?: Record<string, unknown> | null;
  markdownWithCitations?: string | null;
  referencesMarkdown?: string | null;
  fitMarkdown?: string | null;
  linkAnalysis?: CrawlLinkAnalysis | null;
  media?: CrawlMediaCollection | null;
  mediaAssets?: CrawlStoredMediaAsset[] | null;
  tables?: CrawlResultTable[] | null;
}

export interface CrawlTaskView {
  id: string;
  targetUrl: string;
  displayName?: string | null;
  status: CrawlTaskStatus;
  keywords: string[];
  concurrency: number;
  timeRangeFrom?: Date | null;
  timeRangeTo?: Date | null;
  lastRunAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastResultAt?: Date | null;
  lastCursor?: string | null;
  lastError?: string | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
  resultCount: number;
  config?: Record<string, unknown> | null;
  results?: CrawlTaskResult[];
  memoryStats?: CrawlMemoryStats | null;
  lastRunSummary?: CrawlExecutionSummary | null;
  lastServerMemoryMb?: number | null;
  lastPeakMemoryMb?: number | null;
  lastMemoryEfficiency?: number | null;
}

export type CrawlMetadataSource = "sitemap" | "urls";

export interface CrawlMetadataExtractionInput {
  source?: CrawlMetadataSource;
  domain?: string;
  urls?: string[];
  pattern?: string;
  maxUrls?: number;
  query?: string;
  scoreThreshold?: number;
  extractJsonLd?: boolean;
  extractOpenGraph?: boolean;
  extractStandardMeta?: boolean;
  concurrency?: number;
}

export interface CrawlMetadataTag {
  name: string;
  value: string;
}

export interface CrawlMetadataResult {
  url: string;
  status: "success" | "failed";
  httpStatus?: number;
  fetchedAt?: Date;
  title?: string;
  description?: string;
  keywords?: string[];
  author?: string;
  metaTags: CrawlMetadataTag[];
  openGraph: CrawlMetadataTag[];
  jsonLd: string[];
  relevanceScore?: number;
  error?: string;
}
