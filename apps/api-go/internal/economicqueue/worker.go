package economicqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Handler processes one claimed job. Returning an error moves the job to the
// failed set; the handler is responsible for persisting the user-visible fetch
// status exactly once and must stop when ctx is cancelled (worker shutdown or a
// lost job lock).
type Handler func(ctx context.Context, job Job) error

// WorkerOptions configures the BullMQ-compatible consumer. Zero values fall back
// to the BullMQ 5.63.2 defaults, except LockDuration which defaults to five
// minutes because the longest provider chain (three retries at up to 20s plus
// backoff) must fit inside one claim.
type WorkerOptions struct {
	Concurrency     int
	LockDuration    time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	PollInterval    time.Duration
	Name            string
}

func (o WorkerOptions) normalized() WorkerOptions {
	if o.Concurrency <= 0 {
		o.Concurrency = 2
	}
	if o.LockDuration <= 0 {
		o.LockDuration = 5 * time.Minute
	}
	if o.StalledInterval <= 0 {
		o.StalledInterval = 30 * time.Second
	}
	// BullMQ's own default is 1; zero therefore selects the default instead of
	// "fail on the first recovered lock".
	if o.MaxStalledCount <= 0 {
		o.MaxStalledCount = 1
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 200 * time.Millisecond
	}
	if o.Name == "" {
		o.Name = "api-go"
	}
	return o
}

// Worker is the single consumer of bull:akshare-data. It uses the official
// BullMQ state-machine Lua scripts so a job it moves is byte-compatible with
// the queue-ops console and with any job left by the retired NestJS worker.
//
// Lease lifecycle: moveToActive creates the per-job lock and a fresh token; the
// renewal goroutine extends it every lockDuration/2. A renewal failure or a lock
// owned by another token cancels the handler context and skips the finish call,
// so a stale executor can never delete a new lock, remove a new active entry or
// overwrite a newer terminal state. Jobs abandoned this way stay in the active
// list and are recovered by the stalled checker.
type Worker struct {
	redis    *redis.Client
	producer *Producer
	handler  Handler
	opts     WorkerOptions
	keys     keySpace
	scripts  queueScripts
	tokens   *tokenSource

	stop       context.CancelFunc
	jobCtx     context.Context
	cancelJobs context.CancelFunc
	runDone    chan struct{}
	started    atomic.Bool
	once       sync.Once
	mu         sync.Mutex
}

// NewWorker creates a worker. The caller owns the Redis client and closes it
// after Close returns.
func NewWorker(client *redis.Client, handler Handler, opts WorkerOptions) *Worker {
	jobCtx, cancelJobs := context.WithCancel(context.Background())
	return &Worker{
		redis:      client,
		producer:   NewProducer(client),
		handler:    handler,
		opts:       opts.normalized(),
		keys:       newKeySpace(Prefix, QueueName),
		scripts:    defaultQueueScripts,
		tokens:     newTokenSource(),
		jobCtx:     jobCtx,
		cancelJobs: cancelJobs,
		runDone:    make(chan struct{}),
	}
}

// newWorkerWithName builds a worker bound to a scratch queue name. Integration
// tests use it so a run never touches the production akshare-data key space.
func newWorkerWithName(client *redis.Client, handler Handler, opts WorkerOptions, name string) *Worker {
	worker := NewWorker(client, handler, opts)
	worker.keys = newKeySpace(Prefix, name)
	worker.producer = newProducerWithName(client, name)
	return worker
}

// Run blocks until ctx is cancelled and every in-flight job has completed. Call
// it in a goroutine after catalog and repeat synchronization.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.redis == nil || w.handler == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithCancel(ctx)
	w.mu.Lock()
	w.stop = cancel
	w.mu.Unlock()
	w.started.Store(true)
	log.Printf("economicqueue: akshare worker started concurrency=%d", w.opts.Concurrency)

	var loops sync.WaitGroup
	loops.Add(1)
	go func() {
		defer loops.Done()
		w.stalledLoop(runCtx)
	}()
	for index := 0; index < w.opts.Concurrency; index++ {
		loops.Add(1)
		go func() {
			defer loops.Done()
			w.fetchLoop(runCtx)
		}()
	}

	<-runCtx.Done()
	// Stop claiming new work, let in-flight handlers drain, then release the
	// handler contexts. Close cancels w.jobCtx at its deadline so a stuck
	// handler cannot hold the process open forever.
	loops.Wait()
	close(w.runDone)
	if w.cancelJobs != nil {
		w.cancelJobs()
	}
	log.Printf("economicqueue: akshare worker stopped")
}

// Close stops the loop and waits for in-flight jobs.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	w.once.Do(func() {
		w.mu.Lock()
		stop := w.stop
		w.mu.Unlock()
		if stop != nil {
			stop()
		}
	})
	if !w.started.Load() {
		return nil
	}
	done := make(chan struct{})
	go func() {
		<-w.runDone
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		grace, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		select {
		case <-done:
			return nil
		case <-grace.Done():
			return fmt.Errorf("economicqueue: in-flight jobs did not stop before the shutdown deadline")
		}
	}
}

