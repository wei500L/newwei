package dashboardspacetime

import (
	"context"
	"strconv"
	"sync"
	"time"
)

// sharedQueryTTL mirrors DASHBOARD_SHARED_QUERY_TTL_SECONDS in the NestJS
// implementation, which memoizes exactly this row read for ten seconds
// (loadSharedDashboardQuery in dashboard-charts.helpers.ts). Keeping the same
// window means the takeover is never staler than the endpoint it replaces, while
// a dashboard that polls the heatmap from the chart and from the SSE stream
// issues one row query per ten seconds instead of one per request.
const sharedQueryTTL = 10 * time.Second

// maxCachedRowSets bounds the memo. Entries carry up to maxGeoRecords rows, and
// the key contains a caller-supplied event id, so the map is capped and the
// entry that expires first is dropped instead of growing with distinct ids.
const maxCachedRowSets = 64

type geoRowsCache struct {
	mu      sync.Mutex
	entries map[string]*geoRowsEntry
}

type geoRowsEntry struct {
	rows    []geoRow
	err     error
	expires time.Time
	ready   chan struct{}
}

func newGeoRowsCache() *geoRowsCache {
	return &geoRowsCache{entries: map[string]*geoRowsEntry{}}
}

// geoRowsKey scopes the memo to the rows the response depends on. includeBuckets
// is deliberately absent: it shapes the aggregation, not the query.
func geoRowsKey(orgID string, start, end time.Time, eventID string) string {
	return orgID + "|" + strconv.FormatInt(start.UnixMilli(), 10) + "|" +
		strconv.FormatInt(end.UnixMilli(), 10) + "|" + eventID
}

// load returns the rows for key, running fetch at most once per key per TTL.
// Concurrent callers wait for the single in-flight read. Failures are not
// memoized: the next request retries, exactly like the Nest loader whose cache
// entry is only written on success.
//
// The fetch runs on the first caller's context, so a cancelled request can fail
// its waiters; the window is a single query and the entry is dropped, so the
// following request starts a fresh read.
func (c *geoRowsCache) load(ctx context.Context, key string, now time.Time, fetch func(context.Context) ([]geoRow, error)) ([]geoRow, error) {
	if c == nil {
		return fetch(ctx)
	}
	c.mu.Lock()
	c.prune(now)
	if entry, ok := c.entries[key]; ok {
		c.mu.Unlock()
		select {
		case <-entry.ready:
			return entry.rows, entry.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	entry := &geoRowsEntry{ready: make(chan struct{})}
	c.entries[key] = entry
	c.mu.Unlock()

	rows, err := fetch(ctx)
	c.mu.Lock()
	entry.rows, entry.err = rows, err
	if err != nil {
		delete(c.entries, key)
	} else {
		entry.expires = now.Add(sharedQueryTTL)
	}
	c.mu.Unlock()
	close(entry.ready)
	return rows, err
}

// prune drops expired entries and enforces the size cap. Entries still loading
// are left alone: their callers hold the pointer, and dropping one early would
// let the next request start a duplicate read.
func (c *geoRowsCache) prune(now time.Time) {
	oldestKey := ""
	var oldest time.Time
	for key, entry := range c.entries {
		select {
		case <-entry.ready:
			if !entry.expires.After(now) {
				delete(c.entries, key)
				continue
			}
			if oldestKey == "" || entry.expires.Before(oldest) {
				oldestKey, oldest = key, entry.expires
			}
		default:
		}
	}
	if len(c.entries) >= maxCachedRowSets && oldestKey != "" {
		delete(c.entries, oldestKey)
	}
}

func (c *geoRowsCache) size() int {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}
