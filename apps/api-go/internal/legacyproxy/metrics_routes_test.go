package legacyproxy

import (
	"net/http"
	"testing"
)

// TestMetricsRouteOwnership locks GET-only, exact-path ownership and the
// legacy fallback of every other method/path.
func TestMetricsRouteOwnership(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithMetrics(rules, "")
	rules = WithMetrics(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/metrics"); got.Mode != ModeLegacy {
		t.Fatalf("legacy mode = %s", got.Mode)
	}

	rules = DefaultRules(ModeShadow, "")
	rules = WithMetrics(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	rule := gateway.match(http.MethodGet, "/api/metrics")
	if rule.Mode != ModeGo || !rule.Exact || rule.HandlerKey != MetricsKey {
		t.Fatalf("metrics rule = %+v", rule)
	}
	if got := gateway.match(http.MethodOptions, "/api/metrics"); got.Mode != ModeGo ||
		got.HandlerKey != MetricsKey {
		t.Fatalf("metrics preflight rule = %+v", got)
	}
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
		if got := gateway.match(method, "/api/metrics"); got.Mode != ModeLegacy {
			t.Fatalf("%s /api/metrics mode = %s, want legacy", method, got.Mode)
		}
	}
	for _, path := range []string{"/api/metrics/", "/api/metrics/extra", "/api/metricsX"} {
		if got := gateway.match(http.MethodGet, path); got.Mode != ModeLegacy {
			t.Fatalf("GET %s mode = %s, want legacy", path, got.Mode)
		}
	}
}

// TestPipelineRecoveryWriteOwnership locks the two POST routes to their own
// switch: the runs read switch must not take them over, and GET must not move.
func TestPipelineRecoveryWriteOwnership(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithPipelineRecovery(rules, string(ModeGo))
	rules = WithPipelineRecoveryWrite(rules, "")
	rules = WithPipelineRecoveryWrite(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/admin/quality/pipeline/replay",
		"/api/admin/quality/pipeline/rollback",
	} {
		if got := gateway.match(http.MethodPost, path); got.Mode != ModeLegacy {
			t.Fatalf("POST %s mode = %s, want legacy", path, got.Mode)
		}
	}

	rules = DefaultRules(ModeShadow, "")
	rules = WithPipelineRecoveryWrite(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/admin/quality/pipeline/replay",
		"/api/admin/quality/pipeline/rollback",
	} {
		rule := gateway.match(http.MethodPost, path)
		if rule.Mode != ModeGo || !rule.Exact || rule.HandlerKey != PipelineRecoveryWriteKey {
			t.Fatalf("POST %s rule = %+v", path, rule)
		}
		if got := gateway.match(http.MethodGet, path); got.Mode != ModeLegacy {
			t.Fatalf("GET %s mode = %s, want legacy", path, got.Mode)
		}
		if got := gateway.match(http.MethodOptions, path); got.Mode != ModeGo ||
			got.HandlerKey != PipelineRecoveryWriteKey {
			t.Fatalf("OPTIONS %s rule = %+v", path, got)
		}
	}
	// The runs read keeps its own switch and handler.
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs"); got.Mode != ModeLegacy {
		t.Fatalf("runs mode = %s, want legacy (read switch is off)", got.Mode)
	}
}
