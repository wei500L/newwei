package legacyproxy

import (
	"net/http"
	"testing"
)

type routeCase struct {
	method string
	path   string
}

func emailGoRoutes() []routeCase {
	return []routeCase{
		{http.MethodGet, "/api/system-settings/email"},
		{http.MethodPut, "/api/system-settings/email/auth-code"},
		{http.MethodPost, "/api/system-settings/email/test"},
		{http.MethodOptions, "/api/system-settings/email"},
		{http.MethodOptions, "/api/system-settings/email/auth-code"},
		{http.MethodOptions, "/api/system-settings/email/test"},
	}
}

func emailLegacyRoutes() []routeCase {
	return []routeCase{
		{http.MethodPost, "/api/system-settings/email"},
		{http.MethodGet, "/api/system-settings/email/auth-code"},
		{http.MethodPut, "/api/system-settings/email/test"},
		{http.MethodGet, "/api/system-settings/email/"},
		{http.MethodGet, "/api/system-settings/email/extra"},
		{http.MethodGet, "/api/system-settings/emailx"},
	}
}

func TestEmailSettingsRoutes(t *testing.T) {
	rules := WithEmailSettings(BaseRules())
	gateway := New(rules)
	for _, tc := range emailGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || !got.Exact || got.HandlerKey != EmailSettingsKey {
			t.Fatalf("go: %s %s => %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range emailLegacyRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("fallback: %s %s mode=%s", tc.method, tc.path, got.Prefix)
		}
	}
}

func TestGeocodingRoutes(t *testing.T) {
	rules := WithGeocoding(BaseRules())
	gateway := New(rules)
	for _, tc := range []routeCase{
		{http.MethodPost, "/api/geo/geocode"},
		{http.MethodPost, "/api/system-settings/geo/nominatim/test"},
		{http.MethodOptions, "/api/geo/geocode"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != GeocodingKey {
			t.Fatalf("%s %s => %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range []routeCase{
		{http.MethodGet, "/api/geo/geocode"},
		{http.MethodGet, "/api/system-settings/geo/nominatim/test"},
		{http.MethodPost, "/api/system-settings/geo/nominatim"},
		{http.MethodPut, "/api/system-settings/geo/nominatim"},
		{http.MethodPost, "/api/system-settings/geo/nominatim/test/"},
		{http.MethodPost, "/api/geo/geocode/extra"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

func TestRuntimeDiagnosticsRoutesWinOverNeighbouringGroups(t *testing.T) {
	rules := BaseRules()
	rules = WithPlatformGovernanceSettings(rules)
	rules = WithDataRuntimeSettings(rules)
	rules = WithRuntimeDiagnostics(rules)
	gateway := New(rules)
	overlaps := []struct {
		path string
		key  string
	}{
		{"/api/system-settings/assistant-safety/diagnostics", RuntimeDiagnosticsKey},
		{"/api/system-settings/assistant-safety", PlatformGovernanceSettingsKey},
		{"/api/system-settings/realtime-signals/runtime", RuntimeDiagnosticsKey},
		{"/api/system-settings/realtime-signals", DataRuntimeSettingsKey},
	}
	for _, tc := range overlaps {
		got := gateway.match(http.MethodGet, tc.path)
		if got.Prefix == "" || got.HandlerKey != tc.key {
			t.Fatalf("%s => mode=%s key=%s, want go/%s", tc.path, got.Prefix, got.HandlerKey, tc.key)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/system-settings/assistant-safety/diagnostics"); got.Prefix != "" {
		t.Fatalf("POST diagnostics mode=%s, want legacy", got.Prefix)
	}
}
