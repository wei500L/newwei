import type { CrawlTaskStatus } from "@prisma/client";

export type CrawlPriorityClass = "hot" | "normal";
export type CrawlJobKind =
  | "task"
  | "frontier_node"
  | "frontier_llm_judge"
  | "frontier_llm_learn";
export type CrawlSiteExecutionMode = "layered" | "native" | "hybrid";
export type CrawlHostScope = "registrable_domain" | "strict_hosts";
export type CrawlSourceTier = "tier1" | "tier2" | "tier3";
export type CrawlSeedStrategy =
  | "auto"
  | "seed_first"
  | "frontier_first"
  | "frontier_only";
export type CrawlSeedDiscoveryMode =
  | "robots"
  | "common_paths"
  | "sitemap_only"
  | "disabled";
export type CrawlLlmAssistRecallMode =
  | "high_recall"
  | "balanced"
  | "low_cost";
export type CrawlLlmAssistShadowRole = "active" | "shadow";
export type CrawlLlmAssistShadowState =
  | "candidate"
  | "evaluating"
  | "published";
export type CrawlFrontierRunStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";
export type CrawlFrontierPageType = "home" | "category" | "list" | "article";
export type CrawlFrontierNodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled";

export interface CrawlJobData {
  taskId: string;
  orgId: string;
  triggeredById?: string;
  traceId?: string;
  memoryPressureRequeues?: number;
  priorityClass?: CrawlPriorityClass;
  sourcePriority?: number;
  jobKind?: CrawlJobKind;
  frontierRunId?: string;
  frontierNodeId?: string;
  frontierLlmJudge?: CrawlFrontierLlmJudgeJobPayload;
  frontierLlmLearn?: CrawlFrontierLlmLearnJobPayload;
}

export interface CrawlFrontierCandidatePayload {
  url: string;
  pageType: CrawlFrontierPageType;
  score: number;
  freshnessScore: number;
  metadata: Record<string, unknown>;
}

export interface CrawlFrontierLlmJudgeJobPayload {
  mode: "discovery" | "seed";
  runId: string;
  nodeId: string;
  taskId: string;
  maxDepth: number;
  maxPages: number;
  candidates: CrawlFrontierCandidatePayload[];
  diagnostics?: Record<string, unknown>;
  maxDepthOverride?: number;
  maxNewNodes?: number;
  metadataPatch?: Record<string, unknown>;
  seedContext?: {
    seedMethod?: string | null;
    seedDiscoveryMode?: string | null;
    diagnostics?: Record<string, unknown>;
    discoveredCount: number;
    qualityThresholds?: CrawlSeedQualityThresholds;
  };
}

export interface CrawlFrontierLlmLearnJobPayload {
  runId: string;
}

export interface CrawlDeepCrawlComponent {
  type: string;
  params?: Record<string, unknown>;
}

export interface CrawlPageTypeSignalConfig {
  patterns?: string[];
  keywords?: string[];
}

export interface CrawlFreshnessRules {
  recentHours?: number;
  weekHours?: number;
  monthHours?: number;
}

export interface CrawlLocaleScopeConfig {
  locale?: string;
  acceptLanguages?: string[];
  denyUrlPatterns?: string[];
  denyHostPatterns?: string[];
}

export interface CrawlSeedQualityThresholds {
  minCandidates?: number;
  minArticleRatio?: number;
  maxNoiseRatio?: number;
  minFreshRatio?: number;
}

export interface CrawlSeedDiscoveryConfig {
  strategy?: CrawlSeedStrategy;
  mode?: CrawlSeedDiscoveryMode;
  freshnessWindowHours?: number;
  maxSeedUrls?: number;
  topologyBudgetPages?: number;
  topologyBudgetDepth?: number;
  qualityThresholds?: CrawlSeedQualityThresholds;
}

export interface CrawlLlmAssistAutoPublishThresholds {
  minArticleLift?: number;
  minNoiseReduction?: number;
  minJudgeConfidence?: number;
}

export interface CrawlLlmAssistShadowConfig {
  role?: CrawlLlmAssistShadowRole;
  shadowOfProfileId?: string;
  originProfileVersion?: number;
  state?: CrawlLlmAssistShadowState;
  evaluationRunsCompleted?: number;
  consecutivePasses?: number;
  lastOriginRunId?: string;
  lastShadowRunId?: string;
  lastPublishedAt?: string | null;
  lastSuggestedAt?: string | null;
  lastSuggestionConfidence?: number;
  lastSuggestionReason?: string | null;
}

