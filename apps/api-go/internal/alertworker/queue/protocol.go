package queue

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Worker defaults. They are BullMQ's Worker defaults, which the NestJS
// AlertsProcessor also uses (it only overrides concurrency and the custom
// backoff strategy).
const (
	// DefaultConcurrency is used when ALERT_QUEUE_CONCURRENCY is absent.
	DefaultConcurrency = 4
	// LockDuration / LockRenewTime / StalledInterval / MaxStalledCount /
	// DrainDelay are the BullMQ Worker defaults.
	LockDuration       = 30 * time.Second
	LockRenewTime      = 15 * time.Second
	StalledInterval    = 30 * time.Second
	MaxStalledCount    = 1
	DrainDelay         = 5 * time.Second
	minimumPollDelayMs = 10
)

// DelayedError is returned by a Processor that asked the worker to move the
// job to the delayed set without consuming an attempt. It is the Go equivalent
// of calling `job.moveToDelayed(ts, token)` and then throwing `DelayedError`
// in NestJS: the attempt neither completes nor fails.
type DelayedError struct {
	// UntilMs is the epoch millisecond the job must wait for.
	UntilMs int64
}

func (e *DelayedError) Error() string {
	return "alertworker/queue: job moved to delayed until " + strconv.FormatInt(e.UntilMs, 10)
}

// Job is one job claimed from the active list. Data is the raw JSON payload the
// producer stored; the business layer decodes it into a typed payload.
type Job struct {
	ID    string
	Name  string
	Token string
	Data  json.RawMessage
	Opts  JobOptions
	// RepeatJobKey is the hash field `rjk`: the repeat key or job-scheduler id
	// this iteration belongs to (empty for one-shot jobs).
	RepeatJobKey    string
	AttemptsMade    int
	AttemptsStarted int
	StalledCounter  int
	DeferredFailure string
	Timestamp       int64
	ProcessedOn     int64
}

// Attempts is the configured maximum number of attempts. BullMQ stores
// `attempts: 0` for a job that did not set the option, which behaves exactly
// like one attempt, so a value below one is treated as one.
func (j Job) Attempts() int {
	if j.Opts.Attempts == nil || *j.Opts.Attempts < 1 {
		return 1
	}
	return *j.Opts.Attempts
}

// FinalFailure reports whether this execution is the last one BullMQ would run:
// `attemptsMade + 1 >= attempts` (see the package comment on attempts).
func (j Job) FinalFailure() bool {
	if j.DeferredFailure != "" {
		return true
	}
	return j.AttemptsMade+1 >= j.Attempts()
}

// KeepJobs mirrors BullMQ's removeOnComplete/removeOnFail value.
type KeepJobs struct {
	Age   *int64
	Count *int64
}

// UnmarshalJSON accepts BullMQ's three shapes: a boolean, a number or
// {age, count}.
func (k *KeepJobs) UnmarshalJSON(raw []byte) error {
	trimmed := strings.TrimSpace(string(raw))
	switch {
	case trimmed == "" || trimmed == "null":
		return nil
	case trimmed == "true":
		count := int64(0)
		k.Count = &count
		return nil
	case trimmed == "false":
		count := int64(-1)
		k.Count = &count
		return nil
	}
	if trimmed[0] != '{' {
		var count int64
		if err := json.Unmarshal(raw, &count); err != nil {
			return err
		}
		k.Count = &count
		return nil
	}
	var decoded struct {
		Age   *int64 `json:"age"`
		Count *int64 `json:"count"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	k.Age = decoded.Age
	k.Count = decoded.Count
	return nil
}

// BackoffOptions is opts.backoff.
type BackoffOptions struct {
	Type   string   `json:"type"`
	Delay  *float64 `json:"delay"`
	Jitter *float64 `json:"jitter"`
}

// RepeatOptions is opts.repeat for the every-based schedules this queue uses.
// The alert service only creates `every` schedules without an end date, a
// timezone or a pattern.
type RepeatOptions struct {
	Every   *int64 `json:"every"`
	JobID   string `json:"jobId"`
	Count   *int64 `json:"count"`
	Offset  *int64 `json:"offset"`
	Pattern string `json:"pattern"`
	Limit   *int64 `json:"limit"`
	TZ      string `json:"tz"`
}

// JobOptions is the typed view of the job hash `opts` JSON. The alerts queue
// only ever stores the fields below: Queue.add merges
// defaultJobOptions {removeOnFail} with the caller's options, and the repeat
// iterations add jobId/delay/timestamp/prevMillis/repeat.
type JobOptions struct {
	Attempts         *int            `json:"attempts"`
	Backoff          *BackoffOptions `json:"backoff"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
	JobID            string          `json:"jobId"`
	Delay            *float64        `json:"delay"`
	Timestamp        *int64          `json:"timestamp"`
	PrevMillis       *int64          `json:"prevMillis"`
	Repeat           *RepeatOptions  `json:"repeat"`
	LIFO             bool            `json:"lifo"`
	Priority         *int            `json:"priority"`
}

// KeepOnComplete is the worker keepJobs value for a successful finish,
// mirroring Scripts.getKeepJobs: the job's own removeOnComplete wins, otherwise
// the worker keeps the job.
func KeepOnComplete(opts JobOptions) KeepJobs {
	if keep, ok := decodeKeepJobs(opts.RemoveOnComplete); ok {
		return keep
	}
	return KeepJobs{Count: intPtr(-1)}
}

// KeepOnFail is the worker keepJobs value for a terminal failure.
func KeepOnFail(opts JobOptions) KeepJobs {
	if keep, ok := decodeKeepJobs(opts.RemoveOnFail); ok {
		return keep
	}
	return KeepJobs{Count: intPtr(-1)}
}

func decodeKeepJobs(raw json.RawMessage) (KeepJobs, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return KeepJobs{}, false
	}
	var keep KeepJobs
	if err := json.Unmarshal([]byte(trimmed), &keep); err != nil {
		return KeepJobs{}, false
	}
	return keep, true
}

