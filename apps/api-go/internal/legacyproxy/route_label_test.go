package legacyproxy

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// TestGatewayRecordsABoundedRouteLabel proves the gateway hands the outer metrics
// middleware a bounded family for a request it routed, so http_request_duration_seconds
// has one series per route rather than one per URL.
func TestGatewayRecordsABoundedRouteLabel(t *testing.T) {
	gateway := New([]Rule{{Prefix: "/api/"}})
	gateway.RegisterGoHandler("/api/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	cases := []struct{ path, want string }{
		{"/api/items", "/api/items"},
		{"/api/items/507f1f77bcf86cd799439011", "/api/items"},
		{"/api/crawl-tasks/abc/logs?trace=secret-token", "/api/crawl-tasks"},
	}
	for _, testCase := range cases {
		t.Run(testCase.path, func(t *testing.T) {
			var label string
			// Drive the real middleware so the label is read exactly the way cmd/api
			// reads it.
			handler := httpx.MetricsMiddleware(gateway, func(observation httpx.HTTPObservation) {
				label = observation.Route
			})
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, testCase.path, nil))
			if label != testCase.want {
				t.Fatalf("label = %q, want %q", label, testCase.want)
			}
		})
	}
}

// TestGatewayRecordsUnmatchedForAnUnclaimedPath proves a path no rule claims reports the
// NestJS "unmatched" literal instead of its own family, so scanned paths such as
// /wp-admin or a random token cannot create a series.
func TestGatewayRecordsUnmatchedForAnUnclaimedPath(t *testing.T) {
	// Only the notification socket path is routed, so every other path is unclaimed.
	gateway := New([]Rule{{Prefix: "/socket.io-notifications"}})
	for _, path := range []string{"/", "/wp-admin", "/.env", "/random-token-abc123"} {
		t.Run(path, func(t *testing.T) {
			var label string
			handler := httpx.MetricsMiddleware(gateway, func(observation httpx.HTTPObservation) {
				label = observation.Route
			})
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
			if label != httpx.UnmatchedRouteLabel {
				t.Fatalf("label for %q = %q, want %q", path, label, httpx.UnmatchedRouteLabel)
			}
		})
	}
}

// TestMatchRuleDistinguishesDeclaredFromUnmatched pins the two return values the
// label depends on; the public match keeps its old signature and value.
func TestMatchRuleDistinguishesDeclaredFromUnmatched(t *testing.T) {
	gateway := New([]Rule{
		{Prefix: "/api/"},
		{Prefix: "/api/items", Exact: true, Methods: map[string]bool{http.MethodPost: true}},
	})
	if rule, matched := gateway.matchRule(http.MethodPost, "/api/items"); !matched || rule.Prefix != "/api/items" {
		t.Fatalf("POST /api/items = (%+v, %v), want the exact POST rule", rule, matched)
	}
	// The declared /api/ prefix still matches, so this is matched: the family
	// label applies, which is what keeps the series comparable.
	if rule, matched := gateway.matchRule(http.MethodGet, "/api/items"); !matched || rule.Prefix != "/api/" {
		t.Fatalf("GET /api/items = (%+v, %v), want the /api/ prefix rule", rule, matched)
	}
	if rule, matched := gateway.matchRule(http.MethodGet, "/nope"); matched {
		t.Fatalf("GET /nope = (%+v, %v), want no match", rule, matched)
	}
	// match keeps returning the same rule as before for both cases.
	if got := gateway.match(http.MethodGet, "/api/items"); got.Prefix != "/api/" {
		t.Fatalf("match GET /api/items prefix = %q, want /api/", got.Prefix)
	}
	if got := gateway.match(http.MethodGet, "/nope"); got.Prefix != "" {
		t.Fatalf("match GET /nope prefix = %q, want the zero rule", got.Prefix)
	}
}
