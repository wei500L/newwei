package newsbackfilljobs

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// claimSchedulerTick mirrors common/multi-tenant-scheduler claimSchedulerTick:
// SET key {"claimedAt":...} EX ceil(ttl/1000) NX, with no lock: prefix.
//
// This is a tick gate, not a mutual-exclusion lease: it is never released and
// the TTL is what paces the next tick, so it deliberately stays out of cronlock.
func claimSchedulerTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	if client == nil {
		return false, nil
	}
	ttlSeconds := int((ttl + time.Second - 1) / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	payload := `{"claimedAt":"` + now.UTC().Format("2006-01-02T15:04:05.000Z") + `"}`
	return client.SetNX(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Result()
}