func intPtr(value int64) *int64 { return &value }

// moveToActiveOptions is the MessagePack object moveToActive expects. The
// NestJS worker passes no limiter and no worker name, so both slots stay nil.
// These are protocol wire maps, not business data: every value is a scalar and
// the shapes are fixed by the BullMQ scripts.
func moveToActiveOptions(token string, lockDurationMs int64) map[string]any {
	return map[string]any{
		"token":        token,
		"lockDuration": lockDurationMs,
		"limiter":      nil,
		"name":         nil,
	}
}

// finishOptions is the MessagePack object moveToFinished expects. NestJS sends
// the queue's (not the worker's) lockDuration/limiter/name, which the alerts
// Queue never sets, so those slots stay nil; maxMetricsSize is the empty string
// because metrics are disabled.
func finishOptions(job Job, token string, keep KeepJobs) map[string]any {
	attempts := 0
	if job.Opts.Attempts != nil {
		attempts = *job.Opts.Attempts
	}
	return map[string]any{
		"token":          token,
		"name":           nil,
		"keepJobs":       map[string]any{"count": keep.Count, "age": keep.Age},
		"limiter":        nil,
		"lockDuration":   nil,
		"attempts":       attempts,
		"maxMetricsSize": "",
		"fpof":           false,
		"cpof":           false,
		"idof":           false,
		"rdof":           false,
	}
}

// tokenSource produces a unique BullMQ lock token per claimed job.
type tokenSource struct {
	id      string
	counter atomic.Uint64
}

func newTokenSource() *tokenSource {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return &tokenSource{id: "alertworker-go"}
	}
	return &tokenSource{id: "alertworker-go-" + hex.EncodeToString(buf[:])}
}

func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// nextJobData is the decoded moveToActive / moveToFinished return value.
type nextJobData struct {
	Job        *Job
	DelayUntil int64
}

// toText flattens one Redis reply element (HGETALL returns flat [field, value,...]).
func toText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []byte:
		return string(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int:
		return strconv.Itoa(typed)
	case nil:
		return ""
	default:
		return fmt.Sprint(typed)
	}
}

func toInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		return parsed
	case []byte:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(string(typed)), 10, 64)
		return parsed
	case float64:
		return int64(typed)
	default:
		return 0
	}
}

// jobFromFlat decodes the flat HGETALL array moveToActive returns.
func jobFromFlat(flat []any, token, jobID string) (Job, error) {
	if len(flat) == 0 {
		return Job{}, errors.New("alertworker/queue: empty job data")
	}
	fields := make(map[string]string, len(flat)/2)
	for index := 0; index+1 < len(flat); index += 2 {
		fields[toText(flat[index])] = toText(flat[index+1])
	}
	if jobID == "" {
		jobID = fields["id"]
	}
	job := Job{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		RepeatJobKey:    fields["rjk"],
		AttemptsMade:    int(toInt64(fields["atm"])),
		AttemptsStarted: int(toInt64(fields["ats"])),
		StalledCounter:  int(toInt64(fields["stc"])),
		DeferredFailure: fields["defa"],
		Timestamp:       toInt64(fields["timestamp"]),
		ProcessedOn:     toInt64(fields["processedOn"]),
	}
	if job.AttemptsMade == 0 {
		// Older payloads used attemptsMade instead of the compressed atm.
		job.AttemptsMade = int(toInt64(fields["attemptsMade"]))
	}
	if raw := fields["data"]; raw != "" {
		job.Data = json.RawMessage(raw)
	}
	if raw := strings.TrimSpace(fields["opts"]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &job.Opts); err != nil {
			return Job{}, fmt.Errorf("alertworker/queue: decode job opts: %w", err)
		}
	}
	return job, nil
}

// nextJobDataFromResult decodes the [jobData, jobId, rateLimitDelay, delayUntil]
// tuple the scripts return.
func nextJobDataFromResult(result any, token string) (nextJobData, error) {
	values, ok := result.([]any)
	if !ok {
		if result == nil {
			return nextJobData{}, nil
		}
		return nextJobData{}, fmt.Errorf("alertworker/queue: unexpected job result %T", result)
	}
	if len(values) == 0 {
		return nextJobData{}, nil
	}
	next := nextJobData{}
	if len(values) > 3 {
		next.DelayUntil = toInt64(values[3])
	}
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return next, nil
	}
	jobID := ""
	if len(values) > 1 {
		jobID = toText(values[1])
	}
	job, err := jobFromFlat(flat, token, jobID)
	if err != nil {
		return next, err
	}
	next.Job = &job
	return next, nil
}

// stacktraceJSON is the JSON-array string BullMQ stores for a failure. Go has
// no JavaScript stack, so the error text is the stable equivalent.
func stacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

// failureFields is the flat msgpack array moveToFinished/retryJob/moveToDelayed
// accept as their optional job-field update.
func failureFields(reason string) []any {
	return []any{"failedReason", reason, "stacktrace", stacktraceJSON(reason)}
}
