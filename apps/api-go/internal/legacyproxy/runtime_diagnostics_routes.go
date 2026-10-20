package legacyproxy

import "net/http"

// RuntimeDiagnosticsKey is the handler registration key for the two read-only
// runtime diagnostics routes. The platform governance group deliberately leaves
// /assistant-safety/diagnostics to the legacy proxy (see
// platform_governance_settings_routes.go), so this batch registers it under its
// own switch instead of widening that group's ownership.
const RuntimeDiagnosticsKey = "/api/system-settings#runtime-diagnostics"

// WithRuntimeDiagnostics takes over exactly two routes when mode is go:
//
//	GET /api/system-settings/assistant-safety/diagnostics
//	GET /api/system-settings/realtime-signals/runtime
//
// Both paths are longer than the exact platform governance /assistant-safety and
// data runtime /realtime-signals rules, so the matcher (longest prefix first)
// selects this exact rule even when those switches are also go. The data
// runtime group is not widened: /realtime-signals itself stays with its own
// switch.
func WithRuntimeDiagnostics(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, RuntimeDiagnosticsKey,
		"/api/system-settings/assistant-safety/diagnostics", http.MethodGet)
	return appendExactKeyed(rules, RuntimeDiagnosticsKey,
		"/api/system-settings/realtime-signals/runtime", http.MethodGet)
}
