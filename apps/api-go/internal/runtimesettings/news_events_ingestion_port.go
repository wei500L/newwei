package runtimesettings

import (
	"context"
	"sync"
	"time"
)

// newsEventsIngestionRuntimeCacheTTL mirrors RUNTIME_CACHE_TTL_MS in
// MultiTenantSchedulerSettingsService: the news-event ingestion scheduler reads
// the runtime snapshot through a process-local 30 second cache so one tick does
// not query SystemSetting for every organization.
const newsEventsIngestionRuntimeCacheTTL = 30 * time.Second

// newsEventsIngestionRuntimeCache is the process-local cached runtime value.
type newsEventsIngestionRuntimeCache struct {
	mu          sync.Mutex
	valid       bool
	concurrency int
	cachedAt    time.Time
}

// ReadNewsEventsIngestionOrgConcurrency reads only the
// newsEventsIngestionOrgConcurrency value, reusing the existing full-record
// normalizer. A missing row returns the default (4); a present but invalid field
// in any of the eleven concurrency columns still fails the whole read, matching
// the settings GET/PUT contract.
func (s *Service) ReadNewsEventsIngestionOrgConcurrency(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoDatabase
	}
	s.newsEventsIngestionCache.mu.Lock()
	defer s.newsEventsIngestionCache.mu.Unlock()
	now := time.Now()
	if s.newsEventsIngestionCache.valid && now.Sub(s.newsEventsIngestionCache.cachedAt) <= newsEventsIngestionRuntimeCacheTTL {
		return s.newsEventsIngestionCache.concurrency, nil
	}
	settings, err := s.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	value := settings.NewsEventsIngestionOrgConcurrency
	s.newsEventsIngestionCache.valid = true
	s.newsEventsIngestionCache.concurrency = value
	s.newsEventsIngestionCache.cachedAt = now
	return value, nil
}
