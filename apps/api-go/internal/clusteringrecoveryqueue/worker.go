package clusteringrecoveryqueue

// The news_event_clustering_recovery consumer now runs on the shared
// bullmq.Worker state machine. This file keeps only the queue name, the business
// Processor signature and the WorkerOptions the wiring passes; the loop, lock
// renewal, finish, retry and stalled recovery live in internal/bullmq.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Processor runs one claimed job. It must stop writing when ctx is cancelled
// (worker shutdown or a lost lease).
type Processor func(ctx context.Context, job Job) error

// WorkerOptions are the BullMQ worker settings plus the business processor.
type WorkerOptions struct {
	Concurrency     int
	Prefix          string
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Processor       Processor
	Logger          func(format string, args ...any)
}

// Worker consumes the news_event_clustering_recovery queue.
type Worker struct {
	inner *bullmq.Worker
}

// NewWorker builds a worker over the shared command client and a dedicated
// blocking client used for the marker wait.
func NewWorker(client, blocking *redis.Client, opts WorkerOptions) (*Worker, error) {
	inner, err := bullmq.NewWorker(client, blocking, QueueName, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if opts.Processor == nil {
			return nil, nil
		}
		return nil, opts.Processor(ctx, jobFromBullmq(job))
	}, bullmq.WorkerOptions{
		Prefix:          opts.Prefix,
		Concurrency:     opts.Concurrency,
		LockDuration:    opts.LockDuration,
		LockRenewTime:   opts.LockRenewTime,
		StalledInterval: opts.StalledInterval,
		MaxStalledCount: opts.MaxStalledCount,
		DrainDelay:      opts.DrainDelay,
		Logger:          opts.Logger,
		Stacktrace:      stacktraceJSON,
		IsLeaseLost: func(err error) bool {
			var leaseLost *LeaseLostError
			return errors.As(err, &leaseLost)
		},
	})
	if err != nil {
		return nil, err
	}
	return &Worker{inner: inner}, nil
}

// Start verifies both Redis clients and starts the loops.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Start(ctx)
}

// Close drains in-flight jobs and closes the dedicated blocking client.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Close(ctx)
}

// jobFromBullmq adapts the shared job into the business job view.
func jobFromBullmq(job *bullmq.Job) Job {
	if job == nil {
		return Job{}
	}
	adapted := Job{
		ID:              job.ID,
		Name:            job.Name,
		Token:           job.Token,
		AttemptsMade:    int(job.AttemptsMade),
		AttemptsStarted: int(job.AttemptsStarted),
		StalledCounter:  int(job.StalledCount),
		DeferredFailure: job.DeferredFailure,
		Timestamp:       job.Timestamp,
	}
	if job.ProcessedOn != nil {
		adapted.ProcessedOn = *job.ProcessedOn
	}
	if raw := job.Data; len(raw) > 0 {
		_ = json.Unmarshal(raw, &adapted.Payload)
	}
	if raw := job.Opts; len(raw) > 0 {
		_ = json.Unmarshal(raw, &adapted.Opts)
	}
	return adapted
}
