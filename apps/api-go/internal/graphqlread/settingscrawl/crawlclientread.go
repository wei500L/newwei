package settingscrawl

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// This file adds the read entry the crawl discovery chain needs for the crawl
// client settings. It reuses the normalization that already backs the
// crawlClientSettings Query root and reads/writes the same Redis key the NestJS
// CrawlSettingsService uses:
//
//	key  crawl_client:settings
//	ttl  30s
//	body the normalized crawl client settings JSON document (camelCase keys)
//
// Read order (identical to NestJS getSettings): Redis first, then the
// SystemSetting row, then the environment-derived fallback. A database read is
// mirrored back into Redis so the two runtimes share one cache. The cached
// document uses the same camelCase keys NestJS writes, so a value written by
// either runtime is readable by the other. No behaviour of the existing GraphQL
// root changes; this is a new entry point only.

const (
	// crawlClientSettingsCacheKey is SETTINGS_CACHE_KEY in NestJS.
	crawlClientSettingsCacheKey = "crawl_client:settings"
	// crawlClientSettingsCacheTTL is SETTINGS_CACHE_TTL_SECONDS.
	crawlClientSettingsCacheTTL = 30 * time.Second
)

// CrawlClientSettingsEnv carries the env-derived fallbacks. NestJS derives them
// from CRAWL4AI_TIMEOUT_MS / CRAWL4AI_HEALTH_CHECK_TTL_MS / CRAWL4AI_MAX_CONCURRENCY;
// passing them here keeps a deployment without a SystemSetting row identical in
// both runtimes.
type CrawlClientSettingsEnv struct {
	RequestTimeoutMs int
	HealthCheckTTLMs int
	MaxConcurrency   int
}

// crawlClientCacheDocument is the JSON shape of the cached/stored settings.
// The keys are the camelCase names NestJS writes; the model type itself only
// carries GraphQL tags, so it must not be marshaled directly into the cache.
type crawlClientCacheDocument struct {
	HealthCheckTtlMs                         int     `json:"healthCheckTtlMs"`
	RequestTimeoutMs                         int     `json:"requestTimeoutMs"`
	RequestTimeoutHotMs                      int     `json:"requestTimeoutHotMs"`
	RequestTimeoutNormalMs                   int     `json:"requestTimeoutNormalMs"`
	ConditionalRequestEnabled                bool    `json:"conditionalRequestEnabled"`
	ConditionalRequestTimeoutMs              int     `json:"conditionalRequestTimeoutMs"`
	ConditionalRequestMaxRetries             int     `json:"conditionalRequestMaxRetries"`
	DetailPublishSignalHeadFetchTimeoutMs    int     `json:"detailPublishSignalHeadFetchTimeoutMs"`
	DetailPublishSignalHeadFetchConcurrency  int     `json:"detailPublishSignalHeadFetchConcurrency"`
	DetailPublishSignalHeadFetchMaxReadBytes int     `json:"detailPublishSignalHeadFetchMaxReadBytes"`
	MaxRetries                               int     `json:"maxRetries"`
	RetryBackoffMs                           int     `json:"retryBackoffMs"`
	QueueOverloadCooldownMs                  int     `json:"queueOverloadCooldownMs"`
	AdaptiveConcurrencyEnabled               bool    `json:"adaptiveConcurrencyEnabled"`
	AdaptiveWindowMinutes                    int     `json:"adaptiveWindowMinutes"`
	AdaptiveCooldownMinutes                  int     `json:"adaptiveCooldownMinutes"`
	AdaptiveLatencyThresholdRatio            float64 `json:"adaptiveLatencyThresholdRatio"`
	AdaptiveErrorRateThreshold               float64 `json:"adaptiveErrorRateThreshold"`
	AdaptiveMemoryHeadroomThreshold          float64 `json:"adaptiveMemoryHeadroomThreshold"`
	MaxConcurrency                           int     `json:"maxConcurrency"`
}

// LoadCrawlClientSettings returns the effective crawl client settings. A nil
// Redis client degrades to the database read, and a nil database degrades to the
// env fallback.
func LoadCrawlClientSettings(ctx context.Context, db *sql.DB, redisClient *redis.Client, env CrawlClientSettingsEnv) CrawlClientSettingsModel {
	fallback := crawlClientFallback(env)

	if redisClient != nil {
		if raw, err := redisClient.Get(ctx, crawlClientSettingsCacheKey).Bytes(); err == nil && len(raw) > 0 {
			var document crawlClientCacheDocument
			if err := json.Unmarshal(raw, &document); err == nil && document.RequestTimeoutNormalMs > 0 {
				return modelFromDocument(document)
			}
		}
	}

	raw, found, err := selectCrawlClientSetting(ctx, db)
	if err != nil || !found {
		return fallback.Settings
	}
	normalized := normalizeCrawlClientSettings(raw, fallback)
	if redisClient != nil {
		if encoded, err := json.Marshal(documentFromModel(normalized)); err == nil {
			_ = redisClient.Set(ctx, crawlClientSettingsCacheKey, encoded, crawlClientSettingsCacheTTL).Err()
		}
	}
	return normalized.Settings
}

