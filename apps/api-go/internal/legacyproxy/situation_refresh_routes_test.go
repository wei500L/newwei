package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithSituationRefreshMatchesOnlyExactPOST(t *testing.T) {
	rules := WithSituationRefresh(nil, string(ModeGo))
	gateway, err := New("http://legacy.test", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/refresh"); got.Mode != ModeGo || got.HandlerKey != SituationRefreshKey {
		t.Fatalf("POST match = %+v", got)
	}
	if got := gateway.match(http.MethodOptions, "/api/situation-monitor/refresh"); got.Mode != ModeGo {
		t.Fatalf("OPTIONS match = %+v", got)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		if got := gateway.match(method, "/api/situation-monitor/refresh"); got.Mode != ModeLegacy {
			t.Fatalf("%s match = %+v", method, got)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/refresh/"); got.Mode != ModeLegacy {
		t.Fatalf("trailing slash match = %+v", got)
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/refresh/extra"); got.Mode != ModeLegacy {
		t.Fatalf("longer path match = %+v", got)
	}
}

func TestWithSituationRefreshKeepsRefreshRunsOnTheSignalsRule(t *testing.T) {
	rules := WithSituationSignals(nil, string(ModeGo))
	rules = WithSituationRefresh(rules, string(ModeGo))
	gateway, err := New("http://legacy.test", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/refresh"); got.HandlerKey != SituationRefreshKey || got.Mode != ModeGo {
		t.Fatalf("refresh = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/refresh-runs/abc"); got.HandlerKey != SituationSignalsKey || got.Mode != ModeGo {
		t.Fatalf("refresh run = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/catalog"); got.HandlerKey != SituationSignalsKey || got.Mode != ModeGo {
		t.Fatalf("catalog = %+v", got)
	}
}

func TestWithSituationRefreshAddsNoRulesOutsideGo(t *testing.T) {
	for _, mode := range []string{"", string(ModeLegacy)} {
		base := WithSituationInsights(nil, string(ModeGo))
		rules := WithSituationRefresh(base, mode)
		if len(rules) != len(base) {
			t.Fatalf("mode %q added %d rules", mode, len(rules)-len(base))
		}
		gateway, err := New("http://legacy.test", rules)
		if err != nil {
			t.Fatal(err)
		}
		if got := gateway.match(http.MethodPost, "/api/situation-monitor/refresh"); got.Mode != ModeLegacy {
			t.Fatalf("mode %q match = %+v", mode, got)
		}
	}
}
