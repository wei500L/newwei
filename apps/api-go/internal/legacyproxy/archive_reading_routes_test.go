package legacyproxy

import (
	"net/http"
	"testing"
)

// TestArchiveReadingSearchRoute locks the exact boundary of the independent
// archive switch: only POST and its CORS preflight reach Go.
func TestArchiveReadingSearchRoute(t *testing.T) {
	rules := BaseRules()
	rules = WithArchiveReadingSearch(rules)
	gateway := New(rules)
	for _, method := range []string{http.MethodPost, http.MethodOptions} {
		got := gateway.match(method, ArchiveReadingSearchKey)
		if got.Prefix == "" || got.HandlerKey != ArchiveReadingSearchKey {
			t.Fatalf("%s mode=%s key=%s", method, got.Prefix, got.HandlerKey)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, ArchiveReadingSearchKey},
		{http.MethodPost, "/api/analysis/exports/search/extra"},
		{http.MethodPost, "/api/analysis/exports/items"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s unexpectedly go", tc.method, tc.path)
		}
	}

}
