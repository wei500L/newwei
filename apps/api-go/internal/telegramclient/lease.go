package telegramclient

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// leaseIOtimeout bounds every background lease round trip. A renewal must never
// outlive its tick far enough to pile up goroutines, and Close must not hang on
// an unreachable Redis.
const leaseIOtimeout = 5 * time.Second

// minManagerRenewInterval is the floor for the background renewal interval. The
// production lease TTL is DefaultLeaseTTL, so this only matters for tests and
// accidental tiny TTLs.
const minManagerRenewInterval = 50 * time.Millisecond

// errLeaseStoreUnavailable is reported when the Manager has no Redis client; a
// single-instance lease cannot be acquired without one.
var errLeaseStoreUnavailable = errors.New("telegramclient: redis client is not configured")

// leaseStore is the narrow Redis surface of the single-instance lease
// (contract B1). It is an interface so tests can substitute an in-memory
// implementation and never require a live Redis.
type leaseStore interface {
	// SetNX stores value under key with the given TTL only when key is absent.
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	// Renew extends key's TTL only while it still holds token. It reports false
	// when token no longer owns key (the lease expired or was taken over).
	Renew(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	// Release deletes key only while it still holds token.
	Release(ctx context.Context, key, token string) (bool, error)
}

// renewLeaseScript mirrors internal/cronlock's token-checked renewal: PEXPIRE
// only while the stored owner token still matches.
var renewLeaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`)

// releaseLeaseScript deletes the lease only while the stored owner token still
// matches.
var releaseLeaseScript = redis.NewScript(`
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`)

// redisLeaseStore adapts the shared go-redis client to leaseStore.
type redisLeaseStore struct {
	client *redis.Client
}

func (s redisLeaseStore) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	if s.client == nil {
		return false, errLeaseStoreUnavailable
	}
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s redisLeaseStore) Renew(ctx context.Context, key, token string, ttl time.Duration) (bool, error) {
	if s.client == nil {
		return false, errLeaseStoreUnavailable
	}
	result, err := renewLeaseScript.Run(ctx, s.client, []string{key}, token,
		strconv.FormatInt(ttl.Milliseconds(), 10)).Int64()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

func (s redisLeaseStore) Release(ctx context.Context, key, token string) (bool, error) {
	if s.client == nil {
		return false, errLeaseStoreUnavailable
	}
	result, err := releaseLeaseScript.Run(ctx, s.client, []string{key}, token).Int64()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

// lease is one single-owner token lease over Redis with a background renewal
// loop. A new lease object is created for every acquisition, so a lease that
// was lost is neither renewed nor released again.
type lease struct {
	store         leaseStore
	key           string
	ttl           time.Duration
	renewInterval time.Duration
	onLost        func()

	token string

	mu       sync.Mutex
	stopCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once
	lostOnce sync.Once
}

func newLease(store leaseStore, key string, ttl, renewInterval time.Duration, onLost func()) *lease {
	return &lease{
		store:         store,
		key:           key,
		ttl:           ttl,
		renewInterval: renewInterval,
		onLost:        onLost,
	}
}

// tryAcquire attempts to become the single owner of the lease key. ok is false
// (with a nil error) when another process currently holds the key.
func (l *lease) tryAcquire(ctx context.Context) (ok bool, err error) {
	token, err := newLeaseToken()
	if err != nil {
		return false, err
	}
	stored, err := l.store.SetNX(ctx, l.key, token, l.ttl)
	if err != nil {
		return false, err
	}
	if !stored {
		return false, nil
	}

	l.mu.Lock()
	l.token = token
	l.stopCh = make(chan struct{})
	l.doneCh = make(chan struct{})
	stopCh, doneCh := l.stopCh, l.doneCh
	l.mu.Unlock()

	go l.renewLoop(stopCh, doneCh)
	return true, nil
}

// renewLoop keeps the lease alive until it is released, lost, or fails. A
// transient Redis error is ignored: the key only actually disappears after the
// TTL, and the next successful renewal observes whether the token still owns
// it. A renewal that reports "not the owner" is definitive, so the connection
// that depended on the lease is torn down through onLost.
func (l *lease) renewLoop(stopCh, doneCh chan struct{}) {
	defer close(doneCh)

	ticker := time.NewTicker(l.renewInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), leaseIOtimeout)
			owned, err := l.store.Renew(ctx, l.key, l.token, l.ttl)
			cancel()
			if err != nil {
				continue
			}
			if !owned {
				l.markLost()
				return
			}
		}
	}
}

// markLost records that the lease is no longer owned and notifies the Manager
// exactly once.
func (l *lease) markLost() {
	l.lostOnce.Do(func() {
		if l.onLost != nil {
			l.onLost()
		}
	})
}

// release stops the renewal loop and deletes the key while this lease still
// owns it. It is safe to call after the lease was lost; the token-checked
// script then leaves the other owner's key untouched.
func (l *lease) release(ctx context.Context) error {
	l.stopRenewal()

	l.mu.Lock()
	token := l.token
	l.mu.Unlock()
	if token == "" {
		return nil
	}

	held, err := l.store.Release(ctx, l.key, token)
	if err != nil {
		return fmt.Errorf("telegramclient: release lease %q: %w", l.key, err)
	}
	_ = held // false means the lease had already expired or moved on.
	return nil
}

// stopRenewal stops and waits for the renewal goroutine. The wait happens
// without holding mu so a close racing with an in-flight renewal cannot
// deadlock.
func (l *lease) stopRenewal() {
	l.mu.Lock()
	stopCh, doneCh := l.stopCh, l.doneCh
	l.mu.Unlock()
	if stopCh == nil {
		return
	}
	l.stopOnce.Do(func() { close(stopCh) })
	<-doneCh
}

// newLeaseToken returns a random 128-bit owner token.
func newLeaseToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("telegramclient: generate lease token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
