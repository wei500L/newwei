package httproute

import "net/http"

// EmailSettingsKey is the handler registration key for the three email settings
// routes. It is independent of every other /api/system-settings group.
const EmailSettingsKey = "/api/system-settings/email#email-settings"

// WithEmailSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET  /api/system-settings/email
//	PUT  /api/system-settings/email/auth-code
//	POST /api/system-settings/email/test
func WithEmailSettings(rules []Rule) []Rule {
	const base = "/api/system-settings/email"
	rules = appendExactKeyed(rules, EmailSettingsKey, base+"/auth-code", http.MethodPut)
	rules = appendExactKeyed(rules, EmailSettingsKey, base+"/test", http.MethodPost)
	return appendExactKeyed(rules, EmailSettingsKey, base, http.MethodGet)
}
