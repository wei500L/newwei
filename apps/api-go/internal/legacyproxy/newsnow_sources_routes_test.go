package legacyproxy

import (
	"net/http"
	"testing"
)

// TestNewsnowSourcesStayLegacyByDefault pins the empty/legacy behaviour: no rule
// is appended and both public routes keep flowing to NestJS.
func TestNewsnowSourcesStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowSources(rules, "")
	rules = WithNewsnowSources(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/news-aggregator/source"},
		{http.MethodPost, "/api/news-aggregator/sources/batch"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestNewsnowSourcesGoOwnsTwoRoutes checks the exact ownership plus OPTIONS.
func TestNewsnowSourcesGoOwnsTwoRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowSources(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/news-aggregator/source"},
		{http.MethodPost, "/api/news-aggregator/sources/batch"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != NewsnowSourcesKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, NewsnowSourcesKey)
		}
		if option := gateway.match(http.MethodOptions, tc.path); option.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, option.Mode)
		}
	}
}

// TestNewsnowSourcesLeavesNeighbouringRoutesAlone keeps every other NewsNow
// path and wrong method on its previous owner.
func TestNewsnowSourcesLeavesNeighbouringRoutesAlone(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowSources(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/news-aggregator/source"},
		{http.MethodGet, "/api/news-aggregator/sources/batch"},
		{http.MethodGet, "/api/news-aggregator/source/extra"},
		{http.MethodPost, "/api/news-aggregator/sources/batch/extra"},
		{http.MethodGet, "/api/news-aggregator/sources"},
		{http.MethodGet, "/api/news-aggregator/metadata"},
		{http.MethodGet, "/api/news-aggregator/hottest-analysis"},
		{http.MethodGet, "/api/news-aggregator/recommended"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestNewsnowSourcesAndClusteringOpsCoexist checks the two independent switches
// share no path.
func TestNewsnowSourcesAndClusteringOpsCoexist(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsnowClusteringOps(rules, string(ModeGo))
	rules = WithNewsnowSources(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/news-aggregator/metadata"); got.HandlerKey != NewsnowClusteringOpsKey {
		t.Fatalf("metadata key=%s", got.HandlerKey)
	}
	if got := gateway.match(http.MethodGet, "/api/news-aggregator/source"); got.HandlerKey != NewsnowSourcesKey {
		t.Fatalf("source key=%s", got.HandlerKey)
	}
	if got := gateway.match(http.MethodPost, "/api/news-aggregator/sources/order"); got.HandlerKey != NewsnowClusteringOpsKey {
		t.Fatalf("order key=%s", got.HandlerKey)
	}
	if got := gateway.match(http.MethodPost, "/api/news-aggregator/sources/batch"); got.HandlerKey != NewsnowSourcesKey {
		t.Fatalf("batch key=%s", got.HandlerKey)
	}
}
