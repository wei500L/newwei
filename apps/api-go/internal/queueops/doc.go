// Package queueops serves the queue operations console under
// /api/admin/queue-ops.
//
// The console is a new Go-only surface: it is not a port of Bull Board, which
// stays in NestJS and keeps serving /admin/queues. It exists because Bull Board
// only checks the organization-level queue.manage permission, so any
// organization manager can read every tenant's job data (audit finding B1). This
// package requires queue.manage *and* a platform administrator, which is a
// deliberate behaviour change relative to Bull Board.
//
// # Endpoints
//
// Every route is an exact path. Queue names and job ids travel in the query
// string or the request body rather than the path, because a BullMQ job id may
// contain "/" and ":", and the legacy proxy Rule type only supports at most two
// dynamic segments:
//
//	GET  /api/admin/queue-ops/queues
//	GET  /api/admin/queue-ops/jobs?queue=&state=&cursor=&limit=
//	GET  /api/admin/queue-ops/jobs/detail?queue=&jobId=
//	POST /api/admin/queue-ops/jobs/retry
//	POST /api/admin/queue-ops/jobs/delete
//	POST /api/admin/queue-ops/jobs/promote
//	POST /api/admin/queue-ops/queues/retry-failed
//	POST /api/admin/queue-ops/queues/clean
//	POST /api/admin/queue-ops/queues/pause
//	POST /api/admin/queue-ops/queues/resume
//	POST /api/admin/queue-ops/dlq/replay
//	POST /api/admin/queue-ops/dlq/delete
//
// # Queue inventory
//
// bullmqcleanup.Inventory is the single source of queue names. This package does
// not keep a second list: the console may only inspect and mutate a queue that
// the NestJS cleanup registry already tracks, which also pins the itemPipelineDlq
// dead-letter queue.
//
// # BullMQ protocol
//
// Every mutation runs the official BullMQ 5.63.2 Lua script of the matching
// JavaScript call (Job.retry, Job.promote, Job.remove, Queue.clean,
// Queue.pause/resume) instead of re-implementing lock, marker, deduplication and
// event semantics in Go. The scripts live in scripts/ with their provenance in
// scripts/NOTICE. Reads use getCounts/getRanges plus one HMGET pipeline so a page
// of jobs costs a single round trip per step, never one round trip per job.
//
// # Crawl queue pause and resume are refused
//
// The three crawl4ai queues (crawl4ai, crawl4ai-hot, crawl4ai-normal) are listed
// but their pause/resume routes answer 409 and point at
// /api/admin/crawl4ai/queue/pause|resume. Pausing those queues carries extra
// semantics in NestJS that this batch does not port: the adaptive-concurrency
// state machine (CrawlAdaptiveConcurrencyService) and the C2 worker-concurrency
// broadcast. Running the raw BullMQ pause script there would pause the queue
// behind the adaptive controller's back and leave its cached decision state
// wrong, so the console deliberately refuses instead of silently diverging. The
// dedicated crawl4ai routes (API_GO_CRAWL_QUEUE_OPS_MODE) own that behaviour.
//
// # Truncation
//
// Job payloads are truncated by bytes on a UTF-8 boundary so a multi-byte
// character is never cut in half; the result is always valid UTF-8:
//
//   - dataPreview is limited to 2000 bytes and gains a trailing "…" when cut;
//   - the detail data document is limited to 256 KiB. When it is cut, data is
//     returned as a JSON string holding the truncated text (a truncated JSON
//     object would not be a valid JSON document) and dataTruncated is true.
//
// # Audit
//
// Every write appends one AuditLog row with resource "queue" and falls back to
// AuditLogOutbox, the same best-effort writer the other Go domains use. Metadata
// is always a named struct, never a schema-less map. The audit write happens
// after the Redis mutation: a double write failure is logged but does not turn an
// applied queue change into an HTTP error, matching platformgovernance.
package queueops
