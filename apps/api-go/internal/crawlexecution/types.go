// Package crawlexecution owns the in-process crawl execution path the migrated
// news pipeline calls when an item has no reusable stored result.
//
// It ports CrawlExecutionService.runTask and only the branches that chain runs
// for a pipeline item: the CrawlTask status/queue-count update, option
// normalization and session reuse, conditional preflight, anti-bot handling,
// the crawl4ai request with its fallbacks, detail expansion, result and content
// writes with dedupe/fingerprints, optional ingestToItems, PipelineJob updates,
// TaskLog writes, error classification and the terminal task status.
//
// Execution ownership is unchanged: the three crawl queues (hot/normal/retry)
// stay on NestJS. This package is called synchronously by the item pipeline
// worker with the task id it just created or reused; it does not consume any
// BullMQ queue and never enqueues crawl work.
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
