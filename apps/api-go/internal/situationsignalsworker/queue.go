package situationsignalsworker

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	mrand "math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// The worker uses BullMQ's Worker defaults; the NestJS processor only overrides
// concurrency (1). See apps/api/src/modules/situation-monitor/signals/
// situation-monitor-signals.processor.ts.
const (
	workerConcurrency       = 1
	lockDuration            = 30 * time.Second
	lockRenewTime           = 15 * time.Second
	stalledInterval         = 30 * time.Second
	maxStalledCount         = 1
	drainDelay              = 5 * time.Second
	pausedQueuePollInterval = 250 * time.Millisecond
	fetchErrorRetryInterval = time.Second
	finishTimeout           = 10 * time.Second
	// shutdownGrace bounds the graceful drain: the process-level shutdown budget
	// is 30s and several components share it. A poll still running when the
	// grace expires is cancelled and left in the active list, where BullMQ
	// stalled recovery hands it to the next owner after the lock expires.
	shutdownGrace       = 15 * time.Second
	shutdownCancelGrace = 5 * time.Second
)

// logPrefix keeps every queue-layer log line attributable to this package.
const logPrefix = "situationsignalsworker: "

// queueScripts holds the BullMQ commands of the worker and of the producers
// EnsureRepeatables uses. They are the shared copies in internal/bullmq; this
// package no longer vendors its own.
type queueScripts struct {
	addStandardJob        *redis.Script
	addDelayedJob         *redis.Script
	addRepeatableJob      *redis.Script
	moveToActive          *redis.Script
	moveToFinished        *redis.Script
	moveToDelayed         *redis.Script
	extendLock            *redis.Script
	moveStalledJobsToWait *redis.Script
	retryJob              *redis.Script
	updateJobScheduler    *redis.Script
}

func loadQueueScripts() (queueScripts, error) {
	return queueScripts{
		addStandardJob:        bullmq.ScriptAddStandardJob,
		addDelayedJob:         bullmq.ScriptAddDelayedJob,
		addRepeatableJob:      bullmq.ScriptAddRepeatableJob,
		moveToActive:          bullmq.ScriptMoveToActive,
		moveToFinished:        bullmq.ScriptMoveToFinished,
		moveToDelayed:         bullmq.ScriptMoveToDelayed,
		extendLock:            bullmq.ScriptExtendLock,
		moveStalledJobsToWait: bullmq.ScriptMoveStalledJobsToWait,
		retryJob:              bullmq.ScriptRetryJob,
		updateJobScheduler:    bullmq.ScriptUpdateJobScheduler,
	}, nil
}

// queueKeys is BullMQ's key layout for one queue: <prefix>:<queue>:<suffix>.
type queueKeys struct {
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
	Repeat      string
}

// newQueueKeys builds the key set used by both NestJS and this package.
func newQueueKeys(prefix, queueName string) queueKeys {
	if prefix == "" {
		prefix = QueuePrefix
	}
	base := prefix + ":" + queueName + ":"
	key := func(suffix string) string { return base + suffix }
	return queueKeys{
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
		Repeat:      key("repeat"),
	}
}

// jobKey returns the hash key of one job id.
func (k queueKeys) jobKey(id string) string { return k.Base + id }

// queueKeepJobs mirrors BullMQ's removeOnComplete/removeOnFail value.
type queueKeepJobs struct {
	Age   *int64 `json:"age"`
	Count *int64 `json:"count"`
}

// queueBackoffOptions is opts.backoff.
type queueBackoffOptions struct {
	Type   string   `json:"type"`
	Delay  *float64 `json:"delay"`
	Jitter *float64 `json:"jitter"`
}

// queueRepeatOptions is opts.repeat for the every-based schedules this queue
// uses (the Telegram JobScheduler and the legacy Oref repeat).
type queueRepeatOptions struct {
	Every     *int64 `json:"every"`
	JobID     string `json:"jobId"`
	Count     *int64 `json:"count"`
	Offset    *int64 `json:"offset"`
	Pattern   string `json:"pattern"`
	Limit     *int64 `json:"limit"`
	TZ        string `json:"tz"`
	StartDate *int64 `json:"startDate"`
	EndDate   *int64 `json:"endDate"`
}

