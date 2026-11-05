package crawlfrontierllm

// worker.go is the BullMQ consumer for one LLM queue. Concurrency is 1 and the
// queue-level limiter is max 1 per 1000ms, exactly like createLlmWorker. The
// limiter key (bull:<queue>:limiter) is shared with any NestJS worker still
// consuming during a switchover, so both sides observe the same rate.
//
// The loop, lock renewal, finish, retry and stalled recovery now live in the
// shared internal/bullmq.Worker; this file keeps only the queue name, the
// business processor and the WorkerOptions that reproduce the LLM worker.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// Processor runs one job. The returned value is stored as the BullMQ
// returnvalue; an error fails the attempt.
type Processor func(ctx context.Context, data JobData) (any, error)

// Worker owns one queue.
type Worker struct {
	inner *bullmq.Worker
}

// newWorker builds one queue consumer over the shared command client and a
// dedicated blocking client.
func newWorker(queue string, client, blocking *redis.Client, processor Processor) (*Worker, error) {
	if client == nil || blocking == nil {
		return nil, fmt.Errorf("crawlfrontierllm: worker requires command and blocking redis clients")
	}
	if processor == nil {
		return nil, fmt.Errorf("crawlfrontierllm: worker requires a processor")
	}
	inner, err := bullmq.NewWorker(client, blocking, queue, func(ctx context.Context, job *bullmq.Job) (json.RawMessage, error) {
		value, processErr := processor(ctx, jobDataFromBullmq(job))
		if processErr != nil {
			return nil, processErr
		}
		return json.RawMessage(marshalReturnValue(value)), nil
	}, bullmq.WorkerOptions{
		Concurrency:     1,
		LockDuration:    LockDuration,
		LockRenewTime:   LockRenewTime,
		StalledInterval: StalledInterval,
		MaxStalledCount: MaxStalledCount,
		DrainDelay:      DrainDelay,
		Limiter:         &bullmq.Limiter{Max: LimiterMax, Duration: int64(LimiterDuration / time.Millisecond)},
		Stacktrace:      stacktraceJSON,
		// The LLM consumer retries a non-final failure immediately (retryJob)
		// instead of honouring opts.backoff, so a fixed zero delay reproduces it.
		FailurePolicy: func(job *bullmq.Job, err error) bullmq.FailureDecision {
			var unrecoverable *bullmq.UnrecoverableError
			if errors.As(err, &unrecoverable) {
				return bullmq.FailureDecision{Final: true, Permanent: true}
			}
			return bullmq.FailureDecision{Final: job.FinalFailure()}
		},
	})
	if err != nil {
		return nil, err
	}
	return &Worker{inner: inner}, nil
}

// Start pings Redis and starts the fetch and stalled loops.
func (w *Worker) Start(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return fmt.Errorf("crawlfrontierllm: worker is nil")
	}
	return w.inner.Start(ctx)
}

// Close drains in-flight work and closes the blocking client.
func (w *Worker) Close(ctx context.Context) error {
	if w == nil || w.inner == nil {
		return nil
	}
	return w.inner.Close(ctx)
}

// jobDataFromBullmq decodes the business payload of a claimed job.
func jobDataFromBullmq(job *bullmq.Job) JobData {
	if job == nil || len(job.Data) == 0 {
		return JobData{}
	}
	var data JobData
	_ = json.Unmarshal(job.Data, &data)
	return data
}

// newBlockingClient opens the dedicated BZPOPMIN connection for a worker.
func newBlockingClient(options *redis.Options, database int) *redis.Client {
	opts := *options
	opts.DB = database
	opts.Protocol = 2
	return redis.NewClient(&opts)
}
