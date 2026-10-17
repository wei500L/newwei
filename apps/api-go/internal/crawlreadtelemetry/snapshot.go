package crawlreadtelemetry

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Snapshot / lock timings mirror ObservabilitySnapshotService and CacheService:
// a 15 second lock TTL, a 100 ms retry delay and a 20 second maximum wait, and
// the Redis lock key is "lock:observability-snapshot:<orgId>:<scope>:<variant>".
const (
	snapshotLockTTL       = 15 * time.Second
	snapshotRenewInterval = 5 * time.Second
	snapshotMaxWait       = 20 * time.Second
	snapshotRetryDelay    = 100 * time.Millisecond
)

var (
	snapshotReleaseLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `)
	snapshotRenewLockScript = redis.NewScript(`
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      end
      return 0
    `)
)

// snapshotStore owns the MySQL ObservabilitySnapshot rows and the Redis
// distributed lock that serializes rebuilds across the Go and NestJS
// processes. Both sides share the same lock key.
type snapshotStore struct {
	db    *sql.DB
	redis *redis.Client
}

// snapshotCacheKey is the shared Redis/Mysql payload key.
func snapshotCacheKey(orgID, scope, variantKey string) string {
	return "observability-snapshot:" + orgID + ":" + scope + ":" + variantKey
}

// getOrCreateJSON returns a fresh snapshot payload, rebuilding it through
// loader when the stored row is missing or expired. It mirrors
// ObservabilitySnapshotService.getOrCreate, including the final unlock-free
// rebuild after the wait budget expires.
func (s *snapshotStore) getOrCreateJSON(
	ctx context.Context,
	orgID, scope, variantKey string,
	ttlSeconds int,
	loader func() ([]byte, error),
) ([]byte, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errDatabase)
	}
	if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
		return nil, err
	} else if ok {
		return payload, nil
	}

	key := snapshotCacheKey(orgID, scope, variantKey)
	lockKey := "lock:" + key
	token, err := randomToken()
	if err != nil {
		return nil, err
	}
	acquired, err := s.acquireLock(ctx, lockKey, token, snapshotLockTTL)
	if err != nil {
		return nil, err
	}
	if acquired {
		stop := s.startAutoRenew(lockKey, token, snapshotLockTTL, snapshotRenewInterval)
		defer stop()
		defer s.releaseLock(lockKey, token)
		if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
			return nil, err
		} else if ok {
			return payload, nil
		}
		return s.rebuild(ctx, orgID, scope, variantKey, ttlSeconds, loader)
	}

	deadline := time.Now().Add(snapshotMaxWait)
	for time.Now().Before(deadline) {
		if err := sleepContext(ctx, snapshotRetryDelay); err != nil {
			return nil, err
		}
		if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
			return nil, err
		} else if ok {
			return payload, nil
		}
	}
	// NestJS also rebuilds without the lock once the wait budget expires.
	return s.rebuild(ctx, orgID, scope, variantKey, ttlSeconds, loader)
}

// loadFresh reads a non-expired payload. A missing row or an expiresAt not
// strictly after now counts as a miss.
func (s *snapshotStore) loadFresh(
	ctx context.Context,
	orgID, scope, variantKey string,
	now time.Time,
) ([]byte, bool, error) {
	var payload []byte
	var expiresAt time.Time
	err := s.db.QueryRowContext(ctx,
		"SELECT payload, expiresAt FROM ObservabilitySnapshot WHERE orgId = ? AND scope = ? AND variantKey = ?",
		orgID, scope, variantKey,
	).Scan(&payload, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("%w: %v", errDatabase, err)
	}
	if !expiresAt.After(now) {
		return nil, false, nil
	}
	return payload, true, nil
}

// rebuild runs the loader and upserts the payload under the unique
// orgId+scope+variantKey row.
func (s *snapshotStore) rebuild(
	ctx context.Context,
	orgID, scope, variantKey string,
	ttlSeconds int,
	loader func() ([]byte, error),
) ([]byte, error) {
	payload, err := loader()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	expiresAt := now.Add(time.Duration(ttlSeconds) * time.Second)
	id, err := newSnapshotRowID()
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO ObservabilitySnapshot (id, orgId, scope, variantKey, payload, generatedAt, expiresAt, lastRequestedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  payload = VALUES(payload),
  generatedAt = VALUES(generatedAt),
  expiresAt = VALUES(expiresAt),
  lastRequestedAt = VALUES(lastRequestedAt),
  updatedAt = VALUES(updatedAt)`,
		id, orgID, scope, variantKey, payload, now, expiresAt, now, now, now,
	); err != nil {
		return nil, fmt.Errorf("%w: %v", errDatabase, err)
	}
	return payload, nil
}

// acquireLock takes the Redis lock with a TTL.
func (s *snapshotStore) acquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error) {
	if s.redis == nil {
		return false, fmt.Errorf("%w: redis is not configured", errRedis)
	}
	acquired, err := s.redis.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return false, fmt.Errorf("%w: %v", errRedis, err)
	}
	return acquired, nil
}

// releaseLock deletes the lock only when the token still matches.
func (s *snapshotStore) releaseLock(key, token string) {
	if s.redis == nil {
		return
	}
	_, _ = snapshotReleaseLockScript.Run(context.Background(), s.redis, []string{key}, token).Result()
}

// startAutoRenew periodically extends the lock TTL until the returned stop
// function is called.
func (s *snapshotStore) startAutoRenew(key, token string, ttl, interval time.Duration) func() {
	if s.redis == nil {
		return func() {}
	}
	if interval <= 0 {
		interval = ttl / 2
	}
	if interval < time.Second {
		interval = time.Second
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_, _ = snapshotRenewLockScript.Run(context.Background(), s.redis,
					[]string{key}, token, int(ttl.Milliseconds())).Result()
			}
		}
	}()
	return func() {
		close(stop)
		<-done
	}
}

// sleepContext waits for d or until the context is cancelled.
func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// randomToken returns the hex lock token.
func randomToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

// newSnapshotRowID writes a Prisma cuid-shaped id (c + 24 hex chars).
func newSnapshotRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
