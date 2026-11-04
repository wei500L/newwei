package gdeltsnapshot

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
)

// errCacheUnavailable is reported when the Redis client is missing. The
// credentialed wiring never constructs the service without one.
var errCacheUnavailable = errors.New("gdeltsnapshot: redis client is not configured")

// cacheValue is one result of a multi-key read. An absent or empty value is a
// miss, mirroring CacheService.get's truthiness check before JSON.parse.
type cacheValue struct {
	value string
	found bool
}

// cacheEntry is one cache write: key, serialized payload and TTL.
type cacheEntry struct {
	key   string
	value []byte
	ttl   time.Duration
}

// cachePort is the Redis surface the snapshot chain needs. It stays this small
// so the package tests can substitute an in-memory implementation and never
// require a live Redis.
type cachePort interface {
	// MGet reads the listed keys in one round trip, in argument order.
	MGet(ctx context.Context, keys ...string) ([]cacheValue, error)
	// SetMany writes the entries in one pipeline.
	SetMany(ctx context.Context, entries ...cacheEntry) error
}

// lockPort is the shared rebuild lease (CacheService.withLock semantics).
type lockPort interface {
	// WithLock runs runner while holding the lease. acquired is false when
	// another process holds it; runner is then not called.
	WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (acquired bool, err error)
}

// redisCache is cachePort over the shared go-redis client.
type redisCache struct {
	client *redis.Client
}

// MGet reads every key with one MGET. A key that does not exist or holds an
// empty string is reported as a miss.
func (c redisCache) MGet(ctx context.Context, keys ...string) ([]cacheValue, error) {
	if c.client == nil {
		return nil, errCacheUnavailable
	}
	raw, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	values := make([]cacheValue, len(keys))
	for index := range keys {
		if index >= len(raw) || raw[index] == nil {
			continue
		}
		text, ok := raw[index].(string)
		if !ok || text == "" {
			continue
		}
		values[index] = cacheValue{value: text, found: true}
	}
	return values, nil
}

// SetMany writes the fresh and stale layers in one pipeline. The keys, the JSON
// bytes and the TTLs are the NestJS CacheService.set arguments.
func (c redisCache) SetMany(ctx context.Context, entries ...cacheEntry) error {
	if c.client == nil {
		return errCacheUnavailable
	}
	if len(entries) == 0 {
		return nil
	}
	pipeline := c.client.Pipeline()
	for _, entry := range entries {
		pipeline.Set(ctx, entry.key, entry.value, entry.ttl)
	}
	_, err := pipeline.Exec(ctx)
	return err
}

// redisLock is lockPort over the shared Redis client. The whole SET NX PX /
// renewal / token-checked release protocol lives in cronlock; this adapter only
// supplies the physical key prefix and the nil-client guard so NestJS and every
// Go owner contend for the same lease.
type redisLock struct {
	client *redis.Client
}

// WithLock mirrors CacheService.withLock: one SET NX PX attempt, auto-renewal
// every max(500ms, ttl/3) while the runner is in flight, then a best-effort
// token-checked release. A lease held elsewhere returns acquired=false without
// running anything.
func (l redisLock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	if l.client == nil {
		return false, errCacheUnavailable
	}
	return cronlock.New(l.client).WithLease(ctx, "lock:"+key, ttl, cronlock.RenewBestEffort, runner)
}
