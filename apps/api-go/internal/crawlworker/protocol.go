package crawlworker

// BullMQ protocol layer for the three crawl4ai queues: queue names, key layout,
// the CrawlJobData JSON document, job options, the MessagePack option objects
// passed to moveToActive/moveToFinished, and the C2 concurrency broadcast
// payload.
//
// Everything here matches bullmq@5.63.2 as the NestJS CrawlQueueProcessor and
// the Go crawlqueue producer write it: job data is JSON, job options and command
// arguments are MessagePack, and the job hash is read through the same
// typeof-string / typeof-number guards the NestJS handler applies.

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

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// prefix is BullMQ's default key prefix. The NestJS queues are created without a
// prefix option, so both runtimes use `bull`.
const prefix = crawlqueue.Prefix

// jobKindFrontierNode is the CrawlJobData.jobKind of a Frontier node job, which
// is executed by the Frontier processor instead of the task runner.
const jobKindFrontierNode = "frontier_node"

// BullMQ 5.63.2 Worker defaults. The NestJS CrawlQueueProcessor creates its
// workers without overriding lockDuration, stalledInterval, maxStalledCount or
// drainDelay, so the Go worker uses the same values.
const (
	lockDuration    = 30 * time.Second
	lockRenewTime   = 15 * time.Second
	stalledInterval = 30 * time.Second
	maxStalledCount = 1
	drainDelay      = 5 * time.Second
	// transitionTimeout bounds one BullMQ transition or side-effect write. The
	// lock is still renewed by the attempt goroutine while it runs, and a
	// transition that times out leaves the job active for stalled recovery.
	transitionTimeout = 10 * time.Second
)

// queueSpec is one crawl queue worker. The legacy `crawl4ai` queue is the
// pre-hot/normal queue; its jobs are processed with the normal priority class
// (queueContexts() maps it to "normal").
type queueSpec struct {
	Name   string
	Class  crawlqueue.PriorityClass
	Legacy bool
}

// queueSpecs is the queue set, in NestJS declaration order: hot, normal, then
// the legacy queue (which is only started when it still holds work).
func queueSpecs() []queueSpec {
	return []queueSpec{
		{Name: crawlqueue.QueueHot, Class: crawlqueue.PriorityClassHot},
		{Name: crawlqueue.QueueNormal, Class: crawlqueue.PriorityClassNormal},
		{Name: crawlqueue.QueueLegacy, Class: crawlqueue.PriorityClassNormal, Legacy: true},
	}
}