// queueJobOptions is the typed view of the job hash `opts` JSON. Queue.add
// merges the queue defaultJobOptions {removeOnComplete, removeOnFail, attempts,
// backoff} with the caller options, and repeat iterations add
// jobId/delay/timestamp/prevMillis/repeatJobKey/repeat.
type queueJobOptions struct {
	Attempts         *int                 `json:"attempts"`
	Backoff          *queueBackoffOptions `json:"backoff"`
	RemoveOnComplete json.RawMessage      `json:"removeOnComplete"`
	RemoveOnFail     json.RawMessage      `json:"removeOnFail"`
	JobID            string               `json:"jobId"`
	Delay            *float64             `json:"delay"`
	Timestamp        *int64               `json:"timestamp"`
	PrevMillis       *int64               `json:"prevMillis"`
	Repeat           *queueRepeatOptions  `json:"repeat"`
	LIFO             bool                 `json:"lifo"`
	Priority         *int                 `json:"priority"`
}

// queuedJob is one job claimed from the queue. Data is the raw JSON payload the
// producer stored; the poll source is resolved from it.
type queuedJob struct {
	ID              string
	Name            string
	Token           string
	Data            json.RawMessage
	Opts            queueJobOptions
	RepeatJobKey    string
	AttemptsMade    int
	AttemptsStarted int
	StalledCounter  int
	DeferredFailure string
	Timestamp       int64
	ProcessedOn     int64
}

// attempts reports the configured maximum attempts. BullMQ stores
// `attempts: 0` for a job that did not set the option, which behaves like one.
func (j queuedJob) attempts() int {
	if j.Opts.Attempts == nil || *j.Opts.Attempts < 1 {
		return 1
	}
	return *j.Opts.Attempts
}

// finalFailure reports whether this execution is the last one BullMQ would run:
// `attemptsMade + 1 >= attempts`. A deferred failure (job stalled too often) is
// always final.
func (j queuedJob) finalFailure() bool {
	if j.DeferredFailure != "" {
		return true
	}
	return j.AttemptsMade+1 >= j.attempts()
}

// keepOnComplete mirrors Scripts.getKeepJobs for a successful finish: a job
// without removeOnComplete is kept by the BullMQ worker (count -1) instead of
// being removed.
func (j queuedJob) keepOnComplete() queueKeepJobs {
	if keep, ok := decodeQueueKeepJobs(j.Opts.RemoveOnComplete); ok {
		return keep
	}
	return queueKeepJobs{Count: queueInt64(-1)}
}

// keepOnFail mirrors Scripts.getKeepJobs for a terminal failure.
func (j queuedJob) keepOnFail() queueKeepJobs {
	if keep, ok := decodeQueueKeepJobs(j.Opts.RemoveOnFail); ok {
		return keep
	}
	return queueKeepJobs{Count: queueInt64(-1)}
}

// decodeQueueKeepJobs accepts BullMQ's three shapes: a boolean, a number or
// {age, count}.
func decodeQueueKeepJobs(raw json.RawMessage) (queueKeepJobs, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return queueKeepJobs{}, false
	}
	switch trimmed {
	case "true":
		return queueKeepJobs{Count: queueInt64(0)}, true
	case "false":
		return queueKeepJobs{Count: queueInt64(-1)}, true
	}
	if !strings.HasPrefix(trimmed, "{") {
		var count int64
		if err := json.Unmarshal([]byte(trimmed), &count); err != nil {
			return queueKeepJobs{}, false
		}
		return queueKeepJobs{Count: &count}, true
	}
	var keep queueKeepJobs
	if err := json.Unmarshal([]byte(trimmed), &keep); err != nil {
		return queueKeepJobs{}, false
	}
	return keep, true
}

func queueInt64(value int64) *int64 { return &value }

// queueRawOption decodes an arbitrary JSON option value so it can be packed
// back into MessagePack untouched (booleans, numbers and {age, count} objects).
func queueRawOption(raw json.RawMessage) (any, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, false
	}
	var value any
	if err := json.Unmarshal([]byte(trimmed), &value); err != nil {
		return nil, false
	}
	return value, true
}

// queueTokenSource produces a unique BullMQ lock token per claimed job.
type queueTokenSource struct {
	id      string
	counter atomic.Uint64
}

func newQueueTokenSource() *queueTokenSource {
	var buf [12]byte
	if _, err := crand.Read(buf[:]); err != nil {
		return &queueTokenSource{id: "situationsignals-go"}
	}
	return &queueTokenSource{id: "situationsignals-go-" + hex.EncodeToString(buf[:])}
}

