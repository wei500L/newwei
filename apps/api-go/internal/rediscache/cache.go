// Package rediscache holds the Redis lease and cached-value primitives shared by
// the Go runtime units.
//
// It is deliberately small: it exposes only CacheService.withLock,
// claimSchedulerTick and CacheService.wrap as the NestJS cache module defines
// them, so a Go unit and NestJS contend for the same physical keys and observe
// the same TTLs. It owns no domain key.
package rediscache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrNoClient is returned when a caller passes a nil client. Redis is required
// for every operation in this package; silently skipping the lease would let two
// owners run the same work.
var ErrNoClient = errors.New("rediscache: redis client is not configured")

var (
	releaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)
	renewScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`)
)

// LockKey is the physical key CacheService.withLock uses: every logical key is
// namespaced with "lock:".
func LockKey(key string) string { return "lock:" + key }

func newToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

// WithLock runs runner while holding the lease for key. acquired is false when
// another owner holds it; runner is then not called and the returned error is
// nil.
//
// The lease is a SET NX PX with a random token, renewed every ttl/3 (at least
// 500ms) and released with a compare-and-delete. Release uses a background
// context so a cancelled caller still frees the lease instead of waiting for the
// TTL.
func WithLock(ctx context.Context, client *redis.Client, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	if client == nil {
		return false, ErrNoClient
	}
	if ttl < time.Second {
		ttl = time.Second
	}
	token, err := newToken()
	if err != nil {
		return false, err
	}
	physical := LockKey(key)
	acquired, err := client.SetNX(ctx, physical, token, ttl).Result()
	if err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}

	stopRenew := startRenewal(client, physical, token, ttl, ttl/3)
	defer func() {
		stopRenew()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseScript.Run(releaseCtx, client, []string{physical}, token).Err()
	}()
	return true, runner(ctx)
}

// startRenewal extends the lease while the caller works. interval is explicit
// because withLock renews at ttl/3 and wrap at ttl/2 in NestJS. stop does not
// return until the renewal goroutine exited, so a renewal can never race the
// release.
func startRenewal(client *redis.Client, key, token string, ttl, interval time.Duration) func() {
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
				_ = renewScript.Run(renewCtx, client, []string{key}, token,
					strconv.FormatInt(ttl.Milliseconds(), 10)).Err()
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

// ClaimTick mirrors common/multi-tenant-scheduler claimSchedulerTick:
// SET key {"claimedAt":<ISO>} EX ceil(ttl/1000) NX with no lock: prefix.
func ClaimTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	if client == nil {
		return false, ErrNoClient
	}
	ttlSeconds := int((ttl + time.Second - 1) / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	payload := `{"claimedAt":"` + now.UTC().Format("2006-01-02T15:04:05.000Z") + `"}`
	return client.SetNX(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Result()
}

// GetJSON reads and decodes one JSON entry. found is false for a missing key and
// for the JSON literal null (CacheService.get returns null for both).
func GetJSON[T any](ctx context.Context, client *redis.Client, key string) (value T, found bool, err error) {
	if client == nil {
		return value, false, ErrNoClient
	}
	raw, err := client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return value, false, nil
	}
	if err != nil {
		return value, false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return value, false, nil
	}
	if err := json.Unmarshal(raw, &value); err != nil {
		return value, false, err
	}
	return value, true, nil
}

// SetJSON writes one JSON entry with an expiry, matching CacheService.set.
func SetJSON(ctx context.Context, client *redis.Client, key string, value any, ttl time.Duration) error {
	if client == nil {
		return ErrNoClient
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return client.Set(ctx, key, payload, ttl).Err()
}

// WrapOptions are the CacheService.wrap tunables. Zero values keep the NestJS
// defaults (5s lock, 50ms retry, lockTtl wait).
type WrapOptions struct {
	LockTTL    time.Duration
	RetryDelay time.Duration
	MaxWait    time.Duration
}

func (o WrapOptions) normalized() WrapOptions {
	if o.LockTTL <= 0 {
		o.LockTTL = 5 * time.Second
	}
	if o.RetryDelay <= 0 {
		o.RetryDelay = 50 * time.Millisecond
	}
	if o.MaxWait <= 0 {
		o.MaxWait = o.LockTTL
	}
	return o
}

// Wrap is CacheService.wrap: return a truthy cached value, otherwise run loader
// once under a lease and cache the result. present decides truthiness of a
// decoded value, because JavaScript treats an empty array/object as truthy while
// a zero number, empty string, false or null are falsy.
//
// When the wait budget expires without the lease or a value, loader runs outside
// the lease exactly like NestJS, so a slow upstream still serves the caller.
func Wrap[T any](ctx context.Context, client *redis.Client, key string, ttl time.Duration, options WrapOptions, present func(T) bool, loader func(context.Context) (T, error)) (T, error) {
	var zero T
	if client == nil {
		return zero, ErrNoClient
	}
	if cached, found, err := GetJSON[T](ctx, client, key); err == nil && found && present(cached) {
		return cached, nil
	}
	options = options.normalized()
	physical := LockKey(key)

	token, err := newToken()
	if err != nil {
		return zero, err
	}
	lockTTL := options.LockTTL
	if lockTTL < time.Second {
		lockTTL = time.Second
	}
	acquired, err := client.SetNX(ctx, physical, token, lockTTL).Result()
	if err != nil {
		return zero, err
	}
	if !acquired {
		deadline := time.Now().Add(options.MaxWait)
		for time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return zero, ctx.Err()
			case <-time.After(options.RetryDelay):
			}
			if cached, found, getErr := GetJSON[T](ctx, client, key); getErr == nil && found && present(cached) {
				return cached, nil
			}
			if acquired, err = client.SetNX(ctx, physical, token, lockTTL).Result(); err != nil {
				return zero, err
			}
			if acquired {
				break
			}
		}
	}

	if acquired {
		stopRenew := startRenewal(client, physical, token, lockTTL, lockTTL/2)
		defer func() {
			stopRenew()
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = releaseScript.Run(releaseCtx, client, []string{physical}, token).Err()
		}()
		value, err := loader(ctx)
		if err != nil {
			return zero, err
		}
		if setErr := SetJSON(ctx, client, key, value, ttl); setErr != nil {
			return zero, setErr
		}
		return value, nil
	}

	if cached, found, getErr := GetJSON[T](ctx, client, key); getErr == nil && found && present(cached) {
		return cached, nil
	}
	value, err := loader(ctx)
	if err != nil {
		return zero, err
	}
	if setErr := SetJSON(ctx, client, key, value, ttl); setErr != nil {
		return zero, setErr
	}
	return value, nil
}
