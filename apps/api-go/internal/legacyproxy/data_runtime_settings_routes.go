package legacyproxy

import "net/http"

// DataRuntimeSettingsKey is the handler registration key for the nine data
// runtime settings and archive status routes. A single key is enough because the
// handler dispatches on the request path and method itself.
const DataRuntimeSettingsKey = "/api/system-settings#data-runtime"

// WithDataRuntimeSettings takes over the nine exact routes when mode is go:
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
// Every rule is an exact path with an explicit method whitelist, so nothing is
// registered for a whole prefix: HEAD, unlisted methods, trailing slashes,
// similar prefixes such as /api/system-settings/geo/nominatim-test and any longer
// path keep falling back to the legacy /api/ rule. An empty or legacy mode adds
// nothing, so the default deployment is unchanged and rollback only flips this one
// switch.
//
// The helper also whitelists OPTIONS for these paths, so a CORS preflight is
// answered by the Go handler instead of reaching NestJS; a non-preflight OPTIONS
// request is sent back to the proxy by the wiring.
//
// The routes that stay on NestJS even in go mode include
// POST /api/system-settings/geo/nominatim/test and POST /api/geo/geocode (real
// geocoding calls), and the archiveDigest / archiveCalendar / archiveDetail
// routes. The four situation-monitor settings entries belong to their own
// switch (WithSituationSettings) and the remaining situation-monitor sub-paths
// (telegram-auth/start, telegram-auth/complete, external-snapshot/refresh) stay
// on NestJS there as well.
func WithDataRuntimeSettings(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/realtime-signals",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/archive-preparation",
		http.MethodGet, http.MethodPut, http.MethodDelete)
	rules = appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/system-settings/geo/nominatim",
		http.MethodGet, http.MethodPut)
	return appendExactKeyed(rules, DataRuntimeSettingsKey, "/api/admin/archive-preparation/status",
		http.MethodGet)
}
