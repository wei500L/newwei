package legacyproxy

import "net/http"

// CrawlTaskWriteKey is the Go handler registration key for the three crawl task
// write routes. The key is synthetic: it never collides with a real request
// path, and every rule below points at it through Rule.HandlerKey.
const CrawlTaskWriteKey = "/__go/crawl-task-write"

// WithCrawlTaskWrite registers the three crawl task lifecycle routes taken over
// when API_GO_CRAWL_TASK_WRITE_MODE=go:
//
//	POST   /api/crawl-tasks
//	DELETE /api/crawl-tasks/:id
//	POST   /api/crawl-tasks/:id/retry
//
// Only these methods are registered. The list GET and the detail GET stay with
// API_GO_CRAWL_READ_TELEMETRY_MODE, and POST /api/crawl-tasks/metadata stays
// with API_GO_CRAWL_METADATA_MODE. The rules are method-scoped, so the rules
// added by the crawl read unit on the same prefixes keep matching their own
// requests; rule order between methods is irrelevant.
//
// An empty or legacy mode adds no rules.
func WithCrawlTaskWrite(rules []Rule) []Rule {
	// The retry rule is more specific than the bare :id rule, so it is
	// registered first; the router also matches the longest prefix, but keeping
	// the longer rule first mirrors the other units.
	rules = appendSegmentRule(rules, CrawlTaskWriteKey, "/api/crawl-tasks/", true, false, "/retry",
		http.MethodPost)
	rules = appendSegmentRule(rules, CrawlTaskWriteKey, "/api/crawl-tasks/", true, false, "",
		http.MethodDelete)
	return appendExactKeyed(rules, CrawlTaskWriteKey, "/api/crawl-tasks", http.MethodPost)
}
