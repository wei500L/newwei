package situationsignalsworker

import (
	"bytes"
	"context"
	crand "crypto/rand"
	"crypto/sha256"
	"embed"
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
	shutdownGrace           = 30 * time.Second
	shutdownCancelGrace     = 5 * time.Second
)

// logPrefix keeps every queue-layer log line attributable to this package.
const logPrefix = "situationsignalsworker: "

// The embedded files are the official BullMQ 5.63.2 commands expanded exactly
// as the npm package ships them. See scripts/NOTICE.md for version, source,
// license and SHA-256 digests. No script is downloaded at runtime.
//
//go:embed scripts/*.lua
var scriptFiles embed.FS

// scriptDigests pins the vendored bytes so an accidental edit (or a partial
// vendoring) fails the unit test instead of silently changing the shared
// bull:situationMonitorSignals:* state machine.
var scriptDigests = map[string]string{
	"addStandardJob-9.lua":        "9e2e57d86565bcc3d16634449c11d52317299ab9895a19ca50e6619164da675e",
	"addDelayedJob-6.lua":         "b2994e8e08c9d6c140978d0b3ac2b6d965c005d8dfb006b1e5cb85b06fdb9cfb",
	"addRepeatableJob-2.lua":      "53249b4e9adc4934ac2ee99bf946832f5a2623dfbe26e73de54465d86dc53470",
	"moveToActive-11.lua":         "ee4a8eb48cad650aec886580e128418d44582f68b5202a11dcac48bb3dcae117",
	"moveToFinished-14.lua":       "572920a790ad025386a2b9355de086c1c4ca6658fc15ace7d2c4932365c8c0b3",
	"moveToDelayed-8.lua":         "3140607f9078063c1cd35f984ad4fec26f49240aa037fb0c9f787c50b17660a7",
	"extendLock-2.lua":            "f3c0b3f993871533eabfc85f5fbfc9b1dcb7e1b230c9305e23fc96365f96a1f2",
	"moveStalledJobsToWait-8.lua": "c77949cefb61af6b82ee423625aa8a9b90d9ec8a0691af0e8609dbb4775ca27e",
	"retryJob-11.lua":             "5c98c7eae068e06d53dd55d468e397fa73e173697519d1ea8857172e8faa4abe",
	"updateJobScheduler-12.lua":   "09bc293d2ccf3cc493c12d59b39b43e449ced9b640d7693fe5f294316423a562",
}

