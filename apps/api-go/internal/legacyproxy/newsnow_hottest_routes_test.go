package legacyproxy

import (
	"net/http"
	"testing"
)

// TestNewsnowHottestStayLegacyByDefault pins the empty/legacy behaviour: no rule
// is appended and both authenticated routes keep flowing to NestJS.

// TestNewsnowHottestGoOwnsTwoExactRoutes checks the exact paths, the GET method
// whitelist and OPTIONS preflight.
func TestNewsnowHottestGoOwnsTwoExactRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsnowHottest(rules)
	gateway := New(rules)
	for _, path := range []string{"/api/news-aggregator/hottest-analysis", "/api/news-aggregator/recommended"} {
		got := gateway.match(http.MethodGet, path)
		if got.Prefix == "" {
			t.Fatalf("GET %s mode=%s, want go", path, got.Prefix)
		}
		if got.HandlerKey != NewsnowHottestKey {
			t.Fatalf("GET %s key=%s, want %s", path, got.HandlerKey, NewsnowHottestKey)
		}
		if option := gateway.match(http.MethodOptions, path); option.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", path, option.Prefix)
		}
		if other := gateway.match(http.MethodPost, path); other.Prefix != "" {
			t.Fatalf("POST %s must not be owned by the hottest unit", path)
		}
	}
}

// TestNewsnowHottestDoesNotShadowOtherNewsnowRoutes runs the three independent
// NewsNow switches together and proves each path keeps its own handler key.
func TestNewsnowHottestDoesNotShadowOtherNewsnowRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsnowSources(rules)
	rules = WithNewsnowClusteringOps(rules)
	rules = WithNewsnowHottest(rules)
	gateway := New(rules)
	cases := []struct {
		method, path, key string
	}{
		{http.MethodGet, "/api/news-aggregator/hottest-analysis", NewsnowHottestKey},
		{http.MethodGet, "/api/news-aggregator/recommended", NewsnowHottestKey},
		{http.MethodGet, "/api/news-aggregator/source", NewsnowSourcesKey},
		{http.MethodPost, "/api/news-aggregator/sources/batch", NewsnowSourcesKey},
		{http.MethodGet, "/api/news-aggregator/metadata", NewsnowClusteringOpsKey},
		{http.MethodGet, "/api/news-aggregator/resolve", NewsnowClusteringOpsKey},
		{http.MethodPost, "/api/news-aggregator/sources/order", NewsnowClusteringOpsKey},
		{http.MethodGet, "/api/news-aggregator/domestic-opinion-index", NewsnowClusteringOpsKey},
	}
	for _, tc := range cases {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != tc.key {
			t.Fatalf("%s %s mode=%s key=%s, want go/%s", tc.method, tc.path, got.Prefix, got.HandlerKey, tc.key)
		}
	}
	// A sibling path and the plural sources path must never reach the hot
	// handler.
	for _, path := range []string{
		"/api/news-aggregator/hottest-analysis/export",
		"/api/news-aggregator/recommended/extra",
		"/api/news-aggregator/sources",
	} {
		if got := gateway.match(http.MethodGet, path); got.HandlerKey == NewsnowHottestKey {
			t.Fatalf("GET %s must not map to the hottest handler", path)
		}
	}
}
