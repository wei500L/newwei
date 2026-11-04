// Package cronlock is the single Redis lease implementation shared by the
// background duties.
//
// It mirrors the lease CacheService.withLock already uses in NestJS
// (apps/api/src/modules/cache/cache.service.ts): one SET NX PX attempt, optional
// auto-renewal while the runner is in flight, then a token-checked release. The
// physical keys written by every migrated owner are kept byte-for-byte, so a
// rolling deploy where a NestJS or older Go process still holds "lock:<name>"
// keeps excluding the new code.
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

	"github.com/wei500L/newwei/apps/api-go/internal/safego"
)

// errNoClient is returned when the lease has no Redis client.
var errNoClient = errors.New("cronlock: redis is not configured")

// renewScript extends the lease only while the owner token still matches.
const renewScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

// releaseScript deletes the lease only while the owner token still matches.
const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

// Store is the minimal Redis command surface a lease needs. Production wires a
// *redis.Client through New; an in-memory test double can implement it directly.
type Store interface {
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error)
}

// redisStore adapts the shared go-redis client to Store.
type redisStore struct {
	client *redis.Client
}

func (s redisStore) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	if s.client == nil {
		return false, errNoClient
	}
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s redisStore) Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error) {
	if s.client == nil {
		return 0, errNoClient
	}
	values := make([]interface{}, len(args))
	for index, arg := range args {
		values[index] = arg
	}
	return s.client.Eval(ctx, script, keys, values...).Int64()
}

// RenewMode selects the renewal behaviour of a lease.
type RenewMode int

const (
	// RenewBestEffort renews every max(500ms, ttl/3) and ignores a failed or
	// rejected renewal: the caller is a one-shot idempotent duty that may finish
	// while another process owns the lease. This is the WithLock semantics.
	RenewBestEffort RenewMode = iota
	// RenewNone never renews: the lease lives for its TTL and is only released
	// through the token-checked script while the runner is still inside it.
	RenewNone
)

// Lock acquires named leases on the shared Redis.
type Lock struct {
	store Store
}

// New builds a lease helper over the shared go-redis client.
func New(client *redis.Client) *Lock {
	return &Lock{store: redisStore{client: client}}
}

// NewStore builds a lease helper over any Store implementation.
func NewStore(store Store) *Lock {
	return &Lock{store: store}
}

// WithLock runs runner while holding the lease "lock:"+key. acquired is false
// when another process holds it; runner is then not called.
func (l *Lock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (acquired bool, err error) {
	return l.WithLease(ctx, "lock:"+key, ttl, RenewBestEffort, runner)
}

// WithLease runs runner while holding the lease at the complete physical key.
// acquired is false when another process holds it; runner is then not called.
//
// The key is used verbatim: owners whose NestJS logical key already carried a
// "lock:" prefix (or whose physical key is not the generic prefix at all) pass
// it here so the wire key never gains a second prefix or loses the original one.
func (l *Lock) WithLease(ctx context.Context, physicalKey string, ttl time.Duration, mode RenewMode, runner func(context.Context) error) (acquired bool, err error) {
	lease, acquired, err := l.Acquire(ctx, physicalKey, ttl, mode)
	if err != nil || !acquired {
		return acquired, err
	}
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = lease.Release(releaseCtx)
	}()
	return true, runner(ctx)
}

