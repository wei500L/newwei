package legacyproxy

import (
	"net/http"
	"testing"
)

// TestNewsClusteringLlmBackfillStaysLegacyByDefault proves the empty and
// explicit legacy values add no rule.
func TestNewsClusteringLlmBackfillStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsClusteringLlmBackfill(rules, "")
	rules = WithNewsClusteringLlmBackfill(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	got := gateway.match(http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill")
	if got.Mode != ModeLegacy {
		t.Fatalf("mode=%s, want legacy", got.Mode)
	}
}

// TestNewsClusteringLlmBackfillGoOwnsOneRoute proves the rule owns exactly the
// manual backfill route (plus its OPTIONS preflight) and no sibling route.
func TestNewsClusteringLlmBackfillGoOwnsOneRoute(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsClusteringLlmBackfill(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill"
	got := gateway.match(http.MethodPost, path)
	if got.Mode != ModeGo || got.HandlerKey != NewsClusteringLlmBackfillKey {
		t.Fatalf("POST %s mode=%s key=%s", path, got.Mode, got.HandlerKey)
	}
	if got := gateway.match(http.MethodOptions, path); got.Mode != ModeGo {
		t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Mode)
	}

	nestOnly := []struct{ method, path string }{
		// Sibling clustering failure actions are owned by other switches.
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/vector-backfill"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/ignore"},
		// Wrong methods and longer/shorter paths must not be swallowed.
		{http.MethodGet, path},
		{http.MethodPut, path},
		{http.MethodPost, path + "/extra"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/llm-backfill"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/a/b/llm-backfill"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures//llm-backfill"},
		{http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill-other"},
		// The nine-route administration switch is independent.
		{http.MethodGet, "/api/system-settings/news-events/clustering/failures"},
	}
	for _, tc := range nestOnly {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// TestNewsClusteringLlmBackfillDoesNotDisturbClusteringOps keeps the two
// independent switches independent in both directions.
func TestNewsClusteringLlmBackfillDoesNotDisturbClusteringOps(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsClusteringLlmBackfill(rules, string(ModeGo))
	rules = WithNewsnowClusteringOps(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range newsnowClusteringOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != NewsnowClusteringOpsKey {
			t.Fatalf("%s %s mode=%s key=%s", tc.method, tc.path, got.Mode, got.HandlerKey)
		}
	}
	got := gateway.match(http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill")
	if got.Mode != ModeGo || got.HandlerKey != NewsClusteringLlmBackfillKey {
		t.Fatalf("llm backfill mode=%s key=%s", got.Mode, got.HandlerKey)
	}
}
