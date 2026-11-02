package legacyproxy

import (
	"net/http"
	"testing"
)

// TestMetricsRouteOwnership locks GET-only, exact-path ownership and the fact
// that every other method/path is not claimed.
func TestMetricsRouteOwnership(t *testing.T) {
	gateway := New(WithMetrics(BaseRules()))

	rule, matched := gateway.matchRule(http.MethodGet, "/api/metrics")
	if !matched || !rule.Exact || rule.HandlerKey != MetricsKey {
		t.Fatalf("metrics rule = %+v matched=%v", rule, matched)
	}
	if preflight, ok := gateway.matchRule(http.MethodOptions, "/api/metrics"); !ok || preflight.HandlerKey != MetricsKey {
		t.Fatalf("metrics preflight rule = %+v matched=%v", preflight, ok)
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		if _, ok := gateway.matchRule(method, "/api/metrics"); ok {
			t.Fatalf("%s /api/metrics unexpectedly matched", method)
		}
	}
	for _, path := range []string{"/api/metrics/", "/api/metrics/extra", "/api/metricsX"} {
		if _, ok := gateway.matchRule(http.MethodGet, path); ok {
			t.Fatalf("GET %s unexpectedly matched", path)
		}
	}
}

// TestPipelineRecoveryWriteOwnership locks the two POST routes to their own
// switch: the runs read routes are not taken over, and GET must not move.
func TestPipelineRecoveryWriteOwnership(t *testing.T) {
	gateway := New(WithPipelineRecoveryWrite(BaseRules()))
	for _, path := range []string{
		"/api/admin/quality/pipeline/replay",
		"/api/admin/quality/pipeline/rollback",
	} {
		rule, matched := gateway.matchRule(http.MethodPost, path)
		if !matched || !rule.Exact || rule.HandlerKey != PipelineRecoveryWriteKey {
			t.Fatalf("POST %s rule = %+v matched=%v", path, rule, matched)
		}
		if _, ok := gateway.matchRule(http.MethodGet, path); ok {
			t.Fatalf("GET %s unexpectedly matched", path)
		}
		if preflight, ok := gateway.matchRule(http.MethodOptions, path); !ok || preflight.HandlerKey != PipelineRecoveryWriteKey {
			t.Fatalf("OPTIONS %s rule = %+v matched=%v", path, preflight, ok)
		}
	}
	// The runs read keeps its own switch and handler.
	if _, ok := gateway.matchRule(http.MethodGet, "/api/admin/quality/pipeline/runs"); ok {
		t.Fatalf("runs unexpectedly matched (read switch is off)")
	}
}
