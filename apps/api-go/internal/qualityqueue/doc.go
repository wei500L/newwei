// Package qualityqueue is a minimal BullMQ producer and worker for the
// classification_quality queue. It is the only Go code that speaks the BullMQ
// Redis protocol, so the queue contract stays in one auditable place.
//
// # Rationale and scope
//
// NestJS owns the same queue through bullmq@5.63.2. When
// API_GO_CLASSIFICATION_QUALITY_WORKER_MODE=go the NestJS
// ClassificationQualityProcessor stops creating its Worker and this package
// consumes the jobs; the NestJS Queue stays alive because the news pipeline
// keeps producing review-seed jobs. Both sides therefore have to agree on the
// Redis layout, not just on the JSON payload:
//
//   - keys live under "bull:classification_quality:*" (the BullMQ default
//     prefix plus the queue name; the NestJS constant is
//     CLASSIFICATION_QUALITY_QUEUE_NAME = "classification_quality");
//   - a job is the hash "bull:classification_quality:<jobId>" with the fields
//     name/data/opts/timestamp/delay/priority written by the producer and
//     processedOn/ats/atm/stc written by the consumer;
//   - the wait list is a Redis list, delayed retries live in a sorted set
//     scored with BullMQ's "timestamp * 4096" scheme, and the marker key wakes
//     sleeping workers.
//
// The Lua scripts in scripts/ are the expanded BullMQ 5.63.2 scripts (see
// NOTICE). Expanding them instead of re-implementing the state machine in Go
// keeps the transitions byte-compatible with NestJS: a job moved to failed by
// Go looks exactly like a job moved to failed by BullMQ, and the reverse.
//
// Compatibility note: this package deliberately implements only the subset the
// classification queue needs (no delayed add, no priorities, no repeat jobs, no
// parent/child dependencies, no rate limiter configuration). New Go consumers
// should extend this package rather than start a second one, so that there is a
// single place to upgrade when BullMQ changes its protocol.
package qualityqueue
