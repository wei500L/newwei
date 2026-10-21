package legacyproxy

import "net/http"

// CrawlFrontierWritesKey is the Go handler registration key for the three crawl
// frontier write routes. The key is synthetic: it never collides with a real
// request path, and every rule below points at it through Rule.HandlerKey so one
// handler can dispatch by URL path.
const CrawlFrontierWritesKey = "/api/admin/crawl-frontier#writes"

// WithCrawlFrontierWrites registers the three write routes taken over when mode
// is go. An empty or legacy mode adds no rules, so every path keeps proxying to
// NestJS.
//
// The migrated routes are:
//
//	POST /api/admin/crawl-frontier/runs
//	POST /api/admin/crawl-frontier/nodes/retry
//	POST /api/admin/crawl-frontier/nodes/:id/retry
//
// Only POST plus the CORS preflight is registered for each path. Every other
// method, trailing slash and longer path falls back to the /api/ legacy rule,
// and Go never answers its own 404 for those requests. The switch is only
// meaningful together with API_GO_CRAWL_FRONTIER_RUNS_MODE=go: the create and
// retry responses are the same getRun run detail as GET /runs/:id, so reads and
// writes must be served by one side (config.go enforces the pair).
//
// POST /runs/:id/retry is not a NestJS route, so no rule claims it.
// POST /workflow-runs/:runId/replay and POST /workflows/:id/trial-run belong to
// the workflows / workflow-trial switches and are untouched here; the profiles,
// workflow-versions and news-sources subtrees belong to their own switches too.
func WithCrawlFrontierWrites(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
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
