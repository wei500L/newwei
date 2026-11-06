package httproute

import "net/http"

// CrawlQueueOpsKey is the Go handler registration key for the four crawl4ai
// queue administration routes. The key is synthetic and never collides with a
// real request path.
const CrawlQueueOpsKey = "/__go/crawl-queue-ops"

// WithCrawlQueueOps registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/admin/crawl4ai/queue
//	POST /api/admin/crawl4ai/queue/pause
//	POST /api/admin/crawl4ai/queue/resume
//	POST /api/admin/crawl4ai/queue/concurrency
func WithCrawlQueueOps(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/pause", http.MethodPost)
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/resume", http.MethodPost)
	return appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/concurrency", http.MethodPost)
}
