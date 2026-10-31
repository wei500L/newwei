package legacyproxy

import "net/http"

// SituationRefreshKey is the handler registration key for
// POST /api/situation-monitor/refresh. It is deliberately distinct from
// SituationSignalsKey and SituationInsightsKey: API_GO_SITUATION_REFRESH_MODE is
// an independent switch, so neither a signals rollout nor an insights rollout
// may answer the refresh path, and switching refresh back to legacy must not
// disturb the seven read routes.
const SituationRefreshKey = "/api/situation-monitor#refresh"

// WithSituationRefresh takes over exactly POST /api/situation-monitor/refresh
// when mode is go. The rule is exact and method-scoped, so:
//
//   - GET /api/situation-monitor/refresh-runs/:refreshId keeps its own rule
//     (owned by WithSituationSignals) and is unaffected;
//   - the seven signal routes, /insights, /monitors and the settings routes keep
//     their own switches;
//   - every other method on /refresh, a trailing slash and any longer path such
//     as /refresh/extra still fall back to NestJS.
//
// An empty or legacy mode adds no rules at all, so the default deployment is
// unchanged and rollback only flips this one variable. The shared rule helper
// whitelists OPTIONS for the taken-over path, so the CORS preflight is answered
// by the Go handler instead of reaching NestJS.
func WithSituationRefresh(rules []Rule) []Rule {
	return appendExactKeyed(rules, SituationRefreshKey, "/api/situation-monitor/refresh", http.MethodPost)
}
