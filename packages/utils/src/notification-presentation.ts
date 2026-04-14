export enum NotificationPresentationKind {
  CrawlCompleted = "crawl_completed",
  CrawlFailed = "crawl_failed",
  AnalysisCompleted = "analysis_completed",
  AnalysisFailed = "analysis_failed",
  AlertTriggered = "alert_triggered",
  NewsSourceCircuitOpened = "news_source_circuit_opened",
  NewsSourceAutoDisabled = "news_source_auto_disabled",
  NewsSourceRssBodyMissingSpike = "news_source_rss_body_missing_spike",
  NewsSourcePipelineRetrySpike = "news_source_pipeline_retry_spike",
  NewsSourceSchedulerBackpressure = "news_source_scheduler_backpressure",
  ClassificationQualityThresholdExceeded = "classification_quality_threshold_exceeded",
}

export interface NotificationPresentationPayload {
  kind: NotificationPresentationKind;
  params?: Record<string, unknown>;
  technicalDetail?: string;
}

export enum RealtimeSocketErrorCode {
  Unauthorized = "UNAUTHORIZED",
  TooManyConnections = "TOO_MANY_CONNECTIONS",
  TooManyConnectionAttempts = "TOO_MANY_CONNECTION_ATTEMPTS",
  RateLimitExceeded = "RATE_LIMIT_EXCEEDED",
  TooManyFailedAttempts = "TOO_MANY_FAILED_ATTEMPTS",
}

export interface RealtimeSocketErrorPayload {
  code: RealtimeSocketErrorCode;
  message: string;
  retryAfterMs?: number;
}

export { RealtimeSocketErrorCode as NotificationSocketErrorCode };

export interface NotificationSocketErrorPayload
  extends RealtimeSocketErrorPayload {
  code:
    | RealtimeSocketErrorCode.Unauthorized
    | RealtimeSocketErrorCode.TooManyConnections
    | RealtimeSocketErrorCode.TooManyConnectionAttempts
    | RealtimeSocketErrorCode.RateLimitExceeded
    | RealtimeSocketErrorCode.TooManyFailedAttempts;
}
