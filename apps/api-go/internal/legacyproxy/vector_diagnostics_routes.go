package legacyproxy

import "net/http"

// VectorDiagnosticsHandlerKey is the Go handler registration key for the vector
// service diagnostics route. It equals the exact path, which is also the rule's
// Prefix: appendExactMethods leaves HandlerKey empty so the gateway falls back
// to the prefix, and registering with this constant therefore resolves the
// handler. The route has its own API_GO_VECTOR_DIAGNOSTICS_MODE switch and is
// deliberately not part of InfrastructureSettingsKey: taking over the seven
// configuration routes must not take over the diagnostics, and vice versa.
const VectorDiagnosticsHandlerKey = "/api/system-settings/vector-service/diagnostics"

// WithVectorDiagnostics takes over exactly one route when mode is go:
//
//	GET /api/system-settings/vector-service/diagnostics
//
// The rule is an exact path with an explicit GET whitelist (appendExactMethods
// also adds the shared OPTIONS whitelist so a CORS preflight is answered by the
// Go handler; a non-preflight OPTIONS is sent back to the proxy by the wiring).
// HEAD, POST/PUT/PATCH/DELETE, the trailing-slash form and every longer path
// keep falling back to the legacy /api/ rule. An empty or legacy mode adds
// nothing, so the default deployment is unchanged and rollback only flips this
// one switch.
func WithVectorDiagnostics(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	return appendExactMethods(rules, http.MethodGet, VectorDiagnosticsHandlerKey)
}
