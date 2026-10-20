package legacyproxy

import (
	"net/http"
	"testing"
)

// newsSourceOpsRoutes is the exact set of routes the Go takeover must own when
// API_GO_NEWS_SOURCE_OPS_MODE=go.
func newsSourceOpsRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/admin/news-sources/source-1/dispatch"},
		{http.MethodPost, "/api/admin/news-sources/source-1/cancel-queued"},
		{http.MethodPost, "/api/admin/news-sources/source-1/clear-inflight"},
		{http.MethodPost, "/api/admin/news-sources/source-1/retry-latest"},
	}
}

// newsSourceOpsNestRoutes lists everything that must keep its existing owner
// even while the takeover is on: longer paths, wrong methods, the collection
// and the CRUD/preview neighbours.
func newsSourceOpsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/admin/news-sources/source-1/dispatch/extra"},
		{http.MethodGet, "/api/admin/news-sources/source-1/dispatch"},
		{http.MethodPost, "/api/admin/news-sources/source-1"},
		{http.MethodPost, "/api/admin/news-sources/source-1/run"},
		{http.MethodPost, "/api/admin/news-sources/source-1/schedule"},
		{http.MethodGet, "/api/admin/news-sources/source-1/preview"},
		{http.MethodPatch, "/api/admin/news-sources/source-1"},
		{http.MethodDelete, "/api/admin/news-sources/source-1"},
	}
}

func TestNewsSourceOpsStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsSourceOps(rules, "")
	rules = WithNewsSourceOps(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(newsSourceOpsRoutes(), newsSourceOpsNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestNewsSourceOpsGoOwnsOnlyTheFourPosts(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsSourceOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range newsSourceOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != NewsSourceOpsKey {
			t.Fatalf("%s %s = %+v, want the ops handler", tc.method, tc.path, got)
		}
		if !got.OneSegment || got.TwoSegments || got.Exact {
			t.Fatalf("%s %s rule = %+v, want a one-segment rule", tc.method, tc.path, got)
		}
	}

	for _, tc := range newsSourceOpsNestRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.HandlerKey == NewsSourceOpsKey {
			t.Fatalf("%s %s key=%q, want another owner", tc.method, tc.path, got.HandlerKey)
		}
		if got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestNewsSourceOpsDoesNotShadowNewsSources(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	// The news-sources CRUD unit is registered first on the same prefix; the
	// method + tail scoped ops rules still win only for their four POSTs.
	rules = WithNewsSources(rules, string(ModeGo))
	rules = WithNewsSourceOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range newsSourceOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != NewsSourceOpsKey {
			t.Fatalf("%s %s = %+v, want the ops handler", tc.method, tc.path, got)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/admin/news-sources/source-1/run"); got.Mode != ModeGo ||
		got.HandlerKey != NewsSourcesKey {
		t.Fatalf("POST run = %+v, want the news-sources handler", got)
	}
	if got := gateway.match(http.MethodGet, "/api/admin/news-sources/source-1/preview"); got.Mode != ModeLegacy {
		t.Fatalf("GET preview mode=%s, want legacy", got.Mode)
	}
	if got := gateway.match(http.MethodPatch, "/api/admin/news-sources/source-1"); got.Mode != ModeGo ||
		got.HandlerKey != NewsSourcesKey {
		t.Fatalf("PATCH :id = %+v, want the news-sources handler", got)
	}
}