export interface CrawlLlmAssistConfig {
  enabled?: boolean;
  recallMode?: CrawlLlmAssistRecallMode;
  judgeModel?: string;
  siteLearnerModel?: string;
  candidateBudgetByPageType?: Partial<Record<CrawlFrontierPageType, number>>;
  minJudgeConfidence?: number;
  shadowEvaluationRuns?: number;
  autoPublishThresholds?: CrawlLlmAssistAutoPublishThresholds;
  shadow?: CrawlLlmAssistShadowConfig;
}

export interface CrawlSiteProfileConfig {
  keywords?: string[];
  priorityKeywords?: string[];
  denyKeywords?: string[];
  blockedDomains?: string[];
  hostScope?: CrawlHostScope;
  allowedHosts?: string[];
  allowedDomains?: string[];
  domLinkScopes?: string[];
  domLinkExcludeSelectors?: string[];
  urlQueryParamAllowlist?: string[];
  urlPatterns?: Partial<Record<CrawlFrontierPageType | "exclude", string[]>>;
  pageTypeSignals?: Partial<
    Record<CrawlFrontierPageType | "deny", CrawlPageTypeSignalConfig>
  >;
  freshnessRules?: CrawlFreshnessRules;
  localeScope?: CrawlLocaleScopeConfig;
  seedDiscovery?: CrawlSeedDiscoveryConfig;
  llmAssist?: CrawlLlmAssistConfig;
  sourceTier?: CrawlSourceTier;
  pageRules?: Partial<Record<CrawlFrontierPageType, Record<string, unknown>>>;
  layeredOptions?: {
    maxDepth?: number;
    maxPages?: number;
    maxChildrenPerNode?: number;
    paginationKeepCount?: number;
    scoreThreshold?: number;
  };
  nativeOptions?: {
    deepCrawlStrategy?: CrawlDeepCrawlComponent;
    filterChain?: CrawlDeepCrawlComponent;
    urlScorer?: CrawlDeepCrawlComponent;
    adaptiveCrawling?: CrawlDeepCrawlComponent;
    stream?: boolean;
    fallbackToLayered?: boolean;
    minAcceptedResults?: number;
    minArticleResults?: number;
  };
  crawlOptions?: Record<string, unknown>;
}

export interface CrawlSiteProfileRecord {
  id: string;
  orgId: string;
  name: string;
  description?: string | null;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  version: number;
  config: CrawlSiteProfileConfig;
  createdById: string;
  updatedById?: string | null;
  publishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlSiteProfileVersionRecord {
  id: string;
  profileId: string;
  orgId: string;
  version: number;
  name: string;
  description?: string | null;
  matchHost: string;
  isActive: boolean;
  executionMode: CrawlSiteExecutionMode;
  config: CrawlSiteProfileConfig;
  createdById: string;
  createdAt: Date;
}

export interface CrawlFrontierRunRecord {
  id: string;
  orgId: string;
  profileId?: string | null;
  seedUrl: string;
  crawlTaskId?: string | null;
  executionMode: CrawlSiteExecutionMode;
  status: CrawlFrontierRunStatus;
  maxDepth: number;
  maxPages: number;
  keywords?: string[];
  pageCount: number;
  nodeCount: number;
  articleCount: number;
  failedCount: number;
  duplicateCount: number;
  nativeRunId?: string | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
  createdById: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlFrontierNodeRecord {
  id: string;
  runId: string;
  parentNodeId?: string | null;
  orgId: string;
  url: string;
  canonicalUrl?: string | null;
  urlFingerprint?: string | null;
  pageType: CrawlFrontierPageType;
  depth: number;
  queueClass: CrawlPriorityClass;
  status: CrawlFrontierNodeStatus;
  score?: number | null;
  freshnessScore?: number | null;
  attempts: number;
  queuedAt?: Date | null;
  crawledAt?: Date | null;
  crawlResultId?: string | null;
  rejectionReason?: string | null;
  lastError?: string | null;
  metadata?: Record<string, unknown> | null;
  discoveredAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlExecutionSummary {
  inserted: number;
  skipped: number;
  reusedResultId?: string;
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
  includeUrlPatterns?: string[];
  excludeUrlPatterns?: string[];
  minPublishTimeConfidence?: number;
  preferFitMarkdownForQuality?: boolean;
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
  deepCrawlStrategy?: CrawlDeepCrawlComponent;
  filterChain?: CrawlDeepCrawlComponent;
  urlScorer?: CrawlDeepCrawlComponent;
  adaptiveCrawling?: CrawlDeepCrawlComponent;
  stream?: boolean;
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
