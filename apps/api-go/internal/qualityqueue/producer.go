package qualityqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
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
// msgpack table the addStandardJob script stores in the job hash, so every
// field name matches the NestJS job options exactly.
type AddOptions struct {
	JobID            string
	Attempts         int64
	Backoff          Backoff
	RemoveOnComplete KeepJobs
	RemoveOnFail     KeepJobs
}

// addJobOptions is the msgpack projection of AddOptions. jobId is included
// because NestJS stores it in the hash opts field as well.
type addJobOptions struct {
	JobID            string   `msgpack:"jobId"`
	Attempts         int64    `msgpack:"attempts"`
	Backoff          Backoff  `msgpack:"backoff"`
	RemoveOnComplete KeepJobs `msgpack:"removeOnComplete"`
	RemoveOnFail     KeepJobs `msgpack:"removeOnFail"`
}

// Queue is a BullMQ producer bound to one Redis key space.
type Queue struct {
	rdb  redis.Scripter
	keys keySpace
}

// NewQueue builds the producer for the classification_quality queue.
func NewQueue(rdb redis.Scripter) *Queue {
	return newQueue(rdb, QueueName)
}

// newQueue binds the producer/worker to one queue name. Integration tests use it
// to stay out of the shared classification_quality key space.
func newQueue(rdb redis.Scripter, name string) *Queue {
	return &Queue{rdb: rdb, keys: newKeySpace("", name)}
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

	// Script argument tuple: [key prefix, custom id, name, timestamp,
	// parentKey, parentDependenciesKey, parent, repeatJobKey, deduplicationKey].
	// The optional entries stay nil because this migration never creates
	// parent, repeat or deduplicated jobs.
	args, err := pack([]any{
		q.keys.base, opts.JobID, name, time.Now().UnixMilli(),
		nil, nil, nil, nil, nil,
	})
	if err != nil {
		return "", err
	}
	encodedOpts, err := pack(addJobOptions{
		JobID:            opts.JobID,
		Attempts:         opts.Attempts,
		Backoff:          opts.Backoff,
		RemoveOnComplete: opts.RemoveOnComplete,
		RemoveOnFail:     opts.RemoveOnFail,
	})
	if err != nil {
		return "", err
	}

	keys := []string{
		q.keys.wait(),
		q.keys.paused(),
		q.keys.meta(),
		q.keys.id(),
		q.keys.completed(),
		q.keys.delayed(),
		q.keys.active(),
		q.keys.events(),
		q.keys.marker(),
	}
	result, err := scriptAddStandardJob.Run(ctx, q.rdb, keys,
		string(args), string(data), string(encodedOpts)).Result()
	if err != nil {
		return "", fmt.Errorf("qualityqueue: add job %s: %w", opts.JobID, err)
	}
	switch value := result.(type) {
	case string:
		return value, nil
	case int64:
		// Negative codes are script-level failures; -5 means the parent key
		// does not exist, which cannot happen for the jobs added here.
		return "", fmt.Errorf("qualityqueue: add job %s failed with code %d", opts.JobID, value)
	default:
		return "", fmt.Errorf("qualityqueue: add job %s returned %T", opts.JobID, result)
	}
}