func (t *queueTokenSource) next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// queuePack MessagePacks a protocol payload. The BullMQ scripts decode these
// with cmsgpack, so the value shapes must round-trip (maps, arrays, strings,
// numbers, booleans and nil).
func queuePack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("situationsignalsworker: pack MessagePack payload: %w", err)
	}
	return encoded, nil
}

// queueToText flattens one Redis reply element (HGETALL returns flat
// [field, value, ...] arrays).
func queueToText(value any) string {
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

// queueToInt64 decodes a Redis integer reply element.
func queueToInt64(value any) int64 {
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

// queueNegativeCode reports a BullMQ negative script result, which the
// JavaScript client turns into a finishedErrors throw. Non-numeric results are
// treated as 0 (OK).
func queueNegativeCode(result any) int64 {
	switch typed := result.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}

// queueStacktraceJSON is the JSON-array string BullMQ stores for a failure. Go
// has no JavaScript stack, so the error text is the stable equivalent.
func queueStacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

// queueFailureFields is the flat MessagePack array moveToFinished/moveToDelayed/
// retryJob accept as their optional job-field update.
func queueFailureFields(reason string) []any {
	return []any{"failedReason", reason, "stacktrace", queueStacktraceJSON(reason)}
}

// queueSleep sleeps for duration or until ctx is done. It reports whether the
// sleep completed (false means the context was canceled).
func queueSleep(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// QueueWorker consumes the situationMonitorSignals BullMQ queue on the shared
// bullmq.Worker state machine (concurrency 1, BullMQ Worker defaults). The loop,
// lock renewal, finish, retry and stalled recovery live in internal/bullmq; this
// type keeps only the queue wiring, the repeat rescheduling hook and the retry
// backoff table the queue configures.
type QueueWorker struct {
	client   *redis.Client
	blocking *redis.Client
	keys     queueKeys
	scripts  queueScripts
	now      func() time.Time

	mu        sync.Mutex
	started   bool
	closed    bool
	inner     *bullmq.Worker
	closeOnce sync.Once
}

// NewQueueWorker wires the consumer to the shared Redis client and opens the
// dedicated blocking connection. It does not claim a job: Run does.
func NewQueueWorker(client *redis.Client) (*QueueWorker, error) {
	if client == nil {
		return nil, errors.New("situationsignalsworker: queue worker requires a redis client")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	blocking, err := newBlockingClient(client)
	if err != nil {
		return nil, err
	}
	return &QueueWorker{
		client:   client,
		blocking: blocking,
		keys:     newQueueKeys(QueuePrefix, QueueName),
		scripts:  scripts,
		now:      time.Now,
	}, nil
}

// newBlockingClient derives a dedicated blocking connection from the shared
// client's options, mirroring BullmqConnectionService.createDedicatedConnectionOptions:
// a connection blocked on BZPOPMIN cannot be used for regular commands, so it
// must not come from the shared pool.
func newBlockingClient(shared *redis.Client) (*redis.Client, error) {
	options := shared.Options()
	if options == nil {
		return nil, errors.New("situationsignalsworker: shared redis client has no options")
	}
	dedicated := *options
	dedicated.PoolSize = 1
	dedicated.MinIdleConns = 0
	return redis.NewClient(&dedicated), nil
}

// Run claims and processes jobs until ctx is canceled, then drains the in-flight
// job and returns. Run must be called at most once per worker.
func (w *QueueWorker) Run(ctx context.Context, process func(ctx context.Context, source PollSource) error) {
	if w == nil {
		return
	}
	if process == nil {
		log.Print(logPrefix + "queue worker requires a processor")
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	w.mu.Lock()
	if w.started || w.closed {
		w.mu.Unlock()
		log.Print(logPrefix + "queue worker is already started or closed")
		return
	}
	w.started = true
	w.mu.Unlock()

	inner, err := bullmq.NewWorker(w.client, w.blocking, QueueName, w.processor(process), bullmq.WorkerOptions{
		Prefix:          QueuePrefix,
		Concurrency:     workerConcurrency,
		LockDuration:    lockDuration,
		LockRenewTime:   lockRenewTime,
		StalledInterval: stalledInterval,
		MaxStalledCount: maxStalledCount,
		DrainDelay:      drainDelay,
		Stacktrace:      queueStacktraceJSON,
		FailurePolicy:   w.failurePolicy(),
	})
	if err != nil {
		log.Printf(logPrefix+"build worker: %v", err)
		return
	}

	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		closeCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		_ = inner.Close(closeCtx)
		cancel()
		return
	}
	w.inner = inner
	w.mu.Unlock()

	if err := inner.Start(ctx); err != nil {
		log.Printf(logPrefix+"worker start: %v", err)
	}
	<-ctx.Done()
	closeCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := inner.Close(closeCtx); err != nil {
		log.Printf(logPrefix+"worker close: %v", err)
	}
}

// Close stops the consumer, releases the in-flight job deadline and closes the
// dedicated blocking connection. It is idempotent and safe before or after Run.
func (w *QueueWorker) Close() {
	if w == nil {
		return
	}
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closed = true
		inner := w.inner
		w.mu.Unlock()
		if inner != nil {
			closeCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
			defer cancel()
			if err := inner.Close(closeCtx); err != nil {
				log.Printf(logPrefix+"close worker: %v", err)
			}
			return
		}
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil && !errors.Is(err, redis.ErrClosed) {
				log.Printf(logPrefix+"close blocking redis client: %v", err)
			}
		}
	})
}

// processor adapts the business handler into a bullmq.Processor: it reschedules
// the next repeat iteration first (Worker.nextJobFromJobData), resolves the poll
// source, and runs the handler. A failed repeat reschedule leaves the job active
// for stalled recovery instead of processing it.
func (w *QueueWorker) processor(process func(ctx context.Context, source PollSource) error) bullmq.Processor {
	return func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		claimed := queuedJobFromBullmq(job)
		if err := w.rescheduleRepeat(ctx, claimed); err != nil {
			log.Printf(logPrefix+"reschedule repeat for job %s: %v", job.ID, err)
			return nil, bullmq.Handled(nil)
		}
		source, ok := queueJobSource(claimed)
		if !ok {
			log.Printf(logPrefix+"job %s (%s) carries no poll source; completing without work", job.ID, job.Name)
			return nil, nil
		}
		if err := process(ctx, source); err != nil {
			// An unknown backoff strategy is a configuration error in BullMQ; the
			// original worker left the job active for stalled recovery rather than
			// failing it. Only a final attempt still fails.
			if !claimed.finalFailure() {
				if _, ok := w.retryDelay(claimed); !ok {
					log.Printf(logPrefix+"unknown backoff strategy for job %s; leaving it active", job.ID)
					return nil, bullmq.Handled(nil)
				}
			}
			return nil, err
		}
		return nil, nil
	}
}

