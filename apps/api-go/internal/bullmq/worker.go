package bullmq

// Worker is the single Go implementation of the BullMQ 5.63.2 worker state
// machine. Before this package owned it, every queue package carried its own
// 500-750 line copy of moveToActive / lock renewal / finish / retry / stalled
// checking. Those copies drifted: some cancelled the processor when the lock was
// lost and some kept running (and even acknowledged) a job another worker had
// already recovered. This file is the merged, correct implementation.
//
// The wire format is the one the other copies already wrote, so a job moved by
// this worker is indistinguishable from a job moved by the retired hand-written
// loops: the same Lua scripts, keys, token shape and job hash fields.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/safego"
)

// Processor runs one claimed job. It must stop writing when ctx is cancelled
// (worker shutdown or a lost lock). A nil error stores the returned bytes as the
// BullMQ job returnvalue (nil stores "null"); a non-nil error goes through the
// failure policy.
type Processor func(ctx context.Context, job *Job) (json.RawMessage, error)

// Limiter is the BullMQ rate-limit table moveToActive reads. A nil Limiter means
// the queue is not rate limited.
type Limiter struct {
	Max      int64 `msgpack:"max"`
	Duration int64 `msgpack:"duration"`
}

// FailureInfo is the decision made for one failed attempt. It mirrors the shape
// the business 'failed' listeners (item pipeline TaskLog/DLQ, archive status)
// already consume.
type FailureInfo struct {
	// AttemptsMade counts this failure (job.attemptsMade + 1).
	AttemptsMade int
	// RemainingAttempts is max(0, attempts - AttemptsMade).
	RemainingAttempts int
	// Permanent reports an unrecoverable error (never retried).
	Permanent bool
	// FinalFailure reports no further attempt will run.
	FinalFailure bool
	// Cause is the original processor error (unwrapped from the bullmq marker
	// types) so listeners can classify it exactly as before.
	Cause error
}

// FailureDecision is what the failure policy decides for one failed attempt.
type FailureDecision struct {
	Final       bool
	Permanent   bool
	DelayMillis int64
}

// FailurePolicy decides whether a failed attempt retries (with an optional
// backoff delay) or becomes the terminal failure. The default policy implements
// BullMQ's attempts/backoff rules and the Unrecoverable/RetryAfter markers. A
// queue with richer business classification can override it.
type FailurePolicy func(job *Job, err error) FailureDecision

// WorkerOptions are the BullMQ worker settings one queue migration needs. Zero
// values fall back to the BullMQ 5.63.2 defaults.
type WorkerOptions struct {
	// Prefix is the BullMQ key prefix ("bull" when empty).
	Prefix string
	// Name is written to the job "processedBy" field for operator visibility.
	Name string
	// Concurrency is the number of jobs processed at the same time.
	Concurrency int
	// LockDuration is the per-job lock lifetime (BullMQ default 30s).
	LockDuration time.Duration
	// StalledInterval is the stalled checker period (BullMQ default 30s).
	StalledInterval time.Duration
	// LockRenewTime is the lock renewal period (default LockDuration/2).
	LockRenewTime time.Duration
	// MaxStalledCount is how many times a job may be recovered from a lost lock
	// before it fails (BullMQ default 1).
	MaxStalledCount int
	// DrainDelay is the marker blocking timeout when a blocking client is used.
	DrainDelay time.Duration
	// PollInterval is the empty-queue poll delay when no blocking client is
	// supplied.
	PollInterval time.Duration
	// Limiter is the queue rate limit, or nil for none.
	Limiter *Limiter
	// RemoveOnComplete and RemoveOnFail are the worker-level retention fallbacks
	// used when the job hash does not carry its own value.
	RemoveOnComplete KeepJobs
	RemoveOnFail     KeepJobs
	// FailureReasonLimit truncates the failedReason to this many runes (0 keeps
	// the whole message).
	FailureReasonLimit int
	// Stacktrace formats the stacktrace JSON stored with a failure. nil stores
	// the empty array "[]" (Go has no JavaScript stack).
	Stacktrace func(reason string) string
	// FailurePolicy overrides the default retry/fail decision.
	FailurePolicy FailurePolicy
	// IsLeaseLost reports a processor error that must not be acknowledged (the
	// attempt no longer owns the lease).
	IsLeaseLost func(err error) bool
	// OnClaim runs once per claimed job before the processor, for queue-specific
	// bookkeeping that must happen before processing (repeat scheduling).
	OnClaim func(ctx context.Context, job *Job)
	// ProcessDeferredFailure runs the processor for a job carrying BullMQ's defa
	// marker. Queues whose handler advances the terminal state on defa (analysis,
	// clustering) must set this; queues that must not repeat side effects leave it
	// false and the job fails unrecoverably without running the processor.
	ProcessDeferredFailure bool
	// OnFailure runs once for every failed attempt after the BullMQ transition.
	OnFailure func(ctx context.Context, job *Job, failure FailureInfo)
	// Logger is the diagnostic sink (log.Printf when nil).
	Logger func(format string, args ...any)
}

