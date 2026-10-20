package bullmqcleanup

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// JobState is one BullMQ state the cleanup touches.
type JobState string

const (
	// StateFailed is the "failed" sorted set.
	StateFailed JobState = "failed"
	// StateWaiting is the "wait" list (BullMQ aliases "waiting" to "wait").
	StateWaiting JobState = "waiting"
)

// Cleaner executes one retained-job cleanup cycle against the shared Redis.
type Cleaner struct {
	redis *redis.Client
	specs []QueueSpec
	now   func() int64
}

// NewCleaner builds a cleaner for the full tracked-queue inventory.
func NewCleaner(client *redis.Client) *Cleaner {
	return &Cleaner{
		redis: client,
		specs: Inventory(),
		now:   func() int64 { return time.Now().UnixMilli() },
	}
}

// NewCleanerForTest builds a cleaner with an explicit inventory and clock. It
// keeps the integration tests inside their own key space and makes the grace
// boundary deterministic; production uses NewCleaner.
func NewCleanerForTest(client *redis.Client, specs []QueueSpec, now func() int64) *Cleaner {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Cleaner{redis: client, specs: specs, now: now}
}

// Inventory returns the queue inventory this cleaner iterates.
func (c *Cleaner) Inventory() []QueueSpec {
	if c == nil {
		return nil
	}
	out := make([]QueueSpec, len(c.specs))
	copy(out, c.specs)
	return out
}

// CleanAll runs one cycle over every tracked queue.
//
// One queue (or one state of one queue) never aborts the cycle: the NestJS
// service catches errors per state and logs a warning, and this implementation
// does the same. The only returned error is a Redis client that cannot load the
// scripts at all, which makes every queue fail identically.
func (c *Cleaner) CleanAll(ctx context.Context) error {
	if c == nil || c.redis == nil {
		return errors.New("bullmqcleanup: redis is not configured")
	}
	if err := c.loadScripts(ctx); err != nil {
		return err
	}
	for _, spec := range c.specs {
		c.cleanQueue(ctx, spec)
	}
	return nil
}

// loadScripts primes the Redis script cache so the pipelined removeJob calls
// can use EVALSHA. redis.Script.Run performs its own NOSCRIPT fallback on a
// single connection, but a pipeline cannot (the error only surfaces after
// Exec), so every script is loaded once per cycle.
func (c *Cleaner) loadScripts(ctx context.Context) error {
	for _, script := range []*redis.Script{
		scriptCleanJobsInSet, scriptGetRanges, scriptGetCounts, scriptRemoveJob,
	} {
		if err := script.Load(ctx, c.redis).Err(); err != nil {
			return err
		}
	}
	return nil
}

// cleanQueue applies both configured states. The two states are independent:
// an error on failed jobs does not skip the waiting trim, matching the
// Promise.all(cleanState(failed), cleanState(waiting)) in NestJS.
func (c *Cleaner) cleanQueue(ctx context.Context, spec QueueSpec) {
	prefix := queueKeys(spec.Name)
	if spec.Failed != nil {
		c.cleanState(ctx, spec.Name, prefix, StateFailed, *spec.Failed)
	}
	if spec.Waiting != nil {
		c.cleanState(ctx, spec.Name, prefix, StateWaiting, *spec.Waiting)
	}
}

// cleanState runs the age clean followed by the count trim, and turns every
// error into one warning that never escapes the queue.
func (c *Cleaner) cleanState(ctx context.Context, queue, prefix string, state JobState, retention StateRetention) {
	if err := c.cleanByAge(ctx, prefix, state, retention); err != nil {
		log.Printf("bullmqcleanup: clean by age queue=%s state=%s: %v", queue, state, err)
		return
	}
	if err := c.trimByCount(ctx, prefix, state, retention); err != nil {
		log.Printf("bullmqcleanup: trim by count queue=%s state=%s: %v", queue, state, err)
	}
}

// cleanByAge mirrors Queue.clean(grace, 1000, state) in a loop of at most ten
// batches. Queue.clean itself deletes at most `limit` jobs and returns their
// ids; a batch shorter than the limit means no older job is left.
func (c *Cleaner) cleanByAge(ctx context.Context, prefix string, state JobState, retention StateRetention) error {
	if retention.AgeSeconds <= 0 {
		return nil
	}
	graceMillis := retention.AgeSeconds * 1000
	for batch := 0; batch < CleanMaxBatches; batch++ {
		timestamp := c.now() - graceMillis
		removed, err := c.cleanBatch(ctx, prefix, state, timestamp)
		if err != nil {
			return err
		}
		if len(removed) < CleanBatchSize {
			return nil
		}
	}
	return nil
}

