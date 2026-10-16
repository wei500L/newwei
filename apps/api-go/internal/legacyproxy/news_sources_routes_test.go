package legacyproxy

import (
	"net/http"
	"testing"
)

func TestNewsSourcesStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsSources(rules, "")
	rules = WithNewsSources(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range newsSourceRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestNewsSourcesGoOwnsFifteenRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsSources(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range newsSourceRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != NewsSourcesKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	for _, path := range []string{
		"/api/admin/news-sources/options",
		"/api/admin/news-sources/groups",
		"/api/admin/news-sources/opml-presets",
		"/api/admin/news-sources/batch",
		"/api/admin/news-sources/batch/frequency",
		"/api/admin/news-sources/batch/group",
		"/api/admin/news-sources/batch/active",
		"/api/admin/news-sources/opml/preview",
		"/api/admin/news-sources/opml/import",
	} {
		got := gateway.match(http.MethodGet, path)
		if path == "/api/admin/news-sources/options" || path == "/api/admin/news-sources/groups" || path == "/api/admin/news-sources/opml-presets" {
			if !got.Exact || got.Mode != ModeGo {
				t.Fatalf("static GET %s was treated as :id: %+v", path, got)
			}
			continue
		}
		if got.Mode != ModeLegacy {
			t.Fatalf("GET %s mode=%s, want legacy", path, got.Mode)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/news-sources/source-1/preview"},
		{http.MethodPost, "/api/admin/news-sources/source-1/preview"},
		{http.MethodGet, "/api/admin/news-sources/source-1/run"},
		{http.MethodPut, "/api/admin/news-sources"},
		{http.MethodPost, "/api/admin/news-sources/source-1"},
		{http.MethodPatch, "/api/admin/news-sources/source-1/extra"},
		{http.MethodGet, "/api/admin/news-sources/source-1"},
		{http.MethodPost, "/api/admin/news-sources/opml/preview/extra"},
		{http.MethodDelete, "/api/admin/news-sources/batch/frequency"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func newsSourceRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/news-sources"},
		{http.MethodGet, "/api/admin/news-sources/options"},
		{http.MethodGet, "/api/admin/news-sources/groups"},
		{http.MethodGet, "/api/admin/news-sources/opml-presets"},
		{http.MethodPost, "/api/admin/news-sources"},
		{http.MethodPost, "/api/admin/news-sources/batch/frequency"},
		{http.MethodPost, "/api/admin/news-sources/opml/preview"},
		{http.MethodPost, "/api/admin/news-sources/opml/import"},
		{http.MethodPatch, "/api/admin/news-sources/batch/group"},
		{http.MethodPatch, "/api/admin/news-sources/batch/active"},
		{http.MethodDelete, "/api/admin/news-sources/batch"},
		{http.MethodPatch, "/api/admin/news-sources/source-1"},
		{http.MethodDelete, "/api/admin/news-sources/source-1"},
		{http.MethodPost, "/api/admin/news-sources/source-1/run"},
		{http.MethodPost, "/api/admin/news-sources/source-1/schedule"},
	}
}
