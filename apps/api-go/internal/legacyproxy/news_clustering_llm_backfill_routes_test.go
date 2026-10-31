package legacyproxy

import (
	"net/http"
	"testing"
)

// TestNewsClusteringLlmBackfillStaysLegacyByDefault proves the empty and
// explicit legacy values add no rule.

// TestNewsClusteringLlmBackfillGoOwnsOneRoute proves the rule owns exactly the
// manual backfill route (plus its OPTIONS preflight) and no sibling route.
func TestNewsClusteringLlmBackfillGoOwnsOneRoute(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsClusteringLlmBackfill(rules)
	gateway := New(rules)
	path := "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill"
	got := gateway.match(http.MethodPost, path)
	if got.Prefix == "" || got.HandlerKey != NewsClusteringLlmBackfillKey {
		t.Fatalf("POST %s mode=%s key=%s", path, got.Prefix, got.HandlerKey)
	}
	if got := gateway.match(http.MethodOptions, path); got.Prefix == "" {
		t.Fatalf("OPTIONS %s mode=%s, want go", path, got.Prefix)
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
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// TestNewsClusteringLlmBackfillDoesNotDisturbClusteringOps keeps the two
// independent switches independent in both directions.
func TestNewsClusteringLlmBackfillDoesNotDisturbClusteringOps(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsClusteringLlmBackfill(rules)
	rules = WithNewsnowClusteringOps(rules)
	gateway := New(rules)
	for _, tc := range newsnowClusteringOpsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != NewsnowClusteringOpsKey {
			t.Fatalf("%s %s mode=%s key=%s", tc.method, tc.path, got.Prefix, got.HandlerKey)
		}
	}
	got := gateway.match(http.MethodPost, "/api/system-settings/news-events/clustering/failures/group-1/llm-backfill")
	if got.Prefix == "" || got.HandlerKey != NewsClusteringLlmBackfillKey {
		t.Fatalf("llm backfill mode=%s key=%s", got.Prefix, got.HandlerKey)
	}
}