func (w *Worker) fetchLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		job, err := w.moveToActive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("economicqueue: claim job failed: %v", err)
			if !sleepContext(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			if !sleepContext(ctx, w.opts.PollInterval) {
				return
			}
			continue
		}
		// BullMQ schedules the next repeat before the processor runs, so a
		// failed fetch does not stop the schedule. The guard inside
		// ScheduleNextRepeat keeps a deleted/replaced schedule dead.
		if job.RepeatJobKey != "" {
			if err := w.producer.ScheduleNextRepeat(ctx, *job); err != nil {
				log.Printf("economicqueue: schedule next repeat for %s failed: %v", job.ID, err)
			}
		}
		w.process(ctx, *job)
	}
}

// moveToActive atomically promotes due delayed jobs, honors meta.paused, moves
// one job from the correct list into active and takes its lock. A nil job means
// the queue is empty or paused.
func (w *Worker) moveToActive(ctx context.Context) (*Job, error) {
	token := w.tokens.Next()
	opts, err := pack(moveToActiveOptions{
		Token:        token,
		LockDuration: w.opts.LockDuration.Milliseconds(),
		Name:         w.opts.Name,
	})
	if err != nil {
		return nil, err
	}
	keys := []string{
		w.keys.wait(),
		w.keys.active(),
		w.keys.prioritized(),
		w.keys.events(),
		w.keys.stalled(),
		w.keys.limiter(),
		w.keys.delayed(),
		w.keys.paused(),
		w.keys.meta(),
		w.keys.priorityCounter(),
		w.keys.marker(),
	}
	result, err := w.scripts.moveToActive.Run(ctx, w.redis, keys, w.keys.base, time.Now().UnixMilli(), string(opts)).Result()
	if err != nil {
		return nil, err
	}
	values, ok := result.([]any)
	if !ok || len(values) < 2 {
		return nil, fmt.Errorf("economicqueue: unexpected moveToActive reply %T", result)
	}
	jobID, _ := values[1].(string)
	if jobID == "" {
		return nil, nil
	}
	fields := map[string]string{}
	if raw, ok := values[0].([]any); ok {
		fields = flattenPairs(raw)
	}
	if len(fields) == 0 {
		// The wait entry outlived its job hash; drop our active entry and
		// release the lock so the stale id does not linger.
		_ = w.redis.LRem(ctx, w.keys.active(), 1, jobID).Err()
		_ = w.release(ctx, jobID, token)
		return nil, fmt.Errorf("job hash missing")
	}
	job := jobFromFields(jobID, fields, token)
	return &job, nil
}

func (w *Worker) process(parent context.Context, job Job) {
	_ = parent
	jobCtx, cancelJob := context.WithCancelCause(w.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)

	var handlerErr error
	if job.DeferredFailure != "" {
		// BullMQ marked this job unrecoverable ("job stalled more than
		// allowable limit") when it exceeded MaxStalledCount. Fail it without
		// running the fetch so a terminal stall is never reported as success.
		handlerErr = errors.New(job.DeferredFailure)
	} else {
		handlerErr = w.handler(jobCtx, job)
	}
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx.Err() != nil {
		// Shutdown deadline: leave the job active. Its lock expires and stalled
		// recovery hands it to the next attempt.
		return
	}
	var leaseErr *LeaseLostError
	if errors.As(handlerErr, &leaseErr) || leaseLost.Load() {
		log.Printf("economicqueue: lease lost for job %s; leaving it to stalled recovery", job.ID)
		return
	}
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinish()
	if handlerErr == nil {
		w.finish(finishCtx, job, "completed", nil)
		return
	}
	w.finish(finishCtx, job, "failed", handlerErr)
}

// renewLock extends the job lock every lockDuration/2. A failed renewal or a
// lock owned by another token cancels the handler: the attempt stops writing and
// cannot record a terminal state.
func (w *Worker) renewLock(ctx context.Context, job Job, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	interval := w.opts.LockDuration / 2
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			extended, err := w.scripts.extendLock.Run(ctx, w.redis,
				[]string{w.keys.lock(job.ID), w.keys.stalled()},
				job.Token,
				w.opts.LockDuration.Milliseconds(),
				job.ID,
			).Int64()
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("economicqueue: renew lock %s: %v", job.ID, err)
				}
				lost.Store(true)
				cancel(ErrLeaseLost)
				return
			}
			if extended == 0 {
				lost.Store(true)
				cancel(ErrLeaseLost)
				return
			}
		}
	}
}

