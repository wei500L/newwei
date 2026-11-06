package httproute

import "net/http"

// MetricsKey is the Go handler registration key for the Prometheus scrape
// endpoint.
const MetricsKey = "/api/metrics"

// WithMetrics registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
func WithMetrics(rules []Rule) []Rule {
	return appendExactKeyed(rules, MetricsKey, "/api/metrics", http.MethodGet)
}
