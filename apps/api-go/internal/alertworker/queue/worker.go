package queue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// Processor runs one claimed job. Returning a *DelayedError asks the worker to
// move the job to the delayed set without consuming an attempt (the NestJS
// `job.moveToDelayed(ts, token)` + `throw new DelayedError()` pattern);
// returning any other error goes through BullMQ's retry/backoff decision.
type Processor func(ctx context.Context, job Job, handle JobHandle) error

// JobHandle exposes the one BullMQ job operation the delivery handler needs.
// It is valid only while the attempt runs.
type JobHandle struct {
	worker *Worker
	job    Job
}

// UpdateData replaces the job hash `data` field, equivalent to
// `job.updateData(data)`: BullMQ writes the JSON through the updateData
// script.
func (h JobHandle) UpdateData(ctx context.Context, data []byte) error {
	if h.worker == nil {
		return errors.New("alertworker/queue: job handle without a worker")
	}
	result, err := h.worker.scripts.updateData.Run(ctx, h.worker.client,
		[]string{h.worker.keys.Job(h.job.ID)}, data,
	).Result()
	if err != nil {
		return fmt.Errorf("alertworker/queue: update job data %s: %w", h.job.ID, err)
	}
	if code := toInt64(result); code < 0 {
		return fmt.Errorf("alertworker/queue: update job data %s rejected with BullMQ code %d", h.job.ID, code)
	}
	return nil
}

// WorkerOptions are the BullMQ 5.63.2 worker defaults plus the two settings the
// alerts processor overrides: concurrency and the custom backoff strategy.
type WorkerOptions struct {
	Concurrency     int
	Prefix          string
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Processor       Processor
	// BackoffDelay mirrors settings.backoffStrategy(attemptsMade+1, type). It is
	// only consulted for backoff types that are not BullMQ's built-ins.
	BackoffDelay func(attemptsMade int, backoffType string) (int64, bool)
	Logger       func(format string, args ...any)
}

func (o WorkerOptions) normalized() WorkerOptions {
	if o.Concurrency < 1 {
		o.Concurrency = 1
	}
	if o.Prefix == "" {
		o.Prefix = Prefix
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
	if o.MaxStalledCount < 0 {
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

// Worker consumes the `alerts` BullMQ queue with the official Lua state
// machine. It owns a dedicated blocking Redis connection, because a connection
// blocked on BZPOPMIN cannot run commands; the shared command connection stays
// owned by main.
type Worker struct {
	client      *redis.Client
	blocking    *redis.Client
	keys        Keys
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
		return nil, errors.New("alertworker/queue: worker requires command and blocking redis clients")
	}
	if opts.Processor == nil {
		return nil, errors.New("alertworker/queue: worker requires a processor")
	}
	scripts, err := loadQueueScripts()
	if err != nil {
		return nil, err
	}
	normalized := opts.normalized()
	return &Worker{
		client:   client,
		blocking: blocking,
		keys:     NewKeys(normalized.Prefix, QueueName),
		scripts:  scripts,
		opts:     normalized,
		tokens:   newTokenSource(),
		slots:    make(chan struct{}, normalized.Concurrency),
	}, nil
}

// Start verifies both Redis connections and starts the fetch loop and the
// stalled checker. It returns immediately; Close performs the ordered drain.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil {
		return errors.New("alertworker/queue: worker is nil")
	}
	if !w.started.CompareAndSwap(false, true) {
		return errors.New("alertworker/queue: worker already started")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := w.client.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("alertworker/queue: redis ping failed: %w", err)
	}
	if err := w.blocking.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("alertworker/queue: blocking redis ping failed: %w", err)
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
// renewing, and cancels the handlers at the deadline. Jobs cancelled at the
// deadline stay in the active list; their locks expire and BullMQ stalled
// recovery hands them to the next attempt.
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
		// The fetch loop is the only goroutine that calls wg.Add, so it must
		// stop before wg.Wait.
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
				closeErr = errors.New("alertworker/queue: in-flight jobs did not stop before the shutdown deadline")
			}
		}
		if w.cancelJobs != nil {
			w.cancelJobs()
		}
		if w.blocking != nil {
			if err := w.blocking.Close(); err != nil {
				w.opts.Logger("alertworker/queue: close blocking redis: %v", err)
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

		next, err := w.moveToActive(ctx)
		if err != nil {
			<-w.slots
			if ctx.Err() != nil {
				return
			}
			w.opts.Logger("alertworker/queue: fetch job: %v", err)
			if !sleepContext(ctx, time.Second) {
				return
			}
			continue
		}
		job := next.Job
		if job == nil {
			<-w.slots
			if next.DelayUntil > time.Now().UnixMilli() {
				wait := time.Until(time.UnixMilli(next.DelayUntil))
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
			w.process(job)
		}(*job)
	}
}

// isPaused checks the queue meta hash; a paused queue must not be claimed. The
// check is best effort: moveToActive has its own paused check.
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
		w.opts.Logger("alertworker/queue: wait for marker: %v", err)
		if !sleepContext(ctx, time.Second) {
			return
		}
	}
}

