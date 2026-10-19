package newsnowclusteringops

// SourceMetadata is the narrow, read-only projection of one generated source
// registry entry. It intentionally carries only the fields the NewsNow source
// fetch path needs: interval for the fresh cache TTL, redirect for alias
// resolution and the canonical id for logging and error messages. Display
// metadata (name, column, color, runtimeSecrets) stays private to this package.
type SourceMetadata struct {
	ID       string
	Redirect string
	Interval int
}

// newsnowSourceMetadataByID indexes the generated registry once. The registry
// itself is the single source of truth: no second source table is maintained
// here.
var newsnowSourceMetadataByID = func() map[string]SourceMetadata {
	out := make(map[string]SourceMetadata, len(newsnowSourceRegistry))
	for _, entry := range newsnowSourceRegistry {
		out[entry.ID] = SourceMetadata{
			ID:       entry.ID,
			Redirect: entry.Source.Redirect,
			Interval: entry.Source.Interval,
		}
	}
	return out
}()

// LookupSourceMetadata resolves one source id against the generated registry.
// It is the only read port the NewsNow source fetch unit uses; it never
// instantiates the Mongo-backed Service and never mutates registry state.
func LookupSourceMetadata(sourceID string) (SourceMetadata, bool) {
	entry, ok := newsnowSourceMetadataByID[sourceID]
	return entry, ok
}

// KnownSourceIDs returns every id in the generated registry in declaration
// order. Tests use it to assert that each reachable id has a provider getter.
func KnownSourceIDs() []string {
	out := make([]string, 0, len(newsnowSourceRegistry))
	for _, entry := range newsnowSourceRegistry {
		out = append(out, entry.ID)
	}
	return out
}
