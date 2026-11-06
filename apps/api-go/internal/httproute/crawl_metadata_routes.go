package httproute

import "net/http"

// CrawlMetadataKey is the Go handler registration key for the single metadata
// preview POST. The key is a synthetic path so it never collides with a real
// request path.
const CrawlMetadataKey = "/__go/crawl-metadata"

// WithCrawlMetadata registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
// POST /api/crawl-tasks/:id/retry, DELETE /api/crawl-tasks/:id and every other
func WithCrawlMetadata(rules []Rule) []Rule {
	return appendExactKeyed(rules, CrawlMetadataKey, "/api/crawl-tasks/metadata", http.MethodPost)
}
