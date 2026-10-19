package settingswrite

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// UpdateCrawlClientMaxConcurrency is the minimal exported entry the REST queue
// control route needs. It mirrors CrawlSettingsService.updateMaxConcurrency
// exactly: load the current document, normalize {maxConcurrency} over it,
// persist the full document, write the crawl_client_settings_update audit row
// when a field changed, and refresh the shared 30 second cache.
//
// The REST route authorizes with settings.manage only, so this entry deliberately
// performs no administrator gate; the caller has already authenticated the
// request. It returns the persisted maxConcurrency (the normalizer clamps it to
// [1,20]).
func UpdateCrawlClientMaxConcurrency(
	ctx context.Context,
	db *sql.DB,
	redisClient *redis.Client,
	orgID, actorID string,
	maxConcurrency int,
) (int, error) {
	svc := &service{db: db, redis: redisClient}
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
		"Crawl client runtime settings", nullableActorID(actorID)); err != nil {
		return 0, err
	}
	before := crawlClientAuditSnapshotOf(current.Settings, current.MaxConcurrency)
	after := crawlClientAuditSnapshotOf(normalized.Settings, normalized.MaxConcurrency)
	if changed := changedCrawlClientFields(before, after); len(changed) > 0 {
		metadata := crawlClientAuditMetadata{
			SettingsKey:   settingKeyCrawlClientSettings,
			ChangedFields: changed,
			ChangedCount:  len(changed),
			InputFields:   []string{"maxConcurrency"},
			Before:        before,
			After:         after,
		}
		writeAuditLogBestEffort(db, ctx, orgID, actorID, "system_settings",
			"crawl_client_settings_update", metadata)
	}
	svc.cacheSettingsDocument(ctx, cacheKeyCrawlClientSettings, payload, crawlClientCacheTTLSeconds)
	return normalized.MaxConcurrency, nil
}
