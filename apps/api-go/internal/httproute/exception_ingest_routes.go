package httproute

import "net/http"

// Handler registration keys for the two migrated exception-report POST
// endpoints. Both are exact paths, so the keys can be the paths themselves.
const (
	ExceptionIngestClientKey   = "/api/observability/exception-events/client"
	ExceptionIngestInternalKey = "/api/internal/observability/exception-events"
)

// WithExceptionIngest registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/observability/exception-events/client
//	POST /api/internal/observability/exception-events
func WithExceptionIngest(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, ExceptionIngestClientKey,
		"/api/observability/exception-events/client", http.MethodPost)
	return appendExactKeyed(rules, ExceptionIngestInternalKey,
		"/api/internal/observability/exception-events", http.MethodPost)
}
