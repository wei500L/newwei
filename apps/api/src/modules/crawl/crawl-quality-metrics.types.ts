export interface CrawlQualityRejectBreakdown {
  includePattern: number;
  excludePattern: number;
  publishConfidence: number;
}

export interface CrawlQualityConfidenceBuckets {
  lt04: number;
  from04To06: number;
  from06To08: number;
  gte08: number;
}

export interface CrawlQualityAlertThresholds {
  preflightFailureRateHigh: number;
  http304HitRateLow: number;
  orgHashDedupeHitRateHigh: number;
}

export interface CrawlQualityMetricsSourceSnapshot {
  sourceId: string;
  taskCount: number;
  lowSignalRatio: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects: CrawlQualityRejectBreakdown;
  publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
  fitMarkdownPreferenceRate: number;
  headSignalSuccessRate: number;
  headSignalSoftFailureRate: number;
  headSignalTruncatedRate: number;
  headSignalNoPublishSignalRate: number;
  http304HitRate: number;
  orgHashDedupeHitRate: number;
  preflightFailureRate: number;
}

export interface CrawlQualityMetricsSnapshot {
  orgId: string;
  from: string;
  to: string;
  taskCount: number;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects: CrawlQualityRejectBreakdown;
  publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
  fitMarkdownPreferenceRate: number;
  headSignalSuccessRate: number;
  headSignalSoftFailureRate: number;
  headSignalTruncatedRate: number;
  headSignalNoPublishSignalRate: number;
  http304HitRate: number;
  orgHashDedupeHitRate: number;
  preflightFailureRate: number;
  alertThresholds: CrawlQualityAlertThresholds;
  groupedBySource: CrawlQualityMetricsSourceSnapshot[];
}

export interface CrawlQualityMetricsAggregates {
  taskCount: number;
  lowSignalRatio: number;
  emptyMarkdownRate: number;
  expansionTriggerRate: number;
  expansionSuccessRate: number;
  avgMarkdownChars: number;
  candidateRejects: CrawlQualityRejectBreakdown;
  publishConfidenceBuckets: CrawlQualityConfidenceBuckets;
  fitMarkdownPreferenceRate: number;
  headSignalSuccessRate: number;
  headSignalSoftFailureRate: number;
  headSignalTruncatedRate: number;
  headSignalNoPublishSignalRate: number;
  http304HitRate: number;
  orgHashDedupeHitRate: number;
  preflightFailureRate: number;
  groupedBySource: CrawlQualityMetricsSourceSnapshot[];
}

export function createEmptyCrawlQualityRejectBreakdown(): CrawlQualityRejectBreakdown {
  return {
    includePattern: 0,
    excludePattern: 0,
    publishConfidence: 0,
  };
}

export function createEmptyCrawlQualityConfidenceBuckets(): CrawlQualityConfidenceBuckets {
  return {
    lt04: 0,
    from04To06: 0,
    from06To08: 0,
    gte08: 0,
  };
}
