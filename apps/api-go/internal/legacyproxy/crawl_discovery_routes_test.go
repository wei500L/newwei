package legacyproxy

import (
	"net/http"
	"testing"
)

// TestCrawlDiscoveryRoutesStayLegacyByDefault pins the default: with the empty
// and legacy values the three paths keep proxying to NestJS.

// TestCrawlDiscoveryRoutesGoOwnsThreePaths pins the three migrated entries and
// their handler keys.
func TestCrawlDiscoveryRoutesGoOwnsThreePaths(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsSources(rules)
	rules = WithCrawlWorkflows(rules)
	rules = WithCrawlFrontierRuns(rules)
	rules = WithNewsSourcePreview(rules)
	rules = WithCrawlWorkflowTrial(rules)
	gateway := New(rules)
	for _, tc := range crawlDiscoveryRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s => %s", tc.method, tc.path, got.Prefix)
		}
		if got.HandlerKey != tc.key {
			t.Fatalf("%s %s key=%s want %s", tc.method, tc.path, got.HandlerKey, tc.key)
		}
	}
}

// TestCrawlDiscoveryRoutesDoNotShadowExistingRules pins that neighbouring
// shapes and methods keep their previous owner: the preview rule does not steal
// the collection, static siblings, bare :id, :id/run or :id/schedule, and the
// trial/replay rules do not steal the existing workflow GETs.
func TestCrawlDiscoveryRoutesDoNotShadowExistingRules(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsSources(rules)
	rules = WithCrawlWorkflows(rules)
	rules = WithCrawlFrontierRuns(rules)
	rules = WithNewsSourcePreview(rules)
	rules = WithCrawlWorkflowTrial(rules)
	gateway := New(rules)

	// Still owned by the news-sources switch.
	for _, tc := range []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodGet, "/api/admin/news-sources", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources/batch/frequency", NewsSourcesKey},
		{http.MethodPatch, "/api/admin/news-sources/source-1", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources/source-1/run", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources/source-1/schedule", NewsSourcesKey},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != tc.key {
			t.Fatalf("%s %s => mode=%s key=%s", tc.method, tc.path, got.Prefix, got.HandlerKey)
		}
	}

	// Still owned by the workflow switch.
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/workflows"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/w1"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/w1/versions"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/compare"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != CrawlWorkflowsKey {
			t.Fatalf("%s %s => mode=%s key=%s", tc.method, tc.path, got.Prefix, got.HandlerKey)
		}
	}

	// Still owned by the frontier-runs switch.
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/candidates"},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != CrawlFrontierRunsKey {
			t.Fatalf("%s %s => mode=%s key=%s", tc.method, tc.path, got.Prefix, got.HandlerKey)
		}
	}

	// Longer paths and other methods keep falling back to the /api/ legacy rule.
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/admin/news-sources/source-1/preview/extra"},
		{http.MethodPost, "/api/admin/news-sources/source-1/preview"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/w1/trial-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/w1/trial-run/extra"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s => %s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

func crawlDiscoveryRoutes() []struct {
	method string
	path   string
	key    string
} {
	return []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodGet, "/api/admin/news-sources/source-1/preview", NewsSourcePreviewKey},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/w1/trial-run", CrawlWorkflowTrialKey},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay", CrawlWorkflowTrialKey},
	}
}
