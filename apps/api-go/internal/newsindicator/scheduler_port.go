package newsindicator

import "context"

// AssociationIngestionEnabled reports whether an organization enabled both the
// association analysis and the ingestion switch. The six-hour scheduler uses it
// to reproduce the NestJS `if (!cfg.enabled || !cfg.ingestionEnabled) return`
// branch before it calls RefreshOrg.
//
// It reuses getSettings (cache-first, normalized, defaults on a read failure),
// so a missing row or a Redis/MySQL error resolves to the disabled fallback,
// exactly like the NestJS scheduler.
func (s *Service) AssociationIngestionEnabled(ctx context.Context, orgID string) bool {
	if s == nil || s.db == nil {
		return false
	}
	settings := s.loadSettings(ctx, orgID, s.db)
	return settings.Enabled && settings.IngestionEnabled
}
