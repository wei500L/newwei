package legacyproxy

import "net/http"

// CrawlFrontierRunsKey is the Go handler registration key for the crawl
// frontier run monitoring and cancellation routes. The key is synthetic: it
// never collides with a real request path, and every rule below points at it
// through Rule.HandlerKey so one handler can dispatch by URL path.
const CrawlFrontierRunsKey = "/api/admin/crawl-frontier#runs"

// WithCrawlFrontierRuns registers the eleven routes taken over when mode is
// go. An empty or legacy mode adds no rules, so every path keeps proxying to
// NestJS.
//
// The migrated routes are:
//
//	GET  /api/admin/crawl-frontier/runs
//	GET  /api/admin/crawl-frontier/runs/:id
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-run
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-candidates
//	GET  /api/admin/crawl-frontier/runs/:id/workflow-candidates/:candidateId
//	POST /api/admin/crawl-frontier/runs/cancel
//	POST /api/admin/crawl-frontier/runs/:id/cancel
//	GET  /api/admin/crawl-frontier/nodes/:id
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId/candidates
//	GET  /api/admin/crawl-frontier/workflow-runs/:runId/candidates/:candidateId/explanation
//
// Only the listed method is registered for each path. Every other method,
// trailing slash and longer path falls back to the /api/ legacy rule, and Go
// never answers its own 404 for those requests. GET /runs/cancel deliberately
// matches the runs/:id rule (id = "cancel") so it returns the same 404 as the
// NestJS @Get("runs/:id") route.
//
// The three write routes (POST /runs, POST /nodes/retry and
// POST /nodes/:id/retry) are owned by WithCrawlFrontierWrites and
// API_GO_CRAWL_FRONTIER_WRITES_MODE, never by this switch; creating or retrying
// a run returns the same run detail as GET /runs/:id, so config.go requires
// both switches to be go together. POST /workflow-runs/:runId/replay and
// POST /workflows/:id/trial-run still stay on NestJS and are not registered
// here. The profiles, workflows, workflow-versions and news-sources subtrees
// belong to their own switches and are not touched.
func WithCrawlFrontierRuns(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier"
	runsPath := base + "/runs"
	runsPrefix := runsPath + "/"
	workflowRunsPath := base + "/workflow-runs"
	workflowRunsPrefix := workflowRunsPath + "/"
	// CORS preflight is answered by Go on the same paths, exactly like the
	// helper-built rules below (appendSegmentRule adds OPTIONS).
	getOptions := map[string]bool{http.MethodGet: true, http.MethodOptions: true}

	// Exact paths first: /runs and /runs/cancel are not dynamic segments.
	rules = appendExactKeyed(rules, CrawlFrontierRunsKey, runsPath, http.MethodGet)
	rules = appendExactKeyed(rules, CrawlFrontierRunsKey, runsPath+"/cancel", http.MethodPost)

	// Candidate explanation is the most specific runs/:id shape: one dynamic
	// segment, the fixed middle "/workflow-candidates" and a second dynamic
	// segment (the Nest route has no trailing "/explanation").
	rules = append(rules, Rule{
		Prefix:      runsPrefix,
		OneSegment:  true,
		Tail:        "/workflow-candidates",
		TailSegment: true,
		HandlerKey:  CrawlFrontierRunsKey,
		Methods:     getOptions,
	})
	// Remaining runs/:id shapes, most specific tail first.
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, runsPrefix, true, false, "/workflow-candidates", http.MethodGet)
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, runsPrefix, true, false, "/workflow-run", http.MethodGet)
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, runsPrefix, true, false, "/cancel", http.MethodPost)
	// The bare runs/:id rule is last so it never shadows a longer shape. It
	// also matches GET /runs/cancel with id="cancel" (404, like NestJS).
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, runsPrefix, true, false, "", http.MethodGet)

	// nodes/:id is read-only; retry routes are not registered.
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, base+"/nodes/", true, false, "", http.MethodGet)

	// workflow-runs/:runId/candidates/:candidateId/explanation.
	rules = append(rules, Rule{
		Prefix:      workflowRunsPrefix,
		OneSegment:  true,
		Tail:        "/candidates",
		TailSegment: true,
		TailSuffix:  "/explanation",
		HandlerKey:  CrawlFrontierRunsKey,
		Methods:     getOptions,
	})
	rules = appendSegmentRule(rules, CrawlFrontierRunsKey, workflowRunsPrefix, true, false, "/candidates", http.MethodGet)
	return appendSegmentRule(rules, CrawlFrontierRunsKey, workflowRunsPrefix, true, false, "", http.MethodGet)
}
