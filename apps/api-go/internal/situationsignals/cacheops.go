package situationsignals

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// cacheOps is the Redis surface this package uses: one read, one write, an
// increment and a TTL refresh.
//
// It is a struct of typed functions rather than an interface over *redis.Client
// for two reasons. Unit tests can substitute an in-memory store, so the package
// tests never need a live Redis; and no method signature has to accept an
// untyped value, which keeps the package free of untyped containers.
type cacheOps struct {
	// get returns the raw value of a key. A missing key reports redis.Nil.
	get func(ctx context.Context, key string) (string, error)
	// set writes a value with a TTL; a zero TTL means no expiry.
	set func(ctx context.Context, key string, value []byte, ttl time.Duration) error
	// incr increments a counter and returns the new value.
	incr func(ctx context.Context, key string) (int64, error)
	// expire sets a TTL on an existing key.
	expire func(ctx context.Context, key string, ttl time.Duration) error
}

// redisCacheOps binds the four operations to the shared Redis client.
//
// A nil client is the "Redis not configured" case: reads report a miss, writes
// are no-ops and an increment reports the missing-dependency error. Production
// wiring never passes nil.
func redisCacheOps(client *redis.Client) cacheOps {
	return cacheOps{
		get: func(ctx context.Context, key string) (string, error) {
			if client == nil {
				return "", redis.Nil
			}
			return client.Get(ctx, key).Result()
		},
		set: func(ctx context.Context, key string, value []byte, ttl time.Duration) error {
			if client == nil {
				return nil
			}
			if ttl <= 0 {
				return client.Set(ctx, key, value, 0).Err()
			}
			return client.Set(ctx, key, value, ttl).Err()
		},
		incr: func(ctx context.Context, key string) (int64, error) {
			if client == nil {
				return 0, errNoDatabase
			}
			return client.Incr(ctx, key).Result()
		},
		expire: func(ctx context.Context, key string, ttl time.Duration) error {
			if client == nil {
				return nil
			}
			return client.Expire(ctx, key, ttl).Err()
		},
	}
}
