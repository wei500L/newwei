package legacyproxy

import "net/http"

// CrawlMetadataKey is the Go handler registration key for the single metadata
// preview POST. The key is a synthetic path so it never collides with a real
// request path.
const CrawlMetadataKey = "/__go/crawl-metadata"

// WithCrawlMetadata registers the exact POST /api/crawl-tasks/metadata route
// plus its CORS preflight when mode is go.
//
// Only this method and path are taken over. GET /api/crawl-tasks/metadata keeps
// the existing GET /api/crawl-tasks/:id ownership, and POST /api/crawl-tasks,
// POST /api/crawl-tasks/:id/retry, DELETE /api/crawl-tasks/:id and every other
// crawl task route keep falling back to NestJS. An empty or legacy mode adds no
// rules.
func WithCrawlMetadata(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, CrawlMetadataKey, "/api/crawl-tasks/metadata", http.MethodPost)
}
