package auditoutbox

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// The two token-checked scripts mirror CacheService.releaseLock/extendLock and
// the userdigest delivery store. The userdigest Lua helpers are package
// private, so this package owns its copies instead of pretending they can be
// called across packages.
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

// LockStore is the narrow Redis port for the per-minute cron lease. It is
// deliberately smaller than the digest delivery store: this chain only needs
// an NX/PX lease with a token comparison on renew and release.
type LockStore interface {
	SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	RenewLock(ctx context.Context, key, token string, ttl time.Duration) error
	ReleaseLock(ctx context.Context, key, token string) error
}

// redisLockStore is the production LockStore backed by the shared Redis client.
// It never closes the shared client.
type redisLockStore struct {
	client *redis.Client
}

// NewRedisLockStore wraps the shared Redis client in the narrow lease port.
func NewRedisLockStore(client *redis.Client) LockStore {
	return &redisLockStore{client: client}
}

func (s *redisLockStore) SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	if s == nil || s.client == nil {
		return false, errors.New("auditoutbox: redis is not configured")
	}
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s *redisLockStore) RenewLock(ctx context.Context, key, token string, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("auditoutbox: redis is not configured")
	}
	return s.client.Eval(ctx, lockRenewScript, []string{key}, token, ttl.Milliseconds()).Err()
}

func (s *redisLockStore) ReleaseLock(ctx context.Context, key, token string) error {
	if s == nil || s.client == nil {
		return errors.New("auditoutbox: redis is not configured")
	}
	return s.client.Eval(ctx, lockReleaseScript, []string{key}, token).Err()
}
