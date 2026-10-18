package situationsignals

import (
	"context"

	"github.com/wei500L/newwei/apps/api-go/internal/situationmonitors"
)

// monitorLocation is the resolved location of a monitor, narrowed to the three
// fields the geo matcher reads.
type monitorLocation struct {
	Name              string
	Lat               float64
	Lng               float64
	CountryCodeAlpha2 string
}

// monitorRecord is the normalized monitor the matching pipeline operates on. It
// is the Go projection of NormalizedMonitorRecord in
// apps/api/src/modules/situation-monitor/situation-monitor-monitors.service.ts;
// the fields the matcher never reads (rejected suggestions, timestamps, the
// embedding model name) are not projected.
type monitorRecord struct {
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
	Location             *monitorLocation
	QueryEmbeddingVector []float64
}

// loadEnabledMonitors returns the caller's enabled monitors.
//
// Tenancy: the underlying query filters by orgId AND userId, exactly like
// NestJS loadMonitorRows. A monitor that belongs to another user or another
// organization must never reach the matcher, because a match result exposes the
// monitor's name and colour to the caller.
func loadEnabledMonitors(ctx context.Context, monitors *situationmonitors.Service, orgID, userID string) ([]monitorRecord, error) {
	if monitors == nil {
		return nil, errNoDatabase
	}
	rows, err := monitors.LoadEnabledMonitors(ctx, orgID, userID)
	if err != nil {
		return nil, err
	}
	out := make([]monitorRecord, 0, len(rows))
	for _, row := range rows {
		monitor := monitorRecord{
			ID:                   row.ID,
			Kind:                 row.Kind,
			Name:                 row.Name,
			Color:                row.Color,
			RawKeywords:          nonNilStrings(row.RawKeywords),
			ApprovedTopics:       nonNilStrings(row.ApprovedTopics),
			ApprovedEntities:     nonNilStrings(row.ApprovedEntities),
			ApprovedSources:      nonNilStrings(row.ApprovedSources),
			ApprovedGeos:         nonNilStrings(row.ApprovedGeos),
			ApprovedLexicalTerms: nonNilStrings(row.ApprovedLexicalTerms),
			QueryEmbeddingVector: row.QueryEmbeddingVector,
		}
		if row.Location != nil {
			monitor.Location = &monitorLocation{
				Name:              row.Location.Name,
				Lat:               row.Location.Lat,
				Lng:               row.Location.Lng,
				CountryCodeAlpha2: row.Location.CountryCodeAlpha2,
			}
		}
		out = append(out, monitor)
	}
	return out, nil
}

// nonNilStrings keeps the JSON shape stable: every string list serializes as an
// array, never as null.
func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
