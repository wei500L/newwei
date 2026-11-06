package httproute

import "net/http"

// CrawlReadTelemetryKey is the Go handler registration key for the seven crawl
// read/media/telemetry routes. The key is a synthetic path: it never collides
// with a real request path, and every rule below points at it through
// Rule.HandlerKey so one handler can dispatch by URL path.
const CrawlReadTelemetryKey = "/__go/crawl-read-telemetry"

// WithCrawlReadTelemetry registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/crawl-tasks
//	GET  /api/crawl-tasks/:id
//	GET  /api/crawl-media-assets/:assetId/:mode
//	GET  /api/admin/crawl4ai/quality
//	GET  /api/admin/crawl4ai/quality/sources/:sourceId
//	POST /api/search-telemetry
//	GET  /api/admin/search-telemetry/summary
//
// DELETE /api/crawl-tasks/:id plus POST /api/crawl-tasks/:id/retry never match.
func WithCrawlReadTelemetry(rules []Rule) []Rule {
	// The media asset path has two dynamic segments (:assetId/:mode).
	rules = appendSegmentRule(rules, CrawlReadTelemetryKey, "/api/crawl-media-assets/", false, true, "",
		http.MethodGet)
	// The quality source path has one dynamic segment (:sourceId) and is more
	// specific than the quality exact path, so it is registered first.
	rules = appendSegmentRule(rules, CrawlReadTelemetryKey, "/api/admin/crawl4ai/quality/sources/", true, false, "",
		http.MethodGet)
	rules = appendExactKeyed(rules, CrawlReadTelemetryKey, "/api/admin/crawl4ai/quality", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlReadTelemetryKey, "/api/admin/search-telemetry/summary", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlReadTelemetryKey, "/api/search-telemetry", http.MethodPost)
	// The crawl task detail rule is GET-only and one segment, and the list rule
	// is an exact GET, so the crawl task write routes are not matched here.
	rules = appendSegmentRule(rules, CrawlReadTelemetryKey, "/api/crawl-tasks/", true, false, "",
		http.MethodGet)
	return appendExactKeyed(rules, CrawlReadTelemetryKey, "/api/crawl-tasks", http.MethodGet)
}
