package runtimesettings

import (
	"context"
	"sync"
	"time"
)

// newsnowHottestRuntimeCacheTTL mirrors RUNTIME_CACHE_TTL_MS in
// MultiTenantSchedulerSettingsService: the ten-minute NewsNow scheduler reads the
// runtime snapshot through a process-local 30 second cache so one tick does not
// query SystemSetting for every organization.
const newsnowHottestRuntimeCacheTTL = 30 * time.Second

// newsnowHottestRuntimeCache is the process-local cached runtime value.
type newsnowHottestRuntimeCache struct {
	mu          sync.Mutex
	valid       bool
	concurrency int
	cachedAt    time.Time
}

// ReadNewsnowHottestAnalysisOrgConcurrency reads only the
// newsnowHottestAnalysisOrgConcurrency value, reusing the existing full-record
// normalizer. A missing row returns the default (6); a present but invalid field
// in any of the eleven concurrency columns still fails the whole read, matching
// the settings GET/PUT contract.
func (s *Service) ReadNewsnowHottestAnalysisOrgConcurrency(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoDatabase
	}
	s.newsnowHottestCache.mu.Lock()
	defer s.newsnowHottestCache.mu.Unlock()
	now := time.Now()
	if s.newsnowHottestCache.valid && now.Sub(s.newsnowHottestCache.cachedAt) <= newsnowHottestRuntimeCacheTTL {
		return s.newsnowHottestCache.concurrency, nil
	}
	settings, err := s.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	value := settings.NewsnowHottestAnalysisOrgConcurrency
	s.newsnowHottestCache.valid = true
	s.newsnowHottestCache.concurrency = value
	s.newsnowHottestCache.cachedAt = now
	return value, nil
}