// failurePolicy reproduces retryDelay (fixed/exponential with optional jitter)
// for the shared worker's retry decision.
func (w *QueueWorker) failurePolicy() bullmq.FailurePolicy {
	return func(job *bullmq.Job, err error) bullmq.FailureDecision {
		var unrecoverable *bullmq.UnrecoverableError
		if errors.As(err, &unrecoverable) {
			return bullmq.FailureDecision{Final: true, Permanent: true}
		}
		if job.FinalFailure() {
			return bullmq.FailureDecision{Final: true}
		}
		delay, ok := w.retryDelay(queuedJobFromBullmq(job))
		if !ok {
			return bullmq.FailureDecision{Final: true}
		}
		return bullmq.FailureDecision{Final: false, DelayMillis: delay}
	}
}

// queuedJobFromBullmq adapts the shared job into the business job view.
func queuedJobFromBullmq(job *bullmq.Job) queuedJob {
	if job == nil {
		return queuedJob{}
	}
	adapted := queuedJob{
		ID:              job.ID,
		Name:            job.Name,
		Token:           job.Token,
		Data:            job.Data,
		RepeatJobKey:    job.RepeatJobKey,
		AttemptsMade:    int(job.AttemptsMade),
		AttemptsStarted: int(job.AttemptsStarted),
		StalledCounter:  int(job.StalledCount),
		DeferredFailure: job.DeferredFailure,
		Timestamp:       job.Timestamp,
	}
	if job.ProcessedOn != nil {
		adapted.ProcessedOn = *job.ProcessedOn
	}
	if len(job.Opts) > 0 {
		_ = json.Unmarshal(job.Opts, &adapted.Opts)
	}
	return adapted
}

