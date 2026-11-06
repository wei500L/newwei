package httproute

import "net/http"

// NewsnowSourcesKey is the handler registration key for the two public NewsNow
// source fetch routes. Both rules share the key because they are served by the
// same handler.
const NewsnowSourcesKey = "/api/news-aggregator/source"

// WithNewsnowSources registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/news-aggregator/source
//	POST /api/news-aggregator/sources/batch
func WithNewsnowSources(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, NewsnowSourcesKey, "/api/news-aggregator/source", http.MethodGet)
	return appendExactKeyed(rules, NewsnowSourcesKey, "/api/news-aggregator/sources/batch", http.MethodPost)
}
