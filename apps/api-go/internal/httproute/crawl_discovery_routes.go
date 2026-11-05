package httproute

import "net/http"

// NewsSourcePreviewKey is the Go handler registration key for the single
// news-source preview GET. The key is synthetic so it never collides with a
// real request path.
const NewsSourcePreviewKey = "/api/admin/news-sources#preview"

// CrawlWorkflowTrialKey is the Go handler registration key for the crawl
// strategy trial-run and replay POSTs. One handler serves both paths.
const CrawlWorkflowTrialKey = "/api/admin/crawl-frontier#workflow-trial"

// WithNewsSourcePreview appends GET /api/admin/news-sources/:id/preview plus its
// CORS preflight.
//
// The rule is `OneSegment + /preview`, so it never matches the collection, a
// static sibling (options/groups/opml/batch), a bare `:id`, the longer
// `:id/run` / `:id/schedule` shapes, or any other method.
func WithNewsSourcePreview(rules []Rule) []Rule {
	return appendSegmentRule(rules, NewsSourcePreviewKey, "/api/admin/news-sources/", true, false, "/preview", http.MethodGet)
}

// WithCrawlWorkflowTrial appends the two crawl-strategy execution POSTs:
// POST /api/admin/crawl-frontier/workflows/:id/trial-run and
// POST /api/admin/crawl-frontier/workflow-runs/:runId/replay.
//
// Both rules are `OneSegment + fixed suffix`, so they never mask the existing GET
// `workflows/:id`, `workflows/:id/draft|publish|versions`, `workflow-runs/:runId`,
// `workflow-runs/:runId/candidates` or the candidate explanation route.
func WithCrawlWorkflowTrial(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier"
	rules = appendSegmentRule(rules, CrawlWorkflowTrialKey, base+"/workflows/", true, false, "/trial-run", http.MethodPost)
	return appendSegmentRule(rules, CrawlWorkflowTrialKey, base+"/workflow-runs/", true, false, "/replay", http.MethodPost)
}
