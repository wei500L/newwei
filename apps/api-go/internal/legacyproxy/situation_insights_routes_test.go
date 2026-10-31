package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithSituationInsightsMatchesOnlyExactGET(t *testing.T) {
	rules := WithSituationInsights(nil)
	gateway := New(rules)
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights"); got.Prefix == "" || got.HandlerKey != SituationInsightsKey {
		t.Fatalf("GET match = %+v", got)
	}
	if got := gateway.match(http.MethodOptions, "/api/situation-monitor/insights"); got.Prefix == "" {
		t.Fatalf("OPTIONS match = %+v", got)
	}
	if got := gateway.match(http.MethodPost, "/api/situation-monitor/insights"); got.Prefix != "" {
		t.Fatalf("POST match = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights/extra"); got.Prefix != "" {
		t.Fatalf("longer path match = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/monitors"); got.Prefix != "" {
		t.Fatalf("monitors match = %+v", got)
	}
}

func TestWithSituationInsightsDoesNotShadowMonitorRules(t *testing.T) {
	rules := WithSituationMonitors(nil)
	rules = WithSituationInsights(rules)
	gateway := New(rules)
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/monitors"); got.HandlerKey != SituationMonitorsKey || got.Prefix == "" {
		t.Fatalf("monitors = %+v", got)
	}
	if got := gateway.match(http.MethodPatch, "/api/situation-monitor/monitors/x"); got.HandlerKey != SituationMonitorsKey || got.Prefix == "" {
		t.Fatalf("monitor item = %+v", got)
	}
	if got := gateway.match(http.MethodGet, "/api/situation-monitor/insights"); got.HandlerKey != SituationInsightsKey || got.Prefix == "" {
		t.Fatalf("insights = %+v", got)
	}
}
