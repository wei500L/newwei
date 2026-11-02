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

func TestNewsSourceOpsGoOwnsOnlyTheFourPosts(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsSourceOps(rules)
	gateway := New(rules)

	for _, tc := range newsSourceOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != NewsSourceOpsKey {
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
		if got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

func TestNewsSourceOpsDoesNotShadowNewsSources(t *testing.T) {
	rules := BaseRules()
	// The news-sources CRUD unit is registered first on the same prefix; the
	// method + tail scoped ops rules still win only for their four POSTs.
	rules = WithNewsSources(rules)
	rules = WithNewsSourceOps(rules)
	gateway := New(rules)

	for _, tc := range newsSourceOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != NewsSourceOpsKey {
			t.Fatalf("%s %s = %+v, want the ops handler", tc.method, tc.path, got)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/admin/news-sources/source-1/run"); got.Prefix == "" ||
		got.HandlerKey != NewsSourcesKey {
		t.Fatalf("POST run = %+v, want the news-sources handler", got)
	}
	if got := gateway.match(http.MethodGet, "/api/admin/news-sources/source-1/preview"); got.Prefix != "" {
		t.Fatalf("GET preview mode=%s, want legacy", got.Prefix)
	}
	if got := gateway.match(http.MethodPatch, "/api/admin/news-sources/source-1"); got.Prefix == "" ||
		got.HandlerKey != NewsSourcesKey {
		t.Fatalf("PATCH :id = %+v, want the news-sources handler", got)
	}
}
