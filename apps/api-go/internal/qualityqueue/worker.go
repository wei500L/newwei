package qualityqueue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"
)

// Handler processes one job. Returning an error triggers the BullMQ retry
// policy stored in the job options; returning nil moves the job to completed.
type Handler func(ctx context.Context, job Job) error

// WorkerOptions are the BullMQ worker settings this migration needs. The
// defaults mirror bullmq@5.63.2: 30s lock, 30s stalled interval, one allowed
// stall and a short poll interval for an empty queue.
type WorkerOptions struct {
	// Concurrency is the number of jobs processed at the same time. It is
	// capped by the caller, not here.
	Concurrency int
	// Name is stored as the job "processedBy" field.
	Name string
	// LockDuration is how long the job lock lives before it is considered
	// stale (BullMQ default 30s).
	LockDuration time.Duration
	// StalledInterval is how often the stalled checker runs (BullMQ default
	// 30s).
	StalledInterval time.Duration
	// MaxStalledCount is how many times a job may be recovered from a lost
	// lock before it is failed (BullMQ default 1).
	MaxStalledCount int
	// PollInterval is the wait between two empty moveToActive calls. BullMQ
	// blocks on Redis instead; polling keeps the Go worker free of a second
	// blocking connection.
	PollInterval time.Duration
}

// Worker consumes the classification_quality queue.
type Worker struct {
	queue   *Queue
	handler Handler
	opts    WorkerOptions
	stop    chan struct{}
	once    sync.Once
	wg      sync.WaitGroup
}

// NewWorker assembles a worker. A nil handler completes every job without doing
// anything, which is never what a caller wants; the wiring always passes one.
func NewWorker(queue *Queue, handler Handler, opts WorkerOptions) *Worker {
	if opts.Concurrency < 1 {
		opts.Concurrency = 1
	}
	if opts.LockDuration <= 0 {
		opts.LockDuration = 30 * time.Second
	}
	if opts.StalledInterval <= 0 {
		opts.StalledInterval = 30 * time.Second
	}
	// BullMQ's own default is 1; zero therefore selects the default instead
	// of "fail on the first recovered lock".
	if opts.MaxStalledCount <= 0 {
		opts.MaxStalledCount = 1
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = 200 * time.Millisecond
	}
	return &Worker{queue: queue, handler: handler, opts: opts, stop: make(chan struct{})}
}

// Start launches the consumer loops and the stalled checker. It returns
// immediately; the loops run until Stop or until ctx is cancelled.
func (w *Worker) Start(ctx context.Context) {
	for index := 0; index < w.opts.Concurrency; index++ {
		w.wg.Add(1)
		go func() {
			defer w.wg.Done()
			w.run(ctx)
		}()
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		w.runStalledChecks(ctx)
	}()
}

// Stop stops claiming new jobs and waits for in-flight jobs to finish. When ctx
// expires the worker stops waiting; the job locks then expire and the stalled
// checker re-delivers the jobs, which is the same recovery path BullMQ uses.
func (w *Worker) Stop(ctx context.Context) error {
	if w == nil {
		return nil
	}
	w.once.Do(func() { close(w.stop) })
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *Worker) run(ctx context.Context) {
	for {
		if w.stopping(ctx) {
			return
		}
		job, err := w.fetch(ctx)
		if err != nil {
			if w.stopping(ctx) {
				return
			}
			log.Printf("qualityqueue: claim job: %v", err)
			if !w.sleep(ctx, time.Second) {
				return
			}
			continue
		}
		if job == nil {
			if !w.sleep(ctx, w.opts.PollInterval) {
				return
			}
			continue
		}
		w.process(ctx, *job)
	}
}

// fetch claims one job with moveToActive. A nil job means the queue is empty or
// paused (the script returns the zero tuple).
func (w *Worker) fetch(ctx context.Context) (*Job, error) {
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	encodedOpts, err := pack(activeOptions{
		Token:        token,
		LockDuration: w.opts.LockDuration.Milliseconds(),
		Name:         w.opts.Name,
		Limiter:      nil,
	})
	if err != nil {
		return nil, err
	}
	keys := []string{
		w.queue.keys.wait(),
		w.queue.keys.active(),
		w.queue.keys.prioritized(),
		w.queue.keys.events(),
		w.queue.keys.stalled(),
		w.queue.keys.limiter(),
		w.queue.keys.delayed(),
		w.queue.keys.paused(),
		w.queue.keys.meta(),
		w.queue.keys.priorityCounter(),
		w.queue.keys.marker(),
	}
	result, err := scriptMoveToActive.Run(ctx, w.queue.rdb, keys,
		w.queue.keys.base, time.Now().UnixMilli(), string(encodedOpts)).Result()
	if err != nil {
		return nil, err
	}
	items, ok := result.([]any)
	if !ok || len(items) < 2 {
		return nil, fmt.Errorf("unexpected moveToActive reply %T", result)
	}
	jobID, _ := items[1].(string)
	if jobID == "" {
		return nil, nil
	}
	fields := map[string]string{}
	if raw, ok := items[0].([]any); ok {
		fields = flattenPairs(raw)
	}
	job := jobFromFields(jobID, fields, token)
	return &job, nil
}

