package httproute

import "net/http"

// NewsSourceOpsKey is the Go handler registration key for the four news-source
// operations POSTs. The key is synthetic: it never collides with a real request
// path, and every rule below points at it through Rule.HandlerKey.
const NewsSourceOpsKey = "/__go/news-source-ops"

// WithNewsSourceOps registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/admin/news-sources/:id/dispatch
//	POST /api/admin/news-sources/:id/cancel-queued
//	POST /api/admin/news-sources/:id/clear-inflight
//	POST /api/admin/news-sources/:id/retry-latest
func WithNewsSourceOps(rules []Rule) []Rule {
	base := "/api/admin/news-sources/"
	rules = appendSegmentRule(rules, NewsSourceOpsKey, base, true, false, "/dispatch",
		http.MethodPost)
	rules = appendSegmentRule(rules, NewsSourceOpsKey, base, true, false, "/cancel-queued",
		http.MethodPost)
	rules = appendSegmentRule(rules, NewsSourceOpsKey, base, true, false, "/clear-inflight",
		http.MethodPost)
	return appendSegmentRule(rules, NewsSourceOpsKey, base, true, false, "/retry-latest",
		http.MethodPost)
}
