package legacyproxy

import (
	"net/http"
	"testing"
)

// storageDiagnosticsGoRoutes lists the routes (and CORS preflight) the storage
// diagnostics switch owns when it is go.
func storageDiagnosticsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/admin/settings/storage/test"},
		{http.MethodOptions, "/api/admin/settings/storage/test"},
	}
}

// storageDiagnosticsNestRoutes lists method/path pairs that must keep falling
// back to NestJS even when the diagnostics switch is go.
func storageDiagnosticsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Unlisted methods on the taken-over path.
		{http.MethodGet, "/api/admin/settings/storage/test"},
		{http.MethodPut, "/api/admin/settings/storage/test"},
		{http.MethodPatch, "/api/admin/settings/storage/test"},
		{http.MethodDelete, "/api/admin/settings/storage/test"},
		{http.MethodHead, "/api/admin/settings/storage/test"},
		// The storage configuration routes stay under the infrastructure
		// switch.
		{http.MethodGet, "/api/admin/settings/storage"},
		{http.MethodPatch, "/api/admin/settings/storage"},
		// Trailing slashes and longer paths.
		{http.MethodPost, "/api/admin/settings/storage/test/"},
		{http.MethodPost, "/api/admin/settings/storage/test/extra"},
		{http.MethodPost, "/api/admin/settings/storage/"},
		{http.MethodPost, "/api/admin/settings/storage/test-extra"},
		// Neighbouring settings routes.
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodGet, "/api/system-settings/security"},
	}
}

// TestStorageDiagnosticsStayLegacyByDefault locks the default and the explicit
// legacy value.

// TestStorageDiagnosticsGoOwnsTestRoute locks the single exact rule.
func TestStorageDiagnosticsGoOwnsTestRoute(t *testing.T) {
	rules := BaseRules()
	rules = WithStorageDiagnostics(rules)
	gateway := New(rules)
	for _, tc := range storageDiagnosticsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != StorageDiagnosticsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
	}
	for _, tc := range storageDiagnosticsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestStorageDiagnosticsIsIndependentOfInfrastructureSettings locks the switch
// separation: the diagnostics switch never takes a configuration route over and
// the infrastructure switch never takes the test route over.
func TestStorageDiagnosticsIsIndependentOfInfrastructureSettings(t *testing.T) {
	// Diagnostics only: the seven configuration routes stay on NestJS.
	rules := BaseRules()
	rules = WithStorageDiagnostics(rules)
	gateway := New(rules)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/settings/storage"},
		{http.MethodPatch, "/api/admin/settings/storage"},
		{http.MethodGet, "/api/system-settings/vector-service"},
		{http.MethodPut, "/api/system-settings/news-source-runtime-secrets"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" || got.HandlerKey == StorageDiagnosticsKey {
			t.Fatalf("diagnostics switch took over %s %s: %+v", tc.method, tc.path, got)
		}
	}

	// Infrastructure only: the test route stays on NestJS.
	rules = BaseRules()
	rules = WithInfrastructureSettings(rules)
	gateway = New(rules)
	got := gateway.match(http.MethodPost, "/api/admin/settings/storage/test")
	if got.Prefix != "" || got.HandlerKey == StorageDiagnosticsKey {
		t.Fatalf("infrastructure switch took over the test route: %+v", got)
	}

	// Both go: each keeps its own route and handler key.
	rules = BaseRules()
	rules = WithInfrastructureSettings(rules)
	rules = WithStorageDiagnostics(rules)
	gateway = New(rules)
	test := gateway.match(http.MethodPost, "/api/admin/settings/storage/test")
	if test.Prefix == "" || test.HandlerKey != StorageDiagnosticsKey {
		t.Fatalf("both-go test route = %+v", test)
	}
	settings := gateway.match(http.MethodPatch, "/api/admin/settings/storage")
	if settings.Prefix == "" || settings.HandlerKey != InfrastructureSettingsKey {
		t.Fatalf("both-go configuration route = %+v", settings)
	}
}