// finish moves one job to completed or failed through moveToFinished, which
// checks the lock token before touching active/terminal state. cause is nil for
// a success.
func (w *Worker) finish(ctx context.Context, job Job, target string, cause error) {
	property := "returnvalue"
	value := "null"
	keep := keepOnComplete(job.Opts)
	encodedFields := ""
	if target == "failed" {
		reason := truncateReason(cause)
		property = "failedReason"
		value = reason
		keep = keepOnFail(job.Opts)
		packed, err := pack([]string{"failedReason", reason, "stacktrace", "[]"})
		if err != nil {
			log.Printf("economicqueue: encode failure fields for %s: %v", job.ID, err)
			return
		}
		encodedFields = string(packed)
	}
	opts, err := pack(finishOptions{
		Token:          job.Token,
		KeepJobs:       keep,
		LockDuration:   w.opts.LockDuration.Milliseconds(),
		Attempts:       job.Opts.Attempts,
		MaxMetricsSize: "",
	})
	if err != nil {
		log.Printf("economicqueue: encode finish options for %s: %v", job.ID, err)
		return
	}
	targetKey := w.keys.completed()
	if target == "failed" {
		targetKey = w.keys.failed()
	}
	keys := []string{
		w.keys.wait(),
		w.keys.active(),
		w.keys.prioritized(),
		w.keys.events(),
		w.keys.stalled(),
		w.keys.limiter(),
		w.keys.delayed(),
		w.keys.paused(),
		w.keys.meta(),
		w.keys.priorityCounter(),
		targetKey,
		w.keys.job(job.ID),
		w.keys.base + "metrics:" + target,
		w.keys.marker(),
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.redis, keys,
		job.ID,
		time.Now().UnixMilli(),
		property,
		value,
		target,
		"0", // never prefetch: this loop claims the next job itself
		w.keys.base,
		string(opts),
		encodedFields,
	).Result()
	if err != nil {
		log.Printf("economicqueue: finish job %s as %s: %v", job.ID, target, err)
		return
	}
	if code := toInt64(result); code < 0 {
		// -2 missing lock / -3 not in active / -6 lock not owned: another
		// executor owns this job now, so this stale finish is correctly ignored.
		log.Printf("economicqueue: finish job %s as %s rejected with BullMQ code %d", job.ID, target, code)
	}
}

// release deletes the lock only when this worker still owns it.
func (w *Worker) release(ctx context.Context, jobID, token string) error {
	script := `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
	return w.redis.Eval(ctx, script, []string{w.keys.lock(jobID)}, token).Err()
}

func (w *Worker) stalledLoop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			w.checkStalled(ctx)
			timer.Reset(w.opts.StalledInterval)
		}
	}
}

// checkStalled recovers jobs whose lock expired. moveStalledJobsToWait only
// moves a job back to wait when its lock is missing, honors paused state, and
// fails a non-repeat job that exceeds MaxStalledCount with the defa marker.
func (w *Worker) checkStalled(ctx context.Context) {
	keys := []string{
		w.keys.stalled(),
		w.keys.wait(),
		w.keys.active(),
		w.keys.stalledCheck(),
		w.keys.meta(),
		w.keys.paused(),
		w.keys.marker(),
		w.keys.events(),
	}
	result, err := w.scripts.moveStalledJobsToWait.Run(ctx, w.redis, keys,
		w.opts.MaxStalledCount,
		w.keys.base,
		time.Now().UnixMilli(),
		w.opts.StalledInterval.Milliseconds(),
	).Result()
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("economicqueue: stalled checker: %v", err)
		}
		return
	}
	if values, ok := result.([]any); ok && len(values) > 0 {
		log.Printf("economicqueue: recovered %d stalled job(s)", len(values))
	}
}

func sleepContext(ctx context.Context, duration time.Duration) bool {
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

// truncateReason matches the NestJS failedReason length cap of 191 runes.
func truncateReason(err error) string {
	if err == nil {
		return ""
	}
	reason := err.Error()
	runes := []rune(reason)
	if len(runes) > 191 {
		return string(runes[:188]) + "..."
	}
	return reason
}

func toInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	case []byte:
		parsed, _ := strconv.ParseInt(string(typed), 10, 64)
		return parsed
	default:
		return 0
	}
}

// ErrLeaseLost is the cancel cause used when lock renewal fails or the lock
// belongs to another token.
var ErrLeaseLost = errors.New("economicqueue: job lock was lost")

// LeaseLostError tells the worker that this attempt no longer owns the job
// lease; a handler may return it to skip the terminal write explicitly.
type LeaseLostError struct{ Reason string }

func (e *LeaseLostError) Error() string {
	if e == nil || e.Reason == "" {
		return "economicqueue: lease lost"
	}
	return "economicqueue: lease lost: " + e.Reason
}

// tokenSource produces a unique BullMQ lock token per fetched job.
type tokenSource struct {
	id      string
	counter atomic.Uint64
}

func newTokenSource() *tokenSource {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return &tokenSource{id: "akshare-data-go"}
	}
	return &tokenSource{id: "akshare-data-go-" + hex.EncodeToString(buf[:])}
}

func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}
