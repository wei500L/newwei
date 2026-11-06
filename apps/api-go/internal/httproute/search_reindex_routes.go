package httproute

import "net/http"

// SearchReindexKey is the Go handler registration key for the two search index
// rebuild routes. The key is a synthetic path: it never collides with a real
// request path, and both rules below point at it through Rule.HandlerKey so one
// handler can dispatch by URL path.
const SearchReindexKey = "/__go/search-reindex"

// WithSearchReindex registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/admin/search/reindex
//	GET  /api/admin/search/reindex/:jobId
func WithSearchReindex(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, SearchReindexKey, "/api/admin/search/reindex", http.MethodPost)
	return appendSegmentRule(rules, SearchReindexKey, "/api/admin/search/reindex/", true, false, "", http.MethodGet)
}
