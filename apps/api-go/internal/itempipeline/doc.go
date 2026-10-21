// Package itempipeline is the Go owner of the itemPipeline BullMQ queue when
// API_GO_ITEM_PIPELINE_WORKER_MODE=go.
//
// Execution ownership is whole-process and exclusive:
//
//   - go: api-go creates the Worker (concurrency NEWS_PROCESS_QUEUE_CONCURRENCY,
//     fallback 3) and NestJS's QueueProcessor.onModuleInit returns before
//     creating its Worker. NestJS keeps the Queue and QueueEvents objects, so
//     producers, the admin UI and the event stream keep working.
//   - legacy (default): this package is not started; NestJS is unchanged.
//
// During a switchover both processes may briefly claim jobs. The BullMQ job
// lock guarantees one owner per attempt, and the processed_item outbox claim
// (internal/processeditemoutbox) guarantees one delivery, so the overlap is
// safe in both directions. Switching back needs no data migration.
//
// Job shape: the producer payload is JSON ({rawItemId,itemMetaId,orgId,...}),
// job options are MessagePack; the vendored BullMQ 5.63.2 Lua in scripts/
// implements moveToActive, lock renewal, moveToFinished, retryJob,
// moveToDelayed (exponential backoff) and stalled recovery, so the NestJS
// QueueEvents reader observes the same event stream.
//
// Failure semantics:
//
//   - Permanent errors (missing ids, missing orgId, missing RawItem, zod /
//     QueuePermanentError, guardrail violations, crawl4ai 4xx, MySQL constraint
//     violations) are the UnrecoverableError equivalent: the worker calls
//     moveToFinished("failed") immediately, even when attempts remain.
//   - Transient errors retry with the job's exponential backoff
//     (moveToDelayed) until attempts are exhausted, then fail.
//   - The 'failed' listener runs after the BullMQ transition for every failed
//     attempt: TaskLog worker, Failed/delayed status writes, source failure
//     accounting and, only on a final failure, the dead letter enqueue into
//     itemPipelineDlq.
//   - markSourceFailureState reads the NewsSource row with SELECT ... FOR UPDATE
//     inside the update transaction (B1): concurrent final failures no longer
//     lose a count or send the circuit-open/auto-disable notification twice.
//
// Immediate processed_item delivery happens in the pipeline transaction's
// commit path (newspipeline). This package never schedules process-local retry
// timers: the #116 outbox scanner compensates failed immediate deliveries.
package itempipeline
