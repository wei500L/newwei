package legacyproxy

import (
	"net/http"
	"testing"
)

// searchReindexGoRoutes lists the two routes the go mode must own, together with
// the shape assertion each rule has to satisfy.
func searchReindexGoRoutes() []struct {
	method string
	path   string
	shape  string // "exact", "one"
} {
	return []struct {
		method string
		path   string
		shape  string
	}{
		{http.MethodPost, "/api/admin/search/reindex", "exact"},
		{http.MethodGet, "/api/admin/search/reindex/job-1", "one"},
	}
}

// searchReindexNestRoutes lists methods and paths that must keep falling back to
// NestJS even in go mode: the other methods, the trailing slash and longer
// paths.
func searchReindexNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/search/reindex"},
		{http.MethodPost, "/api/admin/search/reindex/job-1"},
		{http.MethodPut, "/api/admin/search/reindex/job-1"},
		{http.MethodDelete, "/api/admin/search/reindex/job-1"},
		{http.MethodGet, "/api/admin/search/reindex/"},
		{http.MethodGet, "/api/admin/search/reindex/job-1/extra"},
		{http.MethodGet, "/api/admin/search/reindex/job-1/extra/segment"},
		{http.MethodGet, "/api/admin/search"},
	}
}

func TestSearchReindexGoOwnsTwoRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithSearchReindex(rules)
	gateway := New(rules)
	for _, tc := range searchReindexGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if got.HandlerKey != SearchReindexKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, SearchReindexKey)
		}
		switch tc.shape {
		case "exact":
			if !got.Exact || got.OneSegment || got.TwoSegments {
				t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
			}
		case "one":
			if got.Exact || !got.OneSegment || got.TwoSegments {
				t.Fatalf("%s %s was not one segment: %+v", tc.method, tc.path, got)
			}
		}
	}
	// CORS preflight on both paths is answered by Go.
	for _, tc := range searchReindexGoRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestSearchReindexUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithSearchReindex(rules)
	gateway := New(rules)
	for _, tc := range searchReindexNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
