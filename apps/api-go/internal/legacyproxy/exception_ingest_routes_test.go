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

func TestExceptionIngestGoOwnsTwoPosts(t *testing.T) {
	rules := BaseRules()
	rules = WithExceptionIngest(rules)
	gateway := New(rules)
	for _, tc := range exceptionIngestRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
	}
	for _, path := range []string{
		"/api/observability/exception-events/client",
		"/api/internal/observability/exception-events",
	} {
		if got := gateway.match(http.MethodOptions, path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Prefix)
		}
	}
}

func TestExceptionIngestUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithExceptionIngest(rules)
	gateway := New(rules)
	for _, tc := range exceptionIngestNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