// queueScripts holds the loaded Lua commands of the BullMQ 5.63.2 worker and
// the producers EnsureRepeatables uses.
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
	load := func(name string) (*redis.Script, error) {
		content, err := scriptFiles.ReadFile("scripts/" + name)
		if err != nil {
			return nil, fmt.Errorf("situationsignalsworker: read embedded script %s: %w", name, err)
		}
		if len(content) == 0 {
			return nil, fmt.Errorf("situationsignalsworker: embedded script %s is empty", name)
		}
		return redis.NewScript(string(content)), nil
	}
	var scripts queueScripts
	var err error
	if scripts.addStandardJob, err = load("addStandardJob-9.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.addDelayedJob, err = load("addDelayedJob-6.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.addRepeatableJob, err = load("addRepeatableJob-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToActive, err = load("moveToActive-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToFinished, err = load("moveToFinished-14.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveToDelayed, err = load("moveToDelayed-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.extendLock, err = load("extendLock-2.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.moveStalledJobsToWait, err = load("moveStalledJobsToWait-8.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.retryJob, err = load("retryJob-11.lua"); err != nil {
		return queueScripts{}, err
	}
	if scripts.updateJobScheduler, err = load("updateJobScheduler-12.lua"); err != nil {
		return queueScripts{}, err
	}
	return scripts, nil
}

// scriptSHA256 is used by the digest test.
func scriptSHA256(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
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

// QueueWorker consumes the situationMonitorSignals BullMQ queue with the
// official BullMQ 5.63.2 state machine and concurrency 1, exactly like the
// NestJS processor it replaces.
//
// It owns a dedicated blocking Redis connection for the marker wait and uses
// the shared client for every other command; the caller keeps ownership of the
// shared client. Run blocks until its context is canceled and then drains the
// in-flight job. Close releases the blocking connection and is idempotent.
type QueueWorker struct {
	client   *redis.Client
	blocking *redis.Client
	keys     queueKeys
	scripts  queueScripts
	tokens   *queueTokenSource
	now      func() time.Time

	mu          sync.Mutex
	started     bool
	closing     bool
	process     func(ctx context.Context, source PollSource) error
	fetchCtx    context.Context
	cancelFetch context.CancelFunc
	jobCtx      context.Context
	cancelJobs  context.CancelFunc
	fetchDone   chan struct{}
	stalledDone chan struct{}
	closed      chan struct{}
	wg          sync.WaitGroup
	slots       chan struct{}
	closeOnce   sync.Once
}

// NewQueueWorker wires the consumer to the shared Redis client and loads the
// vendored Lua scripts. It does not open a connection or claim a job: Run does.
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
		tokens:   newQueueTokenSource(),
		now:      time.Now,
		closed:   make(chan struct{}),
		slots:    make(chan struct{}, workerConcurrency),
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
// job and returns. Failures of the processor are logged and reported to BullMQ
// (which retries per the job options); they never stop the loop.
//
// Run must be called at most once per worker.
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
	if !w.begin(process) {
		return
	}
	select {
	case <-ctx.Done():
	case <-w.closed:
	}
	w.shutdown()
}

// Close stops the consumer, releases the in-flight job deadline, closes the
// dedicated blocking connection and unblocks Run. It is idempotent and safe to
// call before or after Run returns.
func (w *QueueWorker) Close() {
	if w == nil {
		return
	}
	w.shutdown()
}

// begin starts the fetch and stalled loops. It reports false when the worker
// was already started or already closed.
func (w *QueueWorker) begin(process func(ctx context.Context, source PollSource) error) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.started || w.closing {
		log.Print(logPrefix + "queue worker is already started or closed")
		return false
	}
	w.started = true
	w.process = process
	w.fetchCtx, w.cancelFetch = context.WithCancel(context.Background())
	w.jobCtx, w.cancelJobs = context.WithCancel(context.Background())
	w.fetchDone = make(chan struct{})
	w.stalledDone = make(chan struct{})
	go func() {
		defer close(w.stalledDone)
		w.stalledLoop(w.fetchCtx)
	}()
	go func() {
		defer close(w.fetchDone)
		w.fetchLoop(w.fetchCtx)
	}()
	return true
}

// shutdown stops new claims, aborts the marker wait, drains the in-flight job
// while its lock keeps renewing, and closes the blocking connection. A job that
// does not stop before the shutdown deadline is left in the active list; its
// lock expires and BullMQ stalled recovery hands it to the next owner.
func (w *QueueWorker) shutdown() {
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closing = true
		cancelFetch := w.cancelFetch
		cancelJobs := w.cancelJobs
		fetchDone := w.fetchDone
		stalledDone := w.stalledDone
		w.mu.Unlock()

		if cancelFetch != nil {
			cancelFetch()
		}
		// Closing the dedicated connection unblocks a pending BZPOPMIN at once:
		// connection contexts do not cancel in-flight commands by default.
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil && !errors.Is(err, redis.ErrClosed) {
				log.Printf(logPrefix+"close blocking redis client: %v", err)
			}
		}
		if fetchDone != nil {
			<-fetchDone
		}
		if stalledDone != nil {
			<-stalledDone
		}

		drained := make(chan struct{})
		go func() {
			w.wg.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-time.After(shutdownGrace):
			if cancelJobs != nil {
				cancelJobs()
			}
			log.Print(logPrefix + "in-flight job did not finish before the shutdown deadline; leaving it to stalled recovery")
			select {
			case <-drained:
			case <-time.After(shutdownCancelGrace):
			}
		}
		if cancelJobs != nil {
			cancelJobs()
		}
		close(w.closed)
	})
}

func (w *QueueWorker) fetchLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if w.isPaused(ctx) {
			if !queueSleep(ctx, pausedQueuePollInterval) {
				return
			}
			continue
		}
		select {
		case w.slots <- struct{}{}:
		case <-ctx.Done():
			return
		}

		next, err := w.moveToActive(ctx)
		if err != nil {
			<-w.slots
			if ctx.Err() != nil {
				return
			}
			log.Printf(logPrefix+"fetch job: %v", err)
			if !queueSleep(ctx, fetchErrorRetryInterval) {
				return
			}
			continue
		}
		job := next.job
		if job == nil {
			<-w.slots
			if next.delayUntil > w.now().UnixMilli() {
				wait := time.Until(time.UnixMilli(next.delayUntil))
				if wait > drainDelay {
					wait = drainDelay
				}
				if !queueSleep(ctx, wait) {
					return
				}
				continue
			}
			w.waitForMarker(ctx)
			continue
		}

		w.mu.Lock()
		if w.closing {
			w.mu.Unlock()
			<-w.slots
			return
		}
		w.wg.Add(1)
		w.mu.Unlock()
		go func(job queuedJob) {
			defer w.wg.Done()
			defer func() { <-w.slots }()
			w.processJob(job)
		}(*job)
	}
}

