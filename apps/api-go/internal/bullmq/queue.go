package bullmq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/vmihailenco/msgpack/v5"
)

// ErrQueueNoClient is returned by Queue.Add when the queue has no Redis client.
var ErrQueueNoClient = errors.New("bullmq: redis is not configured")

// Queue is a BullMQ producer bound to one Redis key space. It is safe for
// concurrent use as long as the underlying client is.
type Queue struct {
	client redis.Scripter
	// Keys is the BullMQ key set of this queue.
	Keys Keys
	// Now is the clock used for the add timestamp. nil means time.Now.
	Now func() time.Time
}

// NewQueue builds a producer for one queue. An empty prefix falls back to the
// BullMQ default "bull".
func NewQueue(client redis.Scripter, prefix, name string) *Queue {
	return &Queue{client: client, Keys: NewKeys(prefix, name)}
}

func (q *Queue) clock() time.Time {
	if q != nil && q.Now != nil {
		return q.Now()
	}
	return time.Now()
}

// Add creates one job via the standard, delayed or prioritized add command,
// mirroring BullMQ's Scripts.addJob dispatch: a positive delay uses the delayed
// command, otherwise a non-zero priority uses the prioritized command, otherwise
// the standard command. The returned id is the script result (the custom id when
// supplied, otherwise the allocated job counter).
func (q *Queue) Add(ctx context.Context, jobName string, data json.RawMessage, opts JobOptions) (string, error) {
	if q == nil || q.client == nil {
		return "", ErrQueueNoClient
	}
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	packedArgs, err := MarshalJobArguments(q.Keys.Base, opts.JobID, jobName, q.clock().UnixMilli(), opts.RepeatJobKey, deduplicationKey(q.Keys.Base, opts.Deduplication))
	if err != nil {
		return "", err
	}
	packedOpts, err := msgpack.Marshal(opts)
	if err != nil {
		return "", fmt.Errorf("bullmq: encode job options: %w", err)
	}

	var script *redis.Script
	var keys []string
	switch {
	case opts.Delay != nil && *opts.Delay > 0:
		script = ScriptAddDelayedJob
		keys = []string{q.Keys.Marker, q.Keys.Meta, q.Keys.ID, q.Keys.Delayed, q.Keys.Completed, q.Keys.Events}
	case opts.Priority != nil && *opts.Priority != 0:
		script = ScriptAddPrioritizedJob
		keys = []string{q.Keys.Marker, q.Keys.Meta, q.Keys.ID, q.Keys.Prioritized, q.Keys.Delayed, q.Keys.Completed, q.Keys.Active, q.Keys.Events, q.Keys.PC}
	default:
		script = ScriptAddStandardJob
		keys = []string{q.Keys.Wait, q.Keys.Paused, q.Keys.Meta, q.Keys.ID, q.Keys.Completed, q.Keys.Delayed, q.Keys.Active, q.Keys.Events, q.Keys.Marker}
	}
	result, err := script.Run(ctx, q.client, keys, packedArgs, string(data), packedOpts).Result()
	if err != nil {
		return "", err
	}
	return JobIDResult(result)
}

// MarshalJobArguments packs the positional msgpack array the add scripts read as
// ARGV[1]: [key prefix, custom id, name, timestamp, parentKey,
// parentDependenciesKey, parent, repeatJobKey, deduplicationKey]. The unused
// parent slots are always nil.
func MarshalJobArguments(prefix, jobID, name string, timestamp int64, repeatJobKey, deduplicationKey string) ([]byte, error) {
	args := []any{
		prefix,
		jobID,
		name,
		timestamp,
		nil, // parentKey
		nil, // parentDependenciesKey
		nil, // parent {id, queueKey}
		nil, // repeatJobKey
		nil, // deduplicationKey
	}
	if repeatJobKey != "" {
		args[7] = repeatJobKey
	}
	if deduplicationKey != "" {
		args[8] = deduplicationKey
	}
	return msgpack.Marshal(args)
}

// deduplicationKey builds BullMQ's simple-mode deduplication key
// (<queue base>de:<id>) or an empty string when no deduplication is requested.
func deduplicationKey(base string, dedup *Deduplication) string {
	if dedup == nil || dedup.ID == "" {
		return ""
	}
	return base + "de:" + dedup.ID
}

// JobIDResult normalizes an add-script reply into the job id string. A negative
// integer is BullMQ's script-level error code.
func JobIDResult(result any) (string, error) {
	switch value := result.(type) {
	case string:
		return value, nil
	case []byte:
		return string(value), nil
	case int64:
		if value < 0 {
			return "", fmt.Errorf("bullmq: add job rejected with code %d", value)
		}
		return strconv.FormatInt(value, 10), nil
	case int:
		if value < 0 {
			return "", fmt.Errorf("bullmq: add job rejected with code %d", value)
		}
		return strconv.Itoa(value), nil
	default:
		return "", fmt.Errorf("bullmq: unexpected add reply %T", result)
	}
}
