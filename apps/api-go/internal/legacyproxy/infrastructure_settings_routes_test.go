package legacyproxy

import (
	"net/http"
	"testing"
)

// infrastructureSettingsGoRoutes lists the seven routes (and their CORS
// preflight) the switch owns when it is go.
func infrastructureSettingsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/vector-service"},
		{http.MethodPut, "/api/system-settings/vector-service"},
		{http.MethodDelete, "/api/system-settings/vector-service"},
		{http.MethodGet, "/api/admin/settings/storage"},
		{http.MethodPatch, "/api/admin/settings/storage"},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets"},
		{http.MethodPut, "/api/system-settings/news-source-runtime-secrets"},
		{http.MethodOptions, "/api/system-settings/vector-service"},
		{http.MethodOptions, "/api/admin/settings/storage"},
		{http.MethodOptions, "/api/system-settings/news-source-runtime-secrets"},
	}
}

// infrastructureSettingsNestRoutes lists method/path pairs that must keep
// falling back to NestJS even when the switch is go.
func infrastructureSettingsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// The two deliberately unmigrated endpoints.
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodPost, "/api/admin/settings/storage/test"},
		// Unlisted methods on taken-over paths.
		{http.MethodHead, "/api/system-settings/vector-service"},
		{http.MethodPost, "/api/system-settings/vector-service"},
		{http.MethodPatch, "/api/system-settings/vector-service"},
		{http.MethodPost, "/api/system-settings/news-source-runtime-secrets"},
		{http.MethodDelete, "/api/system-settings/news-source-runtime-secrets"},
		{http.MethodPut, "/api/admin/settings/storage"},
		{http.MethodPost, "/api/admin/settings/storage"},
		{http.MethodDelete, "/api/admin/settings/storage"},
		// Trailing slashes and similar prefixes.
		{http.MethodGet, "/api/system-settings/vector-service/"},
		{http.MethodGet, "/api/system-settings/vector-service/extra"},
		{http.MethodGet, "/api/system-settings/vector-service-extra"},
		{http.MethodGet, "/api/admin/settings/storage/"},
		{http.MethodGet, "/api/admin/settings/storage-extra"},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets/"},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets/extra"},
		// Other settings endpoints.
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodGet, "/api/system-settings/rss-diagnostics/overview"},
	}
}

// TestInfrastructureSettingsStayLegacyByDefault locks the default and the
// explicit legacy value.
func TestInfrastructureSettingsStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithInfrastructureSettings(rules, "")
	rules = WithInfrastructureSettings(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(infrastructureSettingsGoRoutes(), infrastructureSettingsNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestInfrastructureSettingsGoOwnsRoutes locks the seven exact rules.
func TestInfrastructureSettingsGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithInfrastructureSettings(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range infrastructureSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != InfrastructureSettingsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
}

// TestInfrastructureSettingsUnmigratedRoutesStayNest locks every fallback.
func TestInfrastructureSettingsUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithInfrastructureSettings(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range infrastructureSettingsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestInfrastructureSettingsCoexistsWithRuntimeSettings locks rule attribution
// when both switches are go.
func TestInfrastructureSettingsCoexistsWithRuntimeSettings(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithRuntimeSettings(rules, string(ModeGo))
	rules = WithInfrastructureSettings(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	// The runtime settings switch must not have taken the new routes over.
	for _, tc := range infrastructureSettingsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != InfrastructureSettingsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
	// And the infrastructure switch must not have taken any runtime route over.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/rate-limits"},
		{http.MethodPut, "/api/system-settings/rate-limits"},
		{http.MethodGet, "/api/system-settings/news-source-scheduler"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != RuntimeSettingsKey {
			t.Fatalf("%s %s = %+v", tc.method, tc.path, got)
		}
	}
}