func (w *Worker) moveToActive(ctx context.Context) (nextJobData, error) {
	token := w.tokens.Next()
	opts, err := MarshalMsgpack(moveToActiveOptions(token, int64(w.opts.LockDuration/time.Millisecond)))
	if err != nil {
		return nextJobData{}, err
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
		return nextJobData{}, err
	}
	return nextJobDataFromResult(result, token)
}

func (w *Worker) process(job Job) {
	// BullMQ reschedules the following repeat iteration while the worker fetches
	// the current one; a scheduling failure leaves the job active for stalled
	// recovery instead of processing it (Worker.nextJobFromJobData).
	if err := w.rescheduleRepeat(w.fetchCtx, job); err != nil {
		w.opts.Logger("alertworker/queue: reschedule repeat for job %s: %v", job.ID, err)
		return
	}

	jobCtx, cancelJob := context.WithCancelCause(w.jobCtx)
	var leaseLost atomic.Bool
	renewDone := make(chan struct{})
	go w.renewLock(jobCtx, job, cancelJob, &leaseLost, renewDone)

	err := w.opts.Processor(jobCtx, job, JobHandle{worker: w, job: job})
	close(renewDone)
	cancelJob(nil)

	if w.jobCtx.Err() != nil {
		// Shutdown deadline: leave the job active; its lock expires and stalled
		// recovery hands it to the next owner.
		return
	}
	if leaseLost.Load() {
		w.opts.Logger("alertworker/queue: lease lost for job %s; leaving it to stalled recovery", job.ID)
		return
	}
	// Acknowledging must not inherit the fetch-loop context: Close cancels it to
	// stop new claims while in-flight jobs still drain.
	finishCtx, cancelFinish := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelFinish()

	var delayed *DelayedError
	if errors.As(err, &delayed) {
		w.moveToDelayed(finishCtx, job, delayed.UntilMs, true, nil)
		return
	}
	if err == nil {
		w.finishCompleted(finishCtx, job)
		return
	}
	if job.FinalFailure() {
		w.finishFailed(finishCtx, job, err)
		return
	}
	// BullMQ recomputes the retry delay from the attempt that just failed:
	// Backoffs.calculate(backoff, attemptsMade + 1, ...).
	delayMs, ok := w.backoffDelay(job, err)
	if !ok {
		w.opts.Logger("alertworker/queue: no backoff strategy %v for job %s; failing it", job.Opts.Backoff, job.ID)
		w.finishFailed(finishCtx, job, err)
		return
	}
	reason := err.Error()
	if delayMs > 0 {
		w.moveToDelayed(finishCtx, job, time.Now().UnixMilli()+delayMs, false, failureFields(reason))
		return
	}
	w.retryJob(finishCtx, job, reason)
}

