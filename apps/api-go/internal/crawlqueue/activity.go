package crawlqueue

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// ActivityCounter ports CrawlActivityService's crawl:activity hash writes. The
// hash is not namespaced (CacheService has no key prefix), so NestJS and Go
// share one counter.

// Activity is the Redis-backed active crawl task counter.
type Activity struct {
	redis *redis.Client
	now   func() time.Time
}

// NewActivity builds the counter on the shared Redis client.
func NewActivity(redisClient *redis.Client) *Activity {
	return &Activity{redis: redisClient}
}

// MarkTaskQueued is markTaskQueued: HINCRBY +1 and lastEnqueuedAt = now ISO.
// The two commands are not atomic in NestJS either (Promise.all).
func (a *Activity) MarkTaskQueued(ctx context.Context) error {
	if a == nil || a.redis == nil {
		return errNoRedis
	}
	now := a.clock().UTC().Format("2006-01-02T15:04:05.000Z")
	pipe := a.redis.Pipeline()
	pipe.HIncrBy(ctx, ActivityHashKey, ActiveTaskCountField, 1)
	pipe.HSet(ctx, ActivityHashKey, LastEnqueuedAtField, now)
	_, err := pipe.Exec(ctx)
	return err
}

// MarkTasksTerminal is markTasksTerminal: decrement by count, floor at zero and
// record lastTerminalAt. A non-positive count only records the timestamp.
func (a *Activity) MarkTasksTerminal(ctx context.Context, count int) error {
	if a == nil || a.redis == nil {
		return errNoRedis
	}
	now := a.clock().UTC().Format("2006-01-02T15:04:05.000Z")
	if count <= 0 {
		return a.redis.HSet(ctx, ActivityHashKey, LastTerminalAtField, now).Err()
	}
	next, err := a.redis.HIncrBy(ctx, ActivityHashKey, ActiveTaskCountField, int64(-count)).Result()
	if err != nil {
		return err
	}
	values := map[string]any{LastTerminalAtField: now}
	if next < 0 {
		values[ActiveTaskCountField] = 0
	}
	return a.redis.HSet(ctx, ActivityHashKey, values).Err()
}

func (a *Activity) clock() time.Time {
	if a != nil && a.now != nil {
		return a.now()
	}
	return time.Now()
}

// errNoRedis reports a missing Redis handle.
var errNoRedis = errorString("crawlqueue: redis is not configured")

type errorString string

func (e errorString) Error() string { return string(e) }
