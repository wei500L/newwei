// Package cronlock is the small Redis lease shared by the background duties
// introduced with the Go residual-duty migration.
//
// It mirrors the lease CacheService.withLock already uses in NestJS
// (apps/api/src/modules/cache/cache.service.ts) and the package-private
// implementation in internal/gdeltsnapshot/cache.go: one SET NX PX attempt,
// auto-renewal while the runner is in flight, then a token-checked release.
// The helper exists as its own package because two new owners (the retained-job
// cleanup and the startup reconciliation) need the same semantics and neither
// should import the GDELT snapshot package.
package cronlock

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// errNoClient is returned when the lease has no Redis client.
var errNoClient = errors.New("cronlock: redis is not configured")

// renewScript extends the lease only while the owner token still matches.
var renewScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`)

// releaseScript deletes the lease only while the owner token still matches.
var releaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)

// Lock acquires named leases on the shared Redis.
type Lock struct {
	client *redis.Client
}

// New builds a lease helper.
func New(client *redis.Client) *Lock {
	return &Lock{client: client}
}

// WithLock runs runner while holding the lease. acquired is false when another
// process holds it; runner is then not called. The "lock:" prefix matches the
// physical keys CacheService writes.
func (l *Lock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (acquired bool, err error) {
	if l == nil || l.client == nil {
		return false, errNoClient
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	token, err := newToken()
	if err != nil {
		return false, err
	}
	lockKey := "lock:" + key
	stored, err := l.client.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return false, err
	}
	if !stored {
		return false, nil
	}

	stopRenew := startRenewal(l.client, lockKey, token, ttl)
	// Release mirrors the NestJS finally block: it runs even after a cancelled
	// run context and swallows its own error. stopRenew waits for the renewal
	// goroutine, so a renewal can never race with the release.
	defer func() {
		stopRenew()
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = releaseScript.Run(releaseCtx, l.client, []string{lockKey}, token).Err()
	}()
	return true, runner(ctx)
}

// startRenewal keeps the lease alive every max(500ms, ttl/3).
func startRenewal(client *redis.Client, key, token string, ttl time.Duration) func() {
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

// newToken returns a 128-bit random owner token.
func newToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}
