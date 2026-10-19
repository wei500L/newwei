package legacyproxy

import (
	"net/http"
	"testing"
)

// crawlDiscoveryGoRoutes 是开关为 go 时预期由 Go 接管的三条路径与方法。
func crawlDiscoveryGoRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/news-sources/source-1/preview"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
	}
}

func TestCrawlDiscoveryStaysLegacyByDefault(t *testing.T) {
	for _, mode := range []string{"", "legacy"} {
		rules := DefaultRules(ModeShadow, "")
		rules = WithCrawlDiscovery(rules, mode, mode)
		gateway, err := New("http://legacy:4000", rules)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range crawlDiscoveryGoRoutes() {
			if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
				t.Fatalf("%s %s mode=%s with switch %q, want legacy", tc.method, tc.path, got.Mode, mode)
			}
		}
	}
}

func TestCrawlDiscoverySwitchesAreIndependent(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlDiscovery(rules, string(ModeGo), "")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/admin/news-sources/source-1/preview"); got.Mode != ModeGo {
		t.Fatalf("preview mode = %s, want go", got.Mode)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode = %s, want legacy while the trial switch is legacy", tc.method, tc.path, got.Mode)
		}
	}

	rules = DefaultRules(ModeShadow, "")
	rules = WithCrawlDiscovery(rules, "", string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	if got := gateway.match(http.MethodGet, "/api/admin/news-sources/source-1/preview"); got.Mode != ModeLegacy {
		t.Fatalf("preview mode = %s, want legacy", got.Mode)
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeGo {
			t.Fatalf("%s %s mode = %s, want go", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlDiscoveryGoOwnsOnlyTheThreeExactShapes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlDiscovery(rules, string(ModeGo), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlDiscoveryGoRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if got.HandlerKey != CrawlDiscoveryKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, got.HandlerKey)
		}
		if !got.OneSegment || got.Exact {
			t.Fatalf("%s %s rule=%+v, want a one-segment tail rule", tc.method, tc.path, got)
		}
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}

	// Every unlisted method, longer path and trailing slash keeps proxying.
	legacy := []struct{ method, path string }{
		{http.MethodPut, "/api/admin/news-sources/source-1/preview"},
		{http.MethodPost, "/api/admin/news-sources/source-1/preview"},
		{http.MethodGet, "/api/admin/news-sources/source-1/preview/extra"},
		{http.MethodGet, "/api/admin/news-sources/a/b/preview"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run/extra"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/a/b/trial-run"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay/extra"},
	}
	for _, tc := range legacy {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlDiscoveryDoesNotShadowNeighbouringRules(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithNewsSources(rules, string(ModeGo))
	rules = WithCrawlWorkflows(rules, string(ModeGo))
	rules = WithCrawlProfiles(rules, string(ModeGo))
	rules = WithCrawlFrontierRuns(rules, string(ModeGo))
	rules = WithCrawlDiscovery(rules, string(ModeGo), string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}

	// news-sources 的既有归属不变：PATCH/DELETE :id、POST :id/run、
	// :id/schedule 仍属于 WithNewsSources；GET :id 没有 Go 规则。
	for _, tc := range []struct {
		method, path, key string
	}{
		{http.MethodPatch, "/api/admin/news-sources/source-1", NewsSourcesKey},
		{http.MethodDelete, "/api/admin/news-sources/source-1", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources/source-1/run", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources/source-1/schedule", NewsSourcesKey},
		{http.MethodGet, "/api/admin/news-sources", NewsSourcesKey},
		{http.MethodPost, "/api/admin/news-sources", NewsSourcesKey},
		{http.MethodGet, "/api/admin/news-sources/options", NewsSourcesKey},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != tc.key {
			t.Fatalf("%s %s = %+v, want go with key %s", tc.method, tc.path, got, tc.key)
		}
	}
	if got := gateway.match(http.MethodGet, "/api/admin/news-sources/source-1"); got.Mode != ModeLegacy {
		t.Fatalf("GET :id mode=%s, want legacy (no Go rule owns it)", got.Mode)
	}

	// workflows 的既有动态规则仍归 WithCrawlWorkflows。
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/versions"},
		{http.MethodPatch, "/api/admin/crawl-frontier/workflows/workflow-1/draft"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/publish"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/compare"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != CrawlWorkflowsKey {
			t.Fatalf("%s %s = %+v, want the crawl workflows handler", tc.method, tc.path, got)
		}
	}

	// workflow-runs 的读取仍归 WithCrawlFrontierRuns。
	for _, tc := range []struct {
		method, path string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/candidates"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/candidates/candidate-1/explanation"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != CrawlFrontierRunsKey {
			t.Fatalf("%s %s = %+v, want the crawl frontier runs handler", tc.method, tc.path, got)
		}
	}

	// profiles 与 runs/nodes 完全不受影响。
	for _, tc := range []struct {
		method, path string
		key          string
	}{
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1", CrawlProfilesKey},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2", CrawlProfilesKey},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1", CrawlFrontierRunsKey},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != tc.key {
			t.Fatalf("%s %s = %+v, want key %s", tc.method, tc.path, got, tc.key)
		}
	}
	// 未接管的 runs 写入仍然回落。
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/api/admin/crawl-frontier/runs"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
