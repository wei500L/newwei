package situationsignals

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// cacheScanCount is CacheService.delByPrefix's default SCAN hint.
const cacheScanCount = 500

// cacheOps is the Redis surface this package uses: one read, one write, an
// increment, a TTL refresh and a prefix delete.
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
	// deleteByPrefix deletes every key with the given prefix using SCAN + DEL and
	// returns how many keys were removed. It is CacheService.delByPrefix.
	deleteByPrefix func(ctx context.Context, prefix string) (int, error)
}

// redisCacheOps binds the five operations to the shared Redis client.
//
// A nil client is the "Redis not configured" case: reads report a miss, writes
// are no-ops and an increment or a prefix delete reports the missing-dependency
// error. Production wiring never passes nil.
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
		deleteByPrefix: func(ctx context.Context, prefix string) (int, error) {
			if client == nil {
				return 0, errNoDatabase
			}
			return redisDeleteByPrefix(ctx, client, prefix)
		},
	}
}

// redisDeleteByPrefix walks every SCAN cursor and deletes the matching pages,
// mirroring CacheService.delByPrefix: the prefix is trimmed (an empty prefix
// deletes nothing), the SCAN hint is cacheScanCount and every page is removed
// with one DEL. The returned count is the number of keys Redis actually removed.
func redisDeleteByPrefix(ctx context.Context, client *redis.Client, prefix string) (int, error) {
	trimmed := strings.TrimSpace(prefix)
	if trimmed == "" {
		return 0, nil
	}
	match := trimmed + "*"
	cursor := uint64(0)
	deleted := 0
	for {
		keys, next, err := client.Scan(ctx, cursor, match, cacheScanCount).Result()
		if err != nil {
			return deleted, err
		}
		cursor = next
		if len(keys) > 0 {
			removed, err := client.Del(ctx, keys...).Result()
			if err != nil {
				return deleted, err
			}
			deleted += int(removed)
		}
		if cursor == 0 {
			return deleted, nil
		}
	}
}
