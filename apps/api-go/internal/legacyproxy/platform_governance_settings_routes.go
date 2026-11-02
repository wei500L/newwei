package legacyproxy

import "net/http"

// PlatformGovernanceSettingsKey is the handler registration key for the sixteen
// platform governance settings routes. It is deliberately different from
// RuntimeSettingsKey ("/api/system-settings") so the two switchable groups never
// share a handler: both may be set to go at the same time, and their paths do
// not overlap.
const PlatformGovernanceSettingsKey = "/api/system-settings#platform-governance"

// WithPlatformGovernanceSettings takes over the sixteen platform governance
// settings HTTP routes when mode is go:
//
//	GET    /api/system-settings/security
//	PUT    /api/system-settings/security
//	GET    /api/system-settings/assistant-quota
//	PUT    /api/system-settings/assistant-quota
//	DELETE /api/system-settings/assistant-quota
//	GET    /api/system-settings/assistant-safety
//	PUT    /api/system-settings/assistant-safety
//	DELETE /api/system-settings/assistant-safety
//	GET    /api/system-settings/assistant-safety/metrics
//	GET    /api/system-settings/task-logs
//	PUT    /api/system-settings/task-logs
//	DELETE /api/system-settings/task-logs
//	GET    /api/system-settings/llm-request-logs
//	PUT    /api/system-settings/llm-request-logs
//	DELETE /api/system-settings/llm-request-logs
//	POST   /api/system-settings/llm-request-logs/metadata-policy/reset
//
// Registration order and shape matter. A longer exact path must be declared
// before the path it extends so it can never be shadowed:
// /assistant-safety/metrics before /assistant-safety, and
// /llm-request-logs/metadata-policy/reset before /llm-request-logs.
//
// Everything else under /api/system-settings keeps falling back to NestJS,
// including GET /assistant-safety/diagnostics, the email, archive-preparation,
// realtime-signals, vector-service and situation-monitor groups, every
// unlisted method on the sixteen paths (for example POST /security) and any
// path with a trailing slash or an extra segment (for example /task-logs/x).
// The four situation-monitor settings entries (GET/PUT/DELETE on
// /api/system-settings/situation-monitor and DELETE on its /telegram-auth) are
// independent and owned by WithSituationSettings.
//
// An empty or legacy mode adds no rules at all, so the default deployment is
// unchanged and rollback only flips this one switch. The shared rule helper also
// whitelists OPTIONS for the taken-over paths, so CORS preflight is answered by
// the Go handler instead of reaching NestJS.
func WithPlatformGovernanceSettings(rules []Rule) []Rule {
	base := "/api/system-settings"

	// Longer exact paths are registered before the paths they extend.
	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/assistant-safety/metrics",
		http.MethodGet)
	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/llm-request-logs/metadata-policy/reset",
		http.MethodPost)

	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/security",
		http.MethodGet, http.MethodPut)
	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/assistant-quota",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/assistant-safety",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/task-logs",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	return appendExactKeyed(rules, PlatformGovernanceSettingsKey, base+"/llm-request-logs",
		http.MethodGet, http.MethodPut, http.MethodDelete)
}
