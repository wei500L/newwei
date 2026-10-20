package legacyproxy

import "net/http"

// NewsSourceOpsKey is the Go handler registration key for the four news-source
// operations POSTs. The key is synthetic: it never collides with a real request
// path, and every rule below points at it through Rule.HandlerKey.
const NewsSourceOpsKey = "/__go/news-source-ops"

// WithNewsSourceOps registers the four news-source operations POSTs taken over
// when API_GO_NEWS_SOURCE_OPS_MODE=go:
//
//	POST /api/admin/news-sources/:id/dispatch
//	POST /api/admin/news-sources/:id/cancel-queued
//	POST /api/admin/news-sources/:id/clear-inflight
//	POST /api/admin/news-sources/:id/retry-latest
//
// The rules are method-scoped and tail-scoped, so the news-source CRUD rules
// (`:id` PATCH/DELETE, `:id/run`, `:id/schedule`), the `:id/preview` GET rule
// and every longer path keep their existing owners. An empty or legacy mode
// adds no rules.
func WithNewsSourceOps(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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
