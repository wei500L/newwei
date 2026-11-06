package httproute

import "net/http"

// SituationRefreshKey is the handler registration key for
// POST /api/situation-monitor/refresh. It is deliberately distinct from
// SituationSignalsKey and SituationInsightsKey, so the refresh path is owned
// only by this unit; neither the signals nor the insights rules may answer it.
const SituationRefreshKey = "/api/situation-monitor#refresh"

// WithSituationRefresh registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
func WithSituationRefresh(rules []Rule) []Rule {
	return appendExactKeyed(rules, SituationRefreshKey, "/api/situation-monitor/refresh", http.MethodPost)
}
