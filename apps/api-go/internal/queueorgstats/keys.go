package queueorgstats

import "github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"

// The itemPipeline queue name and the org counter layout. QueueOrgStatsService
// owns the same names and TTLs; the values below must stay in sync with
// apps/api/src/modules/queue/queue-org-stats.service.ts:25-26 and :143-149. The
// readers of the counters are apps/api/src/modules/queue/queue.service.ts,
// internal/dashboardstats/counts.go and internal/graphqlread/workspace/queue.go;
// none of them changes when this tracker takes over the writes.
const (
	// itemPipelineQueueName is ITEM_PIPELINE_QUEUE_NAME
	// (apps/api/src/modules/queue/queue.constants.ts:5).
	itemPipelineQueueName = "itemPipeline"

	// metaTTLSeconds is META_TTL_SECONDS: 7 days (queue-org-stats.service.ts:25).
	metaTTLSeconds = 60 * 60 * 24 * 7
	// countsTTLSeconds is COUNTS_TTL_SECONDS: 30 days
	// (queue-org-stats.service.ts:26).
	countsTTLSeconds = 60 * 60 * 24 * 30

	// keepFlagTrue / keepFlagFalse are the "1"/"0" values of the keepCompleted
	// and keepFailed meta fields (queue-org-stats.service.ts:13-14).
	keepFlagTrue  = "1"
	keepFlagFalse = "0"
)

// Meta hash fields, exactly the names getJobMeta reads
// (queue-org-stats.service.ts:52-69).
const (
	metaFieldOrgID         = "orgId"
	metaFieldStatus        = "status"
	metaFieldKeepCompleted = "keepCompleted"
	metaFieldKeepFailed    = "keepFailed"
)

// Event stream fields. BullMQ writes one field map per entry with the event name
// and the job id; `event` is the QueueEvents event name and `jobId` the job hash
// id the event belongs to.
const (
	streamFieldEvent = "event"
	streamFieldJobID = "jobId"
)

// queueKeys is the BullMQ key set of the itemPipeline queue. The event stream
// key (`bull:itemPipeline:events`) is the only key the tracker reads directly
// through it; the org counter keys are not BullMQ keys and are built below.
var queueKeys = bullmqwire.NewKeys(bullmqwire.Prefix, itemPipelineQueueName)

// metaKey is QueueOrgStatsService.metaKey: queue:<queue>:job:<jobId>:meta.
func metaKey(jobID string) string {
	return "queue:" + itemPipelineQueueName + ":job:" + jobID + ":meta"
}

// countsKey is QueueOrgStatsService.countsKey: queue:<queue>:org:<orgId>:counts.
func countsKey(orgID string) string {
	return "queue:" + itemPipelineQueueName + ":org:" + orgID + ":counts"
}

// keepFlag converts the boolean retention flag to the "1"/"0" meta value.
func keepFlag(keep bool) string {
	if keep {
		return keepFlagTrue
	}
	return keepFlagFalse
}
