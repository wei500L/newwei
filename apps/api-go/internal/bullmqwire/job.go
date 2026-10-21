package bullmqwire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// ErrNoClient is returned when no Redis client was supplied.
var ErrNoClient = errors.New("bullmqwire: redis is not configured")

// ErrEmptyJobID is returned for an empty job id; BullMQ never produces one.
var ErrEmptyJobID = errors.New("bullmqwire: job id is empty")

// hashFields is the BullMQ job hash subset this package decodes. The names are
// the exact hash fields written by storeJob.lua (name/data/opts/timestamp/
// delay/priority), moveToActive (processedOn, attemptsMade), moveToFinished
// (finishedOn, returnvalue, failedReason bytes) and saveStacktrace
// (stacktrace, failedReason). `atm` is BullMQ's legacy attemptsMade alias.
var hashFields = []string{
	"name",
	"data",
	"opts",
	"timestamp",
	"delay",
	"priority",
	"processedOn",
	"finishedOn",
	"attemptsMade",
	"atm",
	"failedReason",
	"returnvalue",
	"stacktrace",
	"parentKey",
	"rjk",
}

// Job is one decoded BullMQ job hash.
//
// Data and Opts keep the stored JSON: BullMQ writes `data` as JSON.stringify of
// the job payload and `opts` as cjson.encode of the resolved JobsOptions, so
// both are valid JSON documents. ReturnValue is the parsed value (BullMQ stores
// JSON.stringify(returnvalue) and Job.fromJSON runs JSON.parse on it).
type Job struct {
	// ID is the requested job id, not stored in the hash itself.
	ID string
	// Name is the job name (the second argument of Queue.add).
	Name string
	// Data is the raw job payload JSON exactly as stored.
	Data json.RawMessage
	// Opts is the raw resolved JobsOptions JSON exactly as stored.
	Opts json.RawMessage

	// Timestamp is the enqueue time in Unix milliseconds.
	Timestamp int64
	// Delay is the current remaining delay in milliseconds (0 when not delayed).
	Delay int64
	// Priority is the BullMQ priority (0 when unset).
	Priority int64
	// ProcessedOn is the last start time in Unix milliseconds; nil when the job
	// has never been picked up.
	ProcessedOn *int64
	// FinishedOn is the completion time in Unix milliseconds; nil while the job
	// is unfinished.
	FinishedOn *int64
	// AttemptsMade is the number of finished attempts; missing means 0.
	AttemptsMade int64

	// FailedReason is the last failure message; empty when the job never failed.
	FailedReason string
	// ReturnValue is the parsed return value; nil when the hash has none.
	ReturnValue json.RawMessage
	// Stacktrace is the decoded stacktrace array; empty when absent.
	Stacktrace []string

	// ParentKey is the parent job key when the job has a parent.
	ParentKey string
	// RepeatJobKey is the repeat key when the job came from a repeat schedule.
	RepeatJobKey string
}

