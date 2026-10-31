package legacyproxy

import "net/http"

// SituationTelegramAuthKey is the handler registration key for the two
// situation-monitor Telegram login POSTs. It deliberately differs from the
// settings key so the settings handler (GET/PUT/DELETE) and the login handler
// (POST start/complete) can be wired and rolled out independently.
const SituationTelegramAuthKey = "/api/system-settings/situation-monitor#telegram-auth"

// WithSituationTelegramAuth takes over exactly two POST routes when mode is go:
//
//	POST /api/system-settings/situation-monitor/telegram-auth/start
//	POST /api/system-settings/situation-monitor/telegram-auth/complete
//
// The rule is exact and method-scoped, so every other method or sub-path on the
// same prefix (including the DELETE owned by API_GO_SITUATION_SETTINGS_MODE and
// POST external-snapshot/refresh) keeps its existing owner. The default (empty
// or legacy) adds no rule at all.
func WithSituationTelegramAuth(rules []Rule) []Rule {
	base := "/api/system-settings/situation-monitor/telegram-auth"
	rules = appendExactKeyed(rules, SituationTelegramAuthKey, base+"/start", http.MethodPost)
	return appendExactKeyed(rules, SituationTelegramAuthKey, base+"/complete", http.MethodPost)
}
