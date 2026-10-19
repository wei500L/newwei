package newsnowsources

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// Store is the narrow Redis surface the source unit uses: the compatible cache,
// the physical refresh lock and the source-refresh relay. Keeping it as a port
// lets the unit tests exercise cache/lock/batch behaviour without a Redis
// server while production keeps one shared *redis.Client.
type Store interface {
	Get(ctx context.Context, key string) (value string, found bool, err error)
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error)
	Publish(ctx context.Context, channel string, payload []byte) error
}

// redisStore adapts the shared Redis client to Store.
type redisStore struct {
	client *redis.Client
}

// NewRedisStore builds the production Store on the gateway-wide client. It
// creates no second connection pool.
func NewRedisStore(client *redis.Client) Store { return &redisStore{client: client} }

// Get reads one string value; a missing key is (value "", found false, nil).
func (s *redisStore) Get(ctx context.Context, key string) (string, bool, error) {
	value, err := s.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// Set writes one string value with a TTL.
func (s *redisStore) Set(ctx context.Context, key, value string, ttl time.Duration) error {
	return s.client.Set(ctx, key, value, ttl).Err()
}

// SetNX acquires a TTL lease when the key is absent.
func (s *redisStore) SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error) {
	return s.client.SetNX(ctx, key, value, ttl).Result()
}

// Eval runs one of the two token-comparison Lua scripts.
func (s *redisStore) Eval(ctx context.Context, script string, keys []string, args ...string) (int64, error) {
	arguments := make([]interface{}, len(args))
	for index, arg := range args {
		arguments[index] = arg
	}
	value, err := s.client.Eval(ctx, script, keys, arguments...).Int64()
	if err != nil {
		return 0, err
	}
	return value, nil
}

// Publish sends one relay message.
func (s *redisStore) Publish(ctx context.Context, channel string, payload []byte) error {
	return s.client.Publish(ctx, channel, payload).Err()
}
