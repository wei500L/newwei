package crawlmaintenance

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/redis/go-redis/v9"
)

// releaseLockScript deletes a lease only while the owner token still matches.
// The active-organization cache fill uses it directly; the cron mutual-exclusion
// leases moved to cronlock.
var releaseLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `)

// claimSchedulerTick mirrors multi-tenant-scheduler claimSchedulerTick: the
// documented tick-gate key with no "lock:" prefix, {"claimedAt": ISO} as value
// and EX ceil(ttl/1000). It is never released, so it stays out of cronlock.
func claimSchedulerTick(ctx context.Context, client *redis.Client, key string, ttl time.Duration, now time.Time) (bool, error) {
	if client == nil {
		return false, errRedisUnavailable
	}
	ttlSeconds := int((ttl + time.Second - 1) / time.Second)
	if ttlSeconds < 1 {
		ttlSeconds = 1
	}
	payload := `{"claimedAt":"` + formatISO(now) + `"}`
	return client.SetNX(ctx, key, payload, time.Duration(ttlSeconds)*time.Second).Result()
}

// newLockToken produces the random UUID CacheService uses as the lock owner
// token. The active-organization cache fill uses it directly.
func newLockToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buf[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
