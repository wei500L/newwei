package searchreindex

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// reindexLockTTL is SEARCH_REINDEX_LOCK_TTL_MS from search-reindex.service.ts.
const reindexLockTTL = 5 * time.Minute

// reindexLockKeyPrefix is the physical lock key. SearchReindexService passes the
// logical name "search:reindex:org:<orgId>" to CacheService, which adds the
// "lock:" prefix; this constant uses the resulting physical key directly so the
// lock can never be mistaken for the organization job list.
const reindexLockKeyPrefix = "lock:search:reindex:org:"

// Both scripts compare the owner token, mirroring CacheService.extendLock and
// CacheService.releaseLock.
const (
	reindexLockRenewScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

	reindexLockReleaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`
)

// reindexLock is one held organization lock: SET NX PX with a random owner
// token, renewed every TTL/3 and released only while the token still matches.
type reindexLock struct {
	client *redis.Client
	key    string
	token  string
	ttl    time.Duration
}

// reindexLockKey builds the physical Redis lock key for one organization.
func reindexLockKey(orgID string) string {
	return reindexLockKeyPrefix + orgID
}

// acquireReindexLock runs SET NX PX on the physical lock key. acquired is false
// when another run already holds this organization's lock; err is reserved for
// Redis failures.
func acquireReindexLock(ctx context.Context, client *redis.Client, orgID string) (lock *reindexLock, acquired bool, err error) {
	token, err := newOwnerToken()
	if err != nil {
		return nil, false, err
	}
	key := reindexLockKey(orgID)
	stored, err := client.SetNX(ctx, key, token, reindexLockTTL).Result()
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", errRedis, err)
	}
	if !stored {
		return nil, false, nil
	}
	return &reindexLock{client: client, key: key, token: token, ttl: reindexLockTTL}, true, nil
}

// extend refreshes the TTL only while this owner still holds the token.
func (l *reindexLock) extend(ctx context.Context) error {
	if l == nil {
		return nil
	}
	return l.client.Eval(ctx, reindexLockRenewScript, []string{l.key}, l.token, l.ttl.Milliseconds()).Err()
}

// release deletes the lock only while this owner still holds the token.
func (l *reindexLock) release(ctx context.Context) error {
	if l == nil {
		return nil
	}
	return l.client.Eval(ctx, reindexLockReleaseScript, []string{l.key}, l.token).Err()
}

// startAutoRenew renews the lock every TTL/3 (about 100 seconds) until the
// returned stop function is called or ctx is cancelled. Renewal stays best
// effort, like CacheService.startAutoRenew: a failed renewal is ignored here and
// the rebuild keeps running under the existing protocol.
func (l *reindexLock) startAutoRenew(ctx context.Context) func() {
	interval := reindexLockTTL / 3
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = l.extend(ctx)
			}
		}
	}()
	return func() {
		once.Do(func() { close(stop) })
	}
}
