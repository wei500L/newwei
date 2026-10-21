package crawlworker

// O1: process-local cache for the crawl client settings.
//
// CrawlQueueProcessor reads CrawlSettingsService.getSettings() on every job (for
// the per-class request timeout) and again on every memory pressure requeue (for
// queueOverloadCooldownMs). NestJS caches the settings document in Redis and
// keeps no process-local copy, so a settings write is visible on the next read.
// The Go worker resolves them per attempt through a small TTL cache instead: the
// Redis read plus, on a cache miss, the MySQL fallback query would otherwise run
// on every claimed job, and the values it returns change only when an admin
// edits the settings.
//
// Staleness bound (the O1 conclusion): a crawler sees a settings edit at most
// one Config.SettingsTTL (default five seconds) late, because a cached value is
// served for at most that window and an attempt that already resolved its
// timeout keeps it for the duration of that attempt. Reads are never served
// stale after a C2 concurrency broadcast: the subscriber invalidates the cache,
// so the next attempt re-reads the document. The cooldown base, the request
// timeouts and the startup concurrency all live inside that window, and none of
// them is a correctness constraint (the request timeout is clamped to
// [1s,900s] by the settings normalizer, the cooldown to [5s,10min] here).

import (
	"context"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// defaultSettingsTTL is the O1 default when Config.SettingsTTL is zero.
const defaultSettingsTTL = 5 * time.Second

// settingsProvider is the settings read path the attempt uses. The production
// implementation is *settingsCache; tests substitute a fake to model a failed
// read (the NestJS try/catch that falls back to the environment values).
type settingsProvider interface {
	Read(ctx context.Context) (crawlqueue.Settings, error)
	Invalidate()
}

// settingsCache wraps crawlqueue.SettingsReader with the TTL cache described in
// the file comment.
type settingsCache struct {
	reader *crawlqueue.SettingsReader
	ttl    time.Duration
	now    func() time.Time

	mu       sync.Mutex
	value    crawlqueue.Settings
	loadedAt time.Time
	valid    bool
}

// newSettingsCache builds the cache. A zero ttl uses the five second default; a
// nil clock uses time.Now.
func newSettingsCache(reader *crawlqueue.SettingsReader, ttl time.Duration, now func() time.Time) *settingsCache {
	if ttl <= 0 {
		ttl = defaultSettingsTTL
	}
	if now == nil {
		now = time.Now
	}
	return &settingsCache{reader: reader, ttl: ttl, now: now}
}

// Read returns the cached settings or reloads them. The reader itself already
// applies the environment fallback document, so the error case only reports a
// missing reader; the signature keeps the NestJS `catch` branch explicit for the
// callers that fall back to CRAWL4AI_* environment values.
func (c *settingsCache) Read(ctx context.Context) (crawlqueue.Settings, error) {
	if c == nil || c.reader == nil {
		return crawlqueue.Settings{}, errNoSettingsReader
	}
	c.mu.Lock()
	if c.valid && c.now().Sub(c.loadedAt) < c.ttl {
		value := c.value
		c.mu.Unlock()
		return value, nil
	}
	c.mu.Unlock()

	value := c.reader.Read(ctx)
	loadedAt := c.now()
	c.mu.Lock()
	c.value = value
	c.loadedAt = loadedAt
	c.valid = true
	c.mu.Unlock()
	return value, nil
}

// Invalidate drops the cached document. The C2 subscriber calls it so the
// concurrency broadcast also refreshes the settings-derived values.
func (c *settingsCache) Invalidate() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.valid = false
	c.mu.Unlock()
}
