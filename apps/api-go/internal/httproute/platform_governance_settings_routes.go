package httproute

import "net/http"

// PlatformGovernanceSettingsKey is the handler registration key for the sixteen
// platform governance settings routes. It is deliberately different from
// RuntimeSettingsKey ("/api/system-settings") so the two switchable groups never
// share a handler: both may be set to go at the same time, and their paths do
// not overlap.
const PlatformGovernanceSettingsKey = "/api/system-settings#platform-governance"

// WithPlatformGovernanceSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
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
