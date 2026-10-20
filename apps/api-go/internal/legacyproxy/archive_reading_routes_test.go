package legacyproxy

import (
	"net/http"
	"testing"
)

// TestArchiveReadingSearchRoute locks the exact boundary of the independent
// archive switch: only POST and its CORS preflight reach Go.
func TestArchiveReadingSearchRoute(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithArchiveReadingSearch(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodPost, http.MethodOptions} {
		got := gateway.match(method, ArchiveReadingSearchKey)
		if got.Mode != ModeGo || got.HandlerKey != ArchiveReadingSearchKey {
			t.Fatalf("%s mode=%s key=%s", method, got.Mode, got.HandlerKey)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, ArchiveReadingSearchKey},
		{http.MethodPost, "/api/analysis/exports/search/extra"},
		{http.MethodPost, "/api/analysis/exports/items"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode == ModeGo {
			t.Fatalf("%s %s unexpectedly go", tc.method, tc.path)
		}
	}

	legacy := WithArchiveReadingSearch(DefaultRules(ModeShadow, ""), string(ModeLegacy))
	legacyGateway, err := New("http://legacy:4000", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if got := legacyGateway.match(http.MethodPost, ArchiveReadingSearchKey); got.Mode == ModeGo {
		t.Fatal("legacy mode registered the archive search route")
	}
}
