package httproute

import "net/http"

// NewsClusteringLlmBackfillKey is the handler registration key for the manual
// news-event clustering LLM backfill route. The route has one dynamic segment,
// so the key is a stable static path that never collides with a real request
// path.
const NewsClusteringLlmBackfillKey = "/api/system-settings/news-events/clustering/failures/llm-backfill"

// WithNewsClusteringLlmBackfill registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/system-settings/news-events/clustering/failures/:groupId/llm-backfill
func WithNewsClusteringLlmBackfill(rules []Rule) []Rule {
	return appendSegmentRule(rules, NewsClusteringLlmBackfillKey,
		"/api/system-settings/news-events/clustering/failures/", true, false, "/llm-backfill",
		http.MethodPost)
}