// cleanBatch executes cleanJobsInSet once. The argument tuple matches
// Scripts.cleanJobsInSet: jobKey prefix, cutoff timestamp, limit and the set
// name. The set name is normalized to "wait" for waiting jobs exactly like
// Queue.clean normalizes "waiting".
func (c *Cleaner) cleanBatch(ctx context.Context, prefix string, state JobState, timestamp int64) ([]string, error) {
	setKey := prefix + "failed"
	stateArgument := string(StateFailed)
	if state == StateWaiting {
		setKey = prefix + "wait"
		stateArgument = "wait"
	}
	keys := []string{setKey, prefix + "events", prefix + "repeat"}
	result, err := scriptCleanJobsInSet.Run(ctx, c.redis, keys,
		prefix, timestamp, CleanBatchSize, stateArgument).Result()
	if err != nil {
		return nil, err
	}
	return stringList(result), nil
}

// trimByCount removes the excess over the configured count, oldest first, in
// pages of at most 1000 ids and at most 10000 removals per cycle. It mirrors
// the NestJS loop, including the fact that the budget is consumed by the page
// size even when an individual job is locked and cannot be removed.
func (c *Cleaner) trimByCount(ctx context.Context, prefix string, state JobState, retention StateRetention) error {
	if retention.Count < 0 {
		return nil
	}
	current, err := c.stateCount(ctx, prefix, state)
	if err != nil {
		return err
	}
	excess := current - retention.Count
	if excess <= 0 {
		return nil
	}
	remaining := excess
	if maxRemovals := int64(CleanBatchSize * CleanMaxBatches); remaining > maxRemovals {
		remaining = maxRemovals
	}
	for remaining > 0 {
		batchSize := remaining
		if batchSize > CleanBatchSize {
			batchSize = CleanBatchSize
		}
		ids, err := c.oldestIDs(ctx, prefix, state, int(batchSize))
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		if err := c.removeBatch(ctx, prefix, ids); err != nil {
			// Promise.allSettled in NestJS also swallows per-job failures; the
			// page still counts against the cycle budget.
			log.Printf("bullmqcleanup: remove batch state=%s: %v", state, err)
		}
		remaining -= int64(len(ids))
	}
	return nil
}

// stateCount mirrors getFailedCount() and getJobCounts("waiting")[0]. The
// waiting count goes through the vendored getCounts script, which ignores the
// deprecated wait-list marker.
func (c *Cleaner) stateCount(ctx context.Context, prefix string, state JobState) (int64, error) {
	stateArgument := string(StateFailed)
	if state == StateWaiting {
		stateArgument = "wait"
	}
	result, err := scriptGetCounts.Run(ctx, c.redis, []string{prefix}, stateArgument).Result()
	if err != nil {
		return 0, err
	}
	counts, ok := result.([]any)
	if !ok || len(counts) == 0 {
		return 0, nil
	}
	return toInt64(counts[0]), nil
}

// oldestIDs mirrors Queue.getJobs([state], 0, n-1, true):
//
//   - failed is a sorted set, so ZRANGE 0..n-1 already returns the lowest
//     scores (the oldest finishedOn) first;
//   - waiting is a list whose head is the newest job, so the getRanges script
//     reads LRANGE -n..-1 and the result is reversed to oldest-first.
func (c *Cleaner) oldestIDs(ctx context.Context, prefix string, state JobState, batchSize int) ([]string, error) {
	if batchSize <= 0 {
		return nil, nil
	}
	if state == StateFailed {
		ids, err := c.redis.ZRange(ctx, prefix+"failed", 0, int64(batchSize-1)).Result()
		if err != nil {
			return nil, err
		}
		return ids, nil
	}
	result, err := scriptGetRanges.Run(ctx, c.redis, []string{prefix},
		0, batchSize-1, "1", "wait").Result()
	if err != nil {
		return nil, err
	}
	groups, ok := result.([]any)
	if !ok || len(groups) == 0 {
		return nil, nil
	}
	page := stringList(groups[0])
	ids := make([]string, 0, len(page))
	for index := len(page) - 1; index >= 0; index-- {
		ids = append(ids, page[index])
	}
	return ids, nil
}

// removeBatch sends one removeJob script per id in a single pipeline. Each
// script receives the same arguments Job.remove() builds: the job key, the
// repeat key, the id, removeChildren=1 and the queue key prefix.
func (c *Cleaner) removeBatch(ctx context.Context, prefix string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	pipe := c.redis.Pipeline()
	for _, id := range ids {
		scriptRemoveJob.Run(ctx, pipe, []string{prefix + id, prefix + "repeat"}, id, "1", prefix)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// stringList normalizes a Lua array result into a string slice.
func stringList(value any) []string {
	switch typed := value.(type) {
	case []any:
		out := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text, ok := entry.(string); ok {
				out = append(out, text)
			}
		}
		return out
	case []string:
		return typed
	default:
		return nil
	}
}

// toInt64 normalizes one numeric Lua result.
func toInt64(value any) int64 {
	switch typed := value.(type) {
	case int64:
		return typed
	case int:
		return int64(typed)
	default:
		return 0
	}
}
