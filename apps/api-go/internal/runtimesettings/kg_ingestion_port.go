package runtimesettings

import (
	"context"
	"sync"
	"time"
)

// kgIngestionRuntimeCacheTTL mirrors RUNTIME_CACHE_TTL_MS in
// MultiTenantSchedulerSettingsService: the knowledge-graph ingestion scheduler
// reads the runtime snapshot through a process-local 30 second cache so one
// tick does not query SystemSetting for every organization.
const kgIngestionRuntimeCacheTTL = 30 * time.Second

// kgIngestionRuntimeCache is the process-local cached runtime value.
type kgIngestionRuntimeCache struct {
	mu          sync.Mutex
	valid       bool
	concurrency int
	cachedAt    time.Time
}

// ReadKnowledgeGraphIngestionOrgConcurrency reads only the
// knowledgeGraphIngestionOrgConcurrency value, reusing the existing full-record
// normalizer. A missing row returns the default (4); a present but invalid field
// in any of the eleven concurrency columns still fails the whole read, matching
// the settings GET/PUT contract.
func (s *Service) ReadKnowledgeGraphIngestionOrgConcurrency(ctx context.Context) (int, error) {
	if s == nil {
		return 0, errNoDatabase
	}
	s.kgIngestionCache.mu.Lock()
	defer s.kgIngestionCache.mu.Unlock()
	now := time.Now()
	if s.kgIngestionCache.valid && now.Sub(s.kgIngestionCache.cachedAt) <= kgIngestionRuntimeCacheTTL {
		return s.kgIngestionCache.concurrency, nil
	}
	settings, err := s.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	value := settings.KnowledgeGraphIngestionOrgConcurrency
	s.kgIngestionCache.valid = true
	s.kgIngestionCache.concurrency = value
	s.kgIngestionCache.cachedAt = now
	return value, nil
}
