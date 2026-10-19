package newsbackfilljobs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// releaseLockScript and renewLockScript are the CacheService.withLock scripts:
// both check the owner token before touching the key, so a lock that expired
// and was re-acquired by another instance is never released or extended by the
// old owner.
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

// redisLock is one CacheService.withLock lease: SET NX PX with a random UUID
// token, an auto-renew every ttl/3, and a token-checked release.
type redisLock struct {
	client *redis.Client
	key    string
	token  string
	ttl    time.Duration
	stop   chan struct{}
	once   sync.Once
}

// acquireRedisLock attempts one lock. It returns (nil, nil) when another owner
// holds the key.
func acquireRedisLock(ctx context.Context, client *redis.Client, key string, ttl time.Duration) (*redisLock, error) {
	if client == nil {
		return nil, nil
	}
	if ttl < time.Second {
		ttl = time.Second
	}
	token, err := newLockToken()
	if err != nil {
		return nil, err
	}
	acquired, err := client.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return nil, err
	}
	if !acquired {
		return nil, nil
	}
	lock := &redisLock{client: client, key: key, token: token, ttl: ttl, stop: make(chan struct{})}
	lock.startRenew()
	return lock, nil
}

// startRenew extends the lease every ttl/3. The renewal uses a background
// context so a scan that outlives its request context still keeps the lease
// until it stops.
func (l *redisLock) startRenew() {
	interval := l.ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-l.stop:
				return
			case <-ticker.C:
				renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = renewLockScript.Run(renewCtx, l.client, []string{l.key}, l.token, l.ttl.Milliseconds()).Err()
				cancel()
			}
		}
	}()
}

// Release stops the renewal and deletes the key only when this lease still owns
// it.
func (l *redisLock) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		close(l.stop)
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseLockScript.Run(releaseCtx, l.client, []string{l.key}, l.token).Err()
	})
}

// newLockToken produces the random UUID the NestJS CacheService uses as the
// lock owner token.
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

// claimSchedulerTick mirrors common/multi-tenant-scheduler claimSchedulerTick:
// SET key {"claimedAt":...} EX ceil(ttl/1000) NX, with no lock: prefix.
func claimSchedulerTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	if client == nil {
		return false, nil
	}
	ttlSeconds := int((ttl + time.Second - 1) / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	payload := `{"claimedAt":"` + now.UTC().Format("2006-01-02T15:04:05.000Z") + `"}`
	return client.SetNX(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Result()
}
