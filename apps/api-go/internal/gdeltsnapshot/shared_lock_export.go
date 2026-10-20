package gdeltsnapshot

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// SharedLock exposes the CacheService.withLock lease to other background cron
// units.
//
// The physical key is "lock:" + key, the value is a random version-4 UUID, the
// lease is renewed every max(500ms, ttl/3) and the release is token-checked, so
// a Go owner and a NestJS owner of the same cron key exclude each other. A
// false acquired result with a nil error means another process holds the lease
// and the runner was not called.
type SharedLock struct {
	port lockPort
}

// NewSharedLock builds the lease port over the shared Redis client.
func NewSharedLock(client *redis.Client) *SharedLock {
	return &SharedLock{port: redisLock{client: client}}
}

// WithLock runs runner while holding the lease.
func (l *SharedLock) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	if l == nil || l.port == nil {
		return false, errCacheUnavailable
	}
	return l.port.WithLock(ctx, key, ttl, runner)
}
