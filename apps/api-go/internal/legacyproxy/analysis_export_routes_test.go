package legacyproxy

import (
	"net/http"
	"testing"
)

// TestAnalysisExportRoutesStayLegacyUntilGo locks the default and the explicit
// legacy spelling: both export POSTs and their preflight keep flowing through
// NestJS.
func TestAnalysisExportRoutesStayLegacyUntilGo(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		rules := DefaultRules(ModeShadow, "")
		rules = WithAnalysisExport(rules, mode)
		gateway, err := New("http://legacy:4000", rules)
		if err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{AnalysisExportItemsKey, AnalysisExportEventsKey} {
			for _, method := range []string{http.MethodPost, http.MethodOptions} {
				if got := gateway.match(method, path); got.Mode != ModeLegacy {
					t.Fatalf("mode %q: %s %s mode=%s, want legacy", mode, method, path, got.Mode)
				}
			}
		}
	}
}

// TestAnalysisExportRoutesMatchMethodAndShape locks the takeover boundary: only
// the two exact paths, only POST (plus the CORS preflight), and the search
// export and every neighbouring shape stay on NestJS.
func TestAnalysisExportRoutesMatchMethodAndShape(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithAnalysisExport(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	goCases := []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodPost, AnalysisExportItemsKey, AnalysisExportItemsKey},
		{http.MethodOptions, AnalysisExportItemsKey, AnalysisExportItemsKey},
		{http.MethodPost, AnalysisExportEventsKey, AnalysisExportEventsKey},
		{http.MethodOptions, AnalysisExportEventsKey, AnalysisExportEventsKey},
	}
	for _, tc := range goCases {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != tc.key {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, tc.key)
		}
	}

	legacyCases := []struct {
		method string
		path   string
	}{
		// The headlines export prepares archive digests and stays on NestJS.
		{http.MethodPost, "/api/analysis/exports/search"},
		{http.MethodGet, AnalysisExportItemsKey},
		{http.MethodGet, AnalysisExportEventsKey},
		{http.MethodOptions, "/api/analysis/exports/search"},
		{http.MethodPost, "/api/analysis/exports/items/extra"},
		{http.MethodPost, "/api/analysis/exports/events/extra"},
		{http.MethodPost, "/api/analysis/exports"},
		{http.MethodPost, "/api/analysis/exports/itemsX"},
	}
	for _, tc := range legacyCases {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
