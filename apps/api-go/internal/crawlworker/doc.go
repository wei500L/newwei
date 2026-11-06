// Package crawlworker is the Go owner of the three crawl4ai BullMQ queues:
// crawl4ai-hot, crawl4ai-normal and the legacy crawl4ai queue.
//
// Each queue runs on a shared internal/bullmq.Worker, which owns the BullMQ
// 5.63.2 worker state machine: moveToActive, the job lock and its renewal, the
// finish/retry/delayed transitions, the stalled checker and the graceful
// shutdown. This package keeps only the crawl-specific parts:
//
//   - the shared strict-priority concurrency limiter (limiter.go);
//   - the O1 settings cache and the C2 concurrency subscriber (settings.go,
//     worker.go);
//   - the attempt business logic: error classification, the crawl4ai memory
//     pressure fallback and the B1 side effects (attempt.go, errors.go);
//   - the per-queue BullMQ transitions the attempt drives itself (queue.go) and
//     the stalled business side effect wired to the worker's OnStalled hook.
//
// # Queue protocol
//
// Jobs are the JSON CrawlJobData document, job options and command arguments are
// MessagePack, and the vendored bullmq@5.63.2 Lua in scripts/ implements
// moveToActive, moveToFinished, retryJob, moveToDelayed, moveJobFromActiveToWait,
// extendLock, moveStalledJobsToWait and updateData. Producers are unchanged, so
// switching between the Go and Node implementations needs no data migration; the
// BullMQ job lock admits one owner per attempt. The queue event stream keeps
// working for the NestJS admin consumers; it is a broadcast (XREAD), never a
// competing consumer.
//
// # Concurrency (A1)
//
// The initial concurrency is the crawl client setting maxConcurrency (the
// settingscrawl normalizer clamps it to 1..20); when the settings document cannot
// be read the CRAWL4AI_MAX_CONCURRENCY environment value is used, then one. The
// value is written to bull:<queue>:meta concurrency for the three queues (the
// Queue.setGlobalConcurrency equivalent, warn-only on failure) and becomes the
// shared limiter capacity and the per-queue pull concurrency (the shared
// bullmq.Worker's SetConcurrency).
//
// The limiter is strict-priority: hot jobs are served before normal jobs and a
// normal acquisition is refused while a hot waiter is queued. Closing the worker
// rejects the remaining waiters with "Global crawl concurrency limiter is
// shutting down"; an acquisition after that reports "... is closed". Both texts
// are the NestJS ones.
//
// The moveToActive options carry the manual BullMQ limiter
// {max: clamp(round(N)*100, 1, 10000), duration: 1000}. The C2 broadcast
// crawl:worker-concurrency:v1 {"version":1,"maxConcurrency":N} changes the
// limiter capacity, the manual rate-limit table (SetLimiter) and the pull
// concurrency (SetConcurrency) of every running queue worker; a malformed
// message (non-object, wrong version, non-integer or out-of-range value) is
// warned and ignored, with the settings document and the BullMQ meta staying
// authoritative.
//
// # Settings cache (O1)
//
// Settings reads go through a process-local TTL cache (Config.SettingsTTL,
// default five seconds) that the C2 broadcast invalidates. Maximum staleness
// conclusion: a settings edit is observed by new attempts at most one TTL later,
// and an attempt that already resolved its values keeps them until it finishes.
// No cached value can be older than that: the cache is not refreshed in the
// background, and every invalidation forces the next read to hit Redis/MySQL.
//
// # Retry and failure semantics (A2/A3)
//
// maxAttempts is the job attempts option (default one) and attemptsStarted is the
// job hash `ats` counter BullMQ increments on every claim; attempt is
// min(maxAttempts, attemptsStarted). The backoff delay handed to the execution
// retry context is the numeric delay, the exponential delay for
// {type:"exponential"} or nothing.
//
// A crawl4ai memory pressure error has its own budget: when the started attempts
// or the persisted memoryPressureRequeues counter reach the limit the job fails
// as unrecoverable. Otherwise the worker reads queueOverloadCooldownMs (30s when
// the read fails), scales it by the reported memory percentage (>=94% x2, >=96%
// x3, >=98% x4, clamped to [5s,10min]), rate limits every crawl queue of this
// process in one pipeline (SET bull:<queue>:limiter Number.MAX_SAFE_INTEGER PX
// cooldown, O3), persists memoryPressureRequeues+1 by rewriting the whole job data
// object with the original key order, and moves the job back to wait through
// moveJobFromActiveToWait (the RateLimitError path: no attempt is consumed and
// `ats` keeps growing, so the budget terminates).
//
// Any other error: not retryable means the UnrecoverableError equivalent, so the
// job goes straight to moveToFinished("failed") while attempts remain; retryable
// means BullMQ's own decision (retryJob without a backoff delay, delayed with one,
// final failure when attempts are exhausted). The classification only decides the
// BullMQ transition — the CrawlTask/PipelineJob status writes of a retryable
// failure belong to crawlexecution.
//
// # Side effects (B1)
//
// The NestJS QueueEvents handlers ran once per event because the event stream is
// a broadcast; this package applies the same writes once per job, after the
// transition succeeded:
//
//   - completed: a job without jobKind (only plain crawl tasks are counted by
//     markTaskQueued) decrements crawl:activity atomically; a job with a sourceId
//     refreshes the source ops snapshot (warn only).
//   - failed (final failure only): the same counter decrement, then CrawlTask
//     status queued|running -> failed with lastError = truncate(failedReason,
//     4000) (falling back to a VARCHAR(191) truncation when the write fails) and
//     the org-scoped condition, then the ops snapshot.
//   - stalled: every job id moveStalledJobsToWait returns (including the jobs that
//     exceeded maxStalledCount and were stamped with a deferred failure) gets
//     CrawlTask running -> queued with the stalled message and the ops snapshot.
//     The shared worker delivers the ids through its OnStalled hook.
//
// # Shutdown
//
// Close stops the fetch loops of all three queues, drains the in-flight attempts
// while their locks keep renewing, then stops the C2 subscription and refuses
// the remaining limiter waiters; the dedicated blocking connections are closed by
// the shared workers. An attempt still running at the deadline is canceled: it
// leaves its job active, the lock expires, and BullMQ stalled recovery re-delivers
// it. The shared command Redis client is never closed.
package crawlworker
