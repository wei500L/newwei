package legacyproxy

import (
	"net/http"
	"testing"
)

// TestClassificationReportsStaysLegacyByDefault locks the default behaviour: the
// report POST keeps proxying to NestJS when the switch is empty or legacy.
func TestClassificationReportsStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithClassificationReports(rules, "")
	rules = WithClassificationReports(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodOptions} {
		if got := gateway.match(method, "/api/admin/quality/classification/reports"); got.Mode != ModeLegacy {
			t.Fatalf("%s mode=%s, want legacy", method, got.Mode)
		}
	}
}

// TestClassificationReportsGoOwnsOnlyPost verifies the single migrated rule and
// that it is not shadowed by the existing /reports/:jobId dynamic rule.
func TestClassificationReportsGoOwnsOnlyPost(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	// Both classification switches on: the exact POST must win over the
	// dynamic GET rule with the longer prefix.
	rules = WithClassificationRssOps(rules, string(ModeGo))
	rules = WithClassificationReports(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	rule := gateway.match(http.MethodPost, "/api/admin/quality/classification/reports")
	if rule.Mode != ModeGo {
		t.Fatalf("mode = %s, want go", rule.Mode)
	}
	if !rule.Exact || rule.OneSegment || rule.TwoSegments || rule.Tail != "" {
		t.Fatalf("rule = %+v, want an exact rule", rule)
	}
	if rule.HandlerKey != ClassificationReportsKey {
		t.Fatalf("key = %q, want %q", rule.HandlerKey, ClassificationReportsKey)
	}

	// The CORS preflight on the same exact path is served by Go, like every
	// other migrated exact route.
	if got := gateway.match(http.MethodOptions, "/api/admin/quality/classification/reports"); got.Mode != ModeGo {
		t.Fatalf("OPTIONS reports mode=%s, want go", got.Mode)
	}
	// The GET of one job keeps its own rule (rss-ops switch) and its handler.
	if got := gateway.match(http.MethodGet, "/api/admin/quality/classification/reports/abc"); got.Mode != ModeGo ||
		got.HandlerKey != ClassificationRssOpsKey {
		t.Fatalf("GET reports/:jobId = %+v, want the rss-ops handler", got)
	}
	// Unlisted methods and longer paths stay on NestJS.
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		if got := gateway.match(method, "/api/admin/quality/classification/reports"); got.Mode != ModeLegacy {
			t.Fatalf("%s reports mode=%s, want legacy", method, got.Mode)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/admin/quality/classification/reports/abc"); got.Mode != ModeLegacy {
		t.Fatalf("POST reports/abc mode=%s, want legacy", got.Mode)
	}
	// The reports switch alone must not take over the 13 rss-ops routes.
	reportsOnly := DefaultRules(ModeShadow, "")
	reportsOnly = WithClassificationReports(reportsOnly, string(ModeGo))
	reportsOnlyGateway, err := New("http://legacy:4000", reportsOnly)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/api/admin/quality/classification/summary",
		"/api/admin/quality/classification/reviews/queue",
	} {
		if got := reportsOnlyGateway.match(http.MethodGet, path); got.Mode != ModeLegacy {
			t.Fatalf("%s mode=%s, want legacy", path, got.Mode)
		}
	}
}

// TestPipelineRecoveryOwnsOnlyRuns locks the single migrated read route and the
// fallback of replay/rollback.
func TestPipelineRecoveryOwnsOnlyRuns(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithPipelineRecovery(rules, "")
	rules = WithPipelineRecovery(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs"); got.Mode != ModeLegacy {
		t.Fatalf("legacy mode = %s", got.Mode)
	}

	rules = DefaultRules(ModeShadow, "")
	rules = WithQualityOverview(rules, string(ModeGo))
	rules = WithPipelineRecovery(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	rule := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs")
	if rule.Mode != ModeGo || !rule.Exact || rule.HandlerKey != PipelineRecoveryKey {
		t.Fatalf("runs rule = %+v", rule)
	}
	// The neighbouring exact GET /pipeline keeps its own handler.
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline"); got.HandlerKey != QualityOverviewKey {
		t.Fatalf("pipeline rule = %+v", got)
	}
	// Replay and rollback are not implemented in this batch.
	for _, path := range []string{
		"/api/admin/quality/pipeline/replay",
		"/api/admin/quality/pipeline/rollback",
	} {
		if got := gateway.match(http.MethodPost, path); got.Mode != ModeLegacy {
			t.Fatalf("POST %s mode=%s, want legacy", path, got.Mode)
		}
	}
	// Other methods and longer paths of the runs route stay on NestJS.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		if got := gateway.match(method, "/api/admin/quality/pipeline/runs"); got.Mode != ModeLegacy {
			t.Fatalf("%s runs mode=%s, want legacy", method, got.Mode)
		}
	}
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs/extra"); got.Mode != ModeLegacy {
		t.Fatalf("runs/extra mode=%s, want legacy", got.Mode)
	}
}
