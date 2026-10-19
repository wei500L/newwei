// Package queue is the BullMQ-compatible runner for the "alerts" queue only.
//
// It implements the BullMQ 5.63.2 wire protocol the migrated alert worker
// needs, in both directions:
//
//   - Producing: the standard job add, the delayed job add, the repeatable
//     schedule (addRepeatableJob), job and repeatable removal.
//   - Consuming: moveToActive (including delayed promotion), lock renewal, the
//     stalled checker, completing, retrying, failing and moveToDelayed.
//
// The Redis state machine is the official Lua code in scripts/ (see
// scripts/NOTICE.md for version, source, license and digests) and job options
// are MessagePack encoded with the same profile BullMQ's msgpackr uses
// (useRecords=false, undefined as nil), so Node BullMQ producers and consumers
// interoperate with this runner in both directions.
//
// # Repeat schedules
//
// A repeatable schedule is two Redis structures: the `bull:alerts:repeat` zset
// member (the md5 of the undecorated concat options) and the
// `bull:alerts:repeat:<md5>` hash. The next iteration is a delayed job whose id
// is `repeat:<md5>:<nextMillis>` and whose hash carries `rjk` = the md5 key.
//
// BullMQ reschedules the following iteration when the worker *fetches* the
// current one, from Worker.nextJobFromJobData: a job whose `rjk` has fewer than
// five colon-separated segments goes through JobScheduler.upsertJobScheduler
// ({override: false}) and thus the updateJobScheduler script; a legacy
// colon-bearing key goes through Repeat.updateRepeatableJob. This runner
// reproduces both branches, so a rule schedule created by NestJS keeps firing
// while Go owns the queue.
//
// # Delayed jobs
//
// Two different delayed moves exist and both matter for the alert contract:
//
//   - Rate limiting / minimum notify interval: the handler asks for the job to
//     be moved to the delayed set without consuming an attempt
//     (skipAttempt = "1"), exactly like `job.moveToDelayed(ts, token)` followed
//     by `throw new DelayedError()` in NestJS. The attempt counters stay
//     untouched.
//   - Retry after a failure: the worker moves the job to the delayed set with
//     skipAttempt = "0", so `atm` is incremented exactly once, and stores the
//     failure fields.
//
// # Attempts
//
// BullMQ increments `atm` only when an attempt finishes (moveToFinished,
// moveToDelayed with skipAttempt=0, retryJob). While an attempt runs, `atm` is
// therefore the number of *previous* failures, and a retry happens when
// `atm + 1 < attempts`. The delivery handler therefore marks the last attempt
// with `atm + 1 >= attempts`.
//
// Package queue knows nothing about alert semantics: it moves opaque payloads
// and calls the Processor.
package queue
