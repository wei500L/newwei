// Package analysisqueue is the limited BullMQ-compatible runner for the
// analysis queue only.
//
// It implements the subset of the BullMQ 5.63.2 wire protocol the analysis
// product chain uses: the standard add command, moveToActive, lock renewal,
// completed/failed finish, immediate retry, stalled recovery, paused queues,
// delayed promotion, markers/events and the queue retention options. It is not
// a general BullMQ platform and adds no repeat, flow, scheduler or other queue
// owner.
//
// The Redis state machine is the official Lua code in scripts/ (see
// scripts/NOTICE.md for the version, source, license and digests). Job data and
// job options use MessagePack exactly like BullMQ's msgpackr configuration
// (useRecords=false, undefined as nil), so Node BullMQ producers and consumers
// interoperate with this runner in both directions.
//
// Organization ownership lives in the persisted analysisresults document, not
// in the queue: the queue payload carries an optional orgId for legacy jobs and
// for event routing, and the domain handler refuses to touch a record whose
// organization or type does not match the payload.
package analysisqueue

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

	"github.com/vmihailenco/msgpack/v5"
)

const (
	// QueueName is the BullMQ queue shared with the legacy NestJS processor.
	QueueName = "analysis"
	// DefaultPrefix is BullMQ's default key prefix (`bull:analysis:*`).
	DefaultPrefix = "bull"

	// LockDuration and LockRenewTime are BullMQ's worker defaults.
	LockDuration  = 30 * time.Second
	LockRenewTime = 15 * time.Second
	// StalledInterval and MaxStalledCount are BullMQ's worker defaults.
	StalledInterval = 30 * time.Second
	MaxStalledCount = 1
	// DrainDelay is the marker blocking timeout used when the queue is empty.
	DrainDelay = 5 * time.Second

	// FailedRetentionAgeSeconds and FailedRetentionCount mirror
	// BULLMQ_FAILED_JOB_RETENTION {age: 604800, count: 10000}.
	FailedRetentionAgeSeconds = 604_800
	FailedRetentionCount      = 10_000
)

// Job types are the persisted analysis types and the BullMQ job names.
const (
	TypeCorrelation  = "correlation"
	TypeAnomaly      = "anomaly"
	TypeGeoTransport = "geo_transport"
)

var (
	// ErrInvalidJobID is returned when the caller supplies an empty job id.
	ErrInvalidJobID = errors.New("analysisqueue: job id is required")
	// ErrInvalidType is returned for a job type outside the three migrated
	// analysis types.
	ErrInvalidType = errors.New("analysisqueue: invalid analysis job type")
)

// Payload is the BullMQ job data shared with NestJS. Legacy jobs may omit
// orgId and traceId; the domain handler resolves the organization from the
// persisted record and requires a present orgId to match it.
type Payload struct {
	Type       string `json:"type" msgpack:"type"`
	AnalysisID string `json:"analysisId" msgpack:"analysisId"`
	OrgID      string `json:"orgId,omitempty" msgpack:"orgId,omitempty"`
	TraceID    string `json:"traceId,omitempty" msgpack:"traceId,omitempty"`
}

// KeepJobs is BullMQ's removeOnComplete/removeOnFail value.
type KeepJobs struct {
	Age   *int `json:"age,omitempty" msgpack:"age,omitempty"`
	Count *int `json:"count,omitempty" msgpack:"count,omitempty"`
}

