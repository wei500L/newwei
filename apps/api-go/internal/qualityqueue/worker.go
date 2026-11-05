package qualityqueue

// The classification-quality consumer now runs on the shared bullmq.Worker
// state machine. This file keeps only the queue name, the business handler
// signature and the WorkerOptions the wiring passes; the loop, lock renewal,
// finish, retry and stalled recovery live in internal/bullmq.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Handler processes one job. Returning an error triggers the BullMQ retry policy
// stored in the job options; returning nil moves the job to completed.
type Handler func(ctx context.Context, job Job) error

// WorkerOptions are the BullMQ worker settings this queue needs.
type WorkerOptions struct {
	// Concurrency is the number of jobs processed at the same time.
	Concurrency int
	// Name is stored as the job "processedBy" field.
	Name string
	// LockDuration is how long the job lock lives before it is considered stale.
	LockDuration time.Duration
	// StalledInterval is how often the stalled checker runs.
	StalledInterval time.Duration
	// MaxStalledCount is how many times a job may be recovered before it fails.
	MaxStalledCount int
	// PollInterval is the empty-queue poll delay (no blocking client is used).
	PollInterval time.Duration
}

// Worker consumes the classification_quality queue.
type Worker struct {
	inner *bullmq.Worker
}

// NewWorker assembles a worker over the queue's Redis client.
func NewWorker(queue *Queue, handler Handler, opts WorkerOptions) *Worker {
	if queue == nil {
		return &Worker{}
	}
	queueName := QueueName
	if queue.name != "" {
		queueName = queue.name
	}
	inner, err := bullmq.NewWorker(queue.rdb, nil, queueName, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if handler == nil {
			return nil, nil
		}
		return nil, handler(ctx, jobFromBullmq(job))
	}, bullmq.WorkerOptions{
		Name:            opts.Name,
		Concurrency:     opts.Concurrency,
		LockDuration:    opts.LockDuration,
		StalledInterval: opts.StalledInterval,
		MaxStalledCount: opts.MaxStalledCount,
		PollInterval:    opts.PollInterval,
		Stacktrace:      func(string) string { return "[]" },
	})
	if err != nil {
		return &Worker{}
	}
	return &Worker{inner: inner}
}

// Start launches the consumer loops.
func (w *Worker) Start(ctx context.Context) {
	if w == nil || w.inner == nil {
		return
	}
	_ = w.inner.Start(ctx)
}

// Stop stops claiming new jobs and waits for in-flight jobs to finish.
func (w *Worker) Stop(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Stop(ctx)
}

// jobFromBullmq adapts the shared job into the business job view.
func jobFromBullmq(job *bullmq.Job) Job {
	if job == nil {
		return Job{}
	}
	adapted := Job{
		ID:              job.ID,
		Name:            job.Name,
		Data:            job.Data,
		Token:           job.Token,
		AttemptsMade:    job.AttemptsMade,
		AttemptsStarted: job.AttemptsStarted,
		StalledCount:    job.StalledCount,
		DeferredFailure: job.DeferredFailure,
	}
	if raw := job.Opts; len(raw) > 0 {
		var options JobOptions
		if err := json.Unmarshal(raw, &options); err == nil {
			adapted.Options = options
		}
	}
	return adapted
}

// backoffDelay mirrors BullMQ's retry delay computation for the queue's
// exponential policy.
func backoffDelay(backoff *Backoff, attemptsMade int64) int64 {
	if backoff == nil {
		return 0
	}
	return bullmq.BackoffDelay(&bullmq.Backoff{Type: backoff.Type, Delay: backoff.Delay}, attemptsMade)
}

// activeOptions are the msgpack options moveToActive expects. Kept so the
// protocol integration test can claim a job with a short lock without a second
// copy of the field layout.
type activeOptions struct {
	Token        string          `msgpack:"token"`
	LockDuration int64           `msgpack:"lockDuration"`
	Name         string          `msgpack:"name"`
	Limiter      *limiterOptions `msgpack:"limiter"`
}

// limiterOptions is the rate-limit table BullMQ sends.
type limiterOptions struct {
	Max      int64 `msgpack:"max"`
	Duration int64 `msgpack:"duration"`
}
