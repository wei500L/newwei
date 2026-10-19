package legacyproxy

import "net/http"

// CrawlDiscoveryKey is the Go handler registration key for the three
// crawl-discovery entries. The key is synthetic: it never collides with a real
// request path, and every rule below points at it through Rule.HandlerKey so one
// handler can dispatch by URL path.
const CrawlDiscoveryKey = "/api/admin/crawl-discovery#entries"

// WithCrawlDiscovery registers the three exact crawl discovery routes.
//
// The two switches are independent, so each rule is added only for its own mode:
//
//	API_GO_NEWS_SOURCE_PREVIEW_MODE=go:
//	  GET  /api/admin/news-sources/:id/preview
//	API_GO_CRAWL_WORKFLOW_TRIAL_MODE=go:
//	  POST /api/admin/crawl-frontier/workflows/:id/trial-run
//	  POST /api/admin/crawl-frontier/workflow-runs/:runId/replay
//
// Every other method, trailing slash and longer path falls back to the /api/
// legacy rule, and Go never answers its own 404 for those requests.
//
// Shadowing check against the neighbouring rule sets:
//
//   - news-sources (WithNewsSources): the only rules taking one segment after
//     /api/admin/news-sources/ are PATCH/DELETE (:id) plus POST (:id)/run and
//     (:id)/schedule. There is no GET rule for :id, so :id/preview was on the
//     /api/ proxy and this rule is the first to take it. The static
//     options/groups/opml-presets/batch prefixes are longer, so they keep
//     winning; :id/preview can never be parsed as one of them.
//   - crawl-frontier runs (WithCrawlFrontierRuns): workflow-runs/:runId is
//     registered for GET only, and the candidate/explanation shapes end on
//     GET. POST :runId/replay has no competing rule.
//   - crawl profiles/workflows (WithCrawlProfiles, WithCrawlWorkflows): the
//     workflows/:id rules are GET, and draft/publish/versions have their own
//     tails and methods, so POST :id/trial-run is not shadowed. profiles rules
//     never match a workflows/ path.
//   - The dynamic prefixes used here ("/api/admin/news-sources/",
//     "/api/admin/crawl-frontier/workflows/", ".../workflow-runs/") are exactly
//     as long as the existing dynamic rules for the same subtrees. The router
//     sorts by prefix length and falls through on a method mismatch, so the
//     method whitelist alone separates the rules; no existing rule changes
//     meaning.
func WithCrawlDiscovery(rules []Rule, previewMode, trialMode string) []Rule {
	base := "/api/admin/crawl-frontier"
	if previewMode == string(ModeGo) {
		rules = appendSegmentRule(rules, CrawlDiscoveryKey, "/api/admin/news-sources/", true, false, "/preview", http.MethodGet)
	}
	if trialMode == string(ModeGo) {
		rules = appendSegmentRule(rules, CrawlDiscoveryKey, base+"/workflows/", true, false, "/trial-run", http.MethodPost)
		rules = appendSegmentRule(rules, CrawlDiscoveryKey, base+"/workflow-runs/", true, false, "/replay", http.MethodPost)
	}
	return rules
}
