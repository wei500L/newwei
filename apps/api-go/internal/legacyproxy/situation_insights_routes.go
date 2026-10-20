package legacyproxy

import "net/http"

// SituationInsightsKey is the handler registration key for the situation
// monitor insights read. It is deliberately distinct from SituationSignalsKey
// and SituationMonitorsKey: the three switches are independent.
const SituationInsightsKey = "/api/situation-monitor/insights"

// WithSituationInsights takes over exactly GET /api/situation-monitor/insights
// when mode is go. The rule is exact and method-scoped, so:
//
//   - the longer monitors routes remain owned by WithSituationMonitors;
//   - the seven signal routes remain owned by WithSituationSignals;
//   - POST /refresh, the settings routes and every longer path still fall back
//     to NestJS under the shared /api/ prefix.
//
// Sorting by prefix length means the exact insights rule wins over /api/, and
// no existing rule shares this prefix.
func WithSituationInsights(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactKeyed(rules, SituationInsightsKey, "/api/situation-monitor/insights", http.MethodGet)
}
