package runtimesettings

import (
	"context"
	"database/sql"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// crawlMaintenanceRuntimeCacheTTL mirrors RUNTIME_CACHE_TTL_MS in
// MultiTenantSchedulerSettingsService. The five-minute crawl quality snapshot
// tick reads the organization concurrency through this process-local cache so a
// single tick does not query SystemSetting per organization.
const crawlMaintenanceRuntimeCacheTTL = 30 * time.Second

// CrawlQualitySnapshotSettings reads only the
// crawlQualityTaskSnapshotOrgConcurrency value through the existing full-record
// normalizer. A missing row returns the default (2); a present but invalid field
// in any of the eleven concurrency columns still fails the whole read, exactly
// like the settings GET/PUT contract.
type CrawlQualitySnapshotSettings struct {
	service  *Service
	mu       sync.Mutex
	valid    bool
	value    int
	cachedAt time.Time
}

// NewCrawlQualitySnapshotSettings builds the reader over the shared MySQL pool
// and Redis client.
func NewCrawlQualitySnapshotSettings(db *sql.DB, redisClient *redis.Client) *CrawlQualitySnapshotSettings {
	return &CrawlQualitySnapshotSettings{service: NewService(db, redisClient, Config{})}
}

// Read returns the normalized crawlQualityTaskSnapshotOrgConcurrency.
func (s *CrawlQualitySnapshotSettings) Read(ctx context.Context) (int, error) {
	if s == nil || s.service == nil {
		return 0, errNoDatabase
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if s.valid && now.Sub(s.cachedAt) <= crawlMaintenanceRuntimeCacheTTL {
		return s.value, nil
	}
	settings, err := s.service.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	s.value = settings.CrawlQualityTaskSnapshotOrgConcurrency
	s.valid = true
	s.cachedAt = now
	return s.value, nil
}

// AuditLogRetentionReader exposes the shared audit log retention reader
// (audit_log:retention_days cache, SystemSetting, environment fallback) to the
// daily purge cron. It reuses getAuditLogRetention so the cache key, TTL and
// normalization cannot drift from the settings HTTP/GraphQL entries.
type AuditLogRetentionReader struct {
	service *Service
}

// NewAuditLogRetentionReader builds the reader. fallbackDays is
// AUDIT_LOG_RETENTION_DAYS, already normalized by config.
func NewAuditLogRetentionReader(db *sql.DB, redisClient *redis.Client, fallbackDays int) *AuditLogRetentionReader {
	return &AuditLogRetentionReader{service: NewService(db, redisClient, Config{AuditLogRetentionDays: fallbackDays})}
}

// Read returns the normalized retention days.
func (r *AuditLogRetentionReader) Read(ctx context.Context) (int, error) {
	if r == nil || r.service == nil {
		return 0, errNoDatabase
	}
	return r.service.getAuditLogRetention(ctx)
}
