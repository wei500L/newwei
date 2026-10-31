package legacyproxy

import "net/http"

// NewsSourcePreviewKey is the Go handler registration key for the single
// news-source preview GET. The key is synthetic so it never collides with a
// real request path.
const NewsSourcePreviewKey = "/api/admin/news-sources#preview"

// CrawlWorkflowTrialKey is the Go handler registration key for the crawl
// strategy trial-run and replay POSTs. One handler serves both paths.
const CrawlWorkflowTrialKey = "/api/admin/crawl-frontier#workflow-trial"

// WithNewsSourcePreview registers GET /api/admin/news-sources/:id/preview plus
// its CORS preflight when mode is go. An empty or legacy mode adds no rules.
//
// The rule is `OneSegment + /preview`, so it never matches the collection, a
// static sibling (options/groups/opml/batch), a bare `:id`, the longer
// `:id/run` / `:id/schedule` shapes, or any other method. Those keep their
// existing ownership (own switch or the /api/ legacy fallback).
func WithNewsSourcePreview(rules []Rule) []Rule {
	return appendSegmentRule(rules, NewsSourcePreviewKey, "/api/admin/news-sources/", true, false, "/preview", http.MethodGet)
}

// WithCrawlWorkflowTrial registers the two crawl-strategy execution POSTs when
// mode is go:
//
//	POST /api/admin/crawl-frontier/workflows/:id/trial-run
//	POST /api/admin/crawl-frontier/workflow-runs/:runId/replay
//
// Both rules are `OneSegment + fixed suffix`, so they never shadow the existing
// GET `workflows/:id`, `workflows/:id/draft|publish|versions`,
// `workflow-runs/:runId`, `workflow-runs/:runId/candidates` or the candidate
// explanation route. An empty or legacy mode adds no rules.
func WithCrawlWorkflowTrial(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier"
	rules = appendSegmentRule(rules, CrawlWorkflowTrialKey, base+"/workflows/", true, false, "/trial-run", http.MethodPost)
	return appendSegmentRule(rules, CrawlWorkflowTrialKey, base+"/workflow-runs/", true, false, "/replay", http.MethodPost)
}
