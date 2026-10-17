package legacyproxy

import (
	"net/http"
	"testing"
)

// exceptionIngestRoutes are the two POST paths the switch owns.
func exceptionIngestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/observability/exception-events/client"},
		{http.MethodPost, "/api/internal/observability/exception-events"},
	}
}

// exceptionIngestNestRoutes must keep falling through to NestJS (Go never
// answers its own 404).
func exceptionIngestNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/observability/exception-events/client"},
		{http.MethodGet, "/api/internal/observability/exception-events"},
		{http.MethodPost, "/api/observability/exception-events/clients"},
		{http.MethodPost, "/api/observability/exception-events"},
		{http.MethodPost, "/api/observability/exception-events/client/extra"},
		{http.MethodPost, "/api/internal/observability/exception-events/extra"},
	}
}

func TestExceptionIngestStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithExceptionIngest(rules, "")
	rules = WithExceptionIngest(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(exceptionIngestRoutes(), exceptionIngestNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestExceptionIngestGoOwnsTwoPosts(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithExceptionIngest(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range exceptionIngestRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
	}
	for _, path := range []string{
		"/api/observability/exception-events/client",
		"/api/internal/observability/exception-events",
	} {
		if got := gateway.match(http.MethodOptions, path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Mode)
		}
	}
}

func TestExceptionIngestUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithExceptionIngest(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range exceptionIngestNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
