// Package newssourcescheduler implements the Go owner of the news-source
// scheduling loop and the four news-source operations endpoints:
//
//	the 30-second cron (NewsSourceSchedulerService.scheduleCron)
//	POST /api/admin/news-sources/:id/dispatch
//	POST /api/admin/news-sources/:id/cancel-queued
//	POST /api/admin/news-sources/:id/clear-inflight
//	POST /api/admin/news-sources/:id/retry-latest
//
// Execution ownership is decided by two independent switches,
// API_GO_NEWS_SOURCE_SCHEDULER_MODE and API_GO_NEWS_SOURCE_OPS_MODE, both
// defaulting to legacy. The package never starts a crawl worker or an item
// pipeline worker: it hands crawl tasks to the existing crawl4ai queues and
// pipeline jobs to the existing itemPipeline queue, with the exact BullMQ
// payloads, priorities and job ids NestJS writes.
//
// Compatibility notes:
//   - nextRunAt follows cron-parser@4.9.0 (see cron.go) and the same 200-step
//     execution-window search; an unparsable expression falls back to the
//     interval schedule with the same jitter.
//   - every Redis key, TTL and JSON value is byte compatible with
//     CacheService + NewsSourceOpsSnapshotService, including the
//     `lock:` prefixed scheduler lease and the 25-second shared dispatch
//     dedupe window.
//   - the per-URL dispatch transaction creates the PipelineJob, the CrawlTask
//     and (for RSS seeds) the raw_item outbox row with the same columns,
//     statuses and metadata NestJS writes.
//   - official multi-source requests are unchanged: the per-tick source
//     concurrency defaults to 1, which is exactly the serial NestJS loop.
package newssourcescheduler
