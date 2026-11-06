package httproute

import "net/http"

// VectorDiagnosticsHandlerKey is the Go handler registration key for the vector
// service diagnostics route. It equals the exact path, which is also the rule's
// Prefix: appendExactMethods leaves HandlerKey empty so the gateway falls back
// to the prefix, and registering with this constant therefore resolves the
// handler. The route has its own API_GO_VECTOR_DIAGNOSTICS_MODE switch and is
// deliberately not part of InfrastructureSettingsKey: taking over the seven
// configuration routes must not take over the diagnostics, and vice versa.
const VectorDiagnosticsHandlerKey = "/api/system-settings/vector-service/diagnostics"

// WithVectorDiagnostics registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET /api/system-settings/vector-service/diagnostics
func WithVectorDiagnostics(rules []Rule) []Rule {
	return appendExactMethods(rules, http.MethodGet, VectorDiagnosticsHandlerKey)
}
