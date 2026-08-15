import type { Dayjs } from "dayjs";

import type { SeedSchedulerRuntimeSettings } from "@/lib/news-source-seed";

export interface NewsSourceApiRecord {
  id: string;
  name: string;
  url: string;
  siteType: string;
  language?: string | null;
  crawlTemplateId?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowBindingMode?: "published" | "pinned";
  group?: string | null;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number | null;
  circuitOpenUntil?: string | null;
  nextRunAt?: string | null;
  config?: Record<string, unknown> | null;
  opsSummary?: {
    latestJob?: NewsSourceRecord["latestJob"];
    latestCrawlTask?: NewsSourceRecord["latestCrawlTask"];
    latestArticle?: NewsSourceRecord["latestArticle"];
    stats24h?: NewsSourceRecord["stats24h"];
    runtime?: {
      crawlTaskQueuedCount: number;
      crawlTaskRunningCount: number;
      backpressureUntil?: string | null;
      backpressurePendingJobs?: number | null;
      backpressureThreshold?: number | null;
      backpressureCount24h: number;
      rssAdaptiveState?: unknown;
    };
  };
}

export interface NewsSourceListResponse {
  sources: NewsSourceApiRecord[];
  total: number;
  page: number;
  pageSize: number;
}
export interface NewsSourceRecord {
  id: string;
  name: string;
  url: string;
  siteType: string;
  language?: string | null;
  crawlTemplateId?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  workflowBindingMode?: "published" | "pinned";
  group?: string | null;
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number | null;
  circuitOpenUntil?: string | null;
  nextRunAt?: string | null;
  backpressureUntil?: string | null;
  backpressurePendingJobs?: number | null;
  backpressureThreshold?: number | null;
  rssAdaptiveState?: unknown;
  config?: Record<string, unknown> | null;
  latestJob?: {
    id: string;
    status: string;
    url: string;
    createdAt: string;
    startedAt?: string | null;
    completedAt?: string | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  latestCrawlTask?: {
    id: string;
    status: string;
    lastError?: string | null;
    lastRunAt?: string | null;
    lastSuccessAt?: string | null;
    lastResultAt?: string | null;
  } | null;
  latestArticle?: {
    id: string;
    url: string;
    crawlAt: string;
    titleGuess?: string | null;
  } | null;
  crawlTaskQueuedCount: number;
  crawlTaskRunningCount: number;
  backpressureCount24h: number;
  stats24h: {
    completed: number;
    failed: number;
    successRate?: number | null;
    avgDurationMs?: number | null;
  };
}

export interface NewsSourceReadinessSummary {
  total: number;
  active: number;
  inactive: number;
  circuitOpen: number;
  failing: number;
}

export interface CrawlQualitySampleCounts {
  markdownCount: number;
  expansionTriggeredTaskCount: number;
  headSignalAttemptedCount: number;
  preflightRunCount: number;
  dedupeEvaluatedCount: number;
}

export interface RefreshAllOptions {
  silent?: boolean;
  includeQueue?: boolean;
  includeQuality?: boolean;
}
export interface CrawlTemplateRecord {
  id: string;
  name: string;
  isActive: boolean;
}

export interface NewsSourcePreviewCandidate {
  url: string;
  status: "success" | "failed";
  title?: string;
  description?: string;
  author?: string;
  relevanceScore?: number;
  publishedAt?: string | null;
  crawledAt?: string | null;
  effectiveAt?: string | null;
  timestampSource?: "published" | "crawled" | "none";
  publishDateMissing?: boolean;
  alreadyCrawled: boolean;
  lastCrawlAt?: string | null;
  alreadyQueued?: boolean;
  inFlightStatus?: string | null;
  error?: string;
}

export interface NewsSourcePreviewDeepError {
  code: string;
  message: string;
  detail?: string;
}

export interface NewsSourcePreviewDeepFailureStats {
  total24h: number;
  streak: number;
  byCode: { code: string; count: number }[];
  lastFailureAt?: string | null;
  lastCode?: string | null;
  lastMessage?: string | null;
  lastDetail?: string | null;
  nextRetryAt?: string | null;
  circuitOpenUntil?: string | null;
}

export interface NewsSourcePreviewResponse {
  mode: "single" | "sitemap" | "rss" | "list" | "deep";
  sourceId: string;
  url: string;
  name: string;
  seed?: Record<string, unknown> | null;
  candidates: NewsSourcePreviewCandidate[];
  availableToSchedule?: number;
  inFlightCount?: number;
  inFlightLimit?: number;
  scheduleCount: number;
  skippedCount: number;
  deepPreviewError?: NewsSourcePreviewDeepError;
  deepFailureStats?: NewsSourcePreviewDeepFailureStats | null;
}

export interface Crawl4aiQueueStats {
  queueName: string;
  updatedAt: string;
  pending: number;
  counts: Record<string, number>;
  maxConcurrency?: number;
}

export interface Crawl4aiQualitySourceMetric {
  sourceId: string;
  taskCount: number;
  sampleCounts?: CrawlQualitySampleCounts;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects?: {
    includePattern: number;
    excludePattern: number;
    publishConfidence: number;
  };
  publishConfidenceBuckets?: {
    lt04: number;
    from04To06: number;
    from06To08: number;
    gte08: number;
  };
  fitMarkdownPreferenceRate?: number;
  headSignalSuccessRate?: number;
  headSignalSoftFailureRate?: number;
  headSignalTruncatedRate?: number;
  headSignalNoPublishSignalRate?: number;
  http304HitRate?: number;
  orgHashDedupeHitRate?: number;
  preflightFailureRate?: number;
}

export interface Crawl4aiQualitySnapshot {
  orgId: string;
  from: string;
  to: string;
  taskCount: number;
  sampleCounts?: CrawlQualitySampleCounts;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects?: {
    includePattern: number;
    excludePattern: number;
    publishConfidence: number;
  };
  publishConfidenceBuckets?: {
    lt04: number;
    from04To06: number;
    from06To08: number;
    gte08: number;
  };
  fitMarkdownPreferenceRate?: number;
  headSignalSuccessRate?: number;
  headSignalSoftFailureRate?: number;
  headSignalTruncatedRate?: number;
  headSignalNoPublishSignalRate?: number;
  http304HitRate?: number;
  orgHashDedupeHitRate?: number;
  preflightFailureRate?: number;
  alertThresholds?: {
    preflightFailureRateHigh?: number;
    http304HitRateLow?: number;
    orgHashDedupeHitRateHigh?: number;
  };
  groupedBySource: Crawl4aiQualitySourceMetric[];
}

export interface NewsSourceDispatchResponse {
  sourceId: string;
  mode: "single" | "sitemap" | "rss" | "list" | "deep";
  scheduledFor: string;
  nextRunAt: string;
  scheduledCount: number;
  skippedCount: number;
  rssSkippedNoBodyCount?: number;
  enqueueFailures: number;
  pipelineJobIds: string[];
  crawlTaskIds: string[];
  inFlightCount?: number;
  inFlightLimit?: number;
  reason: "ok" | "in_flight" | "no_new_urls" | "deduped";
  dedupeUntil?: string;
}

export interface NewsSourceCancelQueuedResponse {
  sourceId: string;
  removedJobs: number;
  scannedJobs: number;
  canceledTaskIds: string[];
}

export interface NewsSourceClearInflightResponse {
  sourceId: string;
  cutoff: string;
  clearedJobs: number;
}

export interface NewsSourceRetryLatestResponse {
  sourceId: string;
  retryType: "crawl" | "pipeline";
  crawlTaskId?: string;
  pipelineJobId?: string;
  status: string;
  retried: boolean;
}

export interface NewsSourceOpmlPresetSummary {
  id: string;
  name: string;
  description: string;
  defaultLanguage: string;
  entryCount: number;
}

export interface NewsSourceOpmlPreviewEntry {
  name: string;
  url: string;
  feedUrl: string;
  language: string;
  group?: string | null;
  enabled: boolean;
  valid: boolean;
  alreadyExists: boolean;
  errors: string[];
}

export interface NewsSourceOpmlPreviewResponse {
  presetId: string | null;
  title: string | null;
  entries: NewsSourceOpmlPreviewEntry[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicates: number;
    enabled: number;
  };
}

export interface NewsSourceOpmlImportReport {
  summary: {
    total: number;
    enabled: number;
    created: number;
    skipped: number;
    failed: number;
  };
  created: { id: string; name: string; url: string }[];
  skipped: { name: string; url: string; reason: string }[];
  failed: { name: string; url: string; error: string }[];
}

export type NewsSourceOpmlMode = "preset" | "upload";

export interface NewsSourceScheduleValues {
  nextRunAt: Dayjs;
}

export interface NewsSourceSchedulerSettingsResponse
  extends SeedSchedulerRuntimeSettings {
  source?: "default" | "db";
}

export interface NewsSourceFormValues {
  name: string;
  url: string;
  siteType: string;
  language?: string;
  group?: string[] | null;
  crawlTemplateId?: string;
  workflowId?: string;
  workflowVersionId?: string;
  workflowBindingMode?: "published" | "pinned";
  frequencySeconds: number;
  priority: number;
  isActive: boolean;
  scheduleMode?: "interval" | "cron";
  cronExpression?: string;
  cronTimezone?: string;
  cronWindowDaysOfWeek?: number[];
  cronWindowStartHour?: number;
  cronWindowEndHour?: number;
  keywords?: string;
  tags?: string;
  summaryHints?: string;
  metadataJson?: string;
  crawlScanMode?: "default" | "full_page" | "virtual_scroll";
  crawlScrollDelayMs?: number;
  crawlVirtualScrollContainerSelector?: string;
  crawlVirtualScrollScrollCount?: number;
  crawlVirtualScrollScrollBy?: "page_height" | "container_height" | "pixels";
  crawlVirtualScrollScrollByPixels?: number;
  crawlVirtualScrollWaitAfterScrollMs?: number;
  crawlQualityProfile?: "quality_first" | "balanced" | "speed_first";
  crawlPageTypeHint?: "auto" | "list" | "detail";
  crawlAutoExpandDetails?: boolean;
  crawlDetailMaxUrls?: number;
  crawlDetailMinRelevanceScore?: number;
  crawlDetailRequireSameDomain?: boolean;
  crawlDetailAllowExternalLinks?: boolean;
  crawlDetailMinPublishTimeConfidence?: number;
  crawlDetailPreferFitMarkdownForQuality?: boolean;
  crawlDetailIncludeUrlPatterns?: string[];
  crawlDetailExcludeUrlPatterns?: string[];
  crawlMarkdownContentSource?: "cleaned_html" | "raw_html" | "fit_html";
  crawlMarkdownEscapeHtmlMode?: "auto" | "enable" | "disable";
  crawlMarkdownCitationsMode?: "auto" | "enable" | "disable";
  crawlOptionsJson?: string;
  crawlHeadlessMode?: "auto" | "headless" | "headed";
  crawlUndetectedMode?: "auto" | "enable" | "disable";
  crawlStealthMode?: "auto" | "enable" | "disable";
  crawlAntiBotMode?: "auto" | "enable" | "disable";
  forceRefresh?: boolean;
  seedEnabled?: boolean;
  seedMode?: "sitemap" | "rss" | "list" | "deep";
  seedDomain?: string;
  seedPattern?: string;
  seedFeedUrl?: string;
  seedRssAdaptiveEnabled?: boolean;
  seedRssAdvancedEnabled?: boolean;
  seedRssRequestTimeoutMs?: number;
  seedRssBodySourceStrategy?: "content_first" | "content_only" | "summary_only";
  seedRssNoBodyPolicy?: "skip" | "title_description_stub";
  seedQuery?: string;
  seedMaxUrls?: number;
  seedMaxNewUrlsPerRun?: number;
  seedScoreThreshold?: number;
  seedDedupeWindowHours?: number;
  seedCacheTtlSeconds?: number;
  seedConcurrency?: number;
  seedListMaxPages?: number;
  seedListPageConcurrency?: number;
  seedFollowPagination?: boolean;
  seedDeepMaxPages?: number;
  seedDeepMaxDepth?: number;
  seedDeepTimeBudgetSeconds?: number;
  seedDeepPageConcurrency?: number;
  seedDeepScoreThreshold?: number;
  seedDeepCandidatePoolSize?: number;
  seedDeepHeadFetchTopK?: number;
  seedDeepPreferPathDate?: boolean;
  seedDeepEnableSecondaryHubs?: boolean;
  seedDeepIgnoreRobotsTxt?: boolean;
  seedQueryParamAllowlist?: string[];
}

export interface CrawlStrategyTagDescriptor {
  key: string;
  color: string;
  label: string;
}
export type LiveEventSource =
  | "pipeline"
  | "crawl"
  | "analysis"
  | "assistant"
  | "alerts";

export interface OpsLiveEvent {
  orgId: string;
  source: LiveEventSource;
  event: string;
  jobId: string;
  timestamp: string;
  data?: Record<string, unknown>;
  pipelineJobId?: string;
  sourceId?: string;
  rawItemId?: string;
  itemMetaId?: string;
  processedItemId?: string;
  taskId?: string;
  priorityClass?: "hot" | "normal";
  sourcePriority?: number;
}
export type CrawlQualitySampleMetric =
  | "markdownCount"
  | "expansionTriggeredTaskCount"
  | "headSignalAttemptedCount"
  | "preflightRunCount"
  | "dedupeEvaluatedCount";

export interface CrawlQualityThresholds {
  preflightFailureRateHigh: number;
  http304HitRateLow: number;
  orgHashDedupeHitRateHigh: number;
}

export type CrawlQualityRateAlertKey =
  | "softFailure"
  | "truncated"
  | "noPublishSignal"
  | "preflightFailure"
  | "http304Low"
  | "orgHashDedupeHigh";

export interface CrawlQualityRateAlert {
  key: CrawlQualityRateAlertKey;
  direction: "high" | "low";
  threshold: number;
  overallRate: number;
  extremeSource?: { sourceId: string; rate: number } | null;
}

export interface CrawlQualityThresholdStatus {
  preflightFailureRate: number;
  http304HitRate: number;
  orgHashDedupeHitRate: number;
  preflightRunCount: number;
  dedupeEvaluatedCount: number;
  preflightFailureBreached: boolean;
  http304Breached: boolean;
  orgHashDedupeBreached: boolean;
}

export interface NewsSourcesUiBusy {
  modalOpen: boolean;
  createDrawerOpen: boolean;
  previewOpen: boolean;
  scheduleOpen: boolean;
  saving: boolean;
  scheduleLoading: boolean;
  previewLoading: boolean;
  previewRunNowLoading: boolean;
  batchRunLoading: boolean;
  batchToggleLoading: boolean;
  dispatchingCount: number;
  opsLoadingCount: number;
}
