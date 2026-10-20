package crawlmaintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// activeOrgEntry is one entry of the shared active-organization cache. The JSON
// key matches the NestJS ActiveOrgEntry shape.
type activeOrgEntry struct {
	ID string `json:"id"`
}

const (
	activeOrgFillLockTTL = 2 * time.Second
	activeOrgRetryDelay  = 50 * time.Millisecond
	activeOrgWaitBudget  = 500 * time.Millisecond
)

// listActiveOrgIDs reproduces ActiveOrgRegistryService.listActiveOrgs: the
// named Redis cache first, a short fill lock on a miss, and a MySQL fallback on
// any cache or lock failure. The cache key, TTL and fill lock are shared with
// NestJS, so a mixed-version tick cannot stampede the database.
func listActiveOrgIDs(ctx context.Context, db *sql.DB, client *redis.Client) ([]string, error) {
	cached, found, cacheErr := readActiveOrgsCache(ctx, client)
	if cacheErr == nil && found {
		return cached, nil
	}

	token, tokenErr := newLockToken()
	if tokenErr != nil {
		return loadActiveOrgIDs(ctx, db)
	}
	acquired, lockErr := client.SetNX(ctx, "lock:"+activeOrgsCacheKey, token, activeOrgFillLockTTL).Result()
	if lockErr != nil {
		return loadActiveOrgIDs(ctx, db)
	}
	if acquired {
		defer func() {
			releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = releaseLockScript.Run(releaseCtx, client, []string{"lock:" + activeOrgsCacheKey}, token).Err()
		}()
		if cached, found, err := readActiveOrgsCache(ctx, client); err == nil && found {
			return cached, nil
		}
		orgIDs, err := loadActiveOrgIDs(ctx, db)
		if err != nil {
			return nil, err
		}
		if payload, err := json.Marshal(activeOrgEntries(orgIDs)); err == nil {
			_ = client.Set(ctx, activeOrgsCacheKey, payload, activeOrgsCacheTTL*time.Second).Err()
		}
		return orgIDs, nil
	}

	// Another process is filling the cache. Wait for the NestJS wrap budget
	// before falling back to a direct database read.
	deadline := time.Now().Add(activeOrgWaitBudget)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		time.Sleep(activeOrgRetryDelay)
		if cached, found, err := readActiveOrgsCache(ctx, client); err == nil && found {
			return cached, nil
		}
	}
	return loadActiveOrgIDs(ctx, db)
}

// readActiveOrgsCache returns the cached ids, found=false on a miss, and an
// error for a Redis failure or an unusable payload (the caller then falls back
// to MySQL).
func readActiveOrgsCache(ctx context.Context, client *redis.Client) ([]string, bool, error) {
	if client == nil {
		return nil, false, errRedisUnavailable
	}
	raw, err := client.Get(ctx, activeOrgsCacheKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var entries []activeOrgEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, false, fmt.Errorf("crawlmaintenance: decode active org cache: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.ID != "" {
			ids = append(ids, entry.ID)
		}
	}
	return ids, true, nil
}

// loadActiveOrgIDs is loadActiveOrgs: only active organizations, ordered by id
// ascending.
func loadActiveOrgIDs(ctx context.Context, db *sql.DB) ([]string, error) {
	if db == nil {
		return nil, errMySQLUnavailable
	}
	rows, err := db.QueryContext(ctx, "SELECT `id` FROM `Org` WHERE `isActive` = true ORDER BY `id` ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0)
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

// activeOrgEntries converts ids into the cached object shape.
func activeOrgEntries(ids []string) []activeOrgEntry {
	entries := make([]activeOrgEntry, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, activeOrgEntry{ID: id})
	}
	return entries
}
