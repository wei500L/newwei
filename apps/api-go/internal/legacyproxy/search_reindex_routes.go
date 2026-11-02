package legacyproxy

import "net/http"

// SearchReindexKey is the Go handler registration key for the two search index
// rebuild routes. The key is a synthetic path: it never collides with a real
// request path, and both rules below point at it through Rule.HandlerKey so one
// handler can dispatch by URL path.
const SearchReindexKey = "/__go/search-reindex"

// WithSearchReindex registers the two routes taken over when the search reindex
// mode is go:
//
//	POST /api/admin/search/reindex
//	GET  /api/admin/search/reindex/:jobId
//
// Only those methods are registered: every other method, the trailing-slash
// path, longer paths and the parent path keep falling back to the /api/ legacy
// rule, so Go never answers its own 404 for them. Both rules also allow OPTIONS
// so CORS preflight is answered by Go. An empty or legacy mode adds no rules.
func WithSearchReindex(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, SearchReindexKey, "/api/admin/search/reindex", http.MethodPost)
	return appendSegmentRule(rules, SearchReindexKey, "/api/admin/search/reindex/", true, false, "", http.MethodGet)
}