// backoffDelay mirrors Backoffs.calculate + lookupStrategy: built-ins first,
// then the worker's custom strategy.
func (w *Worker) backoffDelay(job Job, cause error) (int64, bool) {
	backoff := job.Opts.Backoff
	if backoff == nil {
		return 0, true
	}
	attempt := job.AttemptsMade + 1
	switch backoff.Type {
	case "fixed":
		if backoff.Delay == nil {
			return 0, true
		}
		return int64(*backoff.Delay), true
	case "exponential":
		delay := 0.0
		if backoff.Delay != nil {
			delay = *backoff.Delay
		}
		return int64(math.Round(math.Pow(2, float64(attempt-1)) * delay)), true
	default:
		if w.opts.BackoffDelay == nil {
			return 0, false
		}
		return w.opts.BackoffDelay(attempt, backoff.Type)
	}
}

// renewLock extends the job lock every lockDuration/2. A failed renewal or a
// lock owned by another token cancels the handler, so the attempt stops and
// cannot write a terminal state for a job it no longer owns.
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
					w.opts.Logger("alertworker/queue: renew lock %s: %v", job.ID, err)
				}
				lost.Store(true)
				cancel(errors.New("alertworker/queue: lock renewal failed"))
				return
			}
			if extended == 0 {
				lost.Store(true)
				cancel(errors.New("alertworker/queue: lock is owned by another worker"))
				return
			}
		}
	}
}