// keys is the BullMQ queue key layout `<prefix>:<queue>:<suffix>`.
type keys struct {
	Queue       string
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

// newKeys builds the key set of one queue.
func newKeys(queue string) keys {
	base := prefix + ":" + queue + ":"
	key := func(suffix string) string { return base + suffix }
	return keys{
		Queue:       queue,
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

// Job returns the job hash key of one job id.
func (k keys) Job(id string) string { return k.Base + id }

// JobData is CrawlJobData as the worker reads it. The four optional members keep
// the NestJS `typeof value === "string"` semantics: a non-string reads as
// missing. Field names and semantics follow crawl.types.ts.
type JobData struct {
	TaskID                 string
	OrgID                  string
	SourceID               *string
	TriggeredByID          *string
	TraceID                string
	MemoryPressureRequeues int
	PriorityClass          string
	SourcePriority         *int
	JobKind                string
	FrontierNodeID         string
}

// jobDataJSON is the raw decode target; every member goes through the same
// typeof guards as the NestJS handler.
type jobDataJSON struct {
	TaskID                 json.RawMessage `json:"taskId"`
	OrgID                  json.RawMessage `json:"orgId"`
	SourceID               json.RawMessage `json:"sourceId"`
	TriggeredByID          json.RawMessage `json:"triggeredById"`
	TraceID                json.RawMessage `json:"traceId"`
	MemoryPressureRequeues json.RawMessage `json:"memoryPressureRequeues"`
	PriorityClass          json.RawMessage `json:"priorityClass"`
	SourcePriority         json.RawMessage `json:"sourcePriority"`
	JobKind                json.RawMessage `json:"jobKind"`
	FrontierNodeID         json.RawMessage `json:"frontierNodeId"`
}

// UnmarshalJSON decodes CrawlJobData with the NestJS type guards.
func (d *JobData) UnmarshalJSON(data []byte) error {
	var raw jobDataJSON
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	requeues, _ := jsonNumber(raw.MemoryPressureRequeues)
	d.TaskID = jsonString(raw.TaskID)
	d.OrgID = jsonString(raw.OrgID)
	d.SourceID = optionalJSONString(raw.SourceID)
	d.TriggeredByID = optionalJSONString(raw.TriggeredByID)
	d.TraceID = jsonString(raw.TraceID)
	d.MemoryPressureRequeues = nonNegativeInteger(requeues)
	d.PriorityClass = jsonString(raw.PriorityClass)
	d.SourcePriority = optionalJSONInt(raw.SourcePriority)
	d.JobKind = jsonString(raw.JobKind)
	d.FrontierNodeID = jsonString(raw.FrontierNodeID)
	return nil
}

// IsFrontierNode reports whether the job is executed by the Frontier processor:
// jobKind is frontier_node and frontierNodeId is a non-empty string.
func (d JobData) IsFrontierNode() bool {
	return d.JobKind == jobKindFrontierNode && d.FrontierNodeID != ""
}

// jobOptions is the typed view of the job hash `opts` JSON. Only the members the
// worker needs are decoded; the rest stay in the document.
type jobOptions struct {
	// Attempts is job.opts.attempts normalized to at least one. BullMQ treats an
	// absent value as a single attempt.
	Attempts int
	LIFO     bool
	// Backoff is the raw backoff option (number or {type,delay}); nil/absent
	// means no backoff.
	Backoff json.RawMessage
	// RemoveOnComplete and RemoveOnFail are the raw retention options.
	RemoveOnComplete json.RawMessage
	RemoveOnFail     json.RawMessage
}

// jobOptionsJSON is the raw decode target of the job options document.
type jobOptionsJSON struct {
	Attempts         json.RawMessage `json:"attempts"`
	LIFO             bool            `json:"lifo"`
	Backoff          json.RawMessage `json:"backoff"`
	RemoveOnComplete json.RawMessage `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage `json:"removeOnFail"`
}

// decodeJobOptions decodes the job options document.
func decodeJobOptions(raw []byte) (jobOptions, error) {
	var document jobOptionsJSON
	trimmed := strings.TrimSpace(string(raw))
	if trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
			return jobOptions{}, fmt.Errorf("crawlworker: decode job options: %w", err)
		}
	}
	options := jobOptions{
		Attempts:         1,
		LIFO:             document.LIFO,
		Backoff:          trimRawJSON(document.Backoff),
		RemoveOnComplete: trimRawJSON(document.RemoveOnComplete),
		RemoveOnFail:     trimRawJSON(document.RemoveOnFail),
	}
	if value, ok := jsonNumber(document.Attempts); ok {
		if attempts, valid := positiveInteger(value); valid {
			options.Attempts = attempts
		}
	}
	return options, nil
}

// trimRawJSON normalizes an absent JSON member to nil.
func trimRawJSON(raw json.RawMessage) json.RawMessage {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	return json.RawMessage(trimmed)
}

// keepJobs is BullMQ's removeOnComplete/removeOnFail value after getKeepJobs.
type keepJobs struct {
	Age   *int `json:"age,omitempty" msgpack:"age,omitempty"`
	Count *int `json:"count,omitempty" msgpack:"count,omitempty"`
}

// KeepOnComplete is getKeepJobs(job.opts.removeOnComplete): the job retention a
// successful finish stores. Without an option BullMQ keeps the job (count -1).
func KeepOnComplete(options jobOptions) keepJobs {
	if keep := decodeKeepJobs(options.RemoveOnComplete); keep != nil {
		return *keep
	}
	return keepJobs{Count: intPointer(-1)}
}

// KeepOnFail is getKeepJobs(job.opts.removeOnFail) for a terminal failure.
func KeepOnFail(options jobOptions) keepJobs {
	if keep := decodeKeepJobs(options.RemoveOnFail); keep != nil {
		return *keep
	}
	return keepJobs{Count: intPointer(-1)}
}

// decodeKeepJobs mirrors the boolean/number/object branches of getKeepJobs.
func decodeKeepJobs(raw json.RawMessage) *keepJobs {
	trimmed := strings.TrimSpace(string(raw))
	switch trimmed {
	case "", "null":
		return nil
	case "true":
		return &keepJobs{Count: intPointer(0)}
	case "false":
		return &keepJobs{Count: intPointer(-1)}
	}
	if count, ok := jsonInteger(raw); ok {
		return &keepJobs{Count: intPointer(count)}
	}
	if trimmed[0] != '{' {
		return nil
	}
	var keep keepJobs
	if err := json.Unmarshal([]byte(trimmed), &keep); err != nil {
		return nil
	}
	return &keep
}

func intPointer(value int) *int { return &value }

// claimedJob is one job moved to the active list. Token is the lock token this
// attempt owns; rawData is the exact JSON document stored in the job hash, which
// the memory pressure requeue rewrites in place.
type claimedJob struct {
	ID              string
	Name            string
	Token           string
	Data            JobData
	rawData         json.RawMessage
	Opts            jobOptions
	AttemptsMade    int
	AttemptsStarted int
	StalledCounter  int
	DeferredFailure string
	Priority        int
	Timestamp       int64
}

// Attempts returns the configured maximum attempts.
func (j claimedJob) Attempts() int { return resolveMaxAttempts(j.Opts.Attempts) }

// jobFromFlat decodes the flat HGETALL array moveToActive returns together with
// the job id it reports.
func jobFromFlat(flat []any, token, jobID string) (claimedJob, error) {
	if len(flat) == 0 {
		return claimedJob{}, errors.New("crawlworker: empty job hash")
	}
	fields := make(map[string]string, len(flat)/2)
	for index := 0; index+1 < len(flat); index += 2 {
		fields[toText(flat[index])] = toText(flat[index+1])
	}
	if jobID == "" {
		jobID = fields["id"]
	}
	rawData := json.RawMessage(fields["data"])
	var data JobData
	if err := json.Unmarshal(rawData, &data); err != nil {
		return claimedJob{}, fmt.Errorf("crawlworker: decode job data: %w", err)
	}
	options, err := decodeJobOptions([]byte(fields["opts"]))
	if err != nil {
		return claimedJob{}, err
	}
	priority := 0
	if value, ok := jsonNumber(json.RawMessage(strings.TrimSpace(fields["priority"]))); ok {
		priority = jsRound(value)
	}
	return claimedJob{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		Data:            data,
		rawData:         rawData,
		Opts:            options,
		AttemptsMade:    int(toInt64(fields["atm"])),
		AttemptsStarted: int(toInt64(fields["ats"])),
		StalledCounter:  int(toInt64(fields["stc"])),
		DeferredFailure: fields["defa"],
		Priority:        priority,
		Timestamp:       toInt64(fields["timestamp"]),
	}, nil
}

// tokenSource produces a unique BullMQ lock token per claimed job. BullMQ uses a
// 32 bit random worker id plus a monotonic counter; the prefix keeps the tokens
// of this process recognizable in logs.
type tokenSource struct {
	id      string
	counter atomic.Uint64
}

// newTokenSource builds the token source.
func newTokenSource() *tokenSource {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return &tokenSource{id: "crawl-worker-go"}
	}
	return &tokenSource{id: "crawl-worker-go-" + hex.EncodeToString(buffer[:])}
}

// Next returns the next token.
func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// limiterOptions is the msgpack `limiter` member of moveToActive/moveToFinished.
type limiterOptions struct {
	Max      int64 `msgpack:"max"`
	Duration int64 `msgpack:"duration"`
}

// moveToActiveOptions is the msgpack object moveToActive expects. `name` is
// omitted like the nameless NestJS worker (BullMQ packs undefined as nil, and
// the Lua only tests truthiness).
type moveToActiveOptions struct {
	Token        string         `msgpack:"token"`
	LockDuration int64          `msgpack:"lockDuration"`
	Limiter      limiterOptions `msgpack:"limiter"`
	Name         string         `msgpack:"name,omitempty"`
}

// finishOptions is the msgpack object moveToFinished expects. The members
// mirror Scripts.moveToFinishedArgs; maxMetricsSize must be the empty string
// (BullMQ sends "" when metrics are disabled) or the Lua would collect metrics
// with a nil bound.
type finishOptions struct {
	Token          string         `msgpack:"token"`
	Name           string         `msgpack:"name,omitempty"`
	KeepJobs       keepJobs       `msgpack:"keepJobs"`
	Limiter        limiterOptions `msgpack:"limiter"`
	LockDuration   int64          `msgpack:"lockDuration"`
	Attempts       int            `msgpack:"attempts"`
	MaxMetricsSize string         `msgpack:"maxMetricsSize"`
	FPOF           bool           `msgpack:"fpof"`
	CPOF           bool           `msgpack:"cpof"`
	IDOF           bool           `msgpack:"idof"`
	RDOF           bool           `msgpack:"rdof"`
}

// pack encodes one MessagePack argument list.
func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("crawlworker: pack msgpack: %w", err)
	}
	return encoded, nil
}

// stacktraceJSON is the JSON-array string BullMQ stores in the job hash
// `stacktrace` field. Go has no JavaScript stack, so the redacted error text is
// the stable equivalent (same shape the itempipeline worker writes).
func stacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

// jobFailureFields are the job hash fields a failed attempt updates through the
// ARGV "fields to update" slot of retryJob/moveToDelayed/moveToFinished.
type jobFailureFields struct {
	Reason     string
	StackTrace string
}

// pack encodes the flat [key,value,...] array the Lua updateJobFields unpacks.
func (f jobFailureFields) pack() ([]byte, error) {
	return pack([]any{
		"failedReason", f.Reason,
		"stacktrace", f.StackTrace,
	})
}

// newFailureFields builds the failure fields of one attempt.
func newFailureFields(reason string) jobFailureFields {
	return jobFailureFields{Reason: reason, StackTrace: stacktraceJSON(reason)}
}

// toText converts a Redis reply element to text. It is driver-boundary
// normalization (bulk strings, integers), not business data.
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

// toInt64 converts a Redis reply element to int64.
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

// toTextSlice converts a Redis array reply of job ids.
func toTextSlice(value any) []string {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return nil
	}
	ids := make([]string, 0, len(values))
	for _, entry := range values {
		text := toText(entry)
		if text != "" {
			ids = append(ids, text)
		}
	}
	return ids
}

// parseWorkerConcurrencyMessage validates the C2 broadcast payload
// {"version":1,"maxConcurrency":N}. The rules are the NestJS
// parseWorkerConcurrencyMessage checks: a JSON object, version strictly the
// number 1, and maxConcurrency an integer JSON number in [1,20]. Anything else
// reports the matching rejection so the caller can warn and ignore it.
func parseWorkerConcurrencyMessage(message string) (int, error) {
	trimmed := strings.TrimSpace(message)
	var parsed json.RawMessage
	if err := json.Unmarshal([]byte(message), &parsed); err != nil {
		return 0, errInvalidJSONMessage
	}
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return 0, errNotObjectMessage
	}
	var record struct {
		Version        json.RawMessage `json:"version"`
		MaxConcurrency json.RawMessage `json:"maxConcurrency"`
	}
	if err := json.Unmarshal([]byte(trimmed), &record); err != nil {
		return 0, errNotObjectMessage
	}
	version, ok := jsonInteger(record.Version)
	if !ok || version != 1 {
		return 0, errUnsupportedPayloadMessage
	}
	concurrency, ok := jsonInteger(record.MaxConcurrency)
	if !ok || concurrency < 1 || concurrency > maxCrawlConcurrency {
		return 0, errUnsupportedPayloadMessage
	}
	return concurrency, nil
}
