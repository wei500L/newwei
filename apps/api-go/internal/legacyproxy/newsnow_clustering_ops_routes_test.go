package legacyproxy

import (
	"net/http"
	"testing"
)

// newsnowClusteringOpsRoutes is the exact set of routes the Go takeover must
// own when API_GO_NEWSNOW_CLUSTERING_OPS_MODE=go.
func newsnowClusteringOpsRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/news-aggregator/metadata"},
		{http.MethodGet, "/api/news-aggregator/resolve"},
		{http.MethodPost, "/api/news-aggregator/sources/order"},
		{http.MethodGet, "/api/news-aggregator/domestic-opinion-index"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/readiness"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/overview"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/vector-backfill"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/ignore"},
	}
}

// newsnowClusteringOpsNestRoutes lists everything that must keep falling back to
// NestJS even while the takeover is on: the four source-fetching NewsNow
// endpoints, the BullMQ-backed llm-backfill, wrong methods, sibling and longer
// paths. Go must never answer its own 404 for these.
func newsnowClusteringOpsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// NewsNow endpoints that fetch external sources stay on NestJS.
		{http.MethodGet, "/api/news-aggregator/source"},
		{http.MethodPost, "/api/news-aggregator/sources/batch"},
		{http.MethodGet, "/api/news-aggregator/hottest-analysis"},
		{http.MethodGet, "/api/news-aggregator/recommended"},
		// LLM backfill enqueues a BullMQ job and stays on NestJS.
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill"},
		// Only the listed methods are taken over.
		{http.MethodPost, "/api/news-aggregator/metadata"},
		{http.MethodGet, "/api/news-aggregator/sources/order"},
		{http.MethodPut, "/api/news-aggregator/domestic-opinion-index"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/overview"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures/group-1/ignore"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures/group-1/vector-backfill"},
		// Sibling, parent and longer paths must not be swallowed.
		{http.MethodGet, "/api/news-aggregator/"},
		{http.MethodGet, "/api/news-aggregator"},
		{http.MethodGet, "/api/news-aggregator/metadata/extra"},
		{http.MethodGet, "/api/news-aggregator/unknown"},
		{http.MethodGet, "/api/news-aggregator/domestic-opinion-index/extra"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures/group-1"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures/group-1/ignored"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/ignore/extra"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/a/b/ignore"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures//ignore"},
		{http.MethodGet, "/api/system-settings/news-events/clustering/unknown"},
		// Other switches own their own prefixes.
		{http.MethodGet, "/api/system-settings/newsnow-personalization"},
		{http.MethodGet, "/api/admin/quality/overview"},
	}
}

func TestNewsnowClusteringOpsStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowClusteringOps(rules, "")
	rules = WithNewsnowClusteringOps(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(newsnowClusteringOpsRoutes(), newsnowClusteringOpsNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestNewsnowClusteringOpsGoOwnsNineRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowClusteringOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range newsnowClusteringOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != NewsnowClusteringOpsKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, NewsnowClusteringOpsKey)
		}
	}
	// OPTIONS preflight reaches the Go handler for every taken-over path.
	for _, tc := range newsnowClusteringOpsRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestNewsnowClusteringOpsUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowClusteringOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range newsnowClusteringOpsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
