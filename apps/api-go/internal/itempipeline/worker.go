package itempipeline

// The itemPipeline consumer now runs on the shared bullmq.Worker state machine.
// This file keeps only the queue name, the business Processor signature, the
// failure listener and the WorkerOptions the wiring passes. The loop, lock
// renewal, finish, retry and stalled recovery live in internal/bullmq.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// JobProcessor runs one claimed job. A nil error stores the returned bytes as
// the BullMQ job returnvalue; a non-nil error goes through the failure policy.
type JobProcessor func(ctx context.Context, job Job) (json.RawMessage, error)

// FailureInfo is the decision made for one failed attempt, mirroring the NestJS
// 'failed' listener input.
type FailureInfo struct {
	AttemptsMade      int
	RemainingAttempts int
	Permanent         bool
	FinalFailure      bool
	Cause             error
}

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
	OnFailure       func(ctx context.Context, job Job, failure FailureInfo)
	Logger          func(format string, args ...any)
}

// Worker consumes the itemPipeline queue.
type Worker struct {
	inner *bullmq.Worker
}

// NewWorker builds a worker over the shared command client and a dedicated
// blocking client used for the marker wait.
func NewWorker(client, blocking *redis.Client, opts WorkerOptions) (*Worker, error) {
	var onFailure func(ctx context.Context, job *bullmq.Job, failure bullmq.FailureInfo)
	if opts.OnFailure != nil {
		onFailure = func(ctx context.Context, job *bullmq.Job, failure bullmq.FailureInfo) {
			adapted := FailureInfo{
				AttemptsMade:      failure.AttemptsMade,
				RemainingAttempts: failure.RemainingAttempts,
				Permanent:         failure.Permanent,
				FinalFailure:      failure.FinalFailure,
				Cause:             failure.Cause,
			}
			// The business listener reclassifies the cause; keep a permanently
			// classified failure permanent (the deferred stalled marker arrives as
			// a plain error from the shared worker).
			if failure.Permanent && failure.Cause != nil && ClassifyQueueError(failure.Cause).Kind != ErrorKindPermanent {
				adapted.Cause = NewPermanentError(failure.Cause.Error())
			}
			opts.OnFailure(ctx, jobFromBullmq(job), adapted)
		}
	}
	inner, err := bullmq.NewWorker(client, blocking, QueueName, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if opts.Processor == nil {
			return nil, nil
		}
		result, processErr := opts.Processor(ctx, jobFromBullmq(job))
		if processErr != nil && ClassifyQueueError(processErr).Kind == ErrorKindPermanent {
			return nil, bullmq.Unrecoverable(processErr)
		}
		return result, processErr
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
		Data:            job.Data,
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

// DecodeFailure computes the retry/fail decision for one failed attempt. It is
// the pure part of the failure policy so the remaining-attempts and
// UnrecoverableError semantics stay unit-testable without Redis.
func DecodeFailure(job Job, err error) FailureInfo {
	classified := ClassifyQueueError(err)
	failure := FailureInfo{
		AttemptsMade:      job.AttemptsMade + 1,
		RemainingAttempts: job.Attempts() - (job.AttemptsMade + 1),
		Permanent:         classified.Kind == ErrorKindPermanent,
		Cause:             err,
	}
	if failure.RemainingAttempts < 0 {
		failure.RemainingAttempts = 0
	}
	failure.FinalFailure = failure.Permanent || job.DeferredFailure != "" || failure.RemainingAttempts == 0
	return failure
}
