package httproute

import "net/http"

// CrawlFrontierWritesKey is the Go handler registration key for the three crawl
// frontier write routes. The key is synthetic: it never collides with a real
// request path, and every rule below points at it through Rule.HandlerKey so one
// handler can dispatch by URL path.
const CrawlFrontierWritesKey = "/api/admin/crawl-frontier#writes"

// WithCrawlFrontierWrites registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/admin/crawl-frontier/runs
//	POST /api/admin/crawl-frontier/nodes/retry
//	POST /api/admin/crawl-frontier/nodes/:id/retry
//
// POST /runs/:id/retry is not a registered route, so no rule claims it.
// POST /workflow-runs/:runId/replay and POST /workflows/:id/trial-run belong to
func WithCrawlFrontierWrites(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier"

	// /runs is a static path, not a dynamic segment.
	rules = appendExactKeyed(rules, CrawlFrontierWritesKey, base+"/runs", http.MethodPost)
	// /nodes/retry must match exactly. A segment rule on the /nodes/ prefix
	// would read "retry" as the :id, and the nodes/:id and nodes/:id/retry
	// segment rules must never treat "retry" as an id. The exact rule also has
	// the longer prefix, so it wins over those segment rules.
	rules = appendExactKeyed(rules, CrawlFrontierWritesKey, base+"/nodes/retry", http.MethodPost)
	// Retry a single node: one dynamic segment followed by the fixed /retry
	// tail, so "retry" stays a static path for the rule above.
	return appendSegmentRule(rules, CrawlFrontierWritesKey, base+"/nodes/", true, false, "/retry", http.MethodPost)
}