// process runs one job while keeping its lock fresh, then finalizes it.
func (w *Worker) process(ctx context.Context, job Job) {
	jobCtx, cancel := context.WithCancel(ctx)
	renewed := make(chan struct{})
	go func() {
		defer close(renewed)
		w.renewLock(jobCtx, job.ID, job.Token)
	}()

	var handlerErr error
	if job.DeferredFailure != "" {
		// The stalled checker already decided this job must fail. BullMQ
		// raises an UnrecoverableError, so no retry is attempted.
		handlerErr = errors.New(job.DeferredFailure)
	} else if w.handler != nil {
		handlerErr = w.handler(jobCtx, job)
	}

	cancel()
	<-renewed

	if handlerErr == nil {
		w.finish(ctx, job, "completed", "returnvalue", "null", nil)
		return
	}
	w.handleFailure(ctx, job, handlerErr, job.DeferredFailure == "")
}

// renewLock extends the job lock until the job finishes. A zero reply means the
// lock is gone (the job was recovered by another worker), so renewing stops and
// the final finish call reports the lost lock.
func (w *Worker) renewLock(ctx context.Context, jobID, token string) {
	interval := w.opts.LockDuration / 2
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	keys := []string{w.queue.keys.lock(jobID), w.queue.keys.stalled()}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			result, err := scriptExtendLock.Run(ctx, w.queue.rdb, keys,
				token, w.opts.LockDuration.Milliseconds(), jobID).Result()
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("qualityqueue: extend lock for job %s: %v", jobID, err)
				}
				continue
			}
			if renewed, ok := result.(int64); ok && renewed == 0 {
				log.Printf("qualityqueue: lock for job %s is no longer owned; stopping renewal", jobID)
				return
			}
		}
	}
}

// handleFailure applies the retry policy stored in the job options and then
// either parks the job in the delayed set or moves it to failed.
func (w *Worker) handleFailure(ctx context.Context, job Job, failure error, retryable bool) {
	reason := failure.Error()
	if retryable && job.AttemptsMade+1 < job.Options.Attempts {
		delay := backoffDelay(job.Options.Backoff, job.AttemptsMade+1)
		if err := w.retryLater(ctx, job, reason, delay); err != nil {
			log.Printf("qualityqueue: delay retry for job %s: %v", job.ID, err)
		}
		return
	}
	w.finish(ctx, job, "failed", "failedReason", reason, failureFields(reason))
}

// retryLater moves the job back to the delayed set with the computed backoff,
// which is what BullMQ's moveToFailed does for a retryable failure.
func (w *Worker) retryLater(ctx context.Context, job Job, reason string, delayMillis int64) error {
	encodedFields, err := pack(failureFields(reason))
	if err != nil {
		return err
	}
	keys := []string{
		w.queue.keys.marker(),
		w.queue.keys.active(),
		w.queue.keys.prioritized(),
		w.queue.keys.delayed(),
		w.queue.keys.job(job.ID),
		w.queue.keys.events(),
		w.queue.keys.meta(),
		w.queue.keys.stalled(),
	}
	_, err = scriptMoveToDelayed.Run(ctx, w.queue.rdb, keys,
		w.queue.keys.base,
		time.Now().UnixMilli(),
		job.ID,
		job.Token,
		delayMillis,
		"0",
		string(encodedFields),
	).Result()
	return err
}

