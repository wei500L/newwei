package legacyproxy

import (
	"net/http"
	"testing"
)

// dataRuntimeSettingsGoRoutes lists the nine routes (and their CORS preflight)
// the switch owns when it is go.
func dataRuntimeSettingsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/realtime-signals"},
		{http.MethodPut, "/api/system-settings/realtime-signals"},
		{http.MethodDelete, "/api/system-settings/realtime-signals"},
		{http.MethodGet, "/api/system-settings/archive-preparation"},
		{http.MethodPut, "/api/system-settings/archive-preparation"},
		{http.MethodDelete, "/api/system-settings/archive-preparation"},
		{http.MethodGet, "/api/admin/archive-preparation/status"},
		{http.MethodGet, "/api/system-settings/geo/nominatim"},
		{http.MethodPut, "/api/system-settings/geo/nominatim"},
		{http.MethodOptions, "/api/system-settings/realtime-signals"},
		{http.MethodOptions, "/api/system-settings/archive-preparation"},
		{http.MethodOptions, "/api/admin/archive-preparation/status"},
		{http.MethodOptions, "/api/system-settings/geo/nominatim"},
	}
}

// dataRuntimeSettingsNestRoutes lists method/path pairs that must keep falling
// back to NestJS even when the switch is go.
func dataRuntimeSettingsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// The deliberately unmigrated neighbours of the taken-over paths.
		{http.MethodPost, "/api/system-settings/geo/nominatim/test"},
		{http.MethodPost, "/api/geo/geocode"},
		{http.MethodGet, "/api/system-settings/situation-monitor"},
		{http.MethodPost, "/api/system-settings/situation-monitor/external-snapshot/refresh"},
		{http.MethodGet, "/api/admin/archive-preparation"},
		{http.MethodPost, "/api/admin/archive-preparation/status"},
		// Unlisted methods on taken-over paths.
		{http.MethodHead, "/api/system-settings/realtime-signals"},
		{http.MethodPost, "/api/system-settings/realtime-signals"},
		{http.MethodPatch, "/api/system-settings/realtime-signals"},
		{http.MethodHead, "/api/system-settings/archive-preparation"},
		{http.MethodPost, "/api/system-settings/archive-preparation"},
		{http.MethodPatch, "/api/system-settings/archive-preparation"},
		{http.MethodDelete, "/api/system-settings/geo/nominatim"},
		{http.MethodPost, "/api/system-settings/geo/nominatim"},
		{http.MethodPut, "/api/admin/archive-preparation/status"},
		// Trailing slashes, longer paths and similar prefixes.
		{http.MethodGet, "/api/system-settings/realtime-signals/"},
		{http.MethodGet, "/api/system-settings/realtime-signals/extra"},
		{http.MethodGet, "/api/system-settings/realtime-signals-extra"},
		{http.MethodGet, "/api/system-settings/archive-preparation/"},
		{http.MethodGet, "/api/system-settings/archive-preparation-extra"},
		{http.MethodGet, "/api/system-settings/geo/nominatim/"},
		{http.MethodGet, "/api/system-settings/geo/nominatim-extra"},
		{http.MethodGet, "/api/admin/archive-preparation/status/"},
		{http.MethodGet, "/api/admin/archive-preparation/status/extra"},
		// Other settings endpoints.
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodGet, "/api/system-settings/vector-service"},
	}
}

// TestDataRuntimeSettingsStayLegacyByDefault locks the default and the explicit
// legacy value.

// TestDataRuntimeSettingsGoOwnsRoutes locks the nine exact rules.
func TestDataRuntimeSettingsGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithDataRuntimeSettings(rules)
	gateway := New(rules)
	for _, tc := range dataRuntimeSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != DataRuntimeSettingsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

// TestDataRuntimeSettingsUnmigratedRoutesStayNest locks every fallback.
func TestDataRuntimeSettingsUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithDataRuntimeSettings(rules)
	gateway := New(rules)
	for _, tc := range dataRuntimeSettingsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestDataRuntimeSettingsCoexistsWithOtherSwitches locks rule attribution when
// every settings switch is go at the same time.
func TestDataRuntimeSettingsCoexistsWithOtherSwitches(t *testing.T) {
	rules := BaseRules()
	rules = WithRuntimeSettings(rules)
	rules = WithInfrastructureSettings(rules)
	rules = WithDataRuntimeSettings(rules)
	gateway := New(rules)
	// Neither of the other switches may have taken a data runtime route over.
	for _, tc := range dataRuntimeSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != DataRuntimeSettingsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	// And this switch must not have taken any of theirs over.
	for _, tc := range []struct{ method, path, key string }{
		{http.MethodGet, "/api/system-settings/rate-limits", RuntimeSettingsKey},
		{http.MethodPut, "/api/system-settings/rate-limits", RuntimeSettingsKey},
		{http.MethodGet, "/api/system-settings/news-source-scheduler", RuntimeSettingsKey},
		{http.MethodGet, "/api/system-settings/vector-service", InfrastructureSettingsKey},
		{http.MethodDelete, "/api/system-settings/vector-service", InfrastructureSettingsKey},
		{http.MethodGet, "/api/admin/settings/storage", InfrastructureSettingsKey},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets", InfrastructureSettingsKey},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != tc.key {
			t.Fatalf("%s %s = %+v, want key %s", tc.method, tc.path, got, tc.key)
		}
	}
}
