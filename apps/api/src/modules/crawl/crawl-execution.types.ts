import type {
  CrawlFailureDetail,
  CrawlPriorityClass,
  CrawlTaskOptions,
} from "./crawl.types";
import type { Crawl4aiArticle, Crawl4aiResponse } from "./crawl4ai.client";

export interface CrawlExecutionRetryContext {
  attempt?: number;
  maxAttempts?: number;
  backoffDelayMs?: number | null;
  requestTimeoutMs?: number | null;
  priorityClass?: CrawlPriorityClass;
}

export interface CrawlRetryResult {
  response: Crawl4aiResponse;
  successes: Crawl4aiArticle[];
  failures: CrawlFailureDetail[];
  lowSignalCandidates: Crawl4aiArticle[];
  options: CrawlTaskOptions;
}

export interface CrawlRetryCandidate extends CrawlRetryResult {
  fromRetry: boolean;
  qualityScore: number;
  challengeFailureCount: number;
}

export interface DetailCandidateDiagnostics {
  includePatternRejected: number;
  excludePatternRejected: number;
  publishConfidenceRejected: number;
}

export interface DetailCandidateConfidenceBuckets {
  lt04: number;
  from04To06: number;
  from06To08: number;
  gte08: number;
}

export interface CandidatePublishSignal {
  confidence: number;
  source: "meta" | "jsonld" | "time_tag" | "url_path" | "none";
  timestamp?: number;
}

export interface PublishSignalEnrichmentSettings {
  timeoutMs: number;
  concurrency: number;
  maxReadBytes: number;
}

export type PublishSignalSoftFailureReason =
  | "http_status"
  | "non_html"
  | "empty_html"
  | "network_or_timeout"
  | "no_publish_signal";

export interface PublishSignalSoftFailureBreakdown {
  httpStatus: number;
  nonHtml: number;
  emptyHtml: number;
  networkOrTimeout: number;
  noPublishSignal: number;
}

export interface CandidatePublishSignalFetchResult {
  signal?: CandidatePublishSignal;
  truncated: boolean;
  earlyStopped: boolean;
  failureReason?: PublishSignalSoftFailureReason;
}

export interface PublishSignalEnrichmentResult {
  signals: Map<string, CandidatePublishSignal>;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
  effectiveTimeoutMs: number;
  effectiveConcurrency: number;
  maxReadBytes: number;
  truncatedResponses: number;
  earlyStoppedResponses: number;
  softFailures: PublishSignalSoftFailureBreakdown;
  softFailureCount: number;
}

export interface CrawlResultHttpValidationState {
  resultId: string;
  fetchedAt: Date;
  etag?: string;
  lastModified?: string;
}

export interface ConditionalPreflightResult {
  status: number;
  etag?: string;
  lastModified?: string;
  method: "HEAD" | "GET";
  checkedAt: string;
}

export interface ConditionalRequestSettings {
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
}

export interface ConditionalPreflightOutcomeCompleted {
  status: "completed";
  result: ConditionalPreflightResult;
  attempts: number;
  failures: number;
}

export interface ConditionalPreflightOutcomeFailed {
  status: "failed";
  attempts: number;
  failures: number;
}

export type ConditionalPreflightOutcome =
  | ConditionalPreflightOutcomeCompleted
  | ConditionalPreflightOutcomeFailed;

export interface PartitionedCrawlerResults {
  successes: Crawl4aiArticle[];
  failures: CrawlFailureDetail[];
  lowSignalCandidates: Crawl4aiArticle[];
}

export interface CrawlClassifiedResult {
  kind: "success" | "failure" | "low_signal";
  hasMarkdown: boolean;
  lowSignalMarkdown: boolean;
  isChallengePage: boolean;
  statusCode?: number;
}
