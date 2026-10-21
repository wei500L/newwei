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
// document derives from EnvService.crawl4aiConfig. Only the fields the fallback
// document derives from the environment are overridden; the remaining defaults
// stay the compiled constants the settings/crawl read path already uses.
type EnvDefaults struct {
	MaxConcurrency int
	MaxRetries     int
	RetryBackoffMs int
	// RequestTimeoutMs is CRAWL4AI_TIMEOUT_MS. getFallbackSettings derives
	// requestTimeoutNormalMs from it (clamped to [5000,900000]) and then
	// requestTimeoutHotMs as min(normal, 60000), so a deployment without a
	// crawl_client_settings row keeps the environment timeout in both tiers.
	RequestTimeoutMs int
}

// The request-timeout bounds and hot-queue ceiling of getFallbackSettings.
const (
	minRequestTimeoutMs        = 5_000
	maxRequestTimeoutMs        = 900_000
	defaultRequestTimeoutHotMs = 60_000
)

// NewSettingsReader builds the reader around the shared MySQL and Redis
// handles. Either may be nil in tests. env may be nil, which keeps the compiled
// defaults.
func NewSettingsReader(db *sql.DB, redisClient *redis.Client, env *EnvDefaults) *SettingsReader {
	fallback := settingscrawl.DefaultCrawlClientNormalized()
	if env != nil {
		document := fallbackSettingsDocument{
			MaxConcurrency: env.MaxConcurrency,
			MaxRetries:     env.MaxRetries,
			RetryBackoffMs: env.RetryBackoffMs,
		}
		if env.RequestTimeoutMs > 0 {
			normal := clampRequestTimeoutMs(env.RequestTimeoutMs)
			hot := clampRequestTimeoutMs(minInt(normal, defaultRequestTimeoutHotMs))
			document.RequestTimeoutNormalMs = &normal
			document.RequestTimeoutHotMs = &hot
		}
		candidate, err := json.Marshal(document)
		if err == nil {
			fallback = settingscrawl.NormalizeCrawlClientSettingsDocument(candidate, fallback)
		}
	}
	return &SettingsReader{db: db, redis: redisClient, fallback: fallback}
}

// fallbackSettingsDocument is the environment-derived part of
// getFallbackSettings. Absent members keep the compiled default.
type fallbackSettingsDocument struct {
	MaxConcurrency         int  `json:"maxConcurrency"`
	MaxRetries             int  `json:"maxRetries"`
	RetryBackoffMs         int  `json:"retryBackoffMs"`
	RequestTimeoutNormalMs *int `json:"requestTimeoutNormalMs,omitempty"`
	RequestTimeoutHotMs    *int `json:"requestTimeoutHotMs,omitempty"`
}

// clampRequestTimeoutMs is the getFallbackSettings clamp.
func clampRequestTimeoutMs(value int) int {
	if value < minRequestTimeoutMs {
		return minRequestTimeoutMs
	}
	if value > maxRequestTimeoutMs {
		return maxRequestTimeoutMs
	}
	return value
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// Settings is the producer and crawl-worker relevant subset of
// CrawlClientSettings. MaxRetries, RetryBackoffMs and MaxConcurrency are the
// enqueue-time values; QueueOverloadCooldownMs and the per-class request
// timeouts are read by the Go crawl worker (CrawlQueueProcessor's
// resolveQueueTimeoutMs and memory pressure cooldown).
type Settings struct {
	MaxRetries     int
	RetryBackoffMs int
	MaxConcurrency int
	// QueueOverloadCooldownMs is queueOverloadCooldownMs, the base cooldown the
	// memory-pressure requeue multiplies by the observed memory percentage.
	QueueOverloadCooldownMs int
	// RequestTimeoutHotMs and RequestTimeoutNormalMs are the per-attempt
	// crawl4ai timeouts of the hot and non-hot queues.
	RequestTimeoutHotMs    int
	RequestTimeoutNormalMs int
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
		MaxRetries:              normalized.Settings.MaxRetries,
		RetryBackoffMs:          normalized.Settings.RetryBackoffMs,
		MaxConcurrency:          normalized.MaxConcurrency,
		QueueOverloadCooldownMs: normalized.Settings.QueueOverloadCooldownMs,
		RequestTimeoutHotMs:     normalized.Settings.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:  normalized.Settings.RequestTimeoutNormalMs,
	}
}
