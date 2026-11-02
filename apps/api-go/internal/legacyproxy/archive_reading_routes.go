package legacyproxy

import "net/http"

// ArchiveReadingSearchKey is the handler key of the search CSV route.
const ArchiveReadingSearchKey = "/api/analysis/exports/search"

// WithArchiveReadingSearch takes over the exact search export route when the
// independent archive reading switch is go. Only POST and its CORS preflight
// are matched; the two already-migrated exports and every other path keep their
// own rules.
func WithArchiveReadingSearch(rules []Rule) []Rule {
	methods := map[string]bool{http.MethodPost: true, http.MethodOptions: true}
	return append(rules, Rule{
		Prefix:     ArchiveReadingSearchKey,
		Exact:      true,
		HandlerKey: ArchiveReadingSearchKey,
		Methods:    methods,
	})
}
