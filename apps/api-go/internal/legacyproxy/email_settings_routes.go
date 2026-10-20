package legacyproxy

import "net/http"

// EmailSettingsKey is the handler registration key for the three email settings
// routes. It is independent of every other /api/system-settings group.
const EmailSettingsKey = "/api/system-settings/email#email-settings"

// WithEmailSettings takes over exactly three routes when mode is go:
//
//	GET  /api/system-settings/email
//	PUT  /api/system-settings/email/auth-code
//	POST /api/system-settings/email/test
//
// Each rule is an exact path with an explicit method whitelist (plus OPTIONS for
// CORS preflight), so HEAD, other methods on the same path, the trailing-slash
// form and longer paths keep falling back to the legacy /api/ rule. The longer
// /auth-code and /test paths are registered after their common prefix but the
// matcher sorts by prefix length, so neither can be shadowed by the GET rule.
//
// An empty or legacy mode adds nothing, so the default deployment is unchanged.
func WithEmailSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	const base = "/api/system-settings/email"
	rules = appendExactKeyed(rules, EmailSettingsKey, base+"/auth-code", http.MethodPut)
	rules = appendExactKeyed(rules, EmailSettingsKey, base+"/test", http.MethodPost)
	return appendExactKeyed(rules, EmailSettingsKey, base, http.MethodGet)
}
