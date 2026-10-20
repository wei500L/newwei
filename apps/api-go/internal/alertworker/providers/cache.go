package providers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Cache is the Redis value cache + lock the economic anomaly provider uses. Key
// layout, TTL, lock key and lock TTL mirror CacheService.get/set/wrap, so the
// NestJS and Go evaluators share one cache entry for the same
// (`alerts:economicAnomaly:...`) key.
type Cache struct {
	client *redis.Client
}

// NewCache wraps the shared Redis client.
func NewCache(client *redis.Client) *Cache {
	if client == nil {
		return nil
	}
	return &Cache{client: client}
}

// WrapOptions mirrors CacheService.wrap's option bag.
type WrapOptions struct {
	LockTTLMs    int
	RetryDelayMs int
	MaxWaitMs    int
}

var releaseLockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)

var extendLockScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`)

// Wrap calls loader behind the cache, mirroring CacheService.wrap: read, lock
// with SET NX PX, renew the lock while the loader runs, then write the value
// with the requested TTL. When the lock cannot be taken the loader still runs
// after the wait window, like the NestJS fallback.
func Wrap[T any](ctx context.Context, cache *Cache, key string, ttlSeconds int, loader func(context.Context) (T, error), opts WrapOptions) (T, error) {
	var zero T
	if cache == nil || cache.client == nil {
		return loader(ctx)
	}
	cached, ok, err := cache.get(ctx, key)
	if err != nil {
		return zero, err
	}
	if ok {
		var value T
		if err := json.Unmarshal(cached, &value); err == nil {
			return value, nil
		}
	}

	lockTTL := opts.LockTTLMs
	if lockTTL <= 0 {
		lockTTL = 5000
	}
	retryDelay := opts.RetryDelayMs
	if retryDelay <= 0 {
		retryDelay = 50
	}
	maxWait := opts.MaxWaitMs
	if maxWait <= 0 {
		maxWait = lockTTL
	}

	lockKey := "lock:" + key
	token, locked, err := cache.acquireLock(ctx, lockKey, lockTTL)
	if err != nil {
		return zero, err
	}
	if !locked {
		deadline := time.Now().Add(time.Duration(maxWait) * time.Millisecond)
		for time.Now().Before(deadline) {
			if !sleep(ctx, time.Duration(retryDelay)*time.Millisecond) {
				break
			}
			cached, ok, err := cache.get(ctx, key)
			if err != nil {
				return zero, err
			}
			if ok {
				var value T
				if err := json.Unmarshal(cached, &value); err == nil {
					return value, nil
				}
			}
			token, locked, err = cache.acquireLock(ctx, lockKey, lockTTL)
			if err != nil {
				return zero, err
			}
			if locked {
				break
			}
		}
	}

	if locked {
		renewInterval := lockTTL / 2
		if renewInterval < 1000 {
			renewInterval = 1000
		}
		renewCtx, cancelRenew := context.WithCancel(ctx)
		defer cancelRenew()
		go func() {
			ticker := time.NewTicker(time.Duration(renewInterval) * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-renewCtx.Done():
					return
				case <-ticker.C:
					_ = cache.extendLock(renewCtx, lockKey, token, lockTTL)
				}
			}
		}()
		value, err := loader(ctx)
		cancelRenew()
		if err != nil {
			_ = cache.releaseLock(ctx, lockKey, token)
			return zero, err
		}
		if err := cache.set(ctx, key, value, ttlSeconds); err != nil {
			_ = cache.releaseLock(ctx, lockKey, token)
			return value, nil
		}
		_ = cache.releaseLock(ctx, lockKey, token)
		return value, nil
	}

	// The lock stayed busy for the whole wait window: run the loader once, like
	// the NestJS fallback, and publish the result.
	value, err := loader(ctx)
	if err != nil {
		return zero, err
	}
	_ = cache.set(ctx, key, value, ttlSeconds)
	return value, nil
}

func (c *Cache) get(ctx context.Context, key string) (json.RawMessage, bool, error) {
	raw, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("alertworker/providers: cache get %s: %w", key, err)
	}
	return raw, true, nil
}

func (c *Cache) set(ctx context.Context, key string, value any, ttlSeconds int) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if ttlSeconds > 0 {
		return c.client.Set(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Err()
	}
	return c.client.Set(ctx, key, payload, 0).Err()
}

func (c *Cache) acquireLock(ctx context.Context, key string, ttlMs int) (string, bool, error) {
	token, err := newCacheToken()
	if err != nil {
		return "", false, err
	}
	ok, err := c.client.SetNX(ctx, key, token, time.Duration(ttlMs)*time.Millisecond).Result()
	if err != nil {
		return "", false, err
	}
	if !ok {
		return "", false, nil
	}
	return token, true, nil
}

func (c *Cache) releaseLock(ctx context.Context, key, token string) error {
	return releaseLockScript.Run(ctx, c.client, []string{key}, token).Err()
}

func (c *Cache) extendLock(ctx context.Context, key, token string, ttlMs int) error {
	if ttlMs < 1000 {
		ttlMs = 1000
	}
	return extendLockScript.Run(ctx, c.client, []string{key}, token, ttlMs).Err()
}

func newCacheToken() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", fmt.Errorf("alertworker/providers: cache lock token: %w", err)
	}
	return hex.EncodeToString(buffer[:]), nil
}

func sleep(ctx context.Context, duration time.Duration) bool {
	if duration <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
