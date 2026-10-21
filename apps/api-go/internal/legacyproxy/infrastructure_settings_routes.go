package legacyproxy

import "net/http"

// InfrastructureSettingsKey is the handler registration key for the seven
// infrastructure connection and crawl-credential settings routes. A single key
// is enough because the handler dispatches on the request path and method
// itself.
const InfrastructureSettingsKey = "/api/system-settings#infrastructure"

// WithInfrastructureSettings takes over the seven exact routes when mode is go:
//
//	GET    /api/system-settings/vector-service
//	PUT    /api/system-settings/vector-service
//	DELETE /api/system-settings/vector-service
//	GET    /api/admin/settings/storage
//	PATCH  /api/admin/settings/storage
//	GET    /api/system-settings/news-source-runtime-secrets
//	PUT    /api/system-settings/news-source-runtime-secrets
//
// Every rule is an exact path with an explicit method whitelist, so nothing is
// registered for a whole prefix: HEAD, unlisted methods, trailing slashes,
// similar prefixes and any longer path keep falling back to the legacy /api/
// rule. An empty or legacy mode adds nothing, so the default deployment is
// unchanged and rollback only flips this one switch.
//
// The routes that stay outside this switch even in go mode include
// GET /api/system-settings/vector-service/diagnostics (its own
// API_GO_VECTOR_DIAGNOSTICS_MODE, see WithVectorDiagnostics) and
// POST /api/admin/settings/storage/test (real S3 calls, its own
// API_GO_STORAGE_DIAGNOSTICS_MODE, see WithStorageDiagnostics).
//
// The shared rule helper also whitelists OPTIONS for these paths, so CORS
// preflight is answered by the Go handler instead of reaching NestJS; a
// non-preflight OPTIONS request is sent back to the proxy by the wiring.
func WithInfrastructureSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, InfrastructureSettingsKey, "/api/system-settings/vector-service",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, InfrastructureSettingsKey, "/api/system-settings/news-source-runtime-secrets",
		http.MethodGet, http.MethodPut)
	return appendExactKeyed(rules, InfrastructureSettingsKey, "/api/admin/settings/storage",
		http.MethodGet, http.MethodPatch)
}
