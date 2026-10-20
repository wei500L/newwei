package kgingestion

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// articleFailureKeyPrefix is the K1 failure counter namespace. The TTL keeps a
// transient failure from being remembered forever.
const (
	articleFailureKeyPrefix = "kg-ingestion:article-failures:"
	articleFailureTTL       = 24 * time.Hour
)

// The release and renew scripts compare the owner token before mutating,
// mirroring CacheService.releaseLock and CacheService.extendLock.
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

// RedisStore is the narrow Redis port the scheduler needs: the tick gate, the
// active-organization cache and the per-organization lock.
type RedisStore interface {
	SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Get(ctx context.Context, key string) (string, bool, error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	ReleaseLock(ctx context.Context, key, token string) error
	RenewLock(ctx context.Context, key, token string, ttl time.Duration) error
}

type redisStore struct {
	client *redis.Client
}

// NewRedisStore wraps the shared Redis client. It never closes the client.
func NewRedisStore(client *redis.Client) RedisStore {
	return &redisStore{client: client}
}

func (s *redisStore) SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	if s == nil || s.client == nil {
		return false, errors.New("kgingestion: redis is not configured")
	}
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s *redisStore) Get(ctx context.Context, key string) (string, bool, error) {
	if s == nil || s.client == nil {
		return "", false, errors.New("kgingestion: redis is not configured")
	}
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

func (s *redisStore) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("kgingestion: redis is not configured")
	}
	return s.client.Set(ctx, key, value, ttl).Err()
}

func (s *redisStore) ReleaseLock(ctx context.Context, key, token string) error {
	if s == nil || s.client == nil {
		return errors.New("kgingestion: redis is not configured")
	}
	return s.client.Eval(ctx, lockReleaseScript, []string{key}, token).Err()
}

func (s *redisStore) RenewLock(ctx context.Context, key, token string, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("kgingestion: redis is not configured")
	}
	return s.client.Eval(ctx, lockRenewScript, []string{key}, token, ttl.Milliseconds()).Err()
}

// RedisFailureCounter is the K1 consecutive-failure counter: one Redis key per
// (organization, article) with a one-day TTL.
type RedisFailureCounter struct {
	client *redis.Client
}

// NewRedisFailureCounter builds the counter on the shared Redis client.
func NewRedisFailureCounter(client *redis.Client) FailureCounter {
	return &RedisFailureCounter{client: client}
}

// Increment adds one failure and returns the new count. The TTL is set on the
// first increment so a busy key keeps its one-day window from the first
// failure.
func (c *RedisFailureCounter) Increment(ctx context.Context, orgID, articleID string) (int64, error) {
	if c == nil || c.client == nil {
		return 0, errors.New("kgingestion: redis is not configured")
	}
	key := articleFailureKeyPrefix + orgID + ":" + articleID
	count, err := c.client.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if count == 1 {
		if err := c.client.Expire(ctx, key, articleFailureTTL).Err(); err != nil {
			return count, err
		}
	}
	return count, nil
}

// Reset clears the counter after a success or after the article is skipped.
func (c *RedisFailureCounter) Reset(ctx context.Context, orgID, articleID string) error {
	if c == nil || c.client == nil {
		return errors.New("kgingestion: redis is not configured")
	}
	return c.client.Del(ctx, articleFailureKeyPrefix+orgID+":"+articleID).Err()
}