// JobOptions is the typed view of the job hash `opts` JSON. Settings the
// runner does not use (repeat, flow, priority, ...) are ignored.
type JobOptions struct {
	Attempts         int             `json:"attempts"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
	LIFO             bool            `json:"lifo"`
}

// Job is one job fetched from the active list. Token is the lock token held by
// this attempt; the domain handler persists it as the Mongo fencing token.
type Job struct {
	ID              string
	Name            string
	Token           string
	Payload         Payload
	Opts            JobOptions
	AttemptsMade    int
	AttemptsStarted int
	StalledCounter  int
	DeferredFailure string
	Timestamp       int64
	ProcessedOn     int64
}

// Attempts returns the configured maximum attempts, defaulting to one exactly
// like BullMQ treats a job without opts.attempts.
func (j Job) Attempts() int {
	if j.Opts.Attempts < 1 {
		return 1
	}
	return j.Opts.Attempts
}

// FinalFailure reports whether this execution is the last one BullMQ will run.
// A deferred failure ("job stalled more than allowable limit") is final even
// when attempts remain, because BullMQ marks it unrecoverable.
func (j Job) FinalFailure() bool {
	if j.DeferredFailure != "" {
		return true
	}
	return j.AttemptsMade+1 >= j.Attempts()
}

// KeepOnComplete is the worker keepJobs value for a successful finish. When the
// job has no removeOnComplete option the BullMQ worker falls back to keeping
// the job (count -1), not to removing it.
func KeepOnComplete(opts JobOptions) KeepJobs {
	if keep := decodeKeepJobs(opts.RemoveOnComplete); keep != nil {
		return *keep
	}
	return KeepJobs{Count: intPtr(-1)}
}

// KeepOnFail is the worker keepJobs value for a terminal failure.
func KeepOnFail(opts JobOptions) KeepJobs {
	if keep := decodeKeepJobs(opts.RemoveOnFail); keep != nil {
		return *keep
	}
	return KeepJobs{Count: intPtr(-1)}
}

func decodeKeepJobs(raw json.RawMessage) *KeepJobs {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if trimmed == "true" {
		return &KeepJobs{Count: intPtr(0)}
	}
	if trimmed == "false" {
		return &KeepJobs{Count: intPtr(-1)}
	}
	var count int
	if err := json.Unmarshal(raw, &count); err == nil {
		return &KeepJobs{Count: intPtr(count)}
	}
	var keep KeepJobs
	if err := json.Unmarshal(raw, &keep); err == nil {
		return &keep
	}
	return nil
}

func intPtr(value int) *int { return &value }

// JobIDPrefix is the BullMQ job id prefix for an analysis type.
func JobIDPrefix(jobType string) (string, error) {
	switch jobType {
	case TypeCorrelation:
		return "corr-", nil
	case TypeAnomaly:
		return "anomaly-", nil
	case TypeGeoTransport:
		return "geo-transport-", nil
	default:
		return "", ErrInvalidType
	}
}

// keys is the BullMQ queue key layout: `<prefix>:<queue>:<suffix>`.
type keys struct {
	Prefix      string
	Base        string
	Wait        string
	Paused      string
	Meta        string
	ID          string
	Completed   string
	Failed      string
	Delayed     string
	Active      string
	Events      string
	Marker      string
	Stalled     string
	Limiter     string
	PC          string
	Prioritized string
}

func newKeys(prefix, queue string) keys {
	if prefix == "" {
		prefix = DefaultPrefix
	}
	base := prefix + ":" + queue + ":"
	key := func(suffix string) string { return base + suffix }
	return keys{
		Prefix:      prefix,
		Base:        base,
		Wait:        key("wait"),
		Paused:      key("paused"),
		Meta:        key("meta"),
		ID:          key("id"),
		Completed:   key("completed"),
		Failed:      key("failed"),
		Delayed:     key("delayed"),
		Active:      key("active"),
		Events:      key("events"),
		Marker:      key("marker"),
		Stalled:     key("stalled"),
		Limiter:     key("limiter"),
		PC:          key("pc"),
		Prioritized: key("prioritized"),
	}
}

func (k keys) Job(id string) string { return k.Base + id }

// redisJobOptions is the MessagePack payload stored for a queued job. The JSON
// form is what storeJob writes into the job hash; the same fields are decoded
// by Node BullMQ when it consumes a Go-produced job.
type redisJobOptions struct {
	Attempts         int       `json:"attempts" msgpack:"attempts"`
	RemoveOnComplete bool      `json:"removeOnComplete" msgpack:"removeOnComplete"`
	RemoveOnFail     *KeepJobs `json:"removeOnFail,omitempty" msgpack:"removeOnFail,omitempty"`
}

func defaultRedisJobOptions(maxRetries int) redisJobOptions {
	attempts := maxRetries
	if attempts < 1 {
		attempts = 1
	}
	return redisJobOptions{
		Attempts:         attempts,
		RemoveOnComplete: true,
		RemoveOnFail: &KeepJobs{
			Age:   intPtr(FailedRetentionAgeSeconds),
			Count: intPtr(FailedRetentionCount),
		},
	}
}

func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("analysisqueue: pack msgpack: %w", err)
	}
	return encoded, nil
}

// tokenSource produces a unique BullMQ lock token per fetched job. It is not
// derived from the worker slot, so a reclaimed job always gets a fresh Mongo
// fencing token.
type tokenSource struct {
	id      string
	counter atomic.Uint64
}

func newTokenSource() *tokenSource {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return &tokenSource{id: "analysis-go"}
	}
	return &tokenSource{id: "analysis-go-" + hex.EncodeToString(buf[:])}
}

func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// ErrLeaseLost is the cancel cause used when lock renewal fails or the lock
// belongs to another token. Handlers can inspect context.Cause(ctx) to stop
// without writing a terminal state.
var ErrLeaseLost = errors.New("analysisqueue: job lock was lost")

// LeaseLostError tells the worker that this attempt no longer owns the BullMQ
// job lease. The worker must not acknowledge the job; the queue recovers it.
type LeaseLostError struct{ Reason string }

func (e *LeaseLostError) Error() string {
	if e == nil {
		return "analysisqueue: lease lost"
	}
	if e.Reason == "" {
		return "analysisqueue: lease lost"
	}
	return "analysisqueue: lease lost: " + e.Reason
}

// UnrecoverableError tells the worker to finalize the job without another
// retry even when attempts remain (for example a corrupt payload that can never
// succeed).
type UnrecoverableError struct{ Err error }

func (e *UnrecoverableError) Error() string {
	if e == nil || e.Err == nil {
		return "analysisqueue: unrecoverable job"
	}
	return e.Err.Error()
}

func (e *UnrecoverableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

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
		return Job{}, errors.New("analysisqueue: empty job data")
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
	if err := json.Unmarshal([]byte(fields["data"]), &job.Payload); err != nil {
		return Job{}, fmt.Errorf("analysisqueue: decode job data: %w", err)
	}
	if raw := strings.TrimSpace(fields["opts"]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &job.Opts); err != nil {
			return Job{}, fmt.Errorf("analysisqueue: decode job opts: %w", err)
		}
	}
	return job, nil
}

// moveToActiveOptions is the MessagePack object the moveToActive Lua command
// expects. Omitting limiter and name mirrors the NestJS worker configuration.
type moveToActiveOptions struct {
	Token        string `msgpack:"token"`
	LockDuration int64  `msgpack:"lockDuration"`
}

// FinishOptions is the MessagePack object moveToFinished expects. BullMQ always
// sends maxMetricsSize as the empty string when metrics are disabled; sending
// nil instead would make the Lua `~= ""` check true and call collectMetrics
// with a nil bound.
type finishOptions struct {
	Token          string   `msgpack:"token"`
	KeepJobs       KeepJobs `msgpack:"keepJobs"`
	LockDuration   int64    `msgpack:"lockDuration"`
	Attempts       int      `msgpack:"attempts"`
	MaxMetricsSize string   `msgpack:"maxMetricsSize"`
}

func newFinishOptions(job Job, token string, keep KeepJobs, lockDuration time.Duration) finishOptions {
	if lockDuration <= 0 {
		lockDuration = LockDuration
	}
	return finishOptions{
		Token:          token,
		KeepJobs:       keep,
		LockDuration:   int64(lockDuration / time.Millisecond),
		Attempts:       job.Attempts(),
		MaxMetricsSize: "",
	}
}

// stacktraceJSON is the JSON-array string BullMQ stores. Go has no JavaScript
// stack; the error text is the stable, redacted equivalent.
func stacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}
