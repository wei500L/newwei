package httproute

import "net/http"

// DataRuntimeSettingsKey is the handler registration key for the nine data
// runtime settings and archive status routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const DataRuntimeSettingsKey = "/api/system-settings#data-runtime"

// WithDataRuntimeSettings registers the Go router rules for this unit. Every rule is
// method-scoped and registered unconditionally by the always-on Go router;
// a path, method or segment that no rule claims is answered with the
// unmatched-route 404 (the Nest-shaped contract). No request is proxied.
//
// Served routes:
//
//	GET    /api/system-settings/realtime-signals
//	PUT    /api/system-settings/realtime-signals
//	DELETE /api/system-settings/realtime-signals
//	GET    /api/system-settings/archive-preparation
//	PUT    /api/system-settings/archive-preparation
//	DELETE /api/system-settings/archive-preparation
//	GET    /api/admin/archive-preparation/status
//	GET    /api/system-settings/geo/nominatim
//	PUT    /api/system-settings/geo/nominatim
//
// POST /api/system-settings/geo/nominatim/test and POST /api/geo/geocode (real
func WithDataRuntimeSettings(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/realtime-signals",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/archive-preparation",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/geo/nominatim",
		http.MethodGet, http.MethodPut)
	return appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/admin/archive-preparation/status",
		http.MethodGet)
}
