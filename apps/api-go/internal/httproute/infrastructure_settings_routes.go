package httproute

import "net/http"

// InfrastructureSettingsKey is the handler registration key for the seven
// infrastructure connection and crawl-credential settings routes. A single key
// is enough because the handler dispatches on the request path and method
// itself.
const InfrastructureSettingsKey = "/api/system-settings#infrastructure"

// WithInfrastructureSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/vector-service
//	PUT    /api/system-settings/vector-service
//	DELETE /api/system-settings/vector-service
//	GET    /api/admin/settings/storage
//	PATCH  /api/admin/settings/storage
//	GET    /api/system-settings/news-source-runtime-secrets
//	PUT    /api/system-settings/news-source-runtime-secrets
//
// GET /api/system-settings/vector-service/diagnostics (its own
// POST /api/admin/settings/storage/test (real S3 calls, its own
func WithInfrastructureSettings(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, InfrastructureSettingsKey, "/api/system-settings/vector-service",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, InfrastructureSettingsKey, "/api/system-settings/news-source-runtime-secrets",
		http.MethodGet, http.MethodPut)
	return appendExactKeyed(rules, InfrastructureSettingsKey, "/api/admin/settings/storage",
		http.MethodGet, http.MethodPatch)
}