func (o WorkerOptions) normalized() WorkerOptions {
	if o.Prefix == "" {
		o.Prefix = Prefix
	}
	if o.Concurrency < 1 {
		o.Concurrency = 1
	}
	if o.LockDuration <= 0 {
		o.LockDuration = 30 * time.Second
	}
	if o.StalledInterval <= 0 {
		o.StalledInterval = 30 * time.Second
	}
	if o.LockRenewTime <= 0 {
		o.LockRenewTime = o.LockDuration / 2
	}
	// BullMQ's own default is 1; the zero value must not mean "fail on the first
	// recovered lock".
	if o.MaxStalledCount < 1 {
		o.MaxStalledCount = 1
	}
	if o.DrainDelay <= 0 {
		o.DrainDelay = 5 * time.Second
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 200 * time.Millisecond
	}
	if o.Logger == nil {
		o.Logger = log.Printf
	}
	return o
}

// UnrecoverableError marks an error no retry can fix. The unwrapped error keeps
// its original message so failedReason is unchanged.
type UnrecoverableError struct{ err error }

func (e *UnrecoverableError) Error() string {
	if e == nil || e.err == nil {
		return "bullmq: unrecoverable job"
	}
	return e.err.Error()
}

func (e *UnrecoverableError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

// Unrecoverable wraps err so the worker moves the job straight to failed even
// when attempts remain. A nil err yields nil.
func Unrecoverable(err error) error {
	if err == nil {
		return nil
	}
	return &UnrecoverableError{err: err}
}

// RetryAfterError parks the job in the delayed set for exactly delay, regardless
// of the job's own backoff policy.
type RetryAfterError struct {
	err   error
	delay time.Duration
}

func (e *RetryAfterError) Error() string {
	if e == nil || e.err == nil {
		return "bullmq: retry after delay"
	}
	return e.err.Error()
}

func (e *RetryAfterError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

// RetryAfter requests a delayed retry for err. A nil err yields nil.
func RetryAfter(err error, delay time.Duration) error {
	if err == nil {
		return nil
	}
	return &RetryAfterError{err: err, delay: delay}
}

// Worker consumes one BullMQ queue with the official Lua state machine.
//
// Lease lifecycle: moveToActive creates the per-job lock and a fresh token; the
// renewal goroutine extends it every lockDuration/2. A failed renewal or a lock
// owned by another token cancels the processor context and skips the finish
// call, so a stale executor can never delete a new lock, remove a new active
// entry or overwrite a newer terminal state. Jobs abandoned this way stay in the
// active list and are recovered by the stalled checker.
type Worker struct {
	commands    redis.Cmdable
	blocking    *redis.Client
	keys        Keys
	opts        WorkerOptions
	processor   Processor
	tokens      *tokenSource
	slots       chan struct{}
	wg          sync.WaitGroup
	mu          sync.Mutex
	closing     bool
	fetchCtx    context.Context
	cancelFetch context.CancelFunc
	fetchDone   chan struct{}
	stalledDone chan struct{}
	jobCtx      context.Context
	cancelJobs  context.CancelFunc
	closeOnce   sync.Once
	started     atomic.Bool
}

// NewWorker builds a worker over the shared command client and an optional
// dedicated blocking client (needed for BZPOPMIN marker waits). When blocking is
// nil the worker polls with PollInterval instead. Close closes the blocking
// client when one was supplied; the command client is owned by the caller.
func NewWorker(commands redis.Cmdable, blocking *redis.Client, queue string, processor Processor, opts WorkerOptions) (*Worker, error) {
	if commands == nil {
		return nil, fmt.Errorf("bullmq: worker requires a command client")
	}
	if processor == nil {
		return nil, fmt.Errorf("bullmq: worker requires a processor")
	}
	normalized := opts.normalized()
	return &Worker{
		commands:  commands,
		blocking:  blocking,
		keys:      NewKeys(normalized.Prefix, queue),
		opts:      normalized,
		processor: processor,
		tokens:    newTokenSource(),
		slots:     make(chan struct{}, normalized.Concurrency),
	}, nil
}

// Start verifies the clients and starts the fetch loop and the stalled checker.
// It returns immediately; Close performs the ordered drain.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil {
		return fmt.Errorf("bullmq: worker is nil")
	}
	if !w.started.CompareAndSwap(false, true) {
		return fmt.Errorf("bullmq: worker already started")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if client, ok := w.commands.(interface {
		Ping(context.Context) *redis.StatusCmd
	}); ok {
		if err := client.Ping(pingCtx).Err(); err != nil {
			return fmt.Errorf("bullmq: redis ping failed: %w", err)
		}
	}
	if w.blocking != nil {
		if err := w.blocking.Ping(pingCtx).Err(); err != nil {
			return fmt.Errorf("bullmq: blocking redis ping failed: %w", err)
		}
	}
	w.fetchCtx, w.cancelFetch = context.WithCancel(context.Background())
	w.jobCtx, w.cancelJobs = context.WithCancel(context.Background())
	w.fetchDone = make(chan struct{})
	w.stalledDone = make(chan struct{})
	safego.Go("bullmq.worker.stalledLoop", func() {
		defer close(w.stalledDone)
		w.stalledLoop(w.fetchCtx)
	})
	safego.Go("bullmq.worker.fetchLoop", func() {
		defer close(w.fetchDone)
		w.fetchLoop(w.fetchCtx)
	})
	return nil
}

// Run starts the worker and blocks until ctx is cancelled, then drains in-flight
// jobs. It is the economic queue's historical entry point.
func (w *Worker) Run(ctx context.Context) {
	if w == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := w.Start(ctx); err != nil {
		w.opts.Logger("bullmq: worker start: %v", err)
		return
	}
	<-ctx.Done()
	closeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := w.Close(closeCtx); err != nil {
		w.opts.Logger("bullmq: worker close: %v", err)
	}
}

// Stop is Close with the historical quality-queue name.
func (w *Worker) Stop(ctx context.Context) error { return w.Close(ctx) }

// Close stops claiming new jobs, drains in-flight jobs while their locks keep
// renewing, cancels the handlers at the deadline, stops the stalled checker and
// closes the dedicated blocking client.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var closeErr error
	w.closeOnce.Do(func() {
		w.mu.Lock()
		w.closing = true
		w.mu.Unlock()
		if w.cancelFetch != nil {
			w.cancelFetch()
		}
		if w.fetchDone != nil {
			select {
			case <-w.fetchDone:
			case <-ctx.Done():
			}
		}
		if w.stalledDone != nil {
			select {
			case <-w.stalledDone:
			case <-ctx.Done():
			}
		}
		drained := make(chan struct{})
		go func() {
			w.wg.Wait()
			close(drained)
		}()
		select {
		case <-drained:
		case <-ctx.Done():
			if w.cancelJobs != nil {
				w.cancelJobs()
			}
			graceCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			select {
			case <-drained:
			case <-graceCtx.Done():
				closeErr = fmt.Errorf("bullmq: in-flight jobs did not stop before the shutdown deadline")
			}
		}
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil {
				w.opts.Logger("bullmq: close blocking redis: %v", err)
			}
		}
	})
	return closeErr
}

