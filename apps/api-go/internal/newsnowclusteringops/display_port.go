package newsnowclusteringops

import "strings"

// SourceDisplay is the display projection of one generated source registry
// entry. The NewsNow hottest analysis and recommendation read it to build the
// per-source metadata context: display name, home URL (domestic authority
// weighting), column (china membership) and title (source aliases).
type SourceDisplay struct {
	ID     string
	Name   string
	Title  string
	Home   string
	Column string
}

// LookupSourceDisplay resolves one source id against the generated registry.
// It is a read-only port: it never instantiates the Mongo-backed Service.
func LookupSourceDisplay(sourceID string) (SourceDisplay, bool) {
	trimmed := strings.TrimSpace(sourceID)
	if trimmed == "" {
		return SourceDisplay{}, false
	}
	for _, entry := range newsnowSourceRegistry {
		if entry.ID != trimmed {
			continue
		}
		return SourceDisplay{
			ID:     entry.ID,
			Name:   entry.Source.Name,
			Title:  entry.Source.Title,
			Home:   entry.Source.Home,
			Column: entry.Source.Column,
		}, true
	}
	return SourceDisplay{}, false
}

// HottestSourceIDs returns the hottest column sources in registry order. The
// generator already materialized the column in newsnowColumnRegistry, so this
// port introduces no second source table.
func HottestSourceIDs() []string {
	sources, ok := newsnowColumnSourcesByID["hottest"]
	if !ok {
		return []string{}
	}
	out := make([]string, len(sources))
	copy(out, sources)
	return out
}
