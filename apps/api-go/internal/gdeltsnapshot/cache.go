package gdeltsnapshot

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
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

// redisLock is lockPort over the shared Redis client. The physical key, the
// token shape, the renewal interval and the compare-and-delete release all
// match CacheService so NestJS and Go contend for one lease.
type redisLock struct {
	client *redis.Client
}

// releaseLockScript deletes the lease only when the owner token still matches.
var releaseLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `)

// renewLockScript extends the lease only while the owner token still matches.
var renewLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `)

// WithLock mirrors CacheService.withLock: one SET NX PX attempt, auto-renewal
// every max(500ms, ttl/3) while the runner is in flight, then a best-effort
// token-checked release. A lease held elsewhere returns acquired=false without
// running anything.
func (l redisLock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	if l.client == nil {
		return false, errCacheUnavailable
	}
	lockKey := "lock:" + key
	token, err := newLockToken()
	if err != nil {
		return false, err
	}
	acquired, err := l.client.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}

	stopRenew := l.startRenewal(lockKey, token, ttl)
	// NestJS releases in a finally block and swallows release errors. The
	// release therefore runs even after a cancelled run context, so a shutdown
	// leaves the lease released instead of waiting for the TTL. stopRenew
	// returns only after the renewal goroutine has exited, so a renewal can
	// never race with the release.
	defer func() {
		stopRenew()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseLockScript.Run(releaseCtx, l.client, []string{lockKey}, token).Err()
	}()
	return true, runner(ctx)
}

// startRenewal keeps the lease alive while the rebuild runs. The returned stop
// function does not return until the renewal goroutine has exited, so no
// renewal can race with the release.
func (l redisLock) startRenewal(key, token string, ttl time.Duration) func() {
	interval := ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = renewLockScript.Run(renewCtx, l.client,
					[]string{key}, token, strconv.FormatInt(ttl.Milliseconds(), 10)).Err()
				cancel()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}
