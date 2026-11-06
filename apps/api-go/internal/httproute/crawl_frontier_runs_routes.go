package httproute

import "net/http"

// CrawlFrontierRunsKey is the Go handler registration key for the crawl
// frontier run monitoring and cancellation routes. The key is synthetic: it
// never collides with a real request path, and every rule below points at it
// through Rule.HandlerKey so one handler can dispatch by URL path.
const CrawlFrontierRunsKey = "/api/admin/crawl-frontier#runs"

// WithCrawlFrontierRuns registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
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
// The write routes (POST /runs, /nodes/retry and /nodes/:id/retry) are owned by
// WithCrawlFrontierWrites and are not registered here.
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
