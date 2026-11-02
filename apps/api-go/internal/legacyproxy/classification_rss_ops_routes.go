package legacyproxy

import "net/http"

// ClassificationRssOpsKey is the handler registration key for the classification
// quality workbench, the RSS chain diagnostics and the RSS translation daily
// metrics. The key is a stable static prefix because some rules carry dynamic
// path segments.
const ClassificationRssOpsKey = "/api/admin/quality/classification"

// WithClassificationRssOps registers the 13 exact route rules owned by the
// classification/RSS ops migration when mode is go:
//
//	GET  /api/admin/quality/classification/summary
//	GET  /api/admin/quality/classification/sources/:sourceId/items
//	GET  /api/admin/quality/classification/reviews/queue
//	POST /api/admin/quality/classification/reviews/:reviewId/decision
//	POST /api/admin/quality/classification/reviews/batch
//	POST /api/admin/quality/classification/sampling/query
//	POST /api/admin/quality/classification/sampling/annotations
//	GET  /api/admin/quality/classification/reports/:jobId
//	GET  /api/system-settings/rss-diagnostics/overview
//	GET  /api/system-settings/rss-diagnostics/chain
//	GET  /api/system-settings/rss-diagnostics/sources
//	POST /api/system-settings/rss-diagnostics/backfill-source-id
//	GET  /api/system-settings/rss-translation/metrics
//
// Every rule pins one HTTP method (plus OPTIONS for CORS preflight). Paths with
// a dynamic segment accept exactly one non-empty segment: ":sourceId", ":reviewId"
// and ":jobId" therefore cannot swallow a longer path such as
// /reports/:jobId/results or /reviews/queue/detail.
//
// POST /api/admin/quality/classification/reports is deliberately absent: it
// enqueues a BullMQ job, so it keeps falling back to NestJS. The same applies to
// unlisted methods and longer paths — Go never answers with its own 404.
// Default (empty or legacy) appends nothing.
func WithClassificationRssOps(rules []Rule) []Rule {
	qualityBase := "/api/admin/quality/classification"
	diagBase := "/api/system-settings/rss-diagnostics"

	// Static exact paths first; they never overlap with the dynamic rules below
	// because the dynamic rules additionally require their own fixed tail.
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, qualityBase+"/summary", http.MethodGet)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, qualityBase+"/reviews/queue", http.MethodGet)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, qualityBase+"/reviews/batch", http.MethodPost)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, qualityBase+"/sampling/query", http.MethodPost)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, qualityBase+"/sampling/annotations", http.MethodPost)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, diagBase+"/overview", http.MethodGet)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, diagBase+"/chain", http.MethodGet)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, diagBase+"/sources", http.MethodGet)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, diagBase+"/backfill-source-id", http.MethodPost)
	rules = appendExactKeyed(rules, ClassificationRssOpsKey, "/api/system-settings/rss-translation/metrics", http.MethodGet)

	// Dynamic rules: exactly one segment, optionally followed by a fixed tail.
	rules = appendSegmentRule(rules, ClassificationRssOpsKey, qualityBase+"/sources/",
		true, false, "/items", http.MethodGet)
	rules = appendSegmentRule(rules, ClassificationRssOpsKey, qualityBase+"/reviews/",
		true, false, "/decision", http.MethodPost)
	return appendSegmentRule(rules, ClassificationRssOpsKey, qualityBase+"/reports/",
		true, false, "", http.MethodGet)
}
