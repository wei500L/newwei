package itemsreading

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// releaseLockScript is the compare-and-delete used by CacheService.releaseLock.
const releaseLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `

// renewLockScript is the compare-and-pexpire used by CacheService.extendLock.
const renewLockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `

// redisCache is the distributed JSON cache shared with NestJS. It ports
// CacheService: values are JSON, and wrap() uses a `lock:<key>` token lease so
// two processes never run the same expensive loader at once.
type redisCache struct {
	client *redis.Client
}

// newRedisCache wraps a Redis client.
func newRedisCache(client *redis.Client) *redisCache {
	return &redisCache{client: client}
}

// Get reads a JSON value. A missing key or a stored JSON null is a miss, which
// mirrors CacheService.get's truthiness check (`if (cached) return cached`).
func (c *redisCache) Get(ctx context.Context, key string) (json.RawMessage, bool) {
	if c == nil || c.client == nil {
		return nil, false
	}
	value, err := c.client.Get(ctx, key).Bytes()
	if err != nil || len(value) == 0 {
		return nil, false
	}
	if !json.Valid(value) {
		return nil, false
	}
	if string(value) == "null" {
		return nil, false
	}
	return json.RawMessage(value), true
}

// Set writes a JSON value with an optional TTL (zero means no expiry, exactly
// like CacheService.set).
func (c *redisCache) Set(ctx context.Context, key string, value json.RawMessage, ttlSeconds int) error {
	if c == nil || c.client == nil {
		return errors.New("cache is not configured")
	}
	if ttlSeconds > 0 {
		return c.client.Set(ctx, key, []byte(value), time.Duration(ttlSeconds)*time.Second).Err()
	}
	return c.client.Set(ctx, key, []byte(value), 0).Err()
}

// Del removes keys.
func (c *redisCache) Del(ctx context.Context, keys ...string) error {
	if c == nil || c.client == nil || len(keys) == 0 {
		return nil
	}
	return c.client.Del(ctx, keys...).Err()
}

// Wrap ports CacheService.wrap: read-through caching with a distributed lock,
// lock renewal while the loader runs, and a no-lock fallback that still
// executes the loader and still writes the cache when the wait budget expires.
func (c *redisCache) Wrap(
	ctx context.Context,
	key string,
	ttlSeconds int,
	loader func(context.Context) (json.RawMessage, error),
) (json.RawMessage, error) {
	if cached, ok := c.Get(ctx, key); ok {
		return cached, nil
	}
	lockKey := "lock:" + key
	lockToken, acquired := c.acquireLock(ctx, lockKey, CacheLockTTLMs)
	if !acquired {
		deadline := time.Now().Add(time.Duration(CacheLockMaxWaitMs) * time.Millisecond)
		for time.Now().Before(deadline) {
			if err := sleepContext(ctx, time.Duration(CacheLockRetryDelayMs)*time.Millisecond); err != nil {
				return nil, err
			}
			if cached, ok := c.Get(ctx, key); ok {
				return cached, nil
			}
			if token, ok := c.acquireLock(ctx, lockKey, CacheLockTTLMs); ok {
				lockToken = token
				acquired = true
				break
			}
		}
	}

	if acquired {
		renewInterval := CacheLockTTLMs / 2
		if renewInterval < 1_000 {
			renewInterval = 1_000
		}
		stopRenew := make(chan struct{})
		go func() {
			ticker := time.NewTicker(time.Duration(renewInterval) * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-stopRenew:
					return
				case <-ticker.C:
					c.extendLock(context.WithoutCancel(ctx), lockKey, lockToken, CacheLockTTLMs)
				}
			}
		}()
		value, err := loader(ctx)
		close(stopRenew)
		if err != nil {
			c.releaseLock(context.WithoutCancel(ctx), lockKey, lockToken)
			return nil, err
		}
		if setErr := c.Set(ctx, key, value, ttlSeconds); setErr != nil {
			c.releaseLock(context.WithoutCancel(ctx), lockKey, lockToken)
			return nil, setErr
		}
		c.releaseLock(context.WithoutCancel(ctx), lockKey, lockToken)
		return value, nil
	}

	if cached, ok := c.Get(ctx, key); ok {
		return cached, nil
	}
	value, err := loader(ctx)
	if err != nil {
		return nil, err
	}
	if setErr := c.Set(ctx, key, value, ttlSeconds); setErr != nil {
		return nil, setErr
	}
	return value, nil
}

// acquireLock implements SET key token PX ttl NX.
func (c *redisCache) acquireLock(ctx context.Context, lockKey string, ttlMs int) (string, bool) {
	if c == nil || c.client == nil {
		return "", false
	}
	token := randomToken()
	ok, err := c.client.SetNX(ctx, lockKey, token, time.Duration(ttlMs)*time.Millisecond).Result()
	if err != nil || !ok {
		return "", false
	}
	return token, true
}

// releaseLock compares the token before deleting.
func (c *redisCache) releaseLock(ctx context.Context, lockKey, token string) {
	if c == nil || c.client == nil || token == "" {
		return
	}
	_ = c.client.Eval(ctx, releaseLockScript, []string{lockKey}, token).Err()
}

// extendLock compares the token before renewing the lease.
func (c *redisCache) extendLock(ctx context.Context, lockKey, token string, ttlMs int) {
	if c == nil || c.client == nil || token == "" {
		return
	}
	ttl := ttlMs
	if ttl < 1_000 {
		ttl = 1_000
	}
	_ = c.client.Eval(ctx, renewLockScript, []string{lockKey}, token, strconv.Itoa(ttl)).Err()
}

// randomToken returns a lock token (a UUID-equivalent unique value).
func randomToken() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buffer)
}

// sleepContext waits for the given duration or until the context is done.
func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
