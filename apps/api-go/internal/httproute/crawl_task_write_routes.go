package httproute

import "net/http"

// CrawlTaskWriteKey is the Go handler registration key for the three crawl task
// write routes. The key is synthetic: it never collides with a real request
// path, and every rule below points at it through Rule.HandlerKey.
const CrawlTaskWriteKey = "/__go/crawl-task-write"

// WithCrawlTaskWrite registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST   /api/crawl-tasks
//	DELETE /api/crawl-tasks/:id
//	POST   /api/crawl-tasks/:id/retry
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