// queueQueuedJobFromFlat decodes the flat HGETALL array moveToActive returns.
func queueQueuedJobFromFlat(flat []any, token, jobID string) (queuedJob, error) {
	if len(flat) == 0 {
		return queuedJob{}, errors.New("situationsignalsworker: empty job data")
	}
	fields := make(map[string]string, len(flat)/2)
	for index := 0; index+1 < len(flat); index += 2 {
		fields[queueToText(flat[index])] = queueToText(flat[index+1])
	}
	if jobID == "" {
		jobID = fields["id"]
	}
	job := queuedJob{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		RepeatJobKey:    fields["rjk"],
		AttemptsMade:    int(queueToInt64(fields["atm"])),
		AttemptsStarted: int(queueToInt64(fields["ats"])),
		StalledCounter:  int(queueToInt64(fields["stc"])),
		DeferredFailure: fields["defa"],
		Timestamp:       queueToInt64(fields["timestamp"]),
		ProcessedOn:     queueToInt64(fields["processedOn"]),
	}
	if job.AttemptsMade == 0 {
		// Older payloads used attemptsMade instead of the compressed atm.
		job.AttemptsMade = int(queueToInt64(fields["attemptsMade"]))
	}
	if raw := fields["data"]; raw != "" {
		job.Data = json.RawMessage(raw)
	}
	if raw := strings.TrimSpace(fields["opts"]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &job.Opts); err != nil {
			return queuedJob{}, fmt.Errorf("situationsignalsworker: decode job opts: %w", err)
		}
	}
	return job, nil
}

// queueJobSource decodes data.source and falls back to the job name prefix.
// A payload that is not valid JSON is treated like BullMQ's undefined
// job.data.source: the name prefix still decides.
func queueJobSource(job queuedJob) (PollSource, bool) {
	var payload pollJobData
	if len(job.Data) > 0 {
		if err := json.Unmarshal(job.Data, &payload); err != nil {
			log.Printf(logPrefix+"job %s has invalid data: %v", job.ID, err)
		}
	}
	return ResolveSource(string(payload.Source), job.Name)
}

// renewLock extends the job lock every lockDuration/2. A failed renewal or a
// lock owned by another token cancels the handler, so the attempt stops and

func (w *QueueWorker) retryDelay(job queuedJob) (int64, bool) {
	backoff := job.Opts.Backoff
	if backoff == nil {
		// Without a backoff strategy BullMQ retries immediately.
		return 0, true
	}
	attempt := float64(job.AttemptsMade + 1)
	base := 0.0
	if backoff.Delay != nil {
		base = *backoff.Delay
	}
	jitter := 0.0
	if backoff.Jitter != nil {
		jitter = *backoff.Jitter
	}
	switch backoff.Type {
	case "fixed":
		if jitter > 0 {
			minDelay := base * (1 - jitter)
			return int64(math.Floor(mrand.Float64()*base*jitter + minDelay)), true
		}
		return int64(base), true
	case "exponential":
		maxDelay := math.Round(math.Pow(2, attempt-1) * base)
		if jitter > 0 {
			minDelay := maxDelay * (1 - jitter)
			return int64(math.Floor(mrand.Float64()*maxDelay*jitter + minDelay)), true
		}
		return int64(maxDelay), true
	default:
		return 0, false
	}
}

