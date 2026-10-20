package legacyproxy

import "net/http"

// SituationSettingsKey is the handler registration key for the four
// situation-monitor settings entries. It deliberately differs from the runtime
// settings prefix and from the situation-signals / situation-monitors keys so
// the three units never share a handler.
const SituationSettingsKey = "/api/system-settings/situation-monitor#settings"

// WithSituationSettings takes over the four situation-monitor settings HTTP
// routes when mode is go:
//
//	GET    /api/system-settings/situation-monitor
//	PUT    /api/system-settings/situation-monitor
//	DELETE /api/system-settings/situation-monitor
//	DELETE /api/system-settings/situation-monitor/telegram-auth
//
// The longer telegram-auth exact path is registered first. POST
// telegram-auth/start, POST telegram-auth/complete, POST external-snapshot/refresh
// and every other sub-path or method stay on NestJS, because no exact rule
// matches them and they fall back to the legacy /api/ proxy. The default
// (empty or legacy) adds no rules at all.
func WithSituationSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	base := "/api/system-settings/situation-monitor"
	rules = appendExactKeyed(rules, SituationSettingsKey, base+"/telegram-auth", http.MethodDelete)
	return appendExactKeyed(rules, SituationSettingsKey, base,
		http.MethodGet, http.MethodPut, http.MethodDelete)
}
