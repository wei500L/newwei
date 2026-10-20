// Package assistantqueue is the BullMQ-compatible producer and worker for the
// single "assistant" queue. It exists because api-go must be able to submit,
// consume, retry, lock-renew and stall-detect the exact jobs NestJS writes.
//
// The wire contract is BullMQ 5.63.2: the queue keys are bull:assistant:*,
// job ids are assistant:<type>:<runId>, the job hash stores the data as JSON
// and the options as JSON, while the Lua scripts exchange msgpack option bags.
// The Lua bodies in scripts.go are copied verbatim from the installed
// bullmq@5.63.2 package with @include expanded, so a job submitted by NestJS
// and a job submitted here are indistinguishable to either worker.
package assistantqueue

import (
	"errors"
	"time"
)

// QueueName is the NestJS ASSISTANT_QUEUE_NAME. It is fixed because the Redis
// keys and the retained QueueEvents bridge already use it.
const QueueName = "assistant"

// Prefix is BullMQ's default key prefix (Queue opts.prefix).
const Prefix = "bull"

// JobType is the job name and the payload "type" field.
type JobType string

const (
	JobTypeQuery    JobType = "query"
	JobTypeReport   JobType = "report"
	JobTypeForecast JobType = "forecast"
)

// JobData is the msgpack/JSON payload of one assistant job. The JSON field
// names match AssistantJobPayload in assistant.types.ts.
type JobData struct {
	Type    JobType `json:"type"`
	RunID   string  `json:"runId"`
	OrgID   string  `json:"orgId"`
	TraceID string  `json:"traceId"`
}

// Backoff is the BullMQ backoff option. Only the exponential strategy is used
// by the assistant queue.
type Backoff struct {
	Type  string `json:"type"`
	Delay int    `json:"delay"`
}

// AddOptions are the job options the assistant submit mutations set. attempts
// comes from ASSISTANT_MAX_RETRIES; backoff is exponential with a 2000ms base.
type AddOptions struct {
	JobID    string
	Attempts int
	Backoff  Backoff
}

// JobOptions is the subset of the stored options the worker needs. The whole
// options document stays in Redis for NestJS; this struct is a typed view.
type JobOptions struct {
	Attempts         int     `json:"attempts"`
	Backoff          Backoff `json:"backoff"`
	JobID            string  `json:"jobId"`
	RemoveOnComplete any     `json:"removeOnComplete"`
	RemoveOnFail     any     `json:"removeOnFail"`
}

// ClaimedJob is one job hash returned by moveToActive.
type ClaimedJob struct {
	ID             string
	Name           string
	Data           JobData
	Options        JobOptions
	AttemptsMade   int
	StalledCounter int
	// Token is the lock token moveToActive stored; it is not a hash field.
	Token string
}

// ErrQueueClosed is returned when Add or Remove runs after Close.
var ErrQueueClosed = errors.New("assistant queue is closed")

// errLockLost marks a failed lock renewal. The in-flight handler is cancelled;
// BullMQ's stalled detection will put the job back on the wait list.
var errLockLost = errors.New("assistant job lock lost")

// DefaultWorkerConfig mirrors the BullMQ Worker defaults NestJS uses when
// AssistantProcessor passes only connection and concurrency.
func DefaultWorkerConfig(concurrency int) WorkerConfig {
	if concurrency < 1 {
		concurrency = 1
	}
	return WorkerConfig{
		Concurrency:      concurrency,
		LockDuration:     30 * time.Second,
		StalledInterval:  30 * time.Second,
		MaxStalledCount:  1,
		PollInterval:     200 * time.Millisecond,
		CompletionBudget: 20 * time.Minute,
	}
}

// WorkerConfig is the typed worker tuning. Names match the BullMQ options so
// the Redis-visible behaviour (lock TTL, stalled cadence) is the same.
type WorkerConfig struct {
	Concurrency      int
	LockDuration     time.Duration
	StalledInterval  time.Duration
	MaxStalledCount  int
	PollInterval     time.Duration
	WorkerName       string
	CompletionBudget time.Duration
}
