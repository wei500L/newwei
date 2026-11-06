package httproute

import "net/http"

// SituationSettingsKey is the handler registration key for the four
// situation-monitor settings entries. It deliberately differs from the runtime
// settings prefix and from the situation-signals / situation-monitors keys so
// the three units never share a handler.
const SituationSettingsKey = "/api/system-settings/situation-monitor#settings"

// WithSituationSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/situation-monitor
//	PUT    /api/system-settings/situation-monitor
//	DELETE /api/system-settings/situation-monitor
//	DELETE /api/system-settings/situation-monitor/telegram-auth
func WithSituationSettings(rules []Rule) []Rule {
	base := "/api/system-settings/situation-monitor"
	rules = appendExactKeyed(rules, SituationSettingsKey, base+"/telegram-auth", http.MethodDelete)
	return appendExactKeyed(rules, SituationSettingsKey, base,
		http.MethodGet, http.MethodPut, http.MethodDelete)
}
