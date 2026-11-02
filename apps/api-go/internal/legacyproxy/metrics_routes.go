package legacyproxy

import "net/http"

// MetricsKey is the Go handler registration key for the Prometheus scrape
// endpoint.
const MetricsKey = "/api/metrics"

// WithMetrics registers GET /api/metrics when mode is go. The rule is exact and
// method-scoped, so a POST, a longer path or any other method keeps falling back
// to the /api/ legacy rule. OPTIONS is registered because appendExactKeyed adds
// it for the CORS preflight.
//
// Default (empty or legacy) appends nothing.
func WithMetrics(rules []Rule) []Rule {
	return appendExactKeyed(rules, MetricsKey, "/api/metrics", http.MethodGet)
}
