package assistantqueue

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

// key builds one queue key exactly like QueueKeys.toKey.
func key(suffix string) string {
	return Prefix + ":" + QueueName + ":" + suffix
}

// jobKey is the BullMQ job hash key for one job id.
func jobKey(jobID string) string {
	return Prefix + ":" + QueueName + ":" + jobID
}

// Producer submits and removes jobs. It shares the process Redis client.
type Producer struct {
	client *redis.Client
	closed bool
}

// NewProducer binds the producer to the shared Redis client.
func NewProducer(client *redis.Client) *Producer {
	return &Producer{client: client}
}

// scripts returns the exact Lua body for a BullMQ command.
func luaScript(name string) *redis.Script {
	return redis.NewScript(luaScripts[name])
}

// Add writes one standard job and returns its id.
//
// The fields are the same Queue.add("query"|"report"|"forecast", data, opts)
// writes in NestJS: a custom job id, attempts, exponential backoff, removal on
// completion and the shared failed-job retention. The queue meta key, the id
// counter, the wait list and the events stream are all written by the same
// addStandardJob script NestJS runs.
func (p *Producer) Add(ctx context.Context, name string, data JobData, opts AddOptions) (string, error) {
	if p == nil || p.client == nil {
		return "", errors.New("assistant queue producer has no redis client")
	}
	if p.closed {
		return "", ErrQueueClosed
	}
	if opts.JobID == "" {
		return "", errors.New("assistant job id is required")
	}
	if opts.Attempts <= 0 {
		opts.Attempts = 3
	}
	if opts.Backoff.Type == "" {
		opts.Backoff = Backoff{Type: "exponential", Delay: 2_000}
	}
	dataBytes, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	// The option bag is the BullMQ cmsgpack protocol document. It is stored as
	// JSON in the job hash by storeJob and read back by moveToFinished, so the
	// key set must stay identical to Queue.add's opts.
	optionBag := map[string]any{
		"jobId":            opts.JobID,
		"attempts":         opts.Attempts,
		"backoff":          map[string]any{"type": opts.Backoff.Type, "delay": opts.Backoff.Delay},
		"removeOnComplete": true,
		"removeOnFail":     map[string]any{"age": 7 * 24 * 60 * 60, "count": 10_000},
	}
	packedOpts, err := msgpack.Marshal(optionBag)
	if err != nil {
		return "", err
	}
	args := []any{
		key(""),
		opts.JobID,
		name,
		time.Now().UnixMilli(),
		nil, // parentKey
		nil, // parentDependenciesKey
		nil, // parent
		nil, // repeatJobKey
		nil, // deduplication key
	}
	packedArgs, err := msgpack.Marshal(args)
	if err != nil {
		return "", err
	}
	keys := []string{
		key("wait"),
		key("paused"),
		key("meta"),
		key("id"),
		key("completed"),
		key("delayed"),
		key("active"),
		key("events"),
		key("marker"),
	}
	scriptArgs := []any{packedArgs, string(dataBytes), packedOpts}
	result, err := luaScript("addStandardJob").Run(ctx, p.client, keys, scriptArgs...).Result()
	if err != nil {
		return "", err
	}
	switch typed := result.(type) {
	case string:
		return typed, nil
	case int64:
		return strconv.FormatInt(typed, 10), nil
	default:
		return "", fmt.Errorf("assistant queue: unexpected add reply %T", result)
	}
}

// Remove deletes one pending job exactly like Job.remove() in NestJS. It
// returns false when the job no longer exists (nothing to remove).
func (p *Producer) Remove(ctx context.Context, jobID string) (bool, error) {
	if p == nil || p.client == nil {
		return false, errors.New("assistant queue producer has no redis client")
	}
	if p.closed {
		return false, ErrQueueClosed
	}
	exists, err := p.client.Exists(ctx, jobKey(jobID)).Result()
	if err != nil {
		return false, err
	}
	if exists == 0 {
		return false, nil
	}
	keys := []string{jobKey(jobID), key("repeat")}
	result, err := luaScript("removeJob").Run(ctx, p.client, keys, jobID, "1", key("")).Result()
	if err != nil {
		return false, err
	}
	code, ok := result.(int64)
	if !ok {
		return false, fmt.Errorf("assistant queue: unexpected remove reply %T", result)
	}
	// -8 means the id belongs to a job scheduler; the assistant queue never
	// creates one, so it is treated as "not removed".
	return code == 1, nil
}

// Close stops the producer from accepting new work. The shared Redis client is
// owned by main and is not closed here.
func (p *Producer) Close() {
	if p != nil {
		p.closed = true
	}
}