// finish moves the job to completed or failed, releases the lock and applies
// the retention policy. fields is the flat [name, value, ...] update list the
// Lua script unpacks; nil sends an empty argument, which updateJobFields treats
// as "no fields".
func (w *Worker) finish(ctx context.Context, job Job, target, property, value string, fields []any) {
	encodedOpts, err := pack(finishOptions{
		Token:                     job.Token,
		Name:                      w.opts.Name,
		KeepJobs:                  job.Options.keepJobs(target),
		LockDuration:              w.opts.LockDuration.Milliseconds(),
		Attempts:                  job.Options.Attempts,
		MaxMetricsSize:            "",
		FailParentOnFailure:       false,
		ContinueParentOnFailure:   false,
		IgnoreDependencyOnFailure: false,
		RemoveDependencyOnFailure: false,
	})
	if err != nil {
		log.Printf("qualityqueue: encode finish options for job %s: %v", job.ID, err)
		return
	}
	encodedFields := ""
	if len(fields) > 0 {
		packed, err := pack(fields)
		if err != nil {
			log.Printf("qualityqueue: encode finish fields for job %s: %v", job.ID, err)
			return
		}
		encodedFields = string(packed)
	}

	targetKey := w.queue.keys.completed()
	if target == "failed" {
		targetKey = w.queue.keys.failed()
	}
	keys := []string{
		w.queue.keys.wait(),
		w.queue.keys.active(),
		w.queue.keys.prioritized(),
		w.queue.keys.events(),
		w.queue.keys.stalled(),
		w.queue.keys.limiter(),
		w.queue.keys.delayed(),
		w.queue.keys.paused(),
		w.queue.keys.meta(),
		w.queue.keys.priorityCounter(),
		targetKey,
		w.queue.keys.job(job.ID),
		w.queue.keys.metrics(target),
		w.queue.keys.marker(),
	}
	result, err := scriptMoveToFinished.Run(ctx, w.queue.rdb, keys,
		job.ID,
		time.Now().UnixMilli(),
		property,
		value,
		target,
		"0", // never prefetch: the Go loop claims the next job itself
		w.queue.keys.base,
		string(encodedOpts),
		encodedFields,
	).Result()
	if err != nil {
		log.Printf("qualityqueue: finish job %s as %s: %v", job.ID, target, err)
		return
	}
	if code, ok := result.(int64); ok && code < 0 {
		log.Printf("qualityqueue: finish job %s as %s returned code %d", job.ID, target, code)
	}
}

// runStalledChecks periodically recovers jobs whose lock expired, using the same
// script BullMQ's Worker uses.
func (w *Worker) runStalledChecks(ctx context.Context) {
	ticker := time.NewTicker(w.opts.StalledInterval)
	defer ticker.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			keys := []string{
				w.queue.keys.stalled(),
				w.queue.keys.wait(),
				w.queue.keys.active(),
				w.queue.keys.stalledCheck(),
				w.queue.keys.meta(),
				w.queue.keys.paused(),
				w.queue.keys.marker(),
				w.queue.keys.events(),
			}
			_, err := scriptMoveStalledJobsToWait.Run(ctx, w.queue.rdb, keys,
				w.opts.MaxStalledCount,
				w.queue.keys.base,
				time.Now().UnixMilli(),
				w.opts.StalledInterval.Milliseconds(),
			).Result()
			if err != nil && ctx.Err() == nil {
				log.Printf("qualityqueue: stalled checker: %v", err)
			}
		}
	}
}

func (w *Worker) stopping(ctx context.Context) bool {
	select {
	case <-w.stop:
		return true
	case <-ctx.Done():
		return true
	default:
		return false
	}
}

func (w *Worker) sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-w.stop:
		return false
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// failureFields is the update list BullMQ writes for a failure: the reason and a
// JSON stacktrace array. Go has no JavaScript stack, so the array stays empty.
func failureFields(reason string) []any {
	return []any{"failedReason", reason, "stacktrace", "[]"}
}

// backoffDelay mirrors BullMQ's exponential strategy:
// round(2^(attemptsMade-1) * delay).
func backoffDelay(backoff *Backoff, attemptsMade int64) int64 {
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
		return int64(math.Round(math.Pow(2, float64(attemptsMade-1)) * float64(backoff.Delay)))
	default:
		return backoff.Delay
	}
}

// activeOptions are the msgpack options moveToActive expects.
type activeOptions struct {
	Token        string          `msgpack:"token"`
	LockDuration int64           `msgpack:"lockDuration"`
	Name         string          `msgpack:"name"`
	Limiter      *limiterOptions `msgpack:"limiter"`
}

// limiterOptions is the rate-limit table BullMQ sends. The classification queue
// is not rate limited, so the value stays nil.
type limiterOptions struct {
	Max      int64 `msgpack:"max"`
	Duration int64 `msgpack:"duration"`
}

// finishOptions are the msgpack options moveToFinished expects. The unused
// BullMQ capabilities are sent with their neutral values so the script sees the
// same table NestJS sends for a job without parents.
type finishOptions struct {
	Token                     string   `msgpack:"token"`
	Name                      string   `msgpack:"name"`
	KeepJobs                  KeepJobs `msgpack:"keepJobs"`
	LockDuration              int64    `msgpack:"lockDuration"`
	Attempts                  int64    `msgpack:"attempts"`
	MaxMetricsSize            string   `msgpack:"maxMetricsSize"`
	FailParentOnFailure       bool     `msgpack:"fpof"`
	ContinueParentOnFailure   bool     `msgpack:"cpof"`
	IgnoreDependencyOnFailure bool     `msgpack:"idof"`
	RemoveDependencyOnFailure bool     `msgpack:"rdof"`
}

// newToken builds a 32 character lock token like BullMQ's random token.
func newToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("qualityqueue: lock token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}