// selectCrawlClientSetting reads the single global SystemSetting row.
func selectCrawlClientSetting(ctx context.Context, db *sql.DB) ([]byte, bool, error) {
	if db == nil {
		return nil, false, nil
	}
	var value []byte
	err := db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", crawlClientSettingsKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// crawlClientFallback builds getFallbackSettings with the env overrides applied
// through the same clamps the normalizer uses.
func crawlClientFallback(env CrawlClientSettingsEnv) crawlClientNormalized {
	fallback := defaultCrawlClientNormalized()
	if env.RequestTimeoutMs > 0 {
		requestTimeoutNormalMs := int(crawlClientClampValue(
			float64(env.RequestTimeoutMs), 5000, 900000, float64(fallback.Settings.RequestTimeoutNormalMs)))
		fallback.Settings.RequestTimeoutMs = requestTimeoutNormalMs
		fallback.Settings.RequestTimeoutNormalMs = requestTimeoutNormalMs
		fallback.Settings.RequestTimeoutHotMs = int(minFloat(
			float64(requestTimeoutNormalMs), float64(fallback.Settings.RequestTimeoutHotMs)))
	}
	if env.HealthCheckTTLMs > 0 {
		fallback.Settings.HealthCheckTTLMs = int(crawlClientClampValue(
			float64(env.HealthCheckTTLMs), 5000, 900000, float64(fallback.Settings.HealthCheckTTLMs)))
	}
	if env.MaxConcurrency > 0 {
		fallback.MaxConcurrency = int(crawlClientClampValue(
			float64(env.MaxConcurrency), 1, 20, float64(fallback.MaxConcurrency)))
	}
	return fallback
}

// documentFromModel renders the camelCase JSON document.
func documentFromModel(normalized crawlClientNormalized) crawlClientCacheDocument {
	settings := normalized.Settings
	return crawlClientCacheDocument{
		HealthCheckTtlMs:                         settings.HealthCheckTTLMs,
		RequestTimeoutMs:                         settings.RequestTimeoutMs,
		RequestTimeoutHotMs:                      settings.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:                   settings.RequestTimeoutNormalMs,
		ConditionalRequestEnabled:                settings.ConditionalRequestEnabled,
		ConditionalRequestTimeoutMs:              settings.ConditionalRequestTimeoutMs,
		ConditionalRequestMaxRetries:             settings.ConditionalRequestMaxRetries,
		DetailPublishSignalHeadFetchTimeoutMs:    settings.DetailPublishSignalHeadFetchTimeoutMs,
		DetailPublishSignalHeadFetchConcurrency:  settings.DetailPublishSignalHeadFetchConcurrency,
		DetailPublishSignalHeadFetchMaxReadBytes: settings.DetailPublishSignalHeadFetchMaxReadBytes,
		MaxRetries:                               settings.MaxRetries,
		RetryBackoffMs:                           settings.RetryBackoffMs,
		QueueOverloadCooldownMs:                  settings.QueueOverloadCooldownMs,
		AdaptiveConcurrencyEnabled:               settings.AdaptiveConcurrencyEnabled,
		AdaptiveWindowMinutes:                    settings.AdaptiveWindowMinutes,
		AdaptiveCooldownMinutes:                  settings.AdaptiveCooldownMinutes,
		AdaptiveLatencyThresholdRatio:            settings.AdaptiveLatencyThresholdRatio,
		AdaptiveErrorRateThreshold:               settings.AdaptiveErrorRateThreshold,
		AdaptiveMemoryHeadroomThreshold:          settings.AdaptiveMemoryHeadroomThreshold,
		MaxConcurrency:                           normalized.MaxConcurrency,
	}
}

// modelFromDocument converts a cached document to the GraphQL model.
func modelFromDocument(document crawlClientCacheDocument) CrawlClientSettingsModel {
	return CrawlClientSettingsModel{
		HealthCheckTTLMs:                         document.HealthCheckTtlMs,
		RequestTimeoutMs:                         document.RequestTimeoutMs,
		RequestTimeoutHotMs:                      document.RequestTimeoutHotMs,
		RequestTimeoutNormalMs:                   document.RequestTimeoutNormalMs,
		ConditionalRequestEnabled:                document.ConditionalRequestEnabled,
		ConditionalRequestTimeoutMs:              document.ConditionalRequestTimeoutMs,
		ConditionalRequestMaxRetries:             document.ConditionalRequestMaxRetries,
		DetailPublishSignalHeadFetchTimeoutMs:    document.DetailPublishSignalHeadFetchTimeoutMs,
		DetailPublishSignalHeadFetchConcurrency:  document.DetailPublishSignalHeadFetchConcurrency,
		DetailPublishSignalHeadFetchMaxReadBytes: document.DetailPublishSignalHeadFetchMaxReadBytes,
		MaxRetries:                               document.MaxRetries,
		RetryBackoffMs:                           document.RetryBackoffMs,
		QueueOverloadCooldownMs:                  document.QueueOverloadCooldownMs,
		AdaptiveConcurrencyEnabled:               document.AdaptiveConcurrencyEnabled,
		AdaptiveWindowMinutes:                    document.AdaptiveWindowMinutes,
		AdaptiveCooldownMinutes:                  document.AdaptiveCooldownMinutes,
		AdaptiveLatencyThresholdRatio:            document.AdaptiveLatencyThresholdRatio,
		AdaptiveErrorRateThreshold:               document.AdaptiveErrorRateThreshold,
		AdaptiveMemoryHeadroomThreshold:          document.AdaptiveMemoryHeadroomThreshold,
	}
}
