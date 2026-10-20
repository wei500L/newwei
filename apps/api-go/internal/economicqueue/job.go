package economicqueue

import (
	"encoding/json"
	"time"
)

const (
	// QueueName is the single queue this package owns.
	QueueName = "akshare-data"
	// Prefix is BullMQ's default prefix (Queue without an explicit prefix).
	Prefix = "bull"
	// FailedJobRetention mirrors BULLMQ_FAILED_JOB_RETENTION.
	FailedJobRetentionAgeSeconds = 7 * 24 * 60 * 60
	FailedJobRetentionCount      = 10_000
)

// JobData is the payload consumed by the economic worker.
type JobData struct {
	DataItemID    string `json:"dataItemId"`
	TriggeredByID string `json:"triggeredById,omitempty"`
	TraceID       string `json:"traceId,omitempty"`
}

// RepeatOptions is the subset of BullMQ RepeatOptions the catalog scheduler
// uses. Pattern and Every are mutually exclusive.
type RepeatOptions struct {
	Pattern   string
	Every     int64
	TZ        string
	StartDate *time.Time
	EndDate   *time.Time
}

// RepeatableJob is one entry from bull:akshare-data:repeat.
type RepeatableJob struct {
	Key     string
	Name    string
	Pattern string
	Every   string
	TZ      string
	Next    int64
}

// Job is the Redis hash representation of one claimed job.
type Job struct {
	ID           string
	Name         string
	Data         json.RawMessage
	Opts         jobOptions
	Timestamp    int64
	Delay        int64
	RepeatJobKey string
}

type jobOptions struct {
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     keepJobs        `json:"removeOnFail"`
	Attempts         int             `json:"attempts"`
	Repeat           *repeatPayload  `json:"repeat"`
	RepeatJobKey     string          `json:"repeatJobKey"`
	JobID            string          `json:"jobId"`
	Delay            int64           `json:"delay"`
	Timestamp        int64           `json:"timestamp"`
	PrevMillis       int64           `json:"prevMillis"`
}

type repeatPayload struct {
	Pattern   string `json:"pattern"`
	Every     int64  `json:"every"`
	TZ        string `json:"tz"`
	EndDate   int64  `json:"endDate"`
	StartDate int64  `json:"startDate"`
	Count     int    `json:"count"`
	Offset    int64  `json:"offset"`
}

type keepJobs struct {
	Age   int64 `json:"age"`
	Count int64 `json:"count"`
}

func queueKey(suffix string) string {
	return Prefix + ":" + QueueName + ":" + suffix
}

func (j *Job) removeOnComplete() bool {
	if len(j.Opts.RemoveOnComplete) == 0 {
		return false
	}
	var keep bool
	if err := json.Unmarshal(j.Opts.RemoveOnComplete, &keep); err == nil {
		return keep
	}
	var count int64
	if err := json.Unmarshal(j.Opts.RemoveOnComplete, &count); err == nil {
		return count == 0
	}
	return false
}
