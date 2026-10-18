package userdigest

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// deliveryLockReleaseScript and deliveryLockRenewScript compare the stored owner
// token before mutating, mirroring CacheService.releaseLock/extendLock.
const (
	deliveryLockReleaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

	deliveryLockRenewScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`
)

// redisDeliveryStore is the production DeliveryStore backed by the shared Redis
// client. It never closes the shared client.
type redisDeliveryStore struct {
	client *redis.Client
}

// NewRedisDeliveryStore wraps the shared Redis client in the narrow delivery
// store port.
func NewRedisDeliveryStore(client *redis.Client) DeliveryStore {
	return &redisDeliveryStore{client: client}
}

func (s *redisDeliveryStore) SetIfAbsent(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	if s == nil || s.client == nil {
		return false, errors.New("userdigest: redis is not configured")
	}
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

func (s *redisDeliveryStore) Get(ctx context.Context, key string) (string, bool, error) {
	if s == nil || s.client == nil {
		return "", false, errors.New("userdigest: redis is not configured")
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

func (s *redisDeliveryStore) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("userdigest: redis is not configured")
	}
	return s.client.Set(ctx, key, value, ttl).Err()
}

func (s *redisDeliveryStore) ReleaseLock(ctx context.Context, key, token string) error {
	if s == nil || s.client == nil {
		return errors.New("userdigest: redis is not configured")
	}
	return s.client.Eval(ctx, deliveryLockReleaseScript, []string{key}, token).Err()
}

func (s *redisDeliveryStore) RenewLock(ctx context.Context, key, token string, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("userdigest: redis is not configured")
	}
	return s.client.Eval(ctx, deliveryLockRenewScript, []string{key}, token, ttl.Milliseconds()).Err()
}

func (s *redisDeliveryStore) Publish(ctx context.Context, channel, payload string) error {
	if s == nil || s.client == nil {
		return errors.New("userdigest: redis is not configured")
	}
	return s.client.Publish(ctx, channel, payload).Err()
}