func (w *Worker) fetchLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		if w.isPaused(ctx) {
			if !sleepContext(ctx, 250*time.Millisecond) {
				return
			}
			continue
		}
		select {
		case w.slots <- struct{}{}:
		case <-ctx.Done():
			return
		}

		var job *Job
		var limiterDelay, delayUntil int64
		err := safego.Call("bullmq.worker.moveToActive", func() error {
			var claimErr error
			job, limiterDelay, delayUntil, claimErr = w.claim(ctx)
			return claimErr
		})
		if err != nil {
			<-w.slots
			if ctx.Err() != nil {
				return
			}
			w.opts.Logger("bullmq: fetch job: %v", err)
			if !sleepContext(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			<-w.slots
			if limiterDelay > 0 {
				// A rate-limited queue reports the remaining limiter TTL in
				// moveToActive reply[2]; wait it out (capped by DrainDelay) instead
				// of spinning on the marker, matching BullMQ's worker.
				wait := time.Duration(limiterDelay) * time.Millisecond
				if wait > w.opts.DrainDelay {
					wait = w.opts.DrainDelay
				}
				if !sleepContext(ctx, wait) {
					return
				}
				continue
			}
			if delayUntil > time.Now().UnixMilli() {
				wait := time.Until(time.UnixMilli(delayUntil))
				if wait > w.opts.DrainDelay {
					wait = w.opts.DrainDelay
				}
				if !sleepContext(ctx, wait) {
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
		claimed := job
		safego.Go("bullmq.worker.job", func() {
			defer w.wg.Done()
			defer func() { <-w.slots }()
			w.ProcessOne(ctx, claimed)
		})
	}
}

// isPaused checks the queue meta hash; a paused queue must not be claimed even
// when the wait list has jobs. On a Redis error the fetch proceeds and
// moveToActive's own paused check still protects the queue.
func (w *Worker) isPaused(ctx context.Context) bool {
	paused, err := w.commands.HExists(ctx, w.keys.Meta, "paused").Result()
	return err == nil && paused
}

func (w *Worker) waitForMarker(ctx context.Context) {
	if w.blocking == nil {
		if !sleepContext(ctx, w.opts.PollInterval) {
			return
		}
		return
	}
	timeout := w.opts.DrainDelay
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	_, err := w.blocking.BZPopMin(ctx, timeout, w.keys.Marker).Result()
	if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
		w.opts.Logger("bullmq: wait for marker: %v", err)
		if !sleepContext(ctx, time.Second) {
			return
		}
	}
}

// Claim atomically moves one job from wait to active and takes its lock. A nil
// job with a non-zero delayUntil means the queue is empty but a delayed job is
// due at that time; both zero means empty or paused.
func (w *Worker) Claim(ctx context.Context) (*Job, int64, error) {
	job, _, delayUntil, err := w.claim(ctx)
	return job, delayUntil, err
}

// claim is Claim plus the rate-limiter TTL moveToActive reports in reply[2]
// (milliseconds), which the fetch loop waits out before asking for another job.
func (w *Worker) claim(ctx context.Context) (*Job, int64, int64, error) {
	token := w.tokens.Next()
	opts, err := pack(moveToActiveOptions{
		Token:        token,
		LockDuration: w.opts.LockDuration.Milliseconds(),
		Name:         w.opts.Name,
		Limiter:      w.opts.Limiter,
	})
	if err != nil {
		return nil, 0, 0, err
	}
	result, err := ScriptMoveToActive.Run(ctx, w.commands,
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
		time.Now().UnixMilli(),
		opts,
	).Result()
	if err != nil {
		return nil, 0, 0, err
	}
	values, ok := result.([]any)
	if !ok || len(values) < 4 {
		return nil, 0, 0, fmt.Errorf("bullmq: unexpected moveToActive result %T", result)
	}
	limiterDelay := toInt64(values[2])
	delayUntil := toInt64(values[3])
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return nil, limiterDelay, delayUntil, nil
	}
	jobID := toText(values[1])
	job, err := jobFromFlat(flat, token, jobID, w.keys)
	if err != nil {
		return nil, limiterDelay, delayUntil, err
	}
	if job.ID == "" {
		// The wait entry outlived its job hash; drop our active entry and release
		// the lock so the stale id does not linger.
		_ = w.commands.LRem(ctx, w.keys.Active, 1, jobID).Err()
		w.release(ctx, jobID, token)
		return nil, limiterDelay, delayUntil, fmt.Errorf("bullmq: job hash missing")
	}
	return job, limiterDelay, delayUntil, nil
}