// WithRenewableLock runs runner while holding the lease and cancels the context
// handed to runner as soon as the lease can no longer be extended.
//
// The difference from WithLock is what happens after a lost lease. WithLock
// ignores the renewal result, because its callers are one-shot idempotent duties
// that may finish while another process holds the lease. A long-lived exclusive
// reader cannot do that: it would keep consuming and writing after a second
// process owns the same duty. WithRenewableLock therefore watches every renewal
// and cancels runner when the renewal either fails (Redis error) or returns 0
// (the owner token no longer matches, so the TTL expired and another process
// acquired the lease). runner is expected to return promptly after its context
// is cancelled; the lease is then released through the same token-checked script
// as WithLock, so a stale owner never deletes the new owner's lease.
//
// acquired is false when another process holds the lease; runner is then not
// called and the returned error is nil.
func (l *Lock) WithRenewableLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (acquired bool, err error) {
	if l == nil || l.store == nil {
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
	stored, err := l.store.SetNX(ctx, lockKey, token, ttl)
	if err != nil {
		return false, err
	}
	if !stored {
		return false, nil
	}

	runCtx, cancelRun := context.WithCancel(ctx)
	defer cancelRun()
	stopRenew := startGuardedRenewal(l.store, lockKey, token, ttl, cancelRun)
	defer func() {
		stopRenew()
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer releaseCancel()
		_, _ = l.store.Eval(releaseCtx, releaseScript, []string{lockKey}, token)
	}()
	return true, runner(runCtx)
}

// Acquire takes the lease at the complete physical key and returns a handle the
// caller releases later. It is the object form of WithLease for owners whose
// critical section outlives the call that acquired the lock (for example a
// request that starts a background rebuild and returns before it finishes).
//
// ok is false (with a nil error) when another process currently holds the key.
func (l *Lock) Acquire(ctx context.Context, physicalKey string, ttl time.Duration, mode RenewMode) (lease *Lease, ok bool, err error) {
	if l == nil || l.store == nil {
		return nil, false, errNoClient
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	token, err := newToken()
	if err != nil {
		return nil, false, err
	}
	stored, err := l.store.SetNX(ctx, physicalKey, token, ttl)
	if err != nil {
		return nil, false, err
	}
	if !stored {
		return nil, false, nil
	}
	acquired := &Lease{store: l.store, key: physicalKey, token: token}
	if mode == RenewBestEffort {
		acquired.stopRenew = startRenewal(l.store, physicalKey, token, ttl)
	}
	return acquired, true, nil
}

// Lease is one held physical-key lease. Release is idempotent and token-checked.
type Lease struct {
	store     Store
	key       string
	token     string
	stopRenew func()
	once      sync.Once
}

// Release stops the renewal and deletes the lease only while this owner still
// holds the token.
func (le *Lease) Release(ctx context.Context) error {
	if le == nil || le.store == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var err error
	le.once.Do(func() {
		if le.stopRenew != nil {
			le.stopRenew()
		}
		_, err = le.store.Eval(ctx, releaseScript, []string{le.key}, le.token)
	})
	return err
}

// startGuardedRenewal keeps the lease alive every max(500ms, ttl/3) and calls
// onLost once when the lease can no longer be extended. Unlike startRenewal it
// owns no silent failure mode: the first failed or rejected renewal stops the
// ticker, so the lease is never extended after it was lost.
func startGuardedRenewal(store Store, key, token string, ttl time.Duration, onLost context.CancelFunc) func() {
	interval := ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	done := make(chan struct{})
	safego.Go("cronlock.lock.guardedRenewal", func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				var extended int64
				renewErr := safego.Call("cronlock.lock.guardedRenewal.tick", func() error {
					renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					var err error
					extended, err = store.Eval(renewCtx, renewScript, []string{key}, token,
						strconv.FormatInt(ttl.Milliseconds(), 10))
					return err
				})
				if renewErr != nil || extended == 0 {
					onLost()
					return
				}
			}
		}
	})
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

// startRenewal keeps the lease alive every max(500ms, ttl/3).
func startRenewal(store Store, key, token string, ttl time.Duration) func() {
	interval := ttl / 3
	if interval < 500*time.Millisecond {
		interval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	done := make(chan struct{})
	safego.Go("cronlock.lock.renewal", func() {
		defer close(done)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = safego.Call("cronlock.lock.renewal.tick", func() error {
					renewCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					_, _ = store.Eval(renewCtx, renewScript, []string{key}, token,
						strconv.FormatInt(ttl.Milliseconds(), 10))
					return nil
				})
			}
		}
	})
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
