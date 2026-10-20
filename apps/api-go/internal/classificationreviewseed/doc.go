// Package classificationreviewseed ports ClassificationQualitySeedTriggerService:
// when an itemPipeline job completes, the processed item id from its returnvalue
// is enqueued as a classification_quality review-seed job.
//
// # Event source
//
// The consumer attaches to the process-wide itemPipeline XREAD loop owned by
// internal/graphqlsubscriptions (see optimization O2). That loop resolves orgId
// exactly like QueueEventPublisher: job data first, then this instance's jobctx
// cache, then the shared queue:pipeline:jobctx:<jobId> cache. Only completed
// events reach this package.
//
// # Payload
//
// The processed item id is the first non-empty trimmed string of data.id,
// data._id and data.processedItemId, matching readProcessedItemId in NestJS.
// enqueueReviewSeedItemJob has no settings switch, sampling rate or dedupe
// window (verified at baseline d4227721): every completed event with a usable
// id produces one enqueue attempt.
//
// # Idempotency
//
// BullMQ's addStandardJob stores the custom job id
// "classification-quality-review-seed-item:<orgId>:<processedItemId>".
// handleDuplicatedJob returns the existing id without adding a second job, so
// the same completed event observed by several api-go instances (each instance
// XREADs the same stream) still creates exactly one review-seed job. See
// qualityqueue.Add, which implements that script.
package classificationreviewseed
