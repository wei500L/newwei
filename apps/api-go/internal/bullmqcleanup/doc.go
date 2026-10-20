// Package bullmqcleanup runs the retained-job cleanup that
// BullmqQueueCleanupService performs in NestJS.
//
// # Source of the rules
//
// The queue inventory in inventory.go mirrors every `cleanup.track(queue)` call
// in apps/api/src (one tracked queue per module, plus the separate
// ClassificationQualityQueueCleanupService instance in the observability
// module). QueueEvents resources are also tracked there, but they are not
// cleanable queues, so they are not part of this inventory.
//
// Every cleanable queue keeps failed jobs for BULLMQ_FAILED_JOB_RETENTION
// (7 days / 10 000 jobs). itemPipelineDlq overrides both failed and waiting
// retention with BULLMQ_DLQ_JOB_RETENTION (30 days / 20 000 jobs). No other
// queue configures waiting retention, so waiting is only cleaned for
// itemPipelineDlq.
//
// # Clean semantics
//
// For each tracked state the NestJS service runs Queue.clean(age*1000, 1000,
// state) up to ten times and stops as soon as a batch returns fewer than 1000
// ids, then trims the excess over the configured count by fetching oldest-first
// pages of 1000 jobs and removing each of them. This package executes the same
// BullMQ 5.63.2 Lua scripts (see NOTICE) with the same keys, grace timestamp and
// page bounds, so the deleted set is identical:
//
//   - failed jobs are removed by the sorted-set score (finishedOn) <= grace;
//   - waiting jobs are a list; the range helper reads from the oldest end and
//     the script compares finishedOn, processedOn, then timestamp;
//   - locked jobs are skipped by the scripts.
//
// # Why a lease is required
//
// NestJS starts one setInterval per process and takes no lock, so N instances
// clean the same queues concurrently and race on the same jobs (issue B1).
// api-go takes the "cron:bullmq-retained-cleanup" lease for 55 minutes, which
// is shorter than the one-hour interval, so exactly one instance performs a
// cycle while a crashed holder's lease expires before the next tick. The lease
// does not change the deleted set: each cycle is idempotent on its own.
//
// # Batching
//
// The count trim sends one removeJob script per page inside a single Redis
// pipeline instead of one round trip per job. The script, the order of the ids
// and the number of ids considered per page are unchanged.
package bullmqcleanup
