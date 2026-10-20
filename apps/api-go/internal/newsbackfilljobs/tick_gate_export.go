package newsbackfilljobs

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// ClaimSchedulerTick exposes the shared tick gate to other background units.
//
// It mirrors common/multi-tenant-scheduler claimSchedulerTick exactly: one
// SET key '{"claimedAt":"<ISO>"}' EX ceil(ttl/1000) NX with no "lock:" prefix,
// so NestJS and Go contend for the same interval key. A false result with a nil
// error means another process already claimed the interval; a Redis failure is
// returned to the caller instead of silently running without the gate.
func ClaimSchedulerTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	return claimSchedulerTick(ctx, client, key, ttl, now)
}