// ProcessOne runs the processor while keeping the lock fresh, then finalizes the
// job according to the failure policy.
func (w *Worker) ProcessOne(ctx context.Context, job *Job) {
	_ = ctx
	parent := w.jobCtx
	if parent == nil {
		parent = context.Background()
	}
	jobCtx, cancelJob := context.WithCancelCause(parent)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	safego.Go("bullmq.worker.renewLock", func() {
		w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)
	})

	var (
		result json.RawMessage
		err    error
	)
	if w.opts.OnClaim != nil {
		w.opts.OnClaim(jobCtx, job)
	}
	if job.DeferredFailure != "" && !w.opts.ProcessDeferredFailure {
		// The stalled checker already decided this job is terminal. Run nothing:
		// the pipeline must not repeat side effects for an attempt BullMQ has
		// already failed.
		err = &UnrecoverableError{err: errors.New(job.DeferredFailure)}
	} else {
		err = safego.Call("bullmq.worker.process", func() error {
			var processErr error
			result, processErr = w.processor(jobCtx, job)
			return processErr
		})
		if job.DeferredFailure != "" && err == nil {
			// The handler advanced the terminal state successfully; the BullMQ
			// acknowledgement must still be a failure, never completed.
			err = errors.New(job.DeferredFailure)
		}
	}
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx != nil && w.jobCtx.Err() != nil {
		// Shutdown deadline: leave the job active. Its lock expires and stalled
		// recovery hands it to the next owner.
		return
	}
	if leaseLost.Load() || (w.opts.IsLeaseLost != nil && w.opts.IsLeaseLost(err)) {
		w.opts.Logger("bullmq: lease lost for job %s; leaving it to stalled recovery", job.ID)
		return
	}
	// A processor that already performed the BullMQ transition (or requeued the
	// job) returns Handled; the worker must not acknowledge it a second time.
	var handled *HandledError
	if errors.As(err, &handled) {
		return
	}
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinish()
	if err == nil {
		w.finishCompleted(finishCtx, job, result)
		return
	}
	decision := w.decideFailure(job, err)
	if decision.Final {
		w.finishFailed(finishCtx, job, err)
	} else if decision.DelayMillis > 0 {
		w.retryLater(finishCtx, job, err, decision.DelayMillis)
	} else {
		w.retryJob(finishCtx, job, err)
	}
	if w.opts.OnFailure != nil {
		attemptsMade := int(job.AttemptsMade) + 1
		remaining := int(job.Attempts()) - attemptsMade
		if remaining < 0 {
			remaining = 0
		}
		w.opts.OnFailure(finishCtx, job, FailureInfo{
			AttemptsMade:      attemptsMade,
			RemainingAttempts: remaining,
			Permanent:         decision.Permanent,
			FinalFailure:      decision.Final,
			Cause:             originalError(err),
		})
	}
}

