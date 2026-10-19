package gdeltsnapshot

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Service owns one snapshot chain: the MySQL history, the two Redis cache
// layers, the shared lease and the GDELT fetcher.
//
// Every collaborator is a narrow port so the package tests run without MySQL or
// Redis. Production wiring passes the shared *sql.DB and *redis.Client through
// NewService.
type Service struct {
	store   storePort
	cache   cachePort
	locks   lockPort
	fetch   *gdeltFetcher
	enabled bool
	now     func() time.Time
	sleep   func(context.Context, time.Duration) error
}

// Options are the production collaborators of one snapshot service.
type Options struct {
	// DB is the shared MySQL pool. It must provide the
	// SituationMonitorExternalSnapshot table.
	DB *sql.DB
	// Redis is the shared client. The service uses the NestJS cache keys and
	// the shared rebuild lease.
	Redis *redis.Client
	// GDeltEnabled is SITUATION_MONITOR_GDELT_ENABLED (default true).
	GDeltEnabled bool
	// Now overrides the clock. Nil uses time.Now.
	Now func() time.Time
}

// NewService wires the production collaborators. Both DB and Redis are required
// whenever a switch selects this implementation; config validation enforces it
// at startup.
func NewService(options Options) *Service {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Service{
		store:   &mysqlStore{db: options.DB},
		cache:   redisCache{client: options.Redis},
		locks:   redisLock{client: options.Redis},
		fetch:   newGDeltFetcher(now),
		enabled: options.GDeltEnabled,
		now:     now,
		sleep:   sleepContext,
	}
}

// sleepContext waits for d or until the context is cancelled. It replaces
// setTimeout in the delay helper so a shutdown interrupts the pause instead of
// sleeping it out.
func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// readSnapshot mirrors readSnapshot({includeDatabase:true}): fresh cache, stale
// cache, then the newest history row (whose payload refills both cache layers).
//
// The two cache layers are read with one MGET instead of two GETs. The
// precedence and the TTL restore are unchanged; only the number of round trips
// differs.
func (s *Service) readSnapshot(ctx context.Context) (readResult, error) {
	values, err := s.cache.MGet(ctx, freshCacheKey, staleCacheKey)
	if err != nil {
		return readResult{}, err
	}
	for _, value := range values {
		if !value.found {
			continue
		}
		payload, decodeErr := decodeCachedPayload(value.value)
		if decodeErr != nil {
			// CacheService.get runs JSON.parse without a guard, so a corrupted
			// entry is an error and not a cache miss.
			return readResult{}, decodeErr
		}
		if payload != nil {
			return readResult{payload: payload, stale: isExpired(payload.ExpiresAt, s.now())}, nil
		}
	}

	raw, found, err := s.store.LatestPayload(ctx)
	if err != nil {
		return readResult{}, err
	}
	if !found {
		return readResult{}, nil
	}
	payload := normalizePayload(raw)
	if payload == nil {
		return readResult{}, nil
	}
	if err := s.restoreCaches(ctx, payload); err != nil {
		return readResult{}, err
	}
	return readResult{payload: payload, stale: isExpired(payload.ExpiresAt, s.now())}, nil
}

// decodeCachedPayload normalizes one cached value. Malformed JSON is an error,
// matching JSON.parse; a parsed null or an unusable document is a miss.
func decodeCachedPayload(value string) (*Payload, error) {
	raw := []byte(value)
	if !json.Valid(raw) {
		return nil, errors.New("gdeltsnapshot: cached snapshot is not valid JSON")
	}
	return normalizePayload(raw), nil
}

// restoreCaches refills the cache layers from a history row. An expired payload
// only refreshes the stale layer, exactly like restoreSnapshotCaches.
func (s *Service) restoreCaches(ctx context.Context, payload *Payload) error {
	encoded, err := marshalJSON(payload)
	if err != nil {
		return err
	}
	entries := make([]cacheEntry, 0, 2)
	if !isExpired(payload.ExpiresAt, s.now()) {
		entries = append(entries, cacheEntry{key: freshCacheKey, value: encoded, ttl: freshTTL})
	}
	entries = append(entries, cacheEntry{key: staleCacheKey, value: encoded, ttl: staleTTL})
	return s.cache.SetMany(ctx, entries...)
}

// refreshScheduled is the 15-minute job. It returns before touching Redis when
// GDELT is disabled, and otherwise runs the rebuild under the shared lease. A
// lease held by the other implementation makes this tick a no-op.
func (s *Service) refreshScheduled(ctx context.Context) error {
	if !s.enabled {
		return nil
	}
	acquired, err := s.locks.WithLock(ctx, refreshLockKey, lockTTL, func(runCtx context.Context) error {
		_, rebuildErr := s.rebuild(runCtx)
		return rebuildErr
	})
	if err != nil {
		return err
	}
	if !acquired {
		log.Printf("gdeltsnapshot: skipped refresh because a previous GDELT snapshot run is still in progress")
	}
	return nil
}

// ForceRefresh mirrors forceRefresh: disabled GDELT returns the disabled
// summary without touching the lock. Otherwise the rebuild runs under the shared
// lease; a held lease falls back to the current snapshot (including the database
// read and its cache refill).
func (s *Service) ForceRefresh(ctx context.Context) (Summary, error) {
	if !s.enabled {
		return s.buildStatusSummary(ctx, nil, false, false)
	}

	var rebuilt *Payload
	acquired, err := s.locks.WithLock(ctx, refreshLockKey, lockTTL, func(runCtx context.Context) error {
		payload, rebuildErr := s.rebuild(runCtx)
		if rebuildErr != nil {
			return rebuildErr
		}
		rebuilt = payload
		return nil
	})
	if err != nil {
		return Summary{}, err
	}
	if acquired && rebuilt != nil {
		return s.buildStatusSummary(ctx, rebuilt, false, true)
	}

	current, err := s.readSnapshot(ctx)
	if err != nil {
		return Summary{}, err
	}
	return s.buildStatusSummary(ctx, current.payload, current.stale, true)
}
