package oidclogin

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisCache adapts the shared Redis client to the cacheStore subset. It keeps
// the exact key strings and TTL units the NestJS CacheService uses.
type redisCache struct {
	client *redis.Client
}

func (c redisCache) Get(ctx context.Context, key string) ([]byte, bool, error) {
	if c.client == nil {
		return nil, false, errNoRedis
	}
	value, err := c.client.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, cacheWrap(err)
	}
	return value, true, nil
}

func (c redisCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if c.client == nil {
		return errNoRedis
	}
	if err := c.client.Set(ctx, key, value, ttl).Err(); err != nil {
		return cacheWrap(err)
	}
	return nil
}

// GetDel is one server-side command. The callback state must never be read and
// then deleted in two steps: two concurrent callbacks holding the same state
// would both see the payload and both try to exchange the code.
func (c redisCache) GetDel(ctx context.Context, key string) ([]byte, bool, error) {
	if c.client == nil {
		return nil, false, errNoRedis
	}
	value, err := c.client.GetDel(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, cacheWrap(err)
	}
	return value, true, nil
}
