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
	legacyRules := WithEmailSettings(DefaultRules(ModeShadow, ""), "legacy")
	legacyGateway, err := New("http://legacy:4000", legacyRules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(emailGoRoutes(), emailLegacyRoutes()...) {
		if got := legacyGateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("legacy: %s %s mode=%s", tc.method, tc.path, got.Mode)
		}
	}

	rules := WithEmailSettings(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range emailGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || !got.Exact || got.HandlerKey != EmailSettingsKey {
			t.Fatalf("go: %s %s => %+v", tc.method, tc.path, got)
		}
	}
	for _, tc := range emailLegacyRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("fallback: %s %s mode=%s", tc.method, tc.path, got.Mode)
		}
	}
}

func TestGeocodingRoutes(t *testing.T) {
	rules := WithGeocoding(DefaultRules(ModeShadow, ""), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []routeCase{
		{http.MethodPost, "/api/geo/geocode"},
		{http.MethodPost, "/api/system-settings/geo/nominatim/test"},
		{http.MethodOptions, "/api/geo/geocode"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != GeocodingKey {
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
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestRuntimeDiagnosticsRoutesWinOverNeighbouringGroups(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithPlatformGovernanceSettings(rules, string(ModeGo))
	rules = WithDataRuntimeSettings(rules, string(ModeGo))
	rules = WithRuntimeDiagnostics(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
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
		if got.Mode != ModeGo || got.HandlerKey != tc.key {
			t.Fatalf("%s => mode=%s key=%s, want go/%s", tc.path, got.Mode, got.HandlerKey, tc.key)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/system-settings/assistant-safety/diagnostics"); got.Mode != ModeLegacy {
		t.Fatalf("POST diagnostics mode=%s, want legacy", got.Mode)
	}
}
