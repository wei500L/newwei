package assistantqueue

// The assistant consumer now runs on the shared bullmq.Worker state machine.
// This file keeps only the queue name, the business handler signature, the
// WorkerOptions the wiring passes and a few low-level delegates used by the
// queue's protocol tests; the loop, lock renewal, finish, retry and stalled
// recovery live in internal/bullmq.

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Handler processes one claimed job. Returning an error triggers the BullMQ
// retry policy (attempts and exponential backoff from the job options); a nil
// error completes the job and removes it (removeOnComplete=true).
type Handler func(ctx context.Context, job ClaimedJob) error

// Worker consumes the assistant queue with the same lock, retry and stalled
// contracts as BullMQ Worker.
type Worker struct {
	inner *bullmq.Worker
}

// NewWorker builds a worker over the shared Redis client. The polling worker
// needs no dedicated blocking client.
func NewWorker(client *redis.Client, cfg WorkerConfig, handler Handler) *Worker {
	if client == nil {
		return &Worker{}
	}
	zero := int64(0)
	age := int64(7 * 24 * 60 * 60)
	count := int64(10_000)
	inner, err := bullmq.NewWorker(client, nil, QueueName, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if handler == nil {
			return nil, nil
		}
		if processErr := handler(ctx, claimedFromBullmq(job)); processErr != nil {
			return nil, processErr
		}
		return nil, nil
	}, bullmq.WorkerOptions{
		Name:             cfg.WorkerName,
		Concurrency:      cfg.Concurrency,
		LockDuration:     cfg.LockDuration,
		StalledInterval:  cfg.StalledInterval,
		MaxStalledCount:  cfg.MaxStalledCount,
		PollInterval:     cfg.PollInterval,
		RemoveOnComplete: bullmq.KeepJobs{Count: &zero},
		RemoveOnFail:     bullmq.KeepJobs{Age: &age, Count: &count},
		Stacktrace:       assistantStacktraceJSON,
	})
	if err != nil {
		return &Worker{}
	}
	return &Worker{inner: inner}
}

// Start launches the claim loops and the stalled detector.
func (w *Worker) Start(ctx context.Context) {
	if w == nil || w.inner == nil {
		return
	}
	_ = w.inner.Start(ctx)
}

// Close stops claiming new jobs and waits for the in-flight handlers.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Close(ctx)
}

// checkStalled runs one stalled-recovery pass (used by the protocol tests).
func (w *Worker) checkStalled(ctx context.Context) {
	if w == nil || w.inner == nil {
		return
	}
	w.inner.CheckStalled(ctx)
}

// claim claims one job for the protocol tests.
func (w *Worker) claim(ctx context.Context) (*ClaimedJob, error) {
	if w == nil || w.inner == nil {
		return nil, nil
	}
	job, _, err := w.inner.Claim(ctx)
	if job == nil {
		return nil, err
	}
	adapted := claimedFromBullmq(job)
	return &adapted, err
}

// complete acknowledges one claimed job as completed for the protocol tests.
func (w *Worker) complete(ctx context.Context, job ClaimedJob, token string) error {
	if w == nil || w.inner == nil {
		return nil
	}
	w.inner.FinishCompleted(ctx, claimedToBullmq(job, token), nil)
	return nil
}

// claimedFromBullmq adapts the shared job into the business job view.
func claimedFromBullmq(job *bullmq.Job) ClaimedJob {
	if job == nil {
		return ClaimedJob{}
	}
	adapted := ClaimedJob{
		ID:             job.ID,
		Name:           job.Name,
		Token:          job.Token,
		AttemptsMade:   int(job.AttemptsMade),
		StalledCounter: int(job.StalledCount),
	}
	if len(job.Data) > 0 {
		_ = json.Unmarshal(job.Data, &adapted.Data)
	}
	if len(job.Opts) > 0 {
		_ = json.Unmarshal(job.Opts, &adapted.Options)
	}
	return adapted
}

// claimedToBullmq is the inverse adapter used by the low-level protocol
// delegates.
func claimedToBullmq(job ClaimedJob, token string) *bullmq.Job {
	data, err := json.Marshal(job.Data)
	if err != nil {
		data = json.RawMessage("{}")
	}
	opts, err := json.Marshal(job.Options)
	if err != nil {
		opts = json.RawMessage("{}")
	}
	return &bullmq.Job{
		ID:           job.ID,
		Name:         job.Name,
		Data:         data,
		Opts:         opts,
		Token:        token,
		AttemptsMade: int64(job.AttemptsMade),
		StalledCount: int64(job.StalledCounter),
	}
}

// assistantStacktraceJSON is the JSON-array stacktrace string BullMQ stores.
func assistantStacktraceJSON(message string) string {
	encoded, err := json.Marshal([]string{message})
	if err != nil {
		return "[]"
	}
	return string(encoded)
}
