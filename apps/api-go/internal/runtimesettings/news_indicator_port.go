package runtimesettings

import "context"

// ReadNewsIndicatorAssociationOrgConcurrency reads only the
// newsIndicatorAssociationOrgConcurrency value, reusing the existing full-record
// normalizer. A missing row returns the default (4). The news-indicator
// association scheduler runs once every six hours, so it reads the record on
// every tick instead of adding another process-local cache.
func (s *Service) ReadNewsIndicatorAssociationOrgConcurrency(ctx context.Context) (int, error) {
	if s == nil || s.db == nil {
		return 0, errNoDatabase
	}
	settings, err := s.readMultiTenantSchedulerSettings(ctx)
	if err != nil {
		return 0, err
	}
	return settings.NewsIndicatorAssociationOrgConcurrency, nil
}