// isPaused checks the queue meta hash; a paused queue must not be claimed. The
// check is best effort: moveToActive has its own paused check.
func (w *QueueWorker) isPaused(ctx context.Context) bool {
	paused, err := w.client.HExists(ctx, w.keys.Meta, "paused").Result()
	return err == nil && paused
}

// waitForMarker blocks on the BullMQ marker until a waiting or delayed job is
// announced, the drain delay elapses or the context is canceled.
func (w *QueueWorker) waitForMarker(ctx context.Context) {
	timeout := drainDelay
	if timeout <= 0 {
		timeout = drainDelay
	}
	_, err := w.blocking.BZPopMin(ctx, timeout, w.keys.Marker).Result()
	if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil && !errors.Is(err, redis.ErrClosed) {
		log.Printf(logPrefix+"wait for marker: %v", err)
		queueSleep(ctx, fetchErrorRetryInterval)
	}
}

// queueNextJob is the decoded moveToActive reply.
type queueNextJob struct {
	job        *queuedJob
	delayUntil int64
}

func (w *QueueWorker) moveToActive(ctx context.Context) (queueNextJob, error) {
	token := w.tokens.next()
	opts, err := queuePack(map[string]any{
		"token":        token,
		"lockDuration": int64(lockDuration / time.Millisecond),
		"limiter":      nil,
		"name":         nil,
	})
	if err != nil {
		return queueNextJob{}, err
	}
	result, err := w.scripts.moveToActive.Run(ctx, w.client,
		[]string{
			w.keys.Wait,
			w.keys.Active,
			w.keys.Prioritized,
			w.keys.Events,
			w.keys.Stalled,
			w.keys.Limiter,
			w.keys.Delayed,
			w.keys.Paused,
			w.keys.Meta,
			w.keys.PC,
			w.keys.Marker,
		},
		w.keys.Base,
		w.now().UnixMilli(),
		opts,
	).Result()
	if err != nil {
		return queueNextJob{}, err
	}
	return queueNextJobFromResult(result, token)
}

// queueNextJobFromResult decodes the [jobData, jobId, rateLimitDelay,
// delayUntil] tuple the scripts return.
func queueNextJobFromResult(result any, token string) (queueNextJob, error) {
	values, ok := result.([]any)
	if !ok {
		if result == nil {
			return queueNextJob{}, nil
		}
		return queueNextJob{}, fmt.Errorf("situationsignalsworker: unexpected moveToActive result %T", result)
	}
	if len(values) == 0 {
		return queueNextJob{}, nil
	}
	next := queueNextJob{}
	if len(values) > 3 {
		next.delayUntil = queueToInt64(values[3])
	}
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return next, nil
	}
	jobID := ""
	if len(values) > 1 {
		jobID = queueToText(values[1])
	}
	job, err := queueQueuedJobFromFlat(flat, token, jobID)
	if err != nil {
		return next, err
	}
	next.job = &job
	return next, nil
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

