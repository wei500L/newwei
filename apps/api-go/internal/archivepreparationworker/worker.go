package archivepreparationworker

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Processor runs one claimed job. It must stop writing when ctx is canceled
// (worker shutdown or a lost lease). Returning a *LeaseLostError means this
// attempt lost the BullMQ lock; the worker then leaves the job in the active
// list for stalled recovery instead of acknowledging it.
type Processor func(ctx context.Context, job Job) error

// WorkerOptions are the fixed BullMQ 5.63.2 worker defaults plus the
// concurrency derived from NEWS_PROCESS_QUEUE_CONCURRENCY.
type WorkerOptions struct {
	Concurrency     int
	Prefix          string
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Processor       Processor
	// OnFailure runs once for every failed attempt before BullMQ retries or
	// terminally fails the job. The archive preparation status record mirrors
	// the NestJS in-process Worker 'failed' event, which fires on every
	// attempt rather than only on the last one.
	OnFailure func(ctx context.Context, job Job, cause error)
	Logger    func(format string, args ...any)
}

func (o WorkerOptions) normalized() WorkerOptions {
	if o.Concurrency < 1 {
		o.Concurrency = 1
	}
	if o.Prefix == "" {
		o.Prefix = DefaultPrefix
	}
	if o.LockDuration <= 0 {
		o.LockDuration = LockDuration
	}
	if o.LockRenewTime <= 0 {
		o.LockRenewTime = o.LockDuration / 2
	}
	if o.StalledInterval <= 0 {
		o.StalledInterval = StalledInterval
	}
	// BullMQ's worker default is one stalled recovery. Treat the zero value as
	// "use the default" so an unset option never means "fail on the first
	// stall" (moveStalledJobsToWait fails a job once stalledCount exceeds the
	// limit).
	if o.MaxStalledCount < 1 {
		o.MaxStalledCount = MaxStalledCount
	}
	if o.DrainDelay <= 0 {
		o.DrainDelay = DrainDelay
	}
	if o.Logger == nil {
		o.Logger = log.Printf
	}
	return o
}

// Worker consumes the archivePreparation BullMQ queue with the
// official Lua state machine. It owns a dedicated blocking Redis client
// (provided by the caller) because a connection blocked on BZPOPMIN cannot run
// commands; the shared command client stays owned by main and is not closed.
//
// Lease lifecycle: moveToActive creates the per-job lock and a fresh token; the
// renewal goroutine extends it every lockDuration/2. A renewal failure or a
// lock that belongs to another token cancels the handler context, so the
// handler cannot write a terminal state. The worker never deletes another
// executor's active entry or lock.
type Worker struct {
	client      *redis.Client
	blocking    *redis.Client
	keys        keys
	scripts     queueScripts
	opts        WorkerOptions
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

// NewWorker builds a worker over the shared command client and a dedicated
// blocking client. Close closes only the blocking client.
func NewWorker(client, blocking *redis.Client, opts WorkerOptions) (*Worker, error) {
	if client == nil || blocking == nil {
		return nil, fmt.Errorf("archivepreparationworker: worker requires command and blocking redis clients")
	}
	if opts.Processor == nil {
		return nil, fmt.Errorf("archivepreparationworker: worker requires a processor")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	normalized := opts.normalized()
	return &Worker{
		client:   client,
		blocking: blocking,
		keys:     newKeys(normalized.Prefix, QueueName),
		scripts:  scripts,
		opts:     normalized,
		tokens:   newTokenSource(),
		slots:    make(chan struct{}, normalized.Concurrency),
	}, nil
}

// Start verifies both Redis clients and starts the fetch loop and the stalled
// checker. It returns immediately; Close performs the ordered drain.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil {
		return fmt.Errorf("archivepreparationworker: worker is nil")
	}
	if !w.started.CompareAndSwap(false, true) {
		return fmt.Errorf("archivepreparationworker: worker already started")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := w.client.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("archivepreparationworker: redis ping failed: %w", err)
	}
	if err := w.blocking.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("archivepreparationworker: blocking redis ping failed: %w", err)
	}
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
	return nil
}

