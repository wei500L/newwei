package economicqueue

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

const (
	// FailedJobRetentionAgeSeconds mirrors BULLMQ_FAILED_JOB_RETENTION.age.
	FailedJobRetentionAgeSeconds = 7 * 24 * 60 * 60
	// FailedJobRetentionCount mirrors BULLMQ_FAILED_JOB_RETENTION.count.
	FailedJobRetentionCount = 10_000
)

// JobData is the payload consumed by the economic worker. It is the JSON job
// data both the Go producer and (historically) the NestJS producer write.
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

// Job is the Redis hash representation of one claimed job. Token is the lock
// token held by this attempt; DeferredFailure carries BullMQ's "job stalled
// more than allowable limit" marker (defa) that must fail without running.
type Job struct {
	ID              string
	Name            string
	Data            json.RawMessage
	Opts            jobOptions
	Timestamp       int64
	Delay           int64
	RepeatJobKey    string
	Token           string
	AttemptsMade    int64
	StalledCount    int64
	DeferredFailure string
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

// keepJobs is the JSON shape of removeOnFail stored in the job hash.
type keepJobs struct {
	Age   int64 `json:"age"`
	Count int64 `json:"count"`
}

// KeepJobs is BullMQ's removeOnComplete/removeOnFail value in the MessagePack
// shape moveToFinished expects.
type KeepJobs struct {
	Age   *int64 `msgpack:"age,omitempty"`
	Count *int64 `msgpack:"count,omitempty"`
}

func int64Ptr(value int64) *int64 { return &value }

// keepOnComplete resolves the removeOnComplete policy for moveToFinished. An
// unset option keeps the job forever (count -1), which is BullMQ's worker
// default; a literal true removes it.
func keepOnComplete(opts jobOptions) KeepJobs {
	raw := strings.TrimSpace(string(opts.RemoveOnComplete))
	switch raw {
	case "", "null":
		return KeepJobs{Count: int64Ptr(-1)}
	case "true":
		return KeepJobs{Count: int64Ptr(0)}
	case "false":
		return KeepJobs{Count: int64Ptr(-1)}
	}
	var count int64
	if err := json.Unmarshal(opts.RemoveOnComplete, &count); err == nil {
		return KeepJobs{Count: int64Ptr(count)}
	}
	var shape KeepJobs
	if err := json.Unmarshal(opts.RemoveOnComplete, &shape); err == nil {
		if shape.Count == nil {
			shape.Count = int64Ptr(-1)
		}
		return shape
	}
	return KeepJobs{Count: int64Ptr(-1)}
}

// keepOnFail resolves the removeOnFail policy. The producer always stores the
// shared failed-job retention, so an all-zero shape falls back to "keep
// forever" rather than silently deleting the failure.
func keepOnFail(opts jobOptions) KeepJobs {
	if opts.RemoveOnFail.Age == 0 && opts.RemoveOnFail.Count == 0 {
		return KeepJobs{Count: int64Ptr(-1)}
	}
	return KeepJobs{Age: int64Ptr(opts.RemoveOnFail.Age), Count: int64Ptr(opts.RemoveOnFail.Count)}
}

func (j *Job) removeOnComplete() bool {
	return len(j.Opts.RemoveOnComplete) > 0 && strings.TrimSpace(string(j.Opts.RemoveOnComplete)) == "true"
}

// moveToActiveOptions is the MessagePack object moveToActive expects. The
// limiter stays nil because akshare-data is not rate limited.
type moveToActiveOptions struct {
	Token        string `msgpack:"token"`
	LockDuration int64  `msgpack:"lockDuration"`
	Name         string `msgpack:"name"`
}

// finishOptions is the MessagePack object moveToFinished expects.
type finishOptions struct {
	Token          string   `msgpack:"token"`
	KeepJobs       KeepJobs `msgpack:"keepJobs"`
	LockDuration   int64    `msgpack:"lockDuration"`
	Attempts       int      `msgpack:"attempts"`
	MaxMetricsSize string   `msgpack:"maxMetricsSize"`
}

// jobFromFields builds a Job from the flat HGETALL reply moveToActive returns.
func jobFromFields(jobID string, fields map[string]string, token string) Job {
	job := Job{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		Timestamp:       parseInt64(fields["timestamp"]),
		Delay:           parseInt64(fields["delay"]),
		RepeatJobKey:    fields["rjk"],
		AttemptsMade:    parseInt64(fields["atm"]),
		StalledCount:    parseInt64(fields["stc"]),
		DeferredFailure: fields["defa"],
	}
	data := fields["data"]
	if data == "" {
		data = "{}"
	}
	job.Data = json.RawMessage(data)
	if raw := fields["opts"]; raw != "" {
		var opts jobOptions
		if err := json.Unmarshal([]byte(raw), &opts); err == nil {
			job.Opts = opts
		}
	}
	if job.Opts.RepeatJobKey == "" {
		job.Opts.RepeatJobKey = job.RepeatJobKey
	}
	return job
}

// flattenPairs turns the flat [field, value, ...] HGETALL reply into a map.
//
// The []any argument is the go-redis protocol result, not business data.
func flattenPairs(reply []any) map[string]string {
	fields := make(map[string]string, len(reply)/2)
	for index := 0; index+1 < len(reply); index += 2 {
		key, ok := reply[index].(string)
		if !ok {
			continue
		}
		value, ok := reply[index+1].(string)
		if !ok {
			continue
		}
		fields[key] = value
	}
	return fields
}

// parseInt64 reads a Redis integer field; a missing or malformed value is zero.
func parseInt64(raw string) int64 {
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return value
}
