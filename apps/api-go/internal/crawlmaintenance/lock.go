package crawlmaintenance

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/redis/go-redis/v9"
)

// Lock scripts mirror CacheService.releaseLock/extendLock: both compare the
// owner token first, so a lease that expired and was taken by another process is
// never released or extended by the previous owner.
var (
	releaseLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `)
	renewLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `)
)

// withRedisLock is CacheService.withLock: one SET NX PX attempt on
// "lock:"+key, auto-renewal every max(500ms, ttl/3) while the runner is in
// flight, then a best-effort token-checked release. A lease held by another
// process returns acquired=false and the runner never starts.
func withRedisLock(ctx context.Context, client *redis.Client, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	if client == nil {
		return false, errRedisUnavailable
	}
	lockKey := "lock:" + key
	token, err := newLockToken()
	if err != nil {
		return false, err
	}
	acquired, err := client.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}

	stop := startLockRenewal(client, lockKey, token, ttl)
	defer func() {
		stop()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseLockScript.Run(releaseCtx, client, []string{lockKey}, token).Err()
	}()
	return true, runner(ctx)
}

// startLockRenewal keeps the lease alive while the runner is in flight. The
// returned stop function only returns after the renewal goroutine exited, so a
// renewal can never race with the release.
func startLockRenewal(client *redis.Client, lockKey, token string, ttl time.Duration) func() {
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
				_ = renewLockScript.Run(renewCtx, client, []string{lockKey}, token, ttl.Milliseconds()).Err()
				cancel()
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

// claimSchedulerTick mirrors multi-tenant-scheduler claimSchedulerTick: the
// documented tick-gate key with no "lock:" prefix, {"claimedAt": ISO} as value
// and EX ceil(ttl/1000).
func claimSchedulerTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	if client == nil {
		return false, errRedisUnavailable
	}
	ttlSeconds := int((ttl + time.Second - 1) / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	payload := `{"claimedAt":"` + formatISO(now) + `"}`
	return client.SetNX(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Result()
}

// newLockToken produces the random UUID CacheService uses as the lock owner
// token.
func newLockToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
