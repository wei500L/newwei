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
}

export type CrawlCacheMode = "bypass" | "prefer_cache" | "force_cache";

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
}

export interface CrawlMemoryStats {
  serverMemoryMb?: number;
  peakMemoryMb?: number;
  efficiencyPercent?: number;
}
