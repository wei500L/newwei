package httproute

import "net/http"

// RuntimeDiagnosticsKey is the handler registration key for the two read-only
// runtime diagnostics routes. The platform governance group deliberately leaves
// /assistant-safety/diagnostics unclaimed (see
// platform_governance_settings_routes.go), so this unit registers it instead of
// widening that group's ownership.
const RuntimeDiagnosticsKey = "/api/system-settings#runtime-diagnostics"

// WithRuntimeDiagnostics registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET /api/system-settings/assistant-safety/diagnostics
//	GET /api/system-settings/realtime-signals/runtime
func WithRuntimeDiagnostics(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, RuntimeDiagnosticsKey,
		"/api/system-settings/assistant-safety/diagnostics", http.MethodGet)
	return appendExactKeyed(rules, RuntimeDiagnosticsKey,
		"/api/system-settings/realtime-signals/runtime", http.MethodGet)
}
