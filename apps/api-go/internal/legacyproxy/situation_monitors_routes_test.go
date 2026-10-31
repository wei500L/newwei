package legacyproxy

import (
	"net/http"
	"testing"
)

func TestSituationMonitorsGoOnlyOwnsFiveRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithSituationMonitors(rules)
	gateway := New(rules)
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/situation-monitor/monitors"},
		{http.MethodPost, "/api/situation-monitor/monitors"},
		{http.MethodPost, "/api/situation-monitor/monitors/preview"},
		{http.MethodPatch, "/api/situation-monitor/monitors/monitor-1"},
		{http.MethodDelete, "/api/situation-monitor/monitors/monitor-1"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != SituationMonitorsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	preview := gateway.match(http.MethodPost, "/api/situation-monitor/monitors/preview")
	if !preview.Exact || preview.Prefix != "/api/situation-monitor/monitors/preview" {
		t.Fatalf("preview rule = %+v", preview)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/situation-monitor/insights"},
		{http.MethodPost, "/api/situation-monitor/refresh"},
		{http.MethodGet, "/api/situation-monitor/catalog"},
		{http.MethodPost, "/api/situation-monitor/feedback"},
		{http.MethodGet, "/api/situation-monitor/refresh-runs/run-1"},
		{http.MethodGet, "/api/situation-monitor/telegram-feed"},
		{http.MethodGet, "/api/situation-monitor/oref-alerts"},
		{http.MethodGet, "/api/situation-monitor/oref-history"},
		{http.MethodGet, "/api/situation-monitor/live-hls-proxy-config"},
		{http.MethodGet, "/api/situation-monitor/monitors/preview"},
		{http.MethodPost, "/api/situation-monitor/monitors/preview/extra"},
		{http.MethodPut, "/api/situation-monitor/monitors"},
		{http.MethodPost, "/api/situation-monitor/monitors/monitor-1"},
		{http.MethodPatch, "/api/situation-monitor/monitors/monitor-1/extra"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
