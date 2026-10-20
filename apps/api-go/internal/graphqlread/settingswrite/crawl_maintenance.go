package settingswrite

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// CrawlSettingsPort is the narrow settings surface the adaptive-concurrency
// maintenance cron needs. It reuses the same load/normalize/store path as the
// GraphQL mutation so the persisted document, the audit snapshot rules and the
// shared cache stay byte-identical.
type CrawlSettingsPort struct {
	db    *sql.DB
	redis *redis.Client
}

// NewCrawlSettingsPort builds the port over the shared MySQL pool and Redis
// client.
func NewCrawlSettingsPort(db *sql.DB, redisClient *redis.Client) *CrawlSettingsPort {
	return &CrawlSettingsPort{db: db, redis: redisClient}
}

// Read is CrawlSettingsService.getSettings without the audit gate: the database
// document is normalized over the environment fallback.
func (p *CrawlSettingsPort) Read(ctx context.Context) (settingscrawl.CrawlClientNormalized, error) {
	if p == nil || p.db == nil {
		return settingscrawl.CrawlClientNormalized{}, errDatabaseUnavailable
	}
	svc := &service{db: p.db, redis: p.redis}
	return svc.loadCrawlClient(ctx)
}

// UpdateMaxConcurrencyInternal is CrawlSettingsService.updateMaxConcurrencyInternal
// with updatedById NULL: it loads the current document, normalizes
// {maxConcurrency} over it, persists the full document with the forced
// description, refreshes the 30 second cache and writes NO audit row. The
// adaptive cron is a machine actor, so NestJS also passes null here.
func (p *CrawlSettingsPort) UpdateMaxConcurrencyInternal(ctx context.Context, maxConcurrency int) (int, error) {
	if p == nil || p.db == nil {
		return 0, errDatabaseUnavailable
	}
	svc := &service{db: p.db, redis: p.redis}
	current, err := svc.loadCrawlClient(ctx)
	if err != nil {
		return 0, err
	}
	candidate, err := json.Marshal(struct {
		MaxConcurrency int `json:"maxConcurrency"`
	}{MaxConcurrency: maxConcurrency})
	if err != nil {
		return 0, err
	}
	normalized := settingscrawl.NormalizeCrawlClientSettingsDocument(candidate, current)
	payload := mustJSON(newCrawlClientDocument(normalized))
	if err := svc.upsertSettingForceDescription(ctx, settingKeyCrawlClientSettings, payload,
		"Crawl client runtime settings", nil); err != nil {
		return 0, err
	}
	svc.cacheSettingsDocument(ctx, cacheKeyCrawlClientSettings, payload, crawlClientCacheTTLSeconds)
	return normalized.MaxConcurrency, nil
}
