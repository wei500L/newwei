package bullmqcleanup

import (
	"time"
)

// Retained-job retention constants, copied from
// apps/api/src/common/bullmq-retention.ts.
const (
	// FailedRetentionAgeSeconds is BULLMQ_FAILED_JOB_RETENTION.age (7 days).
	FailedRetentionAgeSeconds int64 = 7 * 24 * 60 * 60
	// FailedRetentionCount is BULLMQ_FAILED_JOB_RETENTION.count.
	FailedRetentionCount int64 = 10_000
	// DLQRetentionAgeSeconds is BULLMQ_DLQ_JOB_RETENTION.age (30 days).
	DLQRetentionAgeSeconds int64 = 30 * 24 * 60 * 60
	// DLQRetentionCount is BULLMQ_DLQ_JOB_RETENTION.count.
	DLQRetentionCount int64 = 20_000

	// CleanBatchSize is BULLMQ_RETAINED_JOB_CLEAN_BATCH_SIZE.
	CleanBatchSize = 1_000
	// CleanMaxBatches is BULLMQ_RETAINED_JOB_CLEAN_MAX_BATCHES.
	CleanMaxBatches = 10
	// CleanInterval is BULLMQ_RETAINED_JOB_CLEAN_INTERVAL_MS.
	CleanInterval = 60 * 60 * 1000 * time.Millisecond
)

// StateRetention is one resolved KeepJobs value for a job state. Age is in
// seconds, exactly like the BullMQ KeepJobs.age the NestJS constants declare.
type StateRetention struct {
	AgeSeconds int64
	Count      int64
}

// Retention returns the shared failed-job retention value.
func defaultFailedRetention() StateRetention {
	return StateRetention{AgeSeconds: FailedRetentionAgeSeconds, Count: FailedRetentionCount}
}

// dlqRetention returns the itemPipelineDlq retention value.
func dlqRetention() StateRetention {
	return StateRetention{AgeSeconds: DLQRetentionAgeSeconds, Count: DLQRetentionCount}
}

// QueueSpec is one tracked cleanable queue. A nil pointer means "this state is
// not cleaned", which is how the NestJS service distinguishes a missing
// profile entry from a resolved default.
type QueueSpec struct {
	// Name is the BullMQ queue name (the NestJS *_QUEUE_NAME constant).
	Name string
	// Failed is the retention applied to the "failed" sorted set.
	Failed *StateRetention
	// Waiting is the retention applied to the "wait" list. Only
	// itemPipelineDlq configures it.
	Waiting *StateRetention
}

// Inventory returns the tracked cleanable queues, in the order the NestJS
// modules register them. The list is the complete set of `cleanup.track(queue)`
// calls at baseline d4227721:
//
//	assistant.module.ts                 assistant
//	analysis.module.ts                  analysis
//	archive.module.ts                   archivePreparation
//	observability.module.ts             classification_quality
//	alerts.module.ts                    alerts
//	crawl.module.ts                     crawl4ai, crawl4ai-hot, crawl4ai-normal,
//	                                    frontier-llm-judge, frontier-llm-learn
//	news-events.module.ts               news_event_clustering_recovery
//	queue.module.ts                     itemPipeline, itemPipelineDlq
//	situation-monitor-signals.module.ts situationMonitorSignals
//	akshare.module.ts                   akshare-data
//
// QueueEvents tracks are deliberately absent: QueueEvents.clean does not exist,
// so BullmqQueueCleanupService only closes those resources.
func Inventory() []QueueSpec {
	specs := make([]QueueSpec, 0, 15)
	add := func(name string) {
		retention := defaultFailedRetention()
		specs = append(specs, QueueSpec{Name: name, Failed: &retention})
	}
	add("assistant")
	add("analysis")
	add("archivePreparation")
	add("classification_quality")
	add("alerts")
	add("crawl4ai")
	add("crawl4ai-hot")
	add("crawl4ai-normal")
	add("frontier-llm-judge")
	add("frontier-llm-learn")
	add("news_event_clustering_recovery")
	add("itemPipeline")
	dlqFailed := dlqRetention()
	dlqWaiting := dlqRetention()
	specs = append(specs, QueueSpec{Name: "itemPipelineDlq", Failed: &dlqFailed, Waiting: &dlqWaiting})
	add("situationMonitorSignals")
	add("akshare-data")
	return specs
}
