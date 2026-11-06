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

	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
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
	lease, err := s.acquireLease(ctx, lockKey, snapshotLockTTL)
	if err != nil {
		return nil, err
	}
	if lease != nil {
		defer releaseLease(lease)
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

// acquireLease takes the shared Redis lease for the snapshot rebuild critical
// section. A nil lease means another process owns it; an error is a Redis
// failure. cronlock.Acquire starts best-effort renewal while the lease is held.
func (s *snapshotStore) acquireLease(ctx context.Context, key string, ttl time.Duration) (*cronlock.Lease, error) {
	if s.redis == nil {
		return nil, fmt.Errorf("%w: redis is not configured", errRedis)
	}
	lease, ok, err := cronlock.New(s.redis).Acquire(ctx, key, ttl, cronlock.RenewBestEffort)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errRedis, err)
	}
	if !ok {
		return nil, nil
	}
	return lease, nil
}

// releaseLease releases the lease outside the request cancellation.
func releaseLease(lease *cronlock.Lease) {
	if lease == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = lease.Release(ctx)
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

// newSnapshotRowID writes a Prisma cuid-shaped id (c + 24 hex chars).
func newSnapshotRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
