package crawlfrontierllm

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

// protocol.go is the BullMQ 5.63.2 wire subset the two LLM queues need. It is
// adapted from the clustering recovery runner (same vendored official Lua in
// scripts/, see NOTICE) with the queue name supplied per worker and the
// limiter object included in moveToActive.

// BullMQ keys and defaults.
const (
	DefaultPrefix = "bull"

	LockDuration    = 30 * time.Second
	LockRenewTime   = 15 * time.Second
	StalledInterval = 30 * time.Second
	MaxStalledCount = 1
	DrainDelay      = 5 * time.Second

	FailedRetentionAgeSeconds = 604_800
	FailedRetentionCount      = 10_000

	// LimiterMax and LimiterDuration are the NestJS createLlmWorker limiter
	// {max: 1, duration: 1000}. The limiter is a queue-level Redis key
	// (bull:<queue>:limiter), so a NestJS worker and this worker share it
	// during a switchover.
	LimiterMax      = 1
	LimiterDuration = time.Second

	// Job names are the queue.add names crawl-queue.service.ts uses.
	JudgeQueueName = "frontier-llm-judge"
	LearnQueueName = "frontier-llm-learn"
)

// Job is one claimed job.
type Job struct {
	Data            JobData
	ID              string
	Name            string
	Token           string
	Opts            redisJobOptions
	AttemptsMade    int
	AttemptsStarted int
	StalledCounter  int
	DeferredFailure string
}

// Attempts is the effective BullMQ attempts value.
func (j Job) Attempts() int {
	if j.Opts.Attempts < 1 {
		return 1
	}
	return j.Opts.Attempts
}

// FinalFailure reports whether this execution is the final attempt.
func (j Job) FinalFailure() bool {
	if j.DeferredFailure != "" {
		return true
	}
	return j.AttemptsMade+1 >= j.Attempts()
}

// KeepJobs is BullMQ's removeOnComplete/removeOnFail value.
type KeepJobs struct {
	Age   *int `json:"age,omitempty" msgpack:"age,omitempty"`
	Count *int `json:"count,omitempty" msgpack:"count,omitempty"`
}

// redisJobOptions is the JSON form stored in the job hash.
type redisJobOptions struct {
	Attempts         int             `json:"attempts"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
	LIFO             bool            `json:"lifo"`
}

func keepOnComplete(opts redisJobOptions) KeepJobs {
	if keep := decodeKeepJobs(opts.RemoveOnComplete); keep != nil {
		return *keep
	}
	return KeepJobs{Count: intPointer(-1)}
}

func keepOnFail(opts redisJobOptions) KeepJobs {
	if keep := decodeKeepJobs(opts.RemoveOnFail); keep != nil {
		return *keep
	}
	return KeepJobs{Count: intPointer(-1)}
}

func decodeKeepJobs(raw json.RawMessage) *KeepJobs {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	if trimmed == "true" {
		return &KeepJobs{Count: intPointer(0)}
	}
	if trimmed == "false" {
		return &KeepJobs{Count: intPointer(-1)}
	}
	var count int
	if err := json.Unmarshal(raw, &count); err == nil {
		return &KeepJobs{Count: &count}
	}
	var keep KeepJobs
	if err := json.Unmarshal(raw, &keep); err == nil {
		return &keep
	}
	return nil
}

func intPointer(value int) *int { return &value }

// queueKeys is the bull:<queue>:* layout.
type queueKeys struct {
	Prefix      string
	Base        string
	Wait        string
	Paused      string
	Meta        string
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
	ID          string
}

func newQueueKeys(queue string) queueKeys {
	base := DefaultPrefix + ":" + queue + ":"
	key := func(suffix string) string { return base + suffix }
	return queueKeys{
		Prefix: DefaultPrefix, Base: base, Wait: key("wait"), Paused: key("paused"),
		Meta: key("meta"), Completed: key("completed"), Failed: key("failed"), Delayed: key("delayed"),
		Active: key("active"), Events: key("events"), Marker: key("marker"),
		Stalled: key("stalled"), Limiter: key("limiter"), PC: key("pc"),
		Prioritized: key("prioritized"), ID: key("id"),
	}
}

func (k queueKeys) job(id string) string { return k.Base + id }

// limiterOptions is the moveToActive opts.limiter object.
type limiterOptions struct {
	Max      int64 `msgpack:"max"`
	Duration int64 `msgpack:"duration"`
}

// moveToActiveOptions is the MessagePack moveToActive argument object.
type moveToActiveOptions struct {
	Token        string          `msgpack:"token"`
	LockDuration int64           `msgpack:"lockDuration"`
	Limiter      *limiterOptions `msgpack:"limiter,omitempty"`
}

// finishOptions is the moveToFinished argument object.
type finishOptions struct {
	Token          string   `msgpack:"token"`
	KeepJobs       KeepJobs `msgpack:"keepJobs"`
	LockDuration   int64    `msgpack:"lockDuration"`
	Attempts       int      `msgpack:"attempts"`
	MaxMetricsSize string   `msgpack:"maxMetricsSize"`
}

func newFinishOptions(job Job, keep KeepJobs) finishOptions {
	return finishOptions{
		Token: job.Token, KeepJobs: keep,
		LockDuration: int64(LockDuration / time.Millisecond),
		Attempts:     job.Attempts(), MaxMetricsSize: "",
	}
}

func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("crawlfrontierllm: pack msgpack: %w", err)
	}
	return encoded, nil
}

type tokenSource struct {
	id      string
	counter atomic.Uint64
}

func newTokenSource(name string) *tokenSource {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return &tokenSource{id: name}
	}
	return &tokenSource{id: name + "-" + hex.EncodeToString(buffer[:])}
}

func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// ErrLeaseLost is the cancel cause used when lock renewal fails.
var ErrLeaseLost = errors.New("crawlfrontierllm: job lock was lost")

// toText converts a Redis reply element.
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

// jobFromFlat decodes the flat HGETALL reply.
func jobFromFlat(flat []any, token, jobID string) (Job, error) {
	if len(flat) == 0 {
		return Job{}, errors.New("crawlfrontierllm: empty job data")
	}
	fields := make(map[string]string, len(flat)/2)
	for index := 0; index+1 < len(flat); index += 2 {
		fields[toText(flat[index])] = toText(flat[index+1])
	}
	if jobID == "" {
		jobID = fields["id"]
	}
	job := Job{
		ID: jobID, Name: fields["name"], Token: token,
		AttemptsMade:    int(toInt64(fields["atm"])),
		AttemptsStarted: int(toInt64(fields["ats"])),
		StalledCounter:  int(toInt64(fields["stc"])),
		DeferredFailure: fields["defa"],
	}
	if job.AttemptsMade == 0 {
		job.AttemptsMade = int(toInt64(fields["attemptsMade"]))
	}
	if err := json.Unmarshal([]byte(fields["data"]), &job.Data); err != nil {
		return Job{}, fmt.Errorf("crawlfrontierllm: decode job data: %w", err)
	}
	if raw := strings.TrimSpace(fields["opts"]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &job.Opts); err != nil {
			return Job{}, fmt.Errorf("crawlfrontierllm: decode job opts: %w", err)
		}
	}
	return job, nil
}

// stacktraceJSON is the JSON-array stacktrace string BullMQ stores.
func stacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{"Error: " + message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

// marshalReturnValue JSON-encodes the processor result.
func marshalReturnValue(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(encoded)
}
