package legacyproxy

import "net/http"

// CrawlQueueOpsKey is the Go handler registration key for the four crawl4ai
// queue administration routes. The key is synthetic and never collides with a
// real request path.
const CrawlQueueOpsKey = "/__go/crawl-queue-ops"

// WithCrawlQueueOps registers the four queue administration routes taken over
// when API_GO_CRAWL_QUEUE_OPS_MODE=go:
//
//	GET  /api/admin/crawl4ai/queue
//	POST /api/admin/crawl4ai/queue/pause
//	POST /api/admin/crawl4ai/queue/resume
//	POST /api/admin/crawl4ai/queue/concurrency
//
// Only these methods are registered. Every other method, a trailing slash and
// longer paths keep falling back to the /api/ legacy rule, so Go never answers
// its own 404 for them. The quality routes under /api/admin/crawl4ai/quality
// belong to API_GO_CRAWL_READ_TELEMETRY_MODE and are untouched.
//
// An empty or legacy mode adds no rules.
func WithCrawlQueueOps(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/pause", http.MethodPost)
	rules = appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/resume", http.MethodPost)
	return appendExactKeyed(rules, CrawlQueueOpsKey, "/api/admin/crawl4ai/queue/concurrency", http.MethodPost)
}
