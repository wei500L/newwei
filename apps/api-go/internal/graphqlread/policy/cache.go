package policy

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// ResponseCache stores successful economic responses under a Go-owned prefix.
// It does not reuse Apollo's graphql:response: keys.
type ResponseCache struct {
	redis *redis.Client
}

// NewResponseCache uses the shared Redis client. A nil client disables cache
// operations without failing the request.
func NewResponseCache(client *redis.Client) *ResponseCache {
	return &ResponseCache{redis: client}
}

// Get loads a cached data object. Misses and Redis errors are not hits.
func (c *ResponseCache) Get(ctx context.Context, key string) ([]byte, bool) {
	if c == nil || c.redis == nil || key == "" {
		return nil, false
	}
	value, err := c.redis.Get(ctx, key).Bytes()
	if err != nil || len(value) == 0 {
		return nil, false
	}
	return value, true
}

// Set writes the data JSON with a TTL. Failures are ignored; the response was
// already produced.
func (c *ResponseCache) Set(ctx context.Context, key string, body []byte, ttlSeconds int) {
	if c == nil || c.redis == nil || key == "" || ttlSeconds <= 0 || len(body) == 0 {
		return
	}
	_ = c.redis.Set(ctx, key, body, time.Duration(ttlSeconds)*time.Second).Err()
}