// processJob runs one claimed job: it reschedules the next repeat iteration
// first (exactly like BullMQ's Worker.nextJobFromJobData), then keeps the lock
// fresh while the processor runs, and finally acks the job as completed, moves
// it to the delayed set for a retry, or fails it.
func (w *QueueWorker) processJob(job queuedJob) {
	if err := w.rescheduleRepeat(w.fetchCtx, job); err != nil {
		log.Printf(logPrefix+"reschedule repeat for job %s: %v", job.ID, err)
		return
	}

	jobCtx, cancelJob := context.WithCancelCause(w.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)

	source, ok := queueJobSource(job)
	var processErr error
	if !ok {
		log.Printf(logPrefix+"job %s (%s) carries no poll source; completing without work", job.ID, job.Name)
	} else {
		processErr = w.process(jobCtx, source)
	}
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx.Err() != nil {
		// Worker shutdown deadline: leave the job active; its lock expires and
		// stalled recovery hands it to the next owner.
		return
	}
	if leaseLost.Load() {
		log.Printf(logPrefix+"lease lost for job %s; leaving it to stalled recovery", job.ID)
		return
	}
	// Acknowledging must not inherit the fetch-loop context: shutdown cancels it
	// to stop new claims while in-flight jobs still drain.
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), finishTimeout)
	defer cancelFinish()

	if processErr == nil {
		w.finishCompleted(finishCtx, job)
		return
	}
	// The NestJS processor logs every worker 'failed' event and lets BullMQ
	// decide the retry, so the error is logged here and reported to BullMQ.
	log.Printf(logPrefix+"job %s (%s) failed: %v", job.ID, job.Name, processErr)
	if job.finalFailure() {
		w.finishFailed(finishCtx, job, processErr)
		return
	}
	delayMs, ok := w.retryDelay(job)
	if !ok {
		backoffType := ""
		if job.Opts.Backoff != nil {
			backoffType = job.Opts.Backoff.Type
		}
		log.Printf(logPrefix+"unknown backoff strategy %q for job %s; leaving it active", backoffType, job.ID)
		return
	}
	if delayMs > 0 {
		w.moveToDelayed(finishCtx, job, w.now().UnixMilli()+delayMs, false, queueFailureFields(processErr.Error()))
		return
	}
	w.retryJob(finishCtx, job, processErr)
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
// cannot write a terminal state for a job it no longer owns.
func (w *QueueWorker) renewLock(ctx context.Context, job queuedJob, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	ticker := time.NewTicker(lockRenewTime)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			extended, err := w.scripts.extendLock.Run(ctx, w.client,
				[]string{w.keys.jobKey(job.ID) + ":lock", w.keys.Stalled},
				job.Token,
				int64(lockDuration/time.Millisecond),
				job.ID,
			).Int64()
			if err != nil {
				if ctx.Err() == nil {
					log.Printf(logPrefix+"renew lock %s: %v", job.ID, err)
				}
				lost.Store(true)
				cancel(errors.New("situationsignalsworker: lock renewal failed"))
				return
			}
			if extended == 0 {
				lost.Store(true)
				cancel(errors.New("situationsignalsworker: lock is owned by another worker"))
				return
			}
		}
	}
}

// retryDelay mirrors Backoffs.calculate for the built-in fixed and exponential
// strategies (NestJS configures exponential/1000 for this queue). It reports
// false for an unknown strategy, which BullMQ treats as an error: the job is
// left active for stalled recovery instead of being failed.
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