// decideFailure applies the queue's failure policy (default: BullMQ attempts and
// backoff plus the marker errors).
func (w *Worker) decideFailure(job *Job, err error) FailureDecision {
	if w.opts.FailurePolicy != nil {
		return w.opts.FailurePolicy(job, err)
	}
	return defaultFailureDecision(job, err)
}

func defaultFailureDecision(job *Job, err error) FailureDecision {
	if job.DeferredFailure != "" {
		return FailureDecision{Final: true, Permanent: true}
	}
	var unrecoverable *UnrecoverableError
	if errors.As(err, &unrecoverable) {
		return FailureDecision{Final: true, Permanent: true}
	}
	var retryAfter *RetryAfterError
	if errors.As(err, &retryAfter) {
		return FailureDecision{Final: false, DelayMillis: retryAfter.delay.Milliseconds()}
	}
	attemptsMade := job.AttemptsMade + 1
	remaining := job.Attempts() - attemptsMade
	if remaining <= 0 {
		return FailureDecision{Final: true}
	}
	return FailureDecision{Final: false, DelayMillis: BackoffDelay(job.Backoff(), attemptsMade)}
}

// originalError strips the bullmq marker wrappers so listeners see the same
// error value they returned.
func originalError(err error) error {
	var unrecoverable *UnrecoverableError
	if errors.As(err, &unrecoverable) && unrecoverable.err != nil {
		return unrecoverable.err
	}
	var retryAfter *RetryAfterError
	if errors.As(err, &retryAfter) && retryAfter.err != nil {
		return retryAfter.err
	}
	return err
}

