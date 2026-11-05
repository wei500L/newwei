package qualityqueue

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmq"
)

// KeepJobs mirrors the BullMQ keepJobs shape used by removeOnComplete and
// removeOnFail. A nil field is omitted, which is what BullMQ's
// getKeepJobs() produces for the boolean and numeric shorthands.
type KeepJobs struct {
	Age   *int64 `msgpack:"age,omitempty"`
	Count *int64 `msgpack:"count,omitempty"`
}

// RemoveImmediately is the keepJobs value BullMQ derives from a literal true.
func RemoveImmediately() KeepJobs {
	count := int64(0)
	return KeepJobs{Count: &count}
}

// Retention is the keepJobs value BullMQ derives from {age, count}.
func Retention(ageSeconds, count int64) KeepJobs {
	return KeepJobs{Age: &ageSeconds, Count: &count}
}

// Backoff describes the retry strategy stored in the job options. Only the
// exponential strategy is used by this migration, matching the NestJS default
// job options for the classification queue.
type Backoff struct {
	Type  string `msgpack:"type"`
	Delay int64  `msgpack:"delay"`
}

// AddOptions are the BullMQ job options written for a new job. They are the
// fields the classification queue's Queue.add sets; every field name matches the
// NestJS job options exactly.
type AddOptions struct {
	JobID            string
	Attempts         int64
	Backoff          Backoff
	RemoveOnComplete KeepJobs
	RemoveOnFail     KeepJobs
}

// addJobOptions documents the exact msgpack field names qualityqueue stores in
// the job hash. It is kept as the wire-shape contract for TestAddJobOptionsFieldNames.
type addJobOptions struct {
	JobID            string   `msgpack:"jobId"`
	Attempts         int64    `msgpack:"attempts"`
	Backoff          Backoff  `msgpack:"backoff"`
	RemoveOnComplete KeepJobs `msgpack:"removeOnComplete"`
	RemoveOnFail     KeepJobs `msgpack:"removeOnFail"`
}

// Queue is a BullMQ producer bound to one Redis key space.
type Queue struct {
	rdb  redis.Cmdable
	name string
	keys keySpace
	bull *bullmq.Queue
}

// NewQueue builds the producer for the classification_quality queue.
func NewQueue(rdb redis.Cmdable) *Queue {
	return newQueue(rdb, QueueName)
}

// newQueue binds the producer/worker to one queue name. Integration tests use it
// to stay out of the shared classification_quality key space.
func newQueue(rdb redis.Cmdable, name string) *Queue {
	return &Queue{rdb: rdb, name: name, keys: newKeySpace("", name), bull: bullmq.NewQueue(rdb, "", name)}
}

// Add creates one standard job. The returned job id is the custom id passed in
// opts, which is also what BullMQ returns when a job with that id already
// exists.
//
// The producer never silently replaces an existing job: BullMQ's
// addStandardJob returns the existing id through handleDuplicatedJob, which is
// the behaviour NestJS relies on for the review-seed job ids.
func (q *Queue) Add(ctx context.Context, name string, data json.RawMessage, opts AddOptions) (string, error) {
	if q == nil || q.rdb == nil {
		return "", errors.New("qualityqueue: redis is not configured")
	}
	if opts.JobID == "" {
		return "", errors.New("qualityqueue: job id is required")
	}
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	attempts := opts.Attempts
	return q.bull.Add(ctx, name, data, bullmq.JobOptions{
		JobID:            opts.JobID,
		Attempts:         &attempts,
		Backoff:          &bullmq.Backoff{Type: opts.Backoff.Type, Delay: opts.Backoff.Delay},
		RemoveOnComplete: bullmq.KeepJobs{Age: opts.RemoveOnComplete.Age, Count: opts.RemoveOnComplete.Count},
		RemoveOnFail:     bullmq.KeepJobs{Age: opts.RemoveOnFail.Age, Count: opts.RemoveOnFail.Count},
	})
}