// queueFinishOptions is the MessagePack object moveToFinished expects. NestJS
// sends the queue's (not the worker's) name/limiter/lockDuration, which this
// queue never sets, so those slots stay nil; maxMetricsSize is the empty string
// because metrics are disabled. fetchNext is 0, so the lockDuration slot is
// never read.
func queueFinishOptions(job queuedJob, token string, keep queueKeepJobs) map[string]any {
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

func (w *QueueWorker) rescheduleRepeat(ctx context.Context, job queuedJob) error {
	if job.RepeatJobKey == "" || job.Opts.Repeat == nil {
		return nil
	}
	if strings.Count(job.RepeatJobKey, ":")+1 >= 5 {
		log.Printf(logPrefix+"legacy repeat key %s for job %s is not rescheduled", job.RepeatJobKey, job.ID)
		return nil
	}
	if job.Opts.Repeat.Every == nil || *job.Opts.Repeat.Every <= 0 {
		log.Printf(logPrefix+"repeat job %s has no every interval; not rescheduled", job.ID)
		return nil
	}
	now := w.now()
	// JobScheduler.upsertJobScheduler stops iterating past opts.repeat.limit or
	// opts.repeat.endDate.
	if job.Opts.Repeat.Limit != nil && iterationCount(job.Opts.Repeat) > *job.Opts.Repeat.Limit {
		return nil
	}
	if job.Opts.Repeat.EndDate != nil && now.UnixMilli() > *job.Opts.Repeat.EndDate {
		return nil
	}
	encodedOpts, err := queuePack(queueNextRepeatOptions(job, now))
	if err != nil {
		return err
	}
	templateData := job.Data
	if len(templateData) == 0 || !json.Valid(templateData) {
		templateData = []byte("{}")
	} else {
		// JSON.stringify re-serializes without whitespace; the script stores this
		// string as the scheduler template, so keep the same byte shape.
		var compacted bytes.Buffer
		if err := json.Compact(&compacted, templateData); err == nil {
			templateData = compacted.Bytes()
		}
	}
	// The script returns the id of the next delayed job or nil; only the error
	// matters here because the next iteration is not processed by this call.
	if _, err := w.scripts.updateJobScheduler.Run(ctx, w.client,
		[]string{
			w.keys.Repeat,
			w.keys.Delayed,
			w.keys.Wait,
			w.keys.Paused,
			w.keys.Meta,
			w.keys.Prioritized,
			w.keys.Marker,
			w.keys.ID,
			w.keys.Events,
			w.keys.PC,
			w.keys.jobKey(job.ID),
			w.keys.Active,
		},
		// nextMillis stays empty: for an every schedule the script computes it
		// from the repeat hash (getJobSchedulerEveryNextMillis).
		"",
		job.RepeatJobKey,
		string(templateData),
		encodedOpts,
		now.UnixMilli(),
		w.keys.Base,
		job.ID,
	).Result(); err != nil {
		return fmt.Errorf("situationsignalsworker: update job scheduler %s: %w", job.RepeatJobKey, err)
	}
	return nil
}

// iterationCount is Repeat.updateRepeatableJob's `repeat.count + 1`, i.e. the
// 1-based number of the iteration being scheduled.
func iterationCount(repeat *queueRepeatOptions) int64 {
	if repeat == nil || repeat.Count == nil {
		return 1
	}
	return *repeat.Count + 1
}

// queueNextRepeatOptions rebuilds the next iteration's options the way
// JobScheduler.upsertJobScheduler does for the {override: false} branch:
// `{...job.opts, jobId, delay, timestamp, prevMillis, repeat: {...repeat,
// offset: null, count: iterationCount}}` and then Job.optsAsJSON. The script
// overwrites jobId/delay/prevMillis/timestamp, but keeping the same shape means
// the packed payload carries the same fields BullMQ writes (attempts, backoff,
// retention, repeat template).
func queueNextRepeatOptions(job queuedJob, now time.Time) map[string]any {
	repeat := job.Opts.Repeat
	count := iterationCount(repeat)
	iteration := map[string]any{
		"every":     *repeat.Every,
		"offset":    nil,
		"count":     count,
		"startDate": nil,
		"endDate":   nil,
	}
	if repeat.StartDate != nil {
		iteration["startDate"] = *repeat.StartDate
	}
	if repeat.EndDate != nil {
		iteration["endDate"] = *repeat.EndDate
	}
	if repeat.JobID != "" {
		iteration["jobId"] = repeat.JobID
	}
	if repeat.Pattern != "" {
		iteration["pattern"] = repeat.Pattern
	}
	if repeat.TZ != "" {
		iteration["tz"] = repeat.TZ
	}
	if repeat.Limit != nil {
		iteration["limit"] = *repeat.Limit
	}
	attempts := 0
	if job.Opts.Attempts != nil {
		attempts = *job.Opts.Attempts
	}
	options := map[string]any{
		"jobId":        "repeat:" + job.RepeatJobKey + ":undefined",
		"delay":        math.NaN(),
		"timestamp":    now.UnixMilli(),
		"repeatJobKey": job.RepeatJobKey,
		"repeat":       iteration,
		"attempts":     attempts,
	}
	if job.Opts.Backoff != nil {
		backoff := map[string]any{"type": job.Opts.Backoff.Type}
		if job.Opts.Backoff.Delay != nil {
			backoff["delay"] = *job.Opts.Backoff.Delay
		}
		if job.Opts.Backoff.Jitter != nil {
			backoff["jitter"] = *job.Opts.Backoff.Jitter
		}
		options["backoff"] = backoff
	}
	if value, ok := queueRawOption(job.Opts.RemoveOnComplete); ok {
		options["removeOnComplete"] = value
	}
	if value, ok := queueRawOption(job.Opts.RemoveOnFail); ok {
		options["removeOnFail"] = value
	}
	if job.Opts.LIFO {
		options["lifo"] = true
	}
	if job.Opts.Priority != nil {
		options["priority"] = *job.Opts.Priority
	}
	return options
}
