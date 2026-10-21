// Package crawlexecution owns the in-process crawl execution path the migrated
// news pipeline calls when an item has no reusable stored result, and the crawl
// execution body the Go BullMQ crawl worker runs for a queued crawl task.
//
// It ports CrawlExecutionService.runTask in full: the CrawlTask status update,
// option normalization and session reuse, conditional preflight, anti-bot
// handling, the crawl4ai request with its fallbacks, detail expansion, result
// and content writes with dedupe/fingerprints, optional ingestToItems,
// PipelineJob updates, TaskLog writes, error classification and retry decision,
// the terminal task status and the completion/failure notifications.
//
// Two entry points share that body:
//
//   - RunTask is the pipeline bridge: synchronous, no triggeredById and no retry
//     context, so failures always terminate the task.
//   - RunQueuedTask is the BullMQ worker: the job supplies triggeredById and the
//     retry context (attempt/maxAttempts/backoff/requestTimeout).
//
// Execution ownership of the crawl queues stays with the caller; this package
// never consumes a BullMQ queue and never enqueues crawl work.
package crawlexecution

import "time"

// Summary is the CrawlExecutionSummary projection the pipeline bridge reads.
// The remaining legacy fields (memory stats, item batches) are not part of the
// pipeline call path and are intentionally omitted.
type Summary struct {
	Inserted          int
	Skipped           int
	ReusedResultID    string
	RunID             string
	LastFetchedAt     *time.Time
	ItemsQueued       int
	ItemsQueueFailed  int
	Failures          []Failure
	RetryableFailures int
}

// Failure is one CrawlFailureDetail row.
type Failure struct {
	URL        string
	Message    string
	StatusCode *int
	Retryable  bool
}

// RunOptions is CrawlExecutionRetryContext for the BullMQ worker path. The
// pipeline path passes no retry context at all, so attempt/maxAttempts are only
// meaningful when RunQueuedTask built the context.
type RunOptions struct {
	// Attempt is the 1-based attempt number BullMQ reports for the job
	// (normalized from job.ats/attemptsMade by the worker).
	Attempt int
	// MaxAttempts is the job's attempts ceiling (>= 1).
	MaxAttempts int
	// BackoffDelayMs is the configured backoff interval, nil when the job has
	// no backoff strategy. nextRetryAt is only reported when it is set.
	BackoffDelayMs *int
	// PriorityClass is the queue priority class ("hot" or "normal").
	PriorityClass string
	// RequestTimeoutMs is the request timeout the worker resolved for the
	// queue; it is normalized before it reaches crawl4ai or the preflight.
	RequestTimeoutMs int
}
