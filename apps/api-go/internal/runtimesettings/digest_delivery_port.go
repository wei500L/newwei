package runtimesettings

import (
	"context"
	"sync"
	"time"
)

// digestDeliveryRuntimeCacheTTL mirrors RUNTIME_CACHE_TTL_MS in
// MultiTenantSchedulerSettingsService: the scheduler reads the runtime snapshot
// through a process-local 30 second cache so one tick does not query
// SystemSetting for every organization.
const digestDeliveryRuntimeCacheTTL = 30 * time.Second

// digestDeliveryRuntimeCache is the process-local cached runtime value.
type digestDeliveryRuntimeCache struct {
	mu          sync.Mutex
	valid       bool
	concurrency int
	cachedAt    time.Time
}

// ReadDigestDeliveryOrgConcurrency reads only the userDigestDeliveryOrgConcurrency
// value, reusing the existing full-record normalizer. A missing row returns the
// default (4); a present but invalid field in any of the eleven concurrency
// columns still fails the whole read, matching the settings GET/PUT contract.
func (s *Service) ReadDigestDeliveryOrgConcurrency(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoDatabase
	}
	s.digestDeliveryCache.mu.Lock()
	defer s.digestDeliveryCache.mu.Unlock()
	now := time.Now()
	if s.digestDeliveryCache.valid && now.Sub(s.digestDeliveryCache.cachedAt) <= digestDeliveryRuntimeCacheTTL {
		return s.digestDeliveryCache.concurrency, nil
	}
	settings, err := s.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	value := settings.UserDigestDeliveryOrgConcurrency
	s.digestDeliveryCache.valid = true
	s.digestDeliveryCache.concurrency = value
	s.digestDeliveryCache.cachedAt = now
	return value, nil
}
