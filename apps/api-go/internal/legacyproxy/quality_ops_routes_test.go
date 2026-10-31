package legacyproxy

import (
	"net/http"
	"testing"
)

// TestClassificationReportsStaysLegacyByDefault locks the default behaviour: the
// report POST keeps proxying to NestJS when the switch is empty or legacy.

// TestClassificationReportsGoOwnsOnlyPost verifies the single migrated rule and
// that it is not shadowed by the existing /reports/:jobId dynamic rule.
func TestClassificationReportsGoOwnsOnlyPost(t *testing.T) {
	rules := BaseRules()
	// Both classification switches on: the exact POST must win over the
	// dynamic GET rule with the longer prefix.
	rules = WithClassificationRssOps(rules)
	rules = WithClassificationReports(rules)
	gateway := New(rules)

	rule := gateway.match(http.MethodPost, "/api/admin/quality/classification/reports")
	if rule.Prefix == "" {
		t.Fatalf("mode = %s, want go", rule.Prefix)
	}
	if !rule.Exact || rule.OneSegment || rule.TwoSegments || rule.Tail != "" {
		t.Fatalf("rule = %+v, want an exact rule", rule)
	}
	if rule.HandlerKey != ClassificationReportsKey {
		t.Fatalf("key = %q, want %q", rule.HandlerKey, ClassificationReportsKey)
	}

	// The CORS preflight on the same exact path is served by Go, like every
	// other migrated exact route.
	if got := gateway.match(http.MethodOptions, "/api/admin/quality/classification/reports"); got.Prefix == "" {
		t.Fatalf("OPTIONS reports mode=%s, want go", got.Prefix)
	}
	// The GET of one job keeps its own rule (rss-ops switch) and its handler.
	if got := gateway.match(http.MethodGet, "/api/admin/quality/classification/reports/abc"); got.Prefix == "" ||
		got.HandlerKey != ClassificationRssOpsKey {
		t.Fatalf("GET reports/:jobId = %+v, want the rss-ops handler", got)
	}
	// Unlisted methods and longer paths stay on NestJS.
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		if got := gateway.match(method, "/api/admin/quality/classification/reports"); got.Prefix != "" {
			t.Fatalf("%s reports mode=%s, want legacy", method, got.Prefix)
		}
	}
	if got := gateway.match(http.MethodPost, "/api/admin/quality/classification/reports/abc"); got.Prefix != "" {
		t.Fatalf("POST reports/abc mode=%s, want legacy", got.Prefix)
	}
	// The reports switch alone must not take over the 13 rss-ops routes.
	reportsOnly := BaseRules()
	reportsOnly = WithClassificationReports(reportsOnly)
	reportsOnlyGateway := New(reportsOnly)
	for _, path := range []string{
		"/api/admin/quality/classification/summary",
		"/api/admin/quality/classification/reviews/queue",
	} {
		if got := reportsOnlyGateway.match(http.MethodGet, path); got.Prefix != "" {
			t.Fatalf("%s mode=%s, want legacy", path, got.Prefix)
		}
	}
}

// TestPipelineRecoveryOwnsOnlyRuns locks the single migrated read route and the
// fallback of replay/rollback.
func TestPipelineRecoveryOwnsOnlyRuns(t *testing.T) {
	rules := BaseRules()
	rules = WithQualityOverview(rules)
	rules = WithPipelineRecovery(rules)
	gateway := New(rules)
	rule := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs")
	if rule.Prefix == "" || !rule.Exact || rule.HandlerKey != PipelineRecoveryKey {
		t.Fatalf("runs rule = %+v", rule)
	}
	// The neighbouring exact GET /pipeline keeps its own handler.
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline"); got.HandlerKey != QualityOverviewKey {
		t.Fatalf("pipeline rule = %+v", got)
	}
	// Replay and rollback have their own switch (WithPipelineRecoveryWrite),
	// so the runs read rule must leave them on NestJS.
	for _, path := range []string{
		"/api/admin/quality/pipeline/replay",
		"/api/admin/quality/pipeline/rollback",
	} {
		if got := gateway.match(http.MethodPost, path); got.Prefix != "" {
			t.Fatalf("POST %s mode=%s, want legacy", path, got.Prefix)
		}
	}
	// Other methods and longer paths of the runs route stay on NestJS.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		if got := gateway.match(method, "/api/admin/quality/pipeline/runs"); got.Prefix != "" {
			t.Fatalf("%s runs mode=%s, want legacy", method, got.Prefix)
		}
	}
	if got := gateway.match(http.MethodGet, "/api/admin/quality/pipeline/runs/extra"); got.Prefix != "" {
		t.Fatalf("runs/extra mode=%s, want legacy", got.Prefix)
	}
}
