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

export interface CrawlTaskOptions {
  includeImages?: boolean;
  onlyMainContent?: boolean;
  extractLinks?: boolean;
  cacheMode?: CrawlCacheMode;
  scanFullPage?: boolean;
  scrollDelayMs?: number;
  enableUndetectedBrowser?: boolean;
  enableStealthMode?: boolean;
  simulateUser?: boolean;
  overrideNavigator?: boolean;
  proxyUrl?: string;
  proxyConfig?: CrawlProxyConfig;
  additionalUrls?: string[];
  multiUrlConfigs?: CrawlMultiUrlConfig[];
  markdownOptions?: CrawlMarkdownOptions;
  markdownFilter?: CrawlMarkdownFilter;
}

export interface CrawlMemoryStats {
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  efficiencyPercent?: number;
}
