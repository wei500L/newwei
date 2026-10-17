package legacyproxy

import "net/http"

// RuntimeSettingsKey is the handler registration key for the seven platform
// runtime and governance settings domains. A single key is enough because the
// handler dispatches on the request path and method itself.
const RuntimeSettingsKey = "/api/system-settings"

// WithRuntimeSettings takes over the eighteen runtime/governance settings HTTP
// routes when mode is go:
//
//	GET    /api/system-settings/rate-limit-policies
//	POST   /api/system-settings/rate-limit-policies
//	GET    /api/system-settings/rate-limit-policies/:feature
//	PUT    /api/system-settings/rate-limit-policies/:feature
//	DELETE /api/system-settings/rate-limit-policies/:feature
//	GET    /api/system-settings/rate-limits
//	PUT    /api/system-settings/rate-limits
//	GET    /api/system-settings/auth-cache
//	PUT    /api/system-settings/auth-cache
//	GET    /api/system-settings/audit-log
//	PUT    /api/system-settings/audit-log
//	GET    /api/system-settings/multi-tenant-schedulers
//	PUT    /api/system-settings/multi-tenant-schedulers
//	GET    /api/system-settings/news-source-scheduler
//	PUT    /api/system-settings/news-source-scheduler
//	GET    /api/system-settings/newsnow-personalization
//	PUT    /api/system-settings/newsnow-personalization
//	GET    /api/system-settings/newsnow-personalization/metrics
//
// Registration order and shape matter. The metrics route is a longer exact
// path than the personalization settings route, so it must be declared before
// it to win the longest-prefix match; `:feature` is exactly one non-empty path
// segment, so `/rate-limit-policies` itself and any longer path never fall into
// the dynamic rule.
//
// Every other /api/system-settings route (security, email, task-logs,
// llm-gateways, vector-service, archive-preparation, assistant-quota,
// assistant-safety, ...) keeps falling back to the legacy /api/ prefix and is
// proxied to NestJS. An empty or legacy mode adds no rules at all, so the
// default deployment is unchanged and rollback only flips this one switch.
//
// The shared rule helpers also whitelist OPTIONS for the taken-over paths, so
// CORS preflight is answered by the Go handler instead of reaching NestJS.
func WithRuntimeSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	base := "/api/system-settings"

	// Static collection and singleton endpoints. Each exact path only accepts
	// the methods listed in the table above.
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/rate-limit-policies",
		http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/rate-limits",
		http.MethodGet, http.MethodPut)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/auth-cache",
		http.MethodGet, http.MethodPut)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/audit-log",
		http.MethodGet, http.MethodPut)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/multi-tenant-schedulers",
		http.MethodGet, http.MethodPut)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/news-source-scheduler",
		http.MethodGet, http.MethodPut)

	// The metrics route is registered before the settings route it extends so
	// that even an equal-length prefix ordering cannot shadow it.
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/newsnow-personalization/metrics",
		http.MethodGet)
	rules = appendExactKeyed(rules, RuntimeSettingsKey, base+"/newsnow-personalization",
		http.MethodGet, http.MethodPut)

	// `:feature` is exactly one non-empty path segment. PUT and DELETE share
	// the rule with GET because the handler discriminates on the method.
	return appendSegmentRule(rules, RuntimeSettingsKey, base+"/rate-limit-policies/",
		true, false, "", http.MethodGet, http.MethodPut, http.MethodDelete)
}
