package legacyproxy

import (
	"net/http"
	"testing"
)

// vectorDiagnosticsGoRoutes lists the routes (and CORS preflight) the switch
// owns when it is go.
func vectorDiagnosticsGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodOptions, "/api/system-settings/vector-service/diagnostics"},
	}
}

// vectorDiagnosticsNestRoutes lists method/path pairs that must keep falling
// back to NestJS even when the diagnostics switch is go.
func vectorDiagnosticsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// Unlisted methods on the taken-over path.
		{http.MethodPost, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodPut, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodPatch, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodDelete, "/api/system-settings/vector-service/diagnostics"},
		{http.MethodHead, "/api/system-settings/vector-service/diagnostics"},
		// Trailing slashes and longer/similar paths.
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics/"},
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics/extra"},
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics-extra"},
		// The seven configuration routes stay under their own switch.
		{http.MethodGet, "/api/system-settings/vector-service"},
		{http.MethodPut, "/api/system-settings/vector-service"},
		{http.MethodDelete, "/api/system-settings/vector-service"},
		{http.MethodGet, "/api/admin/settings/storage"},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets"},
		// Neighbouring settings diagnostics.
		{http.MethodGet, "/api/system-settings/security"},
		{http.MethodGet, "/api/system-settings/rss-diagnostics/overview"},
	}
}

// TestVectorDiagnosticsStayLegacyByDefault locks the default, the empty value
// and the explicit legacy value: no rule may be added.
func TestVectorDiagnosticsStayLegacyByDefault(t *testing.T) {
	base := DefaultRules(ModeShadow, "")
	rules := WithVectorDiagnostics(base, "")
	rules = WithVectorDiagnostics(rules, "legacy")
	if len(rules) != len(base) {
		t.Fatalf("legacy mode added %d rule(s)", len(rules)-len(base))
	}
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(vectorDiagnosticsGoRoutes(), vectorDiagnosticsNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestVectorDiagnosticsGoOwnsExactGET locks the single exact GET rule (plus the
// shared OPTIONS rule) and the handler-key resolution.
func TestVectorDiagnosticsGoOwnsExactGET(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithVectorDiagnostics(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range vectorDiagnosticsGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact {
			t.Fatalf("%s %s must be an exact rule: %+v", tc.method, tc.path, got)
		}
		if got.Prefix != VectorDiagnosticsHandlerKey {
			t.Fatalf("%s %s prefix=%s, want %s", tc.method, tc.path, got.Prefix, VectorDiagnosticsHandlerKey)
		}
	}
	for _, tc := range vectorDiagnosticsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}

	// The registration key equals the rule prefix, so RegisterGoHandler with
	// VectorDiagnosticsHandlerKey resolves the handler for the exact GET/OPTIONS
	// rules.
	gateway.RegisterGoHandler(VectorDiagnosticsHandlerKey, func(http.ResponseWriter, *http.Request) {})
	for _, tc := range vectorDiagnosticsGoRoutes() {
		rule := gateway.match(tc.method, tc.path)
		key := rule.Prefix
		if rule.HandlerKey != "" {
			key = rule.HandlerKey
		}
		if got := gateway.matchGoHandler(key); got == nil {
			t.Fatalf("%s %s handler not found for key %q", tc.method, tc.path, key)
		}
	}
}

// TestVectorDiagnosticsIsIndependentOfInfrastructureSettings locks the switch
// separation: neither switch may take over the other unit's routes.
func TestVectorDiagnosticsIsIndependentOfInfrastructureSettings(t *testing.T) {
	// Diagnostics only: the configuration routes stay on NestJS.
	rules := DefaultRules(ModeShadow, "")
	rules = WithVectorDiagnostics(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/system-settings/vector-service"},
		{http.MethodPut, "/api/system-settings/vector-service"},
		{http.MethodDelete, "/api/system-settings/vector-service"},
		{http.MethodGet, "/api/admin/settings/storage"},
		{http.MethodGet, "/api/system-settings/news-source-runtime-secrets"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("diagnostics switch took over %s %s: %+v", tc.method, tc.path, got)
		}
	}

	// Infrastructure settings only: the diagnostics route stays on NestJS.
	rules = DefaultRules(ModeShadow, "")
	rules = WithInfrastructureSettings(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	got := gateway.match(http.MethodGet, VectorDiagnosticsHandlerKey)
	if got.Mode != ModeLegacy {
		t.Fatalf("infrastructure switch took over the diagnostics route: %+v", got)
	}

	// Both go: each keeps its own route and mode.
	rules = DefaultRules(ModeShadow, "")
	rules = WithInfrastructureSettings(rules, string(ModeGo))
	rules = WithVectorDiagnostics(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics := gateway.match(http.MethodGet, VectorDiagnosticsHandlerKey)
	if diagnostics.Mode != ModeGo || diagnostics.Prefix != VectorDiagnosticsHandlerKey {
		t.Fatalf("both-go diagnostics route = %+v", diagnostics)
	}
	settings := gateway.match(http.MethodGet, "/api/system-settings/vector-service")
	if settings.Mode != ModeGo || settings.HandlerKey != InfrastructureSettingsKey {
		t.Fatalf("both-go configuration route = %+v", settings)
	}
}