// renewLock extends the job lock every lockDuration/2 until done. A failed
// renewal or a lock owned by another token cancels the processor context.
func (w *Worker) renewLock(ctx context.Context, job *Job, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	interval := w.opts.LockRenewTime
	if interval <= 0 {
		interval = w.opts.LockDuration / 2
	}
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
			extended, err := ScriptExtendLock.Run(ctx, w.commands,
				[]string{w.keys.Job(job.ID) + ":lock", w.keys.Stalled},
				job.Token,
				w.opts.LockDuration.Milliseconds(),
				job.ID,
			).Int64()
			if err != nil {
				if ctx.Err() == nil {
					w.opts.Logger("bullmq: renew lock %s: %v", job.ID, err)
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

// ErrLeaseLost is the cancel cause used when lock renewal fails or the lock
// belongs to another token.
var ErrLeaseLost = errors.New("bullmq: job lock was lost")

// HandledError tells the worker that the processor has already performed the
// job's BullMQ transition itself (completed, failed, retried, delayed or
// requeued). The worker then skips its own finalization so the job is not
// acknowledged twice. It is the escape hatch for a queue whose business
// classification drives the transition (for example a rate-limit requeue that
// must not consume an attempt).
type HandledError struct{ err error }

func (e *HandledError) Error() string {
	if e == nil || e.err == nil {
		return "bullmq: job already handled"
	}
	return e.err.Error()
}

func (e *HandledError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.err
}

// Handled wraps err so the worker leaves the job's state to the processor. A nil
// err still yields a non-nil sentinel (it must be returned from the processor to
// reach the worker).
func Handled(err error) error { return &HandledError{err: err} }

// FinishCompleted acknowledges a job as completed. Exported for the historical
// low-level tests; the fetch loop uses it internally.
func (w *Worker) FinishCompleted(ctx context.Context, job *Job, value json.RawMessage) {
	w.finishCompleted(ctx, job, value)
}

// FinishFailed acknowledges a job as terminally failed.
func (w *Worker) FinishFailed(ctx context.Context, job *Job, cause error) {
	w.finishFailed(ctx, job, cause)
}

// CheckStalled runs one stalled-recovery pass.
func (w *Worker) CheckStalled(ctx context.Context) { w.checkStalled(ctx) }

func (w *Worker) finishCompleted(ctx context.Context, job *Job, value json.RawMessage) {
	opts, err := pack(newFinishOptions(job, job.Token, w.keepOnComplete(job), w.opts.LockDuration))
	if err != nil {
		w.opts.Logger("bullmq: pack completion options for %s: %v", job.ID, err)
		return
	}
	returnValue := "null"
	if len(value) > 0 {
		returnValue = string(value)
	}
	result, err := ScriptMoveToFinished.Run(ctx, w.commands,
		w.finishKeys(job.ID, w.keys.Completed, "metrics:completed"),
		job.ID,
		time.Now().UnixMilli(),
		"returnvalue",
		returnValue,
		"completed",
		0,
		w.keys.Base,
		opts,
	).Result()
	if err != nil {
		w.opts.Logger("bullmq: finish completed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("bullmq: finish completed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) finishFailed(ctx context.Context, job *Job, cause error) {
	reason := w.failureReason(cause)
	fields, err := pack([]string{
		"failedReason", reason,
		"stacktrace", w.stacktrace(reason),
	})
	if err != nil {
		w.opts.Logger("bullmq: pack failure fields for %s: %v", job.ID, err)
		return
	}
	opts, err := pack(newFinishOptions(job, job.Token, w.keepOnFail(job), w.opts.LockDuration))
	if err != nil {
		w.opts.Logger("bullmq: pack failure options for %s: %v", job.ID, err)
		return
	}
	result, err := ScriptMoveToFinished.Run(ctx, w.commands,
		w.finishKeys(job.ID, w.keys.Failed, "metrics:failed"),
		job.ID,
		time.Now().UnixMilli(),
		"failedReason",
		reason,
		"failed",
		0,
		w.keys.Base,
		opts,
		fields,
	).Result()
	if err != nil {
		w.opts.Logger("bullmq: finish failed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("bullmq: finish failed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) retryJob(ctx context.Context, job *Job, cause error) {
	reason := w.failureReason(cause)
	fields, err := pack([]string{
		"failedReason", reason,
		"stacktrace", w.stacktrace(reason),
	})
	if err != nil {
		w.opts.Logger("bullmq: pack retry fields for %s: %v", job.ID, err)
		return
	}
	pushCommand := "LPUSH"
	if job.Options().Lifo {
		pushCommand = "RPUSH"
	}
	result, err := ScriptRetryJob.Run(ctx, w.commands,
		[]string{
			w.keys.Active,
			w.keys.Wait,
			w.keys.Paused,
			w.keys.Job(job.ID),
			w.keys.Meta,
			w.keys.Events,
			w.keys.Delayed,
			w.keys.Prioritized,
			w.keys.PC,
			w.keys.Marker,
			w.keys.Stalled,
		},
		w.keys.Base,
		time.Now().UnixMilli(),
		pushCommand,
		job.ID,
		job.Token,
		fields,
	).Result()
	if err != nil {
		w.opts.Logger("bullmq: retry %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("bullmq: retry %s rejected with BullMQ code %d", job.ID, code)
	}
}

// retryLater moves the job to the delayed set with the given backoff delay.
func (w *Worker) retryLater(ctx context.Context, job *Job, cause error, delayMS int64) {
	reason := w.failureReason(cause)
	fields, err := pack([]string{
		"failedReason", reason,
		"stacktrace", w.stacktrace(reason),
	})
	if err != nil {
		w.opts.Logger("bullmq: pack retry fields for %s: %v", job.ID, err)
		return
	}
	result, err := ScriptMoveToDelayed.Run(ctx, w.commands,
		[]string{
			w.keys.Marker,
			w.keys.Active,
			w.keys.Prioritized,
			w.keys.Delayed,
			w.keys.Job(job.ID),
			w.keys.Events,
			w.keys.Meta,
			w.keys.Stalled,
		},
		w.keys.Base,
		time.Now().UnixMilli(),
		job.ID,
		job.Token,
		delayMS,
		"0",
		fields,
	).Result()
	if err != nil {
		w.opts.Logger("bullmq: retry later %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("bullmq: retry later %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) release(ctx context.Context, jobID, token string) error {
	script := `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`
	return w.commands.Eval(ctx, script, []string{w.keys.Job(jobID) + ":lock"}, token).Err()
}

func (w *Worker) finishKeys(jobID, target, metricsSuffix string) []string {
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
		w.keys.Job(jobID),
		w.keys.Base + metricsSuffix,
		w.keys.Marker,
	}
}

func (w *Worker) stalledLoop(ctx context.Context) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			_ = safego.Call("bullmq.worker.checkStalled", func() error {
				w.checkStalled(ctx)
				return nil
			})
			timer.Reset(w.opts.StalledInterval)
		}
	}
}

func (w *Worker) checkStalled(ctx context.Context) {
	result, err := ScriptMoveStalledJobsToWait.Run(ctx, w.commands,
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
		w.opts.MaxStalledCount,
		w.keys.Base,
		time.Now().UnixMilli(),
		w.opts.StalledInterval.Milliseconds(),
	).Result()
	if err != nil {
		if ctx.Err() == nil {
			w.opts.Logger("bullmq: stalled recovery: %v", err)
		}
		return
	}
	if values, ok := result.([]any); ok && len(values) > 0 {
		w.opts.Logger("bullmq: recovered %d stalled job(s)", len(values))
	}
}

func (w *Worker) failureReason(cause error) string {
	if cause == nil {
		return ""
	}
	reason := cause.Error()
	limit := w.opts.FailureReasonLimit
	if limit <= 0 {
		return reason
	}
	runes := []rune(reason)
	if len(runes) <= limit {
		return reason
	}
	if limit <= 3 {
		return string(runes[:limit])
	}
	return string(runes[:limit-3]) + "..."
}

func (w *Worker) stacktrace(reason string) string {
	if w.opts.Stacktrace != nil {
		return w.opts.Stacktrace(reason)
	}
	return "[]"
}

func (w *Worker) keepOnComplete(job *Job) KeepJobs {
	if keep, ok := job.keepOnComplete(); ok {
		return keep
	}
	if w.opts.RemoveOnComplete.Count != nil || w.opts.RemoveOnComplete.Age != nil {
		return w.opts.RemoveOnComplete
	}
	return keepForever()
}

func (w *Worker) keepOnFail(job *Job) KeepJobs {
	if keep, ok := job.keepOnFail(); ok {
		return keep
	}
	if w.opts.RemoveOnFail.Count != nil || w.opts.RemoveOnFail.Age != nil {
		return w.opts.RemoveOnFail
	}
	return keepForever()
}

// moveToActiveOptions is the MessagePack object the moveToActive Lua command
// expects.
type moveToActiveOptions struct {
	Token        string   `msgpack:"token"`
	LockDuration int64    `msgpack:"lockDuration"`
	Name         string   `msgpack:"name,omitempty"`
	Limiter      *Limiter `msgpack:"limiter"`
}

// finishOptions is the MessagePack object moveToFinished expects. maxMetricsSize
// is always the empty string when metrics are disabled; sending nil would make
// the Lua `~= ""` check true and call collectMetrics with a nil bound.
type finishOptions struct {
	Token          string   `msgpack:"token"`
	KeepJobs       KeepJobs `msgpack:"keepJobs"`
	LockDuration   int64    `msgpack:"lockDuration"`
	Attempts       int64    `msgpack:"attempts"`
	MaxMetricsSize string   `msgpack:"maxMetricsSize"`
}

func newFinishOptions(job *Job, token string, keep KeepJobs, lockDuration time.Duration) finishOptions {
	if lockDuration <= 0 {
		lockDuration = 30 * time.Second
	}
	return finishOptions{
		Token:          token,
		KeepJobs:       keep,
		LockDuration:   int64(lockDuration / time.Millisecond),
		Attempts:       job.Attempts(),
		MaxMetricsSize: "",
	}
}

// jobFromFlat decodes the flat HGETALL array moveToActive returns.
func jobFromFlat(flat []any, token, jobID string, keys Keys) (*Job, error) {
	fields := make(map[string]string, len(flat)/2)
	for index := 0; index+1 < len(flat); index += 2 {
		fields[toText(flat[index])] = toText(flat[index+1])
	}
	if jobID == "" {
		jobID = fields["id"]
	}
	job := &Job{
		ID:              jobID,
		Name:            fields["name"],
		Token:           token,
		Timestamp:       toInt64(fields["timestamp"]),
		AttemptsMade:    toInt64(fields["atm"]),
		AttemptsStarted: toInt64(fields["ats"]),
		StalledCount:    toInt64(fields["stc"]),
		DeferredFailure: fields["defa"],
		RepeatJobKey:    fields["rjk"],
	}
	if job.AttemptsMade == 0 {
		job.AttemptsMade = toInt64(fields["attemptsMade"])
	}
	data := fields["data"]
	if data == "" {
		data = "{}"
	}
	job.Data = json.RawMessage(data)
	if raw := fields["opts"]; raw != "" {
		job.Opts = json.RawMessage(raw)
	} else {
		job.Opts = json.RawMessage("{}")
	}
	return job, nil
}

// tokenSource produces a unique BullMQ lock token per fetched job.
type tokenSource struct {
	id      string
	counter atomic.Uint64
}

func newTokenSource() *tokenSource {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return &tokenSource{id: "api-go"}
	}
	return &tokenSource{id: "api-go-" + hex.EncodeToString(buf[:])}
}

func (t *tokenSource) Next() string {
	return t.id + ":" + strconv.FormatUint(t.counter.Add(1), 10)
}

// BackoffDelay mirrors BullMQ's exponential strategy:
// round(2^(attemptsMade-1) * delay) for "exponential" (the default when empty),
// the fixed delay for "fixed", and no delay otherwise.
func BackoffDelay(backoff *Backoff, attemptsMade int64) int64 {
	if backoff == nil {
		return 0
	}
	switch backoff.Type {
	case "fixed":
		return backoff.Delay
	case "exponential", "":
		if attemptsMade < 1 {
			attemptsMade = 1
		}
		if attemptsMade > 32 {
			attemptsMade = 32
		}
		return int64(math.Round(math.Pow(2, float64(attemptsMade-1)) * float64(backoff.Delay)))
	default:
		return backoff.Delay
	}
}

func pack(value any) ([]byte, error) {
	encoded, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("bullmq: pack msgpack: %w", err)
	}
	return encoded, nil
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
		parsed, _ := strconv.ParseInt(typed, 10, 64)
		return parsed
	case []byte:
		parsed, _ := strconv.ParseInt(string(typed), 10, 64)
		return parsed
	case float64:
		return int64(typed)
	default:
		return 0
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

// keepForever is BullMQ's keepJobs fallback when neither the job nor the worker
// sets a retention option: keep the finished job (count -1).
func keepForever() KeepJobs {
	count := int64(-1)
	return KeepJobs{Count: &count}
}
