package economicqueue

// The akshare-data consumer now runs on the shared bullmq.Worker state machine.
// This file keeps only the queue name, the business Handler signature, the
// WorkerOptions and the repeat scheduling hook; the loop, lock renewal, finish,
// retry and stalled recovery live in internal/bullmq. It also keeps a few small
// delegates used by the queue's own protocol tests to claim and finish a job
// without a second worker loop.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Handler processes one claimed job. Returning an error moves the job to the
// failed set; the handler persists the user-visible fetch status exactly once and
// must stop when ctx is cancelled.
type Handler func(ctx context.Context, job Job) error

// WorkerOptions configures the BullMQ-compatible consumer. Zero values fall back
// to this queue's historical defaults (concurrency 2, five-minute lock).
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

// Worker consumes bull:akshare-data.
type Worker struct {
	inner    *bullmq.Worker
	handler  Handler
	opts     WorkerOptions
	producer *Producer
}

// NewWorker creates a worker bound to the production queue.
func NewWorker(client *redis.Client, handler Handler, opts WorkerOptions) *Worker {
	return newWorkerNamed(client, handler, opts, QueueName)
}

// newWorkerWithName binds a worker to a scratch queue name for integration tests.
func newWorkerWithName(client *redis.Client, handler Handler, opts WorkerOptions, name string) *Worker {
	return newWorkerNamed(client, handler, opts, name)
}

func newWorkerNamed(client *redis.Client, handler Handler, opts WorkerOptions, name string) *Worker {
	normalized := opts.normalized()
	worker := &Worker{handler: handler, opts: normalized, producer: newProducerWithName(client, name)}
	inner, err := bullmq.NewWorker(client, nil, name, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		if worker.handler == nil {
			return nil, nil
		}
		return nil, worker.handler(ctx, jobFromBullmq(job))
	}, bullmq.WorkerOptions{
		Prefix:             Prefix,
		Name:               normalized.Name,
		Concurrency:        normalized.Concurrency,
		LockDuration:       normalized.LockDuration,
		StalledInterval:    normalized.StalledInterval,
		MaxStalledCount:    normalized.MaxStalledCount,
		PollInterval:       normalized.PollInterval,
		FailureReasonLimit: 191,
		Stacktrace:         func(string) string { return "[]" },
		OnClaim: func(ctx context.Context, job *bullmq.Job) {
			adapted := jobFromBullmq(job)
			if adapted.RepeatJobKey == "" {
				return
			}
			if err := worker.producer.ScheduleNextRepeat(ctx, adapted); err != nil {
				// BullMQ schedules the next repeat before the processor runs, so a
				// failure here must not stop the fetch.
				_ = err
			}
		},
	})
	if err == nil {
		worker.inner = inner
	}
	return worker
}

// Run blocks until ctx is cancelled and every in-flight job has completed.
func (w *Worker) Run(ctx context.Context) {
	if w == nil || w.inner == nil {
		return
	}
	w.inner.Run(ctx)
}

// Close stops the loop and waits for in-flight jobs.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Close(ctx)
}

// moveToActive claims one job for the protocol tests.
func (w *Worker) moveToActive(ctx context.Context) (*Job, error) {
	if w == nil || w.inner == nil {
		return nil, nil
	}
	job, _, err := w.inner.Claim(ctx)
	if job == nil {
		return nil, err
	}
	adapted := jobFromBullmq(job)
	return &adapted, err
}

// process runs one claimed job for the protocol tests.
func (w *Worker) process(ctx context.Context, job Job) {
	if w == nil || w.inner == nil {
		return
	}
	w.inner.ProcessOne(ctx, jobToBullmq(job))
}

// finish moves one job to completed or failed for the protocol tests.
func (w *Worker) finish(ctx context.Context, job Job, target string, cause error) {
	if w == nil || w.inner == nil {
		return
	}
	adapted := jobToBullmq(job)
	if target == "failed" {
		w.inner.FinishFailed(ctx, adapted, cause)
		return
	}
	w.inner.FinishCompleted(ctx, adapted, nil)
}

// checkStalled runs one stalled-recovery pass for the protocol tests.
func (w *Worker) checkStalled(ctx context.Context) {
	if w == nil || w.inner == nil {
		return
	}
	w.inner.CheckStalled(ctx)
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
		Timestamp:       job.Timestamp,
		Delay:           job.Delay,
		RepeatJobKey:    job.RepeatJobKey,
		AttemptsMade:    job.AttemptsMade,
		StalledCount:    job.StalledCount,
		DeferredFailure: job.DeferredFailure,
	}
	if raw := job.Opts; len(raw) > 0 {
		_ = json.Unmarshal(raw, &adapted.Opts)
	}
	if adapted.Opts.RepeatJobKey == "" {
		adapted.Opts.RepeatJobKey = adapted.RepeatJobKey
	}
	return adapted
}

// jobToBullmq is the inverse adapter used by the low-level protocol delegates.
func jobToBullmq(job Job) *bullmq.Job {
	opts, err := json.Marshal(job.Opts)
	if err != nil {
		opts = json.RawMessage("{}")
	}
	return &bullmq.Job{
		ID:              job.ID,
		Name:            job.Name,
		Data:            job.Data,
		Opts:            opts,
		Token:           job.Token,
		Timestamp:       job.Timestamp,
		Delay:           job.Delay,
		RepeatJobKey:    job.RepeatJobKey,
		AttemptsMade:    job.AttemptsMade,
		StalledCount:    job.StalledCount,
		DeferredFailure: job.DeferredFailure,
	}
}