func (w *QueueWorker) finishCompleted(ctx context.Context, job queuedJob) {
	opts, err := queuePack(queueFinishOptions(job, job.Token, job.keepOnComplete()))
	if err != nil {
		log.Printf(logPrefix+"pack completion options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
		w.finishKeys(job.ID, w.keys.Completed, "metrics:completed"),
		job.ID,
		w.now().UnixMilli(),
		"returnvalue",
		"null",
		"completed",
		0,
		w.keys.Base,
		opts,
	).Result()
	if err != nil {
		log.Printf(logPrefix+"finish completed %s: %v", job.ID, err)
		return
	}
	if code := queueNegativeCode(result); code < 0 {
		log.Printf(logPrefix+"finish completed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *QueueWorker) finishFailed(ctx context.Context, job queuedJob, cause error) {
	reason := cause.Error()
	fields, err := queuePack(queueFailureFields(reason))
	if err != nil {
		log.Printf(logPrefix+"pack failure fields for %s: %v", job.ID, err)
		return
	}
	opts, err := queuePack(queueFinishOptions(job, job.Token, job.keepOnFail()))
	if err != nil {
		log.Printf(logPrefix+"pack failure options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
		w.finishKeys(job.ID, w.keys.Failed, "metrics:failed"),
		job.ID,
		w.now().UnixMilli(),
		"failedReason",
		reason,
		"failed",
		0,
		w.keys.Base,
		opts,
		fields,
	).Result()
	if err != nil {
		log.Printf(logPrefix+"finish failed %s: %v", job.ID, err)
		return
	}
	if code := queueNegativeCode(result); code < 0 {
		log.Printf(logPrefix+"finish failed %s rejected with BullMQ code %d", job.ID, code)
	}
}

// moveToDelayed moves the job to the delayed set. skipAttempt is false for the
// retry path so the attempt counter is incremented exactly once.
func (w *QueueWorker) moveToDelayed(ctx context.Context, job queuedJob, untilMs int64, skipAttempt bool, fields []any) {
	nowMs := w.now().UnixMilli()
	delay := untilMs - nowMs
	if delay < 0 {
		delay = 0
	}
	skipAttemptArg := "0"
	if skipAttempt {
		skipAttemptArg = "1"
	}
	var encodedFields any
	if fields != nil {
		packed, err := queuePack(fields)
		if err != nil {
			log.Printf(logPrefix+"pack delayed fields for %s: %v", job.ID, err)
			return
		}
		encodedFields = packed
	}
	result, err := w.scripts.moveToDelayed.Run(ctx, w.client,
		[]string{
			w.keys.Marker,
			w.keys.Active,
			w.keys.Prioritized,
			w.keys.Delayed,
			w.keys.jobKey(job.ID),
			w.keys.Events,
			w.keys.Meta,
			w.keys.Stalled,
		},
		w.keys.Base,
		nowMs,
		job.ID,
		job.Token,
		delay,
		skipAttemptArg,
		encodedFields,
	).Result()
	if err != nil {
		log.Printf(logPrefix+"move to delayed %s: %v", job.ID, err)
		return
	}
	if code := queueNegativeCode(result); code < 0 {
		log.Printf(logPrefix+"move to delayed %s rejected with BullMQ code %d", job.ID, code)
	}
}

// retryJob moves the job back to the wait list when a retry has no delay.
func (w *QueueWorker) retryJob(ctx context.Context, job queuedJob, cause error) {
	fields, err := queuePack(queueFailureFields(cause.Error()))
	if err != nil {
		log.Printf(logPrefix+"pack retry fields for %s: %v", job.ID, err)
		return
	}
	pushCommand := "LPUSH"
	if job.Opts.LIFO {
		pushCommand = "RPUSH"
	}
	result, err := w.scripts.retryJob.Run(ctx, w.client,
		[]string{
			w.keys.Active,
			w.keys.Wait,
			w.keys.Paused,
			w.keys.jobKey(job.ID),
			w.keys.Meta,
			w.keys.Events,
			w.keys.Delayed,
			w.keys.Prioritized,
			w.keys.PC,
			w.keys.Marker,
			w.keys.Stalled,
		},
		w.keys.Base,
		w.now().UnixMilli(),
		pushCommand,
		job.ID,
		job.Token,
		fields,
	).Result()
	if err != nil {
		log.Printf(logPrefix+"retry %s: %v", job.ID, err)
		return
	}
	if code := queueNegativeCode(result); code < 0 {
		log.Printf(logPrefix+"retry %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *QueueWorker) finishKeys(jobID, target, metricsSuffix string) []string {
	return []string{
		w.keys.Wait,
		w.keys.Active,
		w.keys.Prioritized,
		w.keys.Events,
		w.keys.Stalled,
		w.keys.Limiter,
		w.keys.Delayed,
		w.keys.Paused,
		w.keys.Meta,
		w.keys.PC,
		target,
		w.keys.jobKey(jobID),
		w.keys.Base + metricsSuffix,
		w.keys.Marker,
	}
}

func (w *QueueWorker) stalledLoop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			w.checkStalled(ctx)
			timer.Reset(stalledInterval)
		}
	}
}

func (w *QueueWorker) checkStalled(ctx context.Context) {
	result, err := w.scripts.moveStalledJobsToWait.Run(ctx, w.client,
		[]string{
			w.keys.Stalled,
			w.keys.Wait,
			w.keys.Active,
			w.keys.Base + "stalled-check",
			w.keys.Meta,
			w.keys.Paused,
			w.keys.Marker,
			w.keys.Events,
		},
		maxStalledCount,
		w.keys.Base,
		w.now().UnixMilli(),
		int64(stalledInterval/time.Millisecond),
	).Result()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf(logPrefix+"stalled recovery: %v", err)
		}
		return
	}
	if values, ok := result.([]any); ok && len(values) > 0 {
		log.Printf(logPrefix+"recovered %d stalled job(s)", len(values))
	}
}

// rescheduleRepeat mirrors Worker.nextJobFromJobData: a fetched job that belongs
// to a repeat schedule schedules the next iteration before it is processed.
//
// Both schedules of this queue are produced by BullMQ 5.63.2 with hashed
// (md5) repeat keys: the legacy Oref repeat (rjk = md5) and the Telegram
// JobScheduler (rjk = "telegram-poll:scheduler"). A repeat key with fewer than
// five colon-separated segments therefore goes through
// JobScheduler.upsertJobScheduler({override: false}), i.e. the
// updateJobScheduler script, which computes the next millis from the repeat
// hash. A pre-5 colon-bearing key is not produced by this repository and is
// left untouched (the job is still processed, like the alerts runner).
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
