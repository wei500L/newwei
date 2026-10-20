package crawlqueue

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// SettingsReader resolves the crawl client settings the producer needs. It
// reads the same document NestJS CrawlSettingsService reads: the shared
// crawl_client:settings cache first, then the crawl_client_settings
// SystemSetting row, each normalized by the shared settingscrawl normalizer so
// both runtimes agree on every clamp and default.
type SettingsReader struct {
	db       *sql.DB
	redis    *redis.Client
	fallback settingscrawl.CrawlClientNormalized
}

// EnvDefaults carries the environment values CrawlSettingsService's fallback
// document derives from EnvService.crawl4aiConfig. Only the producer-relevant
// fields are overridden; the remaining defaults stay the compiled constants the
// settings/crawl read path already uses.
type EnvDefaults struct {
	MaxConcurrency int
	MaxRetries     int
	RetryBackoffMs int
}

// NewSettingsReader builds the reader around the shared MySQL and Redis
// handles. Either may be nil in tests. env may be nil, which keeps the compiled
// defaults.
func NewSettingsReader(db *sql.DB, redisClient *redis.Client, env *EnvDefaults) *SettingsReader {
	fallback := settingscrawl.DefaultCrawlClientNormalized()
	if env != nil {
		candidate, err := json.Marshal(struct {
			MaxConcurrency int `json:"maxConcurrency"`
			MaxRetries     int `json:"maxRetries"`
			RetryBackoffMs int `json:"retryBackoffMs"`
		}{env.MaxConcurrency, env.MaxRetries, env.RetryBackoffMs})
		if err == nil {
			fallback = settingscrawl.NormalizeCrawlClientSettingsDocument(candidate, fallback)
		}
	}
	return &SettingsReader{db: db, redis: redisClient, fallback: fallback}
}

// Settings is the producer-relevant subset of CrawlClientSettings.
type Settings struct {
	MaxRetries     int
	RetryBackoffMs int
	MaxConcurrency int
}

// Read mirrors CrawlSettingsService.getSettings without refreshing the cache.
// A cache miss falls through to the database; a read failure falls back to the
// environment defaults, exactly like the NestJS warn-and-fallback branches.
func (r *SettingsReader) Read(ctx context.Context) Settings {
	return settingsOf(r.ReadNormalized(ctx))
}

// ReadNormalized returns the whole normalized crawl client document, which the
// admin queue status also projects (adaptive thresholds and maxConcurrency).
func (r *SettingsReader) ReadNormalized(ctx context.Context) settingscrawl.CrawlClientNormalized {
	fallback := settingscrawl.DefaultCrawlClientNormalized()
	if r != nil && r.fallback.Settings.MaxRetries != 0 {
		fallback = r.fallback
	}
	normalized := fallback
	if r != nil && r.redis != nil {
		if raw, err := r.redis.Get(ctx, CrawlSettingsCacheKey).Bytes(); err == nil && len(raw) > 0 {
			return settingscrawl.NormalizeCrawlClientSettingsDocument(raw, fallback)
		} else if err != nil && err != redis.Nil {
			log.Printf("crawlqueue: failed to read crawl client settings cache: %v", err)
		}
	}
	if r != nil && r.db != nil {
		var raw []byte
		err := r.db.QueryRowContext(ctx,
			"SELECT `value` FROM SystemSetting WHERE `key` = ? LIMIT 1", CrawlSettingsKey).Scan(&raw)
		switch {
		case err == nil && len(raw) > 0:
			normalized = settingscrawl.NormalizeCrawlClientSettingsDocument(raw, fallback)
		case err == nil, err == sql.ErrNoRows:
			// Missing row: keep the environment fallback.
		default:
			log.Printf("crawlqueue: failed to read crawl client settings row: %v", err)
		}
	}
	return normalized
}

func settingsOf(normalized settingscrawl.CrawlClientNormalized) Settings {
	return Settings{
		MaxRetries:     normalized.Settings.MaxRetries,
		RetryBackoffMs: normalized.Settings.RetryBackoffMs,
		MaxConcurrency: normalized.MaxConcurrency,
	}
}
