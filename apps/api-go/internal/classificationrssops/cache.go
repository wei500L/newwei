package classificationrssops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/wei500L/newwei/apps/api-go/internal/cronlock"
	"github.com/wei500L/newwei/apps/api-go/internal/timefmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// Snapshot locking is aligned field by field with
// observability-snapshot.service.ts and cache.service.ts: a 15s lock TTL, a
// 100ms retry delay, a 20s maximum wait and the shared Redis lock key prefix
// "lock:" + "observability-snapshot:<orgId>:<scope>:<variantKey>".
const (
	snapshotDefaultTTLSeconds = 60
	snapshotLockTTL           = 15 * time.Second
	snapshotRenewInterval     = 5 * time.Second
	snapshotMaxWait           = 20 * time.Second
	snapshotRetryDelay        = 100 * time.Millisecond
)

// snapshotStore owns the MySQL ObservabilitySnapshot table, the shared Redis
// distributed lock and the Redis caches (summary and alert throttles).
type snapshotStore struct {
	db    *sql.DB
	redis *redis.Client
}

// snapshotKey mirrors ObservabilitySnapshotService.buildLockKey.
func snapshotKey(orgID, scope, variantKey string) string {
	return "observability-snapshot:" + orgID + ":" + scope + ":" + variantKey
}

// lockKeyFor mirrors CacheService.withLock, which prefixes every lock key.
func lockKeyFor(key string) string {
	return "lock:" + key
}

// getOrCreate mirrors ObservabilitySnapshotService.getOrCreate: return a fresh
// snapshot payload when one exists, otherwise rebuild it behind the distributed
// lock (re-checking inside the lock) and fall back to polling and finally to an
// unlocked rebuild, exactly like the NestJS implementation.
func (s *snapshotStore) getOrCreate(ctx context.Context, orgID, scope, variantKey string, ttlSeconds int, loader func() (json.RawMessage, error)) (json.RawMessage, error) {
	if s.db == nil {
		return nil, errors.New("mysql is not configured")
	}
	if payload, ok, err := s.loadFresh(ctx, orgID, scope, variantKey, time.Now()); err != nil {
		return nil, err
	} else if ok {
		return payload, nil
	}

	key := snapshotKey(orgID, scope, variantKey)
	lockKey := lockKeyFor(key)
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
	return s.rebuild(ctx, orgID, scope, variantKey, ttlSeconds, loader)
}

// loadFresh returns a stored payload that has not expired yet.
func (s *snapshotStore) loadFresh(ctx context.Context, orgID, scope, variantKey string, now time.Time) (json.RawMessage, bool, error) {
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
		return nil, false, err
	}
	if !expiresAt.After(now) {
		return nil, false, nil
	}
	return json.RawMessage(payload), true, nil
}

// rebuild runs the loader and upserts the payload with a fresh TTL.
func (s *snapshotStore) rebuild(ctx context.Context, orgID, scope, variantKey string, ttlSeconds int, loader func() (json.RawMessage, error)) (json.RawMessage, error) {
	payload, err := loader()
	if err != nil {
		return nil, err
	}
	now := timefmt.NowMillis()
	expiresAt := now.Add(time.Duration(ttlSeconds) * time.Second)
	id, err := newRowID()
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
		id, orgID, scope, variantKey, []byte(payload), now, expiresAt, now, now, now,
	); err != nil {
		return nil, err
	}
	return payload, nil
}

// invalidateSnapshots mirrors ObservabilitySnapshotService.invalidate without a
// variant key: every scope row of the organization is deleted.
func (s *snapshotStore) invalidateSnapshots(ctx context.Context, orgID, scope string) (int64, error) {
	if s.db == nil {
		return 0, errors.New("mysql is not configured")
	}
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM ObservabilitySnapshot WHERE orgId = ? AND scope = ?", orgID, scope)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return affected, nil
}

// cacheOptions mirrors the CacheService.wrap options.
type cacheOptions struct {
	lockTTL    time.Duration
	renewEvery time.Duration
	retryDelay time.Duration
	maxWait    time.Duration
}

// cacheWrapJSON mirrors CacheService.wrap with a JSON payload: read the cache,
// otherwise take the lock and run the loader, polling for another writer's
// result while waiting.
func (s *snapshotStore) cacheWrapJSON(ctx context.Context, key string, ttlSeconds int, opts cacheOptions, loader func() (json.RawMessage, error)) (json.RawMessage, error) {
	if s.redis == nil {
		return loader()
	}
	if cached, ok, err := s.readCache(ctx, key); err != nil {
		return nil, err
	} else if ok {
		return cached, nil
	}

	lockKey := lockKeyFor(key)
	lease, err := s.acquireLease(ctx, lockKey, opts.lockTTL)
	if err != nil {
		return nil, err
	}
	if lease == nil {
		deadline := time.Now().Add(opts.maxWait)
		for time.Now().Before(deadline) {
			if err := sleepContext(ctx, opts.retryDelay); err != nil {
				return nil, err
			}
			if cached, ok, err := s.readCache(ctx, key); err != nil {
				return nil, err
			} else if ok {
				return cached, nil
			}
			lease, err = s.acquireLease(ctx, lockKey, opts.lockTTL)
			if err != nil {
				return nil, err
			}
			if lease != nil {
				break
			}
		}
	}

	if lease != nil {
		defer releaseLease(lease)
		value, err := loader()
		if err != nil {
			return nil, err
		}
		s.writeCache(ctx, key, value, ttlSeconds)
		return value, nil
	}

	if cached, ok, err := s.readCache(ctx, key); err != nil {
		return nil, err
	} else if ok {
		return cached, nil
	}
	value, err := loader()
	if err != nil {
		return nil, err
	}
	s.writeCache(ctx, key, value, ttlSeconds)
	return value, nil
}

// readCache reads a JSON cache entry, treating an empty value as a miss.
func (s *snapshotStore) readCache(ctx context.Context, key string) (json.RawMessage, bool, error) {
	value, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(value) == 0 {
		return nil, false, nil
	}
	return json.RawMessage(value), true, nil
}

// writeCache stores a JSON cache entry; failures are best effort like the
// NestJS cache.
func (s *snapshotStore) writeCache(ctx context.Context, key string, value json.RawMessage, ttlSeconds int) {
	if s.redis == nil {
		return
	}
	_ = s.redis.Set(ctx, key, []byte(value), time.Duration(ttlSeconds)*time.Second).Err()
}

// setIfAbsent mirrors CacheService.setIfAbsent (SET key value EX ttl NX).
func (s *snapshotStore) setIfAbsent(ctx context.Context, key string, value json.RawMessage, ttlSeconds int) (bool, error) {
	if s.redis == nil {
		return false, errors.New("redis is not configured")
	}
	ttl := maxInt(ttlSeconds, 1)
	return s.redis.SetNX(ctx, key, []byte(value), time.Duration(ttl)*time.Second).Result()
}

// acquireLease takes the shared Redis lease for the cache rebuild critical
// section. A nil lease means another process owns it; an error is a Redis
// failure. cronlock.Acquire starts best-effort renewal while the lease is held.
func (s *snapshotStore) acquireLease(ctx context.Context, key string, ttl time.Duration) (*cronlock.Lease, error) {
	if s.redis == nil {
		return nil, errors.New("redis is not configured")
	}
	lease, ok, err := cronlock.New(s.redis).Acquire(ctx, key, ttl, cronlock.RenewBestEffort)
	if err != nil {
		return nil, err
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

// sleepContext waits for the retry delay or the request context.
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
