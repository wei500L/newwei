package queueorgstats

// JobStatus is the subset of BullMQ job states the per-organization counters
// track. It is TrackedJobStatus in
// apps/api/src/modules/queue/queue-org-stats.service.ts:8, and the values are the
// hash fields of the counts key, so they must stay identical to the NestJS ones.
type JobStatus string

const (
	// JobStatusWaiting is the queued state (BullMQ `waiting`).
	JobStatusWaiting JobStatus = "waiting"
	// JobStatusActive is the state of a claimed job (BullMQ `active`).
	JobStatusActive JobStatus = "active"
	// JobStatusCompleted is the successful terminal state.
	JobStatusCompleted JobStatus = "completed"
	// JobStatusFailed is the failed terminal state.
	JobStatusFailed JobStatus = "failed"
	// JobStatusDelayed is the scheduled state (BullMQ `delayed`).
	JobStatusDelayed JobStatus = "delayed"
)

// isTrackedStatus reports whether value is one of the five tracked states,
// mirroring isTrackedStatus (queue-org-stats.service.ts:28-30). A meta hash with
// any other status is treated as missing, exactly like getJobMeta returning null.
func isTrackedStatus(value string) bool {
	switch JobStatus(value) {
	case JobStatusWaiting, JobStatusActive, JobStatusCompleted, JobStatusFailed, JobStatusDelayed:
		return true
	default:
		return false
	}
}

// BullMQ event names the tracker consumes. They are the QueueEvents names the
// NestJS tracker subscribes to (queue-org-stats.tracker.ts:49-54); `removed` is
// not a state and takes the removal path.
const (
	eventWaiting   = "waiting"
	eventDelayed   = "delayed"
	eventActive    = "active"
	eventCompleted = "completed"
	eventFailed    = "failed"
	eventRemoved   = "removed"
)

// StreamEvent is one decoded entry of the BullMQ event stream
// (`bull:itemPipeline:events`). Only the two fields the tracker consumes are
// kept: the BullMQ state name and the job id.
type StreamEvent struct {
	// ID is the Redis stream entry id, used as the next XREAD cursor.
	ID string
	// Event is the BullMQ event name (`waiting`, `active`, `removed`, ...).
	Event string
	// JobID is the BullMQ job id the event belongs to.
	JobID string
}

// statusForEvent maps a BullMQ event name to the state it transitions to. It
// returns false for `removed` and for every event the tracker ignores, which is
// the NestJS switch on the six registered events.
func statusForEvent(name string) (JobStatus, bool) {
	switch name {
	case eventWaiting:
		return JobStatusWaiting, true
	case eventDelayed:
		return JobStatusDelayed, true
	case eventActive:
		return JobStatusActive, true
	case eventCompleted:
		return JobStatusCompleted, true
	case eventFailed:
		return JobStatusFailed, true
	default:
		return "", false
	}
}

// JobMeta is the queue:<queue>:job:<jobId>:meta hash, the JobMeta interface of
// queue-org-stats.service.ts:10-15 with the "1"/"0" strings resolved to booleans.
type JobMeta struct {
	// OrgID is the organization the job belongs to (meta field `orgId`).
	OrgID string
	// Status is the last recorded state (meta field `status`).
	Status JobStatus
	// KeepCompleted reports whether the completed job is retained (meta field
	// `keepCompleted`). It comes from removeOnComplete through
	// keepsFinishedJob.
	KeepCompleted bool
	// KeepFailed reports whether the failed job is retained (meta field
	// `keepFailed`). It comes from removeOnFail through keepsFinishedJob.
	KeepFailed bool
}

// UpsertJobMetaInput is one upsertJobMetaAndCount call: the UPSERT_AND_TRANSITION
// script keys on the job id and the organization, and takes the whole meta
// document as arguments.
type UpsertJobMetaInput struct {
	// JobID is the BullMQ job id (the meta key suffix).
	JobID string
	// Meta is the meta document to store; its Status is the state to count +1.
	Meta JobMeta
}
