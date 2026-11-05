package archivepreparationworker

// The archivePreparation consumer now runs on the shared bullmq.Worker state
// machine. This file keeps only the queue name, the business processor
// signature, the failed-attempt listener and the WorkerOptions the wiring
// passes; the loop, lock renewal, finish, retry and stalled recovery live in
// internal/bullmq.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Processor runs one claimed job. It must stop writing when ctx is canceled
// (worker shutdown or a lost lease). Returning a *LeaseLostError means this
// attempt lost the BullMQ lock; the worker then leaves the job in the active
// list for stalled recovery instead of acknowledging it.
type JobProcessor func(ctx context.Context, job Job) error

// WorkerOptions are the BullMQ worker settings plus the business processor and
// the failed-attempt listener.
type WorkerOptions struct {
	Concurrency     int
	Prefix          string
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	MaxStalledCount int
	DrainDelay      time.Duration
	Processor       JobProcessor
	// OnFailure runs once for every failed attempt after the BullMQ transition.
	// The archive preparation status record mirrors the NestJS in-process Worker
	// 'failed' event, which fires on every attempt rather than only on the last
	// one.
	OnFailure func(ctx context.Context, job Job, cause error)
	Logger    func(format string, args ...any)
}

// Worker consumes the archivePreparation BullMQ queue.
type Worker struct {
	inner *bullmq.Worker
}

// NewWorker builds a worker over the shared command client and a dedicated
// blocking client used for the marker wait.
func NewWorker(client, blocking *redis.Client, opts WorkerOptions) (*Worker, error) {
	if client == nil || blocking == nil {
		return nil, fmt.Errorf("archivepreparationworker: worker requires command and blocking redis clients")
	}
	if opts.Processor == nil {
		return nil, fmt.Errorf("archivepreparationworker: worker requires a processor")
	}
	var onFailure func(ctx context.Context, job *bullmq.Job, failure bullmq.FailureInfo)
	if opts.OnFailure != nil {
		onFailure = func(ctx context.Context, job *bullmq.Job, failure bullmq.FailureInfo) {
			opts.OnFailure(ctx, jobFromBullmq(job), failure.Cause)
		}
	}
	inner, err := bullmq.NewWorker(client, blocking, QueueName, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if processErr := opts.Processor(ctx, jobFromBullmq(job)); processErr != nil {
			return nil, processErr
		}
		return nil, nil
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
		OnFailure:       onFailure,
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

// Start verifies both Redis connections and starts the loops.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Start(ctx)
}

// Close drains in-flight jobs, stops the stalled checker and closes the
// dedicated blocking client.
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
	if len(job.Data) > 0 {
		_ = json.Unmarshal(job.Data, &adapted.Payload)
	}
	if len(job.Opts) > 0 {
		_ = json.Unmarshal(job.Opts, &adapted.Opts)
	}
	return adapted
}
