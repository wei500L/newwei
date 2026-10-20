package runtimesettings

import (
	"context"
	"database/sql"

	"github.com/redis/go-redis/v9"
)

// MultiTenantConcurrencyReader exposes the stored organization concurrency
// values to the background cron units without copying the settings document
// shape.
//
// Every read reuses the full-record normalizer behind GET/PUT
// multi-tenant-scheduler-settings: an absent row returns the defaults and a
// present but invalid field in any of the eleven concurrency columns fails the
// whole read, exactly like MultiTenantSchedulerSettingsService.getSettings. The
// NestJS scheduler wraps that read in a 30 second process-local cache; a cron
// tick reads the value once, so this port performs one SystemSetting query per
// tick and never serves a value older than that cache could.
type MultiTenantConcurrencyReader struct {
	service *Service
}

// NewMultiTenantConcurrencyReader builds the reader on the shared MySQL and
// Redis handles.
func NewMultiTenantConcurrencyReader(db *sql.DB, client *redis.Client) *MultiTenantConcurrencyReader {
	return &MultiTenantConcurrencyReader{service: NewService(db, client, Config{})}
}

// ReadNewsEventsTimelineOrgConcurrency reads newsEventsTimelineOrgConcurrency.
func (r *MultiTenantConcurrencyReader) ReadNewsEventsTimelineOrgConcurrency(ctx context.Context) (int, error) {
	settings, err := r.read(ctx)
	if err != nil {
		return 0, err
	}
	return settings.NewsEventsTimelineOrgConcurrency, nil
}

// ReadSentimentSnapshotOrgConcurrency reads sentimentSnapshotOrgConcurrency.
func (r *MultiTenantConcurrencyReader) ReadSentimentSnapshotOrgConcurrency(ctx context.Context) (int, error) {
	settings, err := r.read(ctx)
	if err != nil {
		return 0, err
	}
	return settings.SentimentSnapshotOrgConcurrency, nil
}

func (r *MultiTenantConcurrencyReader) read(ctx context.Context) (multiTenantSchedulerSettings, error) {
	if r == nil || r.service == nil {
		return multiTenantSchedulerSettings{}, errNoDatabase
	}
	return r.service.readMultiTenantSchedulerSettings(ctx)
}