func (w *Worker) finishCompleted(ctx context.Context, job Job) {
	opts, err := MarshalMsgpack(finishOptions(job, job.Token, KeepOnComplete(job.Opts)))
	if err != nil {
		w.opts.Logger("alertworker/queue: pack completion options for %s: %v", job.ID, err)
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
		w.opts.Logger("alertworker/queue: finish completed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("alertworker/queue: finish completed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) finishFailed(ctx context.Context, job Job, cause error) {
	reason := cause.Error()
	fields, err := MarshalMsgpack(failureFields(reason))
	if err != nil {
		w.opts.Logger("alertworker/queue: pack failure fields for %s: %v", job.ID, err)
		return
	}
	opts, err := MarshalMsgpack(finishOptions(job, job.Token, KeepOnFail(job.Opts)))
	if err != nil {
		w.opts.Logger("alertworker/queue: pack failure options for %s: %v", job.ID, err)
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
		w.opts.Logger("alertworker/queue: finish failed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("alertworker/queue: finish failed %s rejected with BullMQ code %d", job.ID, code)
	}
}

// moveToDelayed moves the job to the delayed set. skipAttempt is true for the
// rate-limit path (BullMQ Job.moveToDelayed, `atm` untouched) and false for the
// retry path (BullMQ Job.moveToFailed, `atm` incremented once).
func (w *Worker) moveToDelayed(ctx context.Context, job Job, untilMs int64, skipAttempt bool, fields []any) {
	nowMs := time.Now().UnixMilli()
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
		packed, err := MarshalMsgpack(fields)
		if err != nil {
			w.opts.Logger("alertworker/queue: pack delayed fields for %s: %v", job.ID, err)
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
			w.keys.Job(job.ID),
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
		w.opts.Logger("alertworker/queue: move to delayed %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("alertworker/queue: move to delayed %s rejected with BullMQ code %d", job.ID, code)
	}
}

func (w *Worker) retryJob(ctx context.Context, job Job, reason string) {
	fields, err := MarshalMsgpack(failureFields(reason))
	if err != nil {
		w.opts.Logger("alertworker/queue: pack retry fields for %s: %v", job.ID, err)
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
		w.opts.Logger("alertworker/queue: retry %s: %v", job.ID, err)
		return
	}
	if code := toInt64(result); code < 0 {
		w.opts.Logger("alertworker/queue: retry %s rejected with BullMQ code %d", job.ID, code)
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
			w.opts.Logger("alertworker/queue: stalled recovery: %v", err)
		}
		return
	}
	if values, ok := result.([]any); ok && len(values) > 0 {
		w.opts.Logger("alertworker/queue: recovered %d stalled job(s)", len(values))
	}
}

// rescheduleRepeat mirrors Worker.nextJobFromJobData: a fetched job that belongs
// to a repeat schedule schedules the next iteration before it is processed.
//
// A repeat key with fewer than five colon-separated segments is a hashed
// job-scheduler key and goes through JobScheduler.upsertJobScheduler
// ({override: false}), i.e. the updateJobScheduler script, which computes the
// next millis from the repeat hash. The legacy colon-bearing key branch
// (Repeat.updateRepeatableJob) is not implemented: every schedule in this queue
// is created with a hashed key by BullMQ 5.63.2, and re-scheduling an ancient
// pre-5 schedule is not part of the alert contract.
func (w *Worker) rescheduleRepeat(ctx context.Context, job Job) error {
	if job.RepeatJobKey == "" || job.Opts.Repeat == nil {
		return nil
	}
	if strings.Count(job.RepeatJobKey, ":")+1 >= 5 {
		w.opts.Logger("alertworker/queue: legacy repeat key %s for job %s is not rescheduled", job.RepeatJobKey, job.ID)
		return nil
	}
	every := job.Opts.Repeat.Every
	if every == nil || *every <= 0 {
		w.opts.Logger("alertworker/queue: repeat job %s has no every interval; not rescheduled", job.ID)
		return nil
	}
	merged, err := mergeRepeatOptions(job)
	if err != nil {
		return err
	}
	encodedOpts, err := MarshalMsgpack(merged)
	if err != nil {
		return err
	}
	templateData := job.Data
	if len(templateData) == 0 || !json.Valid(templateData) {
		templateData = []byte("{}")
	}
	// The script returns the id of the next delayed job or nil; only the error
	// matters here because the next iteration is not processed by this worker.
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
			w.keys.Job(job.ID),
			w.keys.Active,
		},
		// nextMillis stays empty: for an every schedule the script computes it
		// from the repeat hash (getJobSchedulerEveryNextMillis).
		"",
		job.RepeatJobKey,
		string(templateData),
		encodedOpts,
		time.Now().UnixMilli(),
		w.keys.Base,
		job.ID,
	).Result(); err != nil {
		return fmt.Errorf("alertworker/queue: update job scheduler %s: %w", job.RepeatJobKey, err)
	}
	return nil
}

// mergeRepeatOptions rebuilds the next iteration's options the way
// JobScheduler.upsertJobScheduler does for the {override: false} branch:
// `{...job.opts, jobId, delay, timestamp, prevMillis, repeat: {...repeat,
// offset: null, count: iterationCount}}` and then Job.optsAsJSON. Values the
// script overwrites anyway (jobId, delay) are still set, so the packed payload
// matches BullMQ's field for field.
func mergeRepeatOptions(job Job) (map[string]any, error) {
	repeat := job.Opts.Repeat
	count := int64(1)
	if repeat.Count != nil {
		count = *repeat.Count + 1
	}
	iteration := map[string]any{
		"every":     *repeat.Every,
		"offset":    nil,
		"count":     count,
		"startDate": nil,
		"endDate":   nil,
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
	merged := map[string]any{
		"jobId":     "repeat:" + job.RepeatJobKey + ":undefined",
		"delay":     math.NaN(),
		"timestamp": time.Now().UnixMilli(),
		"repeat":    iteration,
	}
	if job.Opts.Attempts != nil {
		merged["attempts"] = int64(*job.Opts.Attempts)
	}
	if keep, ok := decodeKeepJobs(job.Opts.RemoveOnComplete); ok {
		merged["removeOnComplete"] = keepJobsWire(keep)
	}
	if keep, ok := decodeKeepJobs(job.Opts.RemoveOnFail); ok {
		merged["removeOnFail"] = keepJobsWire(keep)
	}
	if job.Opts.LIFO {
		merged["lifo"] = true
	}
	if job.Opts.Priority != nil {
		merged["priority"] = int64(*job.Opts.Priority)
	}
	return merged, nil
}

// keepJobsWire rebuilds the JSON shape of a keepJobs option (boolean, number or
// {age, count}) for the MessagePack payload.
func keepJobsWire(keep KeepJobs) any {
	if keep.Age == nil && keep.Count != nil {
		switch *keep.Count {
		case -1:
			return false
		case 0:
			return true
		}
	}
	value := map[string]any{}
	if keep.Age != nil {
		value["age"] = *keep.Age
	}
	if keep.Count != nil {
		value["count"] = *keep.Count
	}
	return value
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