// JobOptions is the resolved JobsOptions subset that changes console behaviour
// or retention. The console also returns the raw Opts document.
type JobOptions struct {
	Attempts         int64           `json:"attempts"`
	Delay            int64           `json:"delay"`
	Priority         int64           `json:"priority"`
	JobID            string          `json:"jobId"`
	Lifo             bool            `json:"lifo"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
	Backoff          json.RawMessage `json:"backoff"`
}

// ReadJob decodes one job hash. A missing hash returns (nil, nil) so callers can
// answer 404 without special-casing the Redis nil.
func ReadJob(ctx context.Context, client redis.Cmdable, keys Keys, jobID string) (*Job, error) {
	if client == nil {
		return nil, ErrNoClient
	}
	if jobID == "" {
		return nil, ErrEmptyJobID
	}
	values, err := client.HMGet(ctx, keys.Job(jobID), hashFields...).Result()
	if err != nil {
		return nil, err
	}
	present := false
	for _, value := range values {
		if value != nil {
			present = true
			break
		}
	}
	if !present {
		return nil, nil
	}
	field := func(index int) string { return stringValue(values, index) }

	job := &Job{
		ID:           jobID,
		Name:         field(0),
		Data:         rawJSON(field(1)),
		Opts:         rawJSON(field(2)),
		Timestamp:    int64Value(field(3)),
		Delay:        int64Value(field(4)),
		Priority:     int64Value(field(5)),
		ProcessedOn:  millisPointer(field(6)),
		FinishedOn:   millisPointer(field(7)),
		FailedReason: field(10),
		ReturnValue:  storedJSONValue(field(11)),
		Stacktrace:   stringArray(field(12)),
		ParentKey:    field(13),
		RepeatJobKey: field(14),
	}
	// attemptsMade has the legacy `atm` alias and defaults to 0.
	if attempts := field(8); attempts != "" {
		job.AttemptsMade = int64Value(attempts)
	} else {
		job.AttemptsMade = int64Value(field(9))
	}
	if len(job.Data) == 0 {
		job.Data = json.RawMessage("{}")
	}
	if len(job.Opts) == 0 {
		job.Opts = json.RawMessage("{}")
	}
	return job, nil
}

// ReadJobLogs returns the job's log rows, oldest first. BullMQ appends with
// RPUSH, so the list order is already chronological; limit <= 0 reads all rows.
func ReadJobLogs(ctx context.Context, client redis.Cmdable, keys Keys, jobID string, limit int64) ([]string, error) {
	if client == nil {
		return nil, ErrNoClient
	}
	if jobID == "" {
		return nil, ErrEmptyJobID
	}
	var (
		rows []string
		err  error
	)
	if limit > 0 {
		rows, err = client.LRange(ctx, keys.Logs(jobID), -limit, -1).Result()
	} else {
		rows, err = client.LRange(ctx, keys.Logs(jobID), 0, -1).Result()
	}
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// Options parses the stored JobsOptions document. A malformed document yields
// the zero value: the console renders the raw Opts either way, and the tracker
// falls back to "the job is retained", which is what BullMQ assumes for an
// option it cannot read.
func (j *Job) Options() JobOptions {
	var opts JobOptions
	if j == nil || len(j.Opts) == 0 {
		return opts
	}
	if err := json.Unmarshal(j.Opts, &opts); err != nil {
		return JobOptions{}
	}
	return opts
}

// KeepCompleted reports whether a completed job of this job is retained, i.e.
// keepsFinishedJob(opts.removeOnComplete).
func (j *Job) KeepCompleted() bool {
	if j == nil {
		return true
	}
	return KeepsFinishedJob(j.Options().RemoveOnComplete)
}

// KeepFailed reports whether a failed job of this job is retained, i.e.
// keepsFinishedJob(opts.removeOnFail).
func (j *Job) KeepFailed() bool {
	if j == nil {
		return true
	}
	return KeepsFinishedJob(j.Options().RemoveOnFail)
}

// KeepsFinishedJob ports keepsFinishedJob from
// apps/api/src/common/bullmq-retention.ts: it reports whether BullMQ keeps a
// finished job for the given removeOnComplete / removeOnFail option.
//
//	true              -> false (the job is removed as soon as it finishes)
//	number n          -> n > 0
//	{age, count}      -> age != 0 && count != 0 (an absent key is not 0)
//	false / null / "" -> true (BullMQ's default keeps finished jobs)
func KeepsFinishedJob(option json.RawMessage) bool {
	trimmed := bytes.TrimSpace(option)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return true
	}
	switch trimmed[0] {
	case 't':
		return false
	case 'f':
		return true
	case '{':
		var keep struct {
			Age   *float64 `json:"age"`
			Count *float64 `json:"count"`
		}
		if err := json.Unmarshal(trimmed, &keep); err != nil {
			return true
		}
		ageZero := keep.Age != nil && *keep.Age == 0
		countZero := keep.Count != nil && *keep.Count == 0
		return !ageZero && !countZero
	default:
		var number float64
		if err := json.Unmarshal(trimmed, &number); err != nil {
			return true
		}
		return number > 0
	}
}

// OrgIDFromData returns the `orgId` field of a job payload. It is the tenant key
// the queue org counters use; an absent or non-string value yields "".
func OrgIDFromData(data json.RawMessage) string {
	if len(bytes.TrimSpace(data)) == 0 {
		return ""
	}
	var payload struct {
		OrgID string `json:"orgId"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return ""
	}
	return payload.OrgID
}

// stringValue reads one HMGET slot. The []interface{} slice is the go-redis
// HMGet protocol result, not business data: a missing field arrives as a nil
// interface and is mapped to "".
func stringValue(values []interface{}, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	switch value := values[index].(type) {
	case nil:
		return ""
	case string:
		return value
	case []byte:
		return string(value)
	case int64:
		return strconv.FormatInt(value, 10)
	default:
		return ""
	}
}

// int64Value parses a BullMQ numeric hash field. Every BullMQ counter and
// timestamp is stored as a base-10 integer string; a malformed or absent value
// yields 0 exactly like parseInt(... || '0').
func int64Value(raw string) int64 {
	if raw == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

// millisPointer parses an optional millisecond field. BullMQ only writes
// processedOn/finishedOn once the job reaches that state.
func millisPointer(raw string) *int64 {
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return nil
	}
	return &value
}

// rawJSON keeps a stored JSON document byte-for-byte; an invalid document is
// re-encoded as a JSON string so the response stays valid JSON.
func rawJSON(raw string) json.RawMessage {
	if raw == "" {
		return nil
	}
	trimmed := bytes.TrimSpace([]byte(raw))
	if json.Valid(trimmed) {
		return json.RawMessage(trimmed)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return encoded
}

// storedJSONValue decodes the `returnvalue` field. BullMQ stores the JSON text
// returned by JSON.stringify, so a valid document is already the parsed value.
func storedJSONValue(raw string) json.RawMessage {
	if raw == "" {
		return nil
	}
	return rawJSON(raw)
}

// stringArray decodes the `stacktrace` field, which BullMQ stores as a JSON
// array of strings.
func stringArray(raw string) []string {
	if raw == "" {
		return nil
	}
	var rows []string
	if err := json.Unmarshal([]byte(raw), &rows); err != nil {
		return nil
	}
	return rows
}
