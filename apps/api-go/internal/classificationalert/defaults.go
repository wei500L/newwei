package classificationalert

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/rediscache"
)

// Active organization cache constants copied from
// apps/api/src/modules/org/active-org-registry.service.ts.
const (
	// activeOrgCacheKey is the cache ActiveOrgRegistryService reads and fills.
	// NestJS and api-go share it, so both see one list.
	activeOrgCacheKey = "org:active:list:v1"
	// activeOrgCacheTTL is ActiveOrgRegistryService's 15 second value TTL.
	activeOrgCacheTTL = 15 * time.Second
)

// activeOrgWrapOptions are the ActiveOrgRegistryService cache.wrap tunables:
// lockTtlMs 2000, retryDelayMs 50, maxWaitMs 500.
var activeOrgWrapOptions = rediscache.WrapOptions{
	LockTTL:    2 * time.Second,
	RetryDelay: 50 * time.Millisecond,
	MaxWait:    500 * time.Millisecond,
}

// activeOrgEntry is one entry of the active-organization cache. The cache holds
// the same JSON array of {id} objects the NestJS registry writes.
type activeOrgEntry struct {
	ID string `json:"id"`
}

// activeOrgRegistry is the default ActiveOrgLister: the shared cache.wrap first
// and an unconditional MySQL fallback on any cache failure, exactly like
// ActiveOrgRegistryService.listActiveOrgs.
type activeOrgRegistry struct {
	db    *sql.DB
	redis *redis.Client
}

// ListActiveOrgIDs returns the active organization ids ordered by id ascending.
func (r *activeOrgRegistry) ListActiveOrgIDs(ctx context.Context) ([]string, error) {
	// The cached value is a JavaScript array, which is truthy even when empty,
	// so every successfully decoded entry counts as present.
	entries, err := rediscache.Wrap[[]activeOrgEntry](ctx, r.redis, activeOrgCacheKey, activeOrgCacheTTL,
		activeOrgWrapOptions,
		func([]activeOrgEntry) bool { return true },
		func(ctx context.Context) ([]activeOrgEntry, error) {
			ids, loadErr := r.loadActiveOrgIDs(ctx)
			if loadErr != nil {
				return nil, loadErr
			}
			return activeOrgEntries(ids), nil
		})
	if err != nil {
		log.Printf("classificationalert: active organization cache read failed; falling back to mysql err=%v", err)
		return r.loadActiveOrgIDs(ctx)
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, nil
}

// loadActiveOrgIDs runs ActiveOrgRegistryService.loadActiveOrgs:
// org.findMany({where:{isActive:true},select:{id:true},orderBy:{id:"asc"}}).
func (r *activeOrgRegistry) loadActiveOrgIDs(ctx context.Context) ([]string, error) {
	if r == nil || r.db == nil {
		return nil, errNoDatabase
	}
	rows, err := r.db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := make([]string, 0, 16)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

// activeOrgEntries converts the id list into the cached JSON shape.
func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}

// redisTickGate is the production TickGate: the shared claimSchedulerTick
// implementation, so a Go and a NestJS instance contend for the same key.
type redisTickGate struct {
	client *redis.Client
}

// ClaimTick writes SET key {"claimedAt":<ISO>} EX 285 NX with no "lock:" prefix.
func (g redisTickGate) ClaimTick(ctx context.Context, key string, ttl time.Duration, now time.Time) (bool, error) {
	return rediscache.ClaimTick(ctx, g.client, key, ttl, now)
}

// redisOrgLocker is the production OrgLocker: CacheService.withLock with its
// "lock:" prefix, token-checked renewal and release.
type redisOrgLocker struct {
	client *redis.Client
}

// WithLock runs runner while holding the lease for key.
func (l redisOrgLocker) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	return rediscache.WithLock(ctx, l.client, key, ttl, runner)
}

// errNoDatabase fails closed when MySQL was not configured.
var errNoDatabase = errors.New("classificationalert: mysql is not configured")
