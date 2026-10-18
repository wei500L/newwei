package situationmonitors

import (
	"context"
	"errors"
)

// EnabledMonitor is the read-only monitor projection needed by the situation
// monitor signals read batch (monitorMatches on the telegram feed and the two
// OREF reads).
//
// The field set mirrors exactly what NestJS normalizeMonitorRow exposes to the
// matching pipeline in
// apps/api/src/modules/situation-monitor/situation-monitor-monitors.service.ts;
// fields the matcher never reads (rejectedSuggestions, timestamps, embedding
// model name) are deliberately not projected.
type EnabledMonitor struct {
	ID                   string
	Kind                 string
	Name                 string
	Color                string
	RawKeywords          []string
	ApprovedTopics       []string
	ApprovedEntities     []string
	ApprovedSources      []string
	ApprovedGeos         []string
	ApprovedLexicalTerms []string
	Location             *EnabledMonitorLocation
	QueryEmbeddingVector []float64
}

// EnabledMonitorLocation is a monitor's resolved location, narrowed to the
// three fields the geo matcher reads.
type EnabledMonitorLocation struct {
	Name              string
	Lat               float64
	Lng               float64
	CountryCodeAlpha2 string
}

// LoadEnabledMonitors runs the legacy migration for the caller and then returns
// their enabled monitors ordered by kind ASC, createdAt DESC.
//
// Tenancy: the query is filtered by orgId AND userId, exactly like NestJS
// loadMonitorRows. Match results are the caller's own monitors, so a monitor
// that belongs to another user or another organization must never appear.
//
// The projection and normalization reuse the package-private row mapping
// (ensureLegacyMigration, listRows, mapRow) so the exported adapter cannot
// drift from the list/create/update HTTP contract served by this same package.
// Reading is not wrapped in the per-user advisory lock: NestJS reads monitors
// without the lock too, and this adapter never writes monitor rows.
func (s *Service) LoadEnabledMonitors(ctx context.Context, orgID, userID string) ([]EnabledMonitor, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("situation monitor store is not configured")
	}
	if err := s.ensureLegacyMigration(ctx, s.db, orgID, userID); err != nil {
		return nil, err
	}
	rows, err := s.listRows(ctx, s.db, orgID, userID)
	if err != nil {
		return nil, err
	}
	out := make([]EnabledMonitor, 0, len(rows))
	for _, row := range rows {
		mapped := mapRow(row)
		if !mapped.Enabled {
			continue
		}
		monitor := EnabledMonitor{
			ID:                   mapped.ID,
			Kind:                 mapped.Kind,
			Name:                 mapped.Name,
			Color:                mapped.Color,
			RawKeywords:          mapped.RawKeywords,
			ApprovedTopics:       mapped.ApprovedTopics,
			ApprovedEntities:     mapped.ApprovedEntities,
			ApprovedSources:      mapped.ApprovedSources,
			ApprovedGeos:         mapped.ApprovedGeos,
			ApprovedLexicalTerms: mapped.ApprovedLexicalTerms,
			QueryEmbeddingVector: mapped.QueryEmbeddingVector,
		}
		if mapped.Location != nil {
			monitor.Location = &EnabledMonitorLocation{
				Name:              mapped.Location.Name,
				Lat:               mapped.Location.Lat,
				Lng:               mapped.Location.Lng,
				CountryCodeAlpha2: mapped.Location.CountryCodeAlpha2,
			}
		}
		out = append(out, monitor)
	}
	return out, nil
}