// Close stops claiming new jobs, drains in-flight jobs while their locks keep
// renewing, and cancels the handlers at the deadline. It then stops the stalled
// checker and closes the dedicated blocking client. Jobs that were cancelled
// remain in the active list; their locks expire and BullMQ stalled recovery
// hands them to the next attempt (which is a new BullMQ job attempt, not a Go
// restart).
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
		// The fetch loop is the only goroutine that calls wg.Add. Wait for it
		// to stop before waiting on the in-flight jobs, so a new Add cannot
		// race the Wait.
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
				closeErr = fmt.Errorf("archivepreparationworker: in-flight jobs did not stop before the shutdown deadline")
			}
		}
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil {
				w.opts.Logger("archivepreparationworker: close blocking redis: %v", err)
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

		job, delayUntil, err := w.moveToActive(ctx)
		if err != nil {
			<-w.slots
			if ctx.Err() != nil {
				return
			}
			w.opts.Logger("archivepreparationworker: fetch job: %v", err)
			if !sleepContext(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			<-w.slots
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
		go func(job Job) {
			defer w.wg.Done()
			defer func() { <-w.slots }()
			w.process(ctx, job)
		}(*job)
	}
}

// isPaused checks the queue meta hash; a paused queue must not be claimed even
// when the wait list has jobs. The check is best effort: on a Redis error the
// fetch proceeds and moveToActive's own paused check still protects the queue.
func (w *Worker) isPaused(ctx context.Context) bool {
	paused, err := w.client.HExists(ctx, w.keys.Meta, "paused").Result()
	return err == nil && paused
}

func (w *Worker) waitForMarker(ctx context.Context) {
	timeout := w.opts.DrainDelay
	if timeout <= 0 {
		timeout = DrainDelay
	}
	_, err := w.blocking.BZPopMin(ctx, timeout, w.keys.Marker).Result()
	if err != nil && !errors.Is(err, redis.Nil) && ctx.Err() == nil {
		w.opts.Logger("archivepreparationworker: wait for marker: %v", err)
		if !sleepContext(ctx, time.Second) {
			return
		}
	}
}

func (w *Worker) moveToActive(ctx context.Context) (*Job, int64, error) {
	token := w.tokens.Next()
	opts, err := pack(moveToActiveOptions{
		Token:        token,
		LockDuration: int64(w.opts.LockDuration / time.Millisecond),
	})
	if err != nil {
		return nil, 0, err
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
		time.Now().UnixMilli(),
		opts,
	).Result()
	if err != nil {
		return nil, 0, err
	}
	values, ok := result.([]any)
	if !ok || len(values) < 4 {
		return nil, 0, fmt.Errorf("archivepreparationworker: unexpected moveToActive result %T", result)
	}
	delayUntil := toInt64(values[3])
	flat, ok := values[0].([]any)
	if !ok || len(flat) == 0 {
		return nil, delayUntil, nil
	}
	job, err := jobFromFlat(flat, token, toText(values[1]))
	if err != nil {
		return nil, delayUntil, err
	}
	return &job, delayUntil, nil
}

func (w *Worker) process(parent context.Context, job Job) {
	_ = parent
	jobCtx, cancelJob := context.WithCancelCause(w.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)

	err := w.opts.Processor(jobCtx, job)
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx.Err() != nil {
		// Worker shutdown deadline: leave the job active. Its lock expires and
		// stalled recovery hands it to the next owner.
		return
	}
	var leaseErr *LeaseLostError
	if errors.As(err, &leaseErr) || leaseLost.Load() {
		w.opts.Logger("archivepreparationworker: lease lost for job %s; leaving it to stalled recovery", job.ID)
		return
	}
	// Acknowledging must not inherit the fetch-loop context: Close cancels it
	// to stop new claims while in-flight jobs are still draining and renewing
	// their locks.
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinish()
	if err != nil && w.opts.OnFailure != nil {
		w.opts.OnFailure(finishCtx, job, err)
	}
	if err == nil {
		w.finishCompleted(finishCtx, job)
		return
	}
	if !job.FinalFailure() {
		w.retryJob(finishCtx, job, err)
		return
	}
	w.finishFailed(finishCtx, job, err)
}

// renewLock extends the job lock every lockDuration/2. A failed renewal or a
// lock owned by another token cancels the handler: the attempt stops writing
// and cannot record a terminal state.
func (w *Worker) renewLock(ctx context.Context, job Job, cancel context.CancelCauseFunc, lost *atomic.Bool, done <-chan struct{}) {
	ticker := time.NewTicker(w.opts.LockRenewTime)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			extended, err := w.scripts.extendLock.Run(ctx, w.client,
				[]string{w.keys.Job(job.ID) + ":lock", w.keys.Stalled},
				job.Token,
				int64(w.opts.LockDuration/time.Millisecond),
				job.ID,
			).Int64()
			if err != nil {
				if ctx.Err() == nil {
					w.opts.Logger("archivepreparationworker: renew lock %s: %v", job.ID, err)
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

func (w *Worker) finishCompleted(ctx context.Context, job Job) {
	opts, err := pack(newFinishOptions(job, job.Token, KeepOnComplete(job.Opts), w.opts.LockDuration))
	if err != nil {
		w.opts.Logger("archivepreparationworker: pack completion options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
		w.finishKeys(job.ID, w.keys.Completed, "metrics:completed"),
		job.ID,
		time.Now().UnixMilli(),
		"returnvalue",
		"null",
		"completed",
		0,
		w.keys.Base,
		opts,
	).Result()
	if err != nil {
		w.opts.Logger("archivepreparationworker: finish completed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("archivepreparationworker: finish completed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) finishFailed(ctx context.Context, job Job, cause error) {
	reason := cause.Error()
	fields, err := pack([]string{
		"failedReason", reason,
		"stacktrace", stacktraceJSON(reason),
	})
	if err != nil {
		w.opts.Logger("archivepreparationworker: pack failure fields for %s: %v", job.ID, err)
		return
	}
	opts, err := pack(newFinishOptions(job, job.Token, KeepOnFail(job.Opts), w.opts.LockDuration))
	if err != nil {
		w.opts.Logger("archivepreparationworker: pack failure options for %s: %v", job.ID, err)
		return
	}
	result, err := w.scripts.moveToFinished.Run(ctx, w.client,
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
		w.opts.Logger("archivepreparationworker: finish failed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("archivepreparationworker: finish failed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) retryJob(ctx context.Context, job Job, cause error) {
	reason := cause.Error()
	fields, err := pack([]string{
		"failedReason", reason,
		"stacktrace", stacktraceJSON(reason),
	})
	if err != nil {
		w.opts.Logger("archivepreparationworker: pack retry fields for %s: %v", job.ID, err)
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
		w.opts.Logger("archivepreparationworker: retry %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("archivepreparationworker: retry %s rejected with BullMQ code %d", job.ID, code)
	}
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
			w.checkStalled(ctx)
			timer.Reset(w.opts.StalledInterval)
		}
	}
}

func (w *Worker) checkStalled(ctx context.Context) {
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
		w.opts.MaxStalledCount,
		w.keys.Base,
		time.Now().UnixMilli(),
		int64(w.opts.StalledInterval/time.Millisecond),
	).Result()
	if err != nil {
		if ctx.Err() == nil {
			w.opts.Logger("archivepreparationworker: stalled recovery: %v", err)
		}
		return
	}
	if values, ok := result.([]any); ok && len(values) > 0 {
		w.opts.Logger("archivepreparationworker: recovered %d stalled job(s)", len(values))
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
