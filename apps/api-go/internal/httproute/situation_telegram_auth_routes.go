package httproute

import "net/http"

// SituationTelegramAuthKey is the handler registration key for the two
// situation-monitor Telegram login POSTs. It deliberately differs from the
// settings key so the settings handler (GET/PUT/DELETE) and the login handler
// (POST start/complete) can be wired and rolled out independently.
const SituationTelegramAuthKey = "/api/system-settings/situation-monitor#telegram-auth"

// WithSituationTelegramAuth registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	POST /api/system-settings/situation-monitor/telegram-auth/start
//	POST /api/system-settings/situation-monitor/telegram-auth/complete
func WithSituationTelegramAuth(rules []Rule) []Rule {
	base := "/api/system-settings/situation-monitor/telegram-auth"
	rules = appendExactKeyed(rules, SituationTelegramAuthKey, base+"/start", http.MethodPost)
	return appendExactKeyed(rules, SituationTelegramAuthKey, base+"/complete", http.MethodPost)
}
