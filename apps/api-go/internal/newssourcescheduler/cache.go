package newssourcescheduler

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file ports the subset of CacheService the scheduler uses: JSON get/set,
// SET NX EX, INCR, HINCRBY, EXPIRE, the `lock:` leased locks with renewal and
// cache.wrap. Values, TTLs and lock keys are identical to NestJS so the two
// implementations exclude each other around the same source.

// cacheEntry is one pipelined SET.
type cacheEntry struct {
	Key   string
	Value string
	TTL   time.Duration
}

// cacheStore is the Redis port. A fake implements it in the unit tests.
type cacheStore interface {
	Get(ctx context.Context, key string) (string, bool, error)
	GetMany(ctx context.Context, keys []string) ([]string, []bool, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	SetMany(ctx context.Context, entries []cacheEntry) error
	SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Del(ctx context.Context, keys ...string) error
	// DelByPrefix is CacheService.delByPrefix: SCAN + DEL, reporting how many
	// keys were removed. Only the RSS seed cache TTL migration uses it.
	DelByPrefix(ctx context.Context, prefix string) (int, error)
	Incr(ctx context.Context, key string) (int64, error)
	IncrMany(ctx context.Context, keys []string) ([]int64, error)
	Expire(ctx context.Context, key string, ttl time.Duration) error
	ExpireMany(ctx context.Context, keys []string, ttl time.Duration) error
	HIncrBy(ctx context.Context, key, field string, value int64) (int64, error)
	Publish(ctx context.Context, channel string, payload []byte) error
	// ReleaseLease and RenewLease run the compare-and-swap scripts on the
	// `lock:` key. Fakes may treat them as no-ops.
	ReleaseLease(ctx context.Context, key, token string) error
	RenewLease(ctx context.Context, key, token string, ttl time.Duration) error
}

// redisCache is the production cacheStore. It never closes the shared client.
type redisCache struct {
	client *redis.Client
}

func newRedisCache(client *redis.Client) *redisCache {
	return &redisCache{client: client}
}

// delByPrefixScanCount is the default CacheService.delByPrefix scanCount.
const delByPrefixScanCount = 500

// lockReleaseScript and lockRenewScript compare the owner token first, exactly
// like CacheService.releaseLock and CacheService.extendLock.
const (
	lockReleaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`
	lockRenewScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`
)

func (c *redisCache) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := c.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (c *redisCache) GetMany(ctx context.Context, keys []string) ([]string, []bool, error) {
	values, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, nil, err
	}
	out := make([]string, len(values))
	present := make([]bool, len(values))
	for index, value := range values {
		if value == nil {
			continue
		}
		text, ok := value.(string)
		if !ok {
			continue
		}
		out[index] = text
		present[index] = true
	}
	return out, present, nil
}

func (c *redisCache) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return c.client.Set(ctx, key, value, ttl).Err()
}

