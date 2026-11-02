package legacyproxy

import (
	"net/http"
	"testing"
)

func TestWithSituationRefreshMatchesOnlyExactPOST(t *testing.T) {
	gateway := New(WithSituationRefresh(nil))
	if rule, matched := gateway.matchRule(http.MethodPost, "/api/situation-monitor/refresh"); !matched || rule.HandlerKey != SituationRefreshKey {
		t.Fatalf("POST match = %+v matched=%v", rule, matched)
	}
	if rule, matched := gateway.matchRule(http.MethodOptions, "/api/situation-monitor/refresh"); !matched || rule.HandlerKey != SituationRefreshKey {
		t.Fatalf("OPTIONS match = %+v matched=%v", rule, matched)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		if _, matched := gateway.matchRule(method, "/api/situation-monitor/refresh"); matched {
			t.Fatalf("%s unexpectedly matched", method)
		}
	}
	for _, path := range []string{
		"/api/situation-monitor/refresh/",
		"/api/situation-monitor/refresh/extra",
	} {
		if _, matched := gateway.matchRule(http.MethodPost, path); matched {
			t.Fatalf("POST %s unexpectedly matched", path)
		}
	}
}

func TestWithSituationRefreshKeepsRefreshRunsOnTheSignalsRule(t *testing.T) {
	gateway := New(WithSituationRefresh(WithSituationSignals(nil)))
	if rule, matched := gateway.matchRule(http.MethodPost, "/api/situation-monitor/refresh"); !matched || rule.HandlerKey != SituationRefreshKey {
		t.Fatalf("refresh = %+v matched=%v", rule, matched)
	}
	if rule, matched := gateway.matchRule(http.MethodGet, "/api/situation-monitor/refresh-runs/abc"); !matched || rule.HandlerKey != SituationSignalsKey {
		t.Fatalf("refresh run = %+v matched=%v", rule, matched)
	}
	if rule, matched := gateway.matchRule(http.MethodGet, "/api/situation-monitor/catalog"); !matched || rule.HandlerKey != SituationSignalsKey {
		t.Fatalf("catalog = %+v matched=%v", rule, matched)
	}
}
