package httproute

import "net/http"

// SituationInsightsKey is the handler registration key for the situation
// monitor insights read. It is deliberately distinct from SituationSignalsKey
// and SituationMonitorsKey: the three switches are independent.
const SituationInsightsKey = "/api/situation-monitor/insights"

// WithSituationInsights registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
func WithSituationInsights(rules []Rule) []Rule {
	return appendExactKeyed(rules, SituationInsightsKey, "/api/situation-monitor/insights", http.MethodGet)
}