func (c *redisCache) SetMany(ctx context.Context, entries []cacheEntry) error {
	if len(entries) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	for _, entry := range entries {
		pipe.Set(ctx, entry.Key, entry.Value, entry.TTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (c *redisCache) SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	return c.client.SetNX(ctx, key, value, ttl).Result()
}

func (c *redisCache) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return c.client.Del(ctx, keys...).Err()
}

// DelByPrefix is CacheService.delByPrefix: a non-blocking SCAN loop with the
// same MATCH pattern, COUNT and per-page DEL batching.
func (c *redisCache) DelByPrefix(ctx context.Context, prefix string) (int, error) {
	trimmed := trimJS(prefix)
	if trimmed == "" {
		return 0, nil
	}
	match := trimmed + "*"
	var cursor uint64
	deleted := 0
	for {
		keys, next, err := c.client.Scan(ctx, cursor, match, delByPrefixScanCount).Result()
		if err != nil {
			return deleted, err
		}
		if len(keys) > 0 {
			removed, delErr := c.client.Del(ctx, keys...).Result()
			if delErr != nil {
				return deleted, delErr
			}
			deleted += int(removed)
		}
		cursor = next
		if cursor == 0 {
			return deleted, nil
		}
	}
}

func (c *redisCache) Incr(ctx context.Context, key string) (int64, error) {
	return c.client.Incr(ctx, key).Result()
}

func (c *redisCache) IncrMany(ctx context.Context, keys []string) ([]int64, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	pipe := c.client.Pipeline()
	commands := make([]*redis.IntCmd, len(keys))
	for index, key := range keys {
		commands[index] = pipe.Incr(ctx, key)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	out := make([]int64, len(keys))
	for index, command := range commands {
		value, err := command.Result()
		if err != nil {
			return nil, err
		}
		out[index] = value
	}
	return out, nil
}

func (c *redisCache) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return c.client.Expire(ctx, key, ttl).Err()
}

func (c *redisCache) ExpireMany(ctx context.Context, keys []string, ttl time.Duration) error {
	if len(keys) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	for _, key := range keys {
		pipe.Expire(ctx, key, ttl)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (c *redisCache) HIncrBy(ctx context.Context, key, field string, value int64) (int64, error) {
	return c.client.HIncrBy(ctx, key, field, value).Result()
}

func (c *redisCache) Publish(ctx context.Context, channel string, payload []byte) error {
	return c.client.Publish(ctx, channel, string(payload)).Err()
}

func (c *redisCache) ReleaseLease(ctx context.Context, key, token string) error {
	return c.client.Eval(ctx, lockReleaseScript, []string{"lock:" + key}, token).Err()
}

func (c *redisCache) RenewLease(ctx context.Context, key, token string, ttl time.Duration) error {
	millis := ttl.Milliseconds()
	if millis < 1_000 {
		millis = 1_000
	}
	return c.client.Eval(ctx, lockRenewScript, []string{"lock:" + key}, token, millis).Err()
}

// ---- Service helpers -------------------------------------------------------

// randomToken is randomUUID(): 16 random bytes in UUID v4 text form.
func randomToken() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

// cacheGetJSON decodes a JSON cache value. A missing key returns ok=false.
func (s *Service) cacheGetJSON(ctx context.Context, key string, target any) (bool, error) {
	raw, present, err := s.cache.Get(ctx, key)
	if err != nil || !present || raw == "" {
		return false, err
	}
	if err := json.Unmarshal([]byte(raw), target); err != nil {
		return false, nil
	}
	return true, nil
}

// cacheSetJSON writes a JSON cache value with CacheService.set semantics.
func (s *Service) cacheSetJSON(ctx context.Context, key string, value any, ttl time.Duration) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return s.cache.Set(ctx, key, string(encoded), ttl)
}

// cacheSetIfAbsentJSON writes a JSON value only when the key is absent.
func (s *Service) cacheSetIfAbsentJSON(ctx context.Context, key string, value any, ttl time.Duration) (bool, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	return s.cache.SetIfAbsent(ctx, key, string(encoded), ttl)
}

// acquireLease acquires `lock:{key}` with a PX lease and a random owner token.
func (s *Service) acquireLease(ctx context.Context, key string, ttl time.Duration) (string, bool, error) {
	token, err := randomToken()
	if err != nil {
		return "", false, err
	}
	acquired, err := s.cache.SetIfAbsent(ctx, "lock:"+key, token, ttl)
	if err != nil {
		return "", false, err
	}
	if !acquired {
		return "", false, nil
	}
	return token, true, nil
}

// releaseLease is CacheService.releaseLock.
func (s *Service) releaseLease(ctx context.Context, key, token string) {
	if err := s.cache.ReleaseLease(ctx, key, token); err != nil {
		log.Printf("newssourcescheduler: release lease %s: %v", key, err)
	}
}

// renewLease is CacheService.extendLock.
func (s *Service) renewLease(ctx context.Context, key, token string, ttl time.Duration) {
	if err := s.cache.RenewLease(ctx, key, token, ttl); err != nil {
		log.Printf("newssourcescheduler: renew lease %s: %v", key, err)
	}
}

// startLeaseRenewal renews the lease about every TTL/3 while the body runs.
func (s *Service) startLeaseRenewal(ctx context.Context, key, token string, ttl time.Duration) func() {
	interval := ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				s.renewLease(ctx, key, token, ttl)
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

// withLock is CacheService.withLock: it returns ran=false when another process
// holds the lease.
func (s *Service) withLock(ctx context.Context, key string, ttl time.Duration, body func(ctx context.Context) error) (bool, error) {
	token, acquired, err := s.acquireLease(ctx, key, ttl)
	if err != nil || !acquired {
		return false, err
	}
	stop := s.startLeaseRenewal(ctx, key, token, ttl)
	defer stop()
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.releaseLease(releaseCtx, key, token)
	}()
	return true, body(ctx)
}

// wrapCache is CacheService.wrap: read, then take `lock:{key}`, run the loader
// and cache the result. While the loader runs the lock is renewed, exactly like
// the NestJS helper, so a slow discovery does not let a second caller run the
// same loader.
func (s *Service) wrapCache(
	ctx context.Context,
	key string,
	ttl time.Duration,
	loader func(ctx context.Context) ([]json.RawMessage, error),
) ([]json.RawMessage, error) {
	var cached []json.RawMessage
	if ok, err := s.cacheGetJSON(ctx, key, &cached); err == nil && ok && cached != nil {
		return cached, nil
	}

	lockTTL := seedDiscoveryCacheLockTTL
	maxWait := seedDiscoveryCacheMaxWait
	retryDelay := seedDiscoveryCacheRetryDelay
	token, acquired, err := s.acquireLease(ctx, key, lockTTL)
	if err != nil {
		return nil, err
	}
	if !acquired {
		started := s.now()
		for s.now().Sub(started) < maxWait {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(retryDelay):
			}
			var retried []json.RawMessage
			if ok, getErr := s.cacheGetJSON(ctx, key, &retried); getErr == nil && ok && retried != nil {
				return retried, nil
			}
			token, acquired, err = s.acquireLease(ctx, key, lockTTL)
			if err != nil {
				return nil, err
			}
			if acquired {
				break
			}
		}
	}

	if acquired {
		stop := s.startLeaseRenewal(ctx, key, token, lockTTL)
		defer stop()
		defer func() {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			s.releaseLease(releaseCtx, key, token)
		}()
		value, loadErr := loader(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		if setErr := s.cacheSetJSON(ctx, key, value, ttl); setErr != nil {
			log.Printf("newssourcescheduler: cache discovery result %s: %v", key, setErr)
		}
		return value, nil
	}

	var final []json.RawMessage
	if ok, getErr := s.cacheGetJSON(ctx, key, &final); getErr == nil && ok && final != nil {
		return final, nil
	}
	value, loadErr := loader(ctx)
	if loadErr != nil {
		return nil, loadErr
	}
	if setErr := s.cacheSetJSON(ctx, key, value, ttl); setErr != nil {
		log.Printf("newssourcescheduler: cache discovery result %s: %v", key, setErr)
	}
	return value, nil
}
