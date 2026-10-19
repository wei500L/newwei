package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithSituationInsightsMatchesOnlyExactGET(t *testing.T) {
	rules := WithSituationInsights(nil, string(ModeGo))
	gateway, err := New("http://legacy.test", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights"); got.Mode != ModeGo || got.HandlerKey != SituationInsightsKey {
		t.Fatalf("GET match = %+v", got)
	}
	if got := gateway.match(http.MethodOptions, "/api/situation-monitor/insights"); got.Mode != ModeGo {
		t.Fatalf("OPTIONS match = %+v", got)
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/insights"); got.Mode != ModeLegacy {
		t.Fatalf("POST match = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights/extra"); got.Mode != ModeLegacy {
		t.Fatalf("longer path match = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/monitors"); got.Mode != ModeLegacy {
		t.Fatalf("monitors match = %+v", got)
	}
}

func TestWithSituationInsightsDoesNotShadowMonitorRules(t *testing.T) {
	rules := WithSituationMonitors(nil, string(ModeGo))
	rules = WithSituationInsights(rules, string(ModeGo))
	gateway, err := New("http://legacy.test", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/monitors"); got.HandlerKey != SituationMonitorsKey || got.Mode != ModeGo {
		t.Fatalf("monitors = %+v", got)
	}
	if got := gateway.match(http.MethodPatch, "/api/situation-monitor/monitors/x"); got.HandlerKey != SituationMonitorsKey || got.Mode != ModeGo {
		t.Fatalf("monitor item = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights"); got.HandlerKey != SituationInsightsKey || got.Mode != ModeGo {
		t.Fatalf("insights = %+v", got)
	}
}
