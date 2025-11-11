export interface CrawlJobData {
  taskId: string;
  orgId: string;
  triggeredById?: string;
}

export interface CrawlExecutionSummary {
  inserted: number;
  skipped: number;
  lastFetchedAt?: Date;
  runId?: string;
  memory?: CrawlMemoryStats;
  failures?: CrawlFailureDetail[];
  retryableFailures?: number;
}

export interface CrawlFailureDetail {
  url?: string;
  statusCode?: number;
  error?: string;
  retryable: boolean;
}

export type CrawlCacheMode = "bypass" | "prefer_cache" | "force_cache";

export type CrawlUrlMatchMode = "glob" | "regex" | "substring" | "prefix";

export type CrawlMarkdownContentSource = "raw_html" | "cleaned_html" | "fit_html";

export interface CrawlProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface CrawlUrlMatcher {
  matchMode?: CrawlUrlMatchMode;
  patterns?: string[];
}

export interface CrawlStrategyOverrides {
  cacheMode?: CrawlCacheMode;
  scanFullPage?: boolean;
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
  bodyWidth?: number;
}

export interface CrawlMarkdownFilter {
  type: "pruning";
  threshold?: number;
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

export interface CrawlTaskOptions {
  includeImages?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  storeMedia?: boolean;
  cacheMode?: CrawlCacheMode;
  sessionId?: string;
  storageState?: string;
  scanFullPage?: boolean;
  scrollDelayMs?: number;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  jsCode?: string[];
  jsOnly?: boolean;
  waitForSelector?: string;
  waitForScript?: string;
  waitForTimeoutMs?: number;
  proxyUrl?: string;
  proxyConfig?: CrawlProxyConfig;
  additionalUrls?: string[];
  multiUrlConfigs?: CrawlMultiUrlConfig[];
  markdownOptions?: CrawlMarkdownOptions;
  markdownFilter?: CrawlMarkdownFilter;
  scoreLinks?: boolean;
  linkPreview?: CrawlLinkPreviewOptions;
}

export interface CrawlMemoryStats {
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  efficiencyPercent?: number;
}
