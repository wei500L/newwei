package legacyproxy

import (
	"net/http"
	"testing"
)

// goRoutes 是开关为 go 时预期由 Go 接管的路径与方法。
func crawlWorkflowRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/node-schemas"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/compare"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1"},
		{http.MethodPatch, "/api/admin/crawl-frontier/workflows/workflow-1/draft"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/publish"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/versions"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-versions/version-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge"},
		{http.MethodGet, "/api/admin/crawl-frontier/news-sources/source-1/workflow-bridge"},
	}
}

// stayLegacy 是开关为 go 时也必须回 NestJS 的路径与方法（以及 Go 路由的
// 错误方法）。Go 不得返回自己的 404。
func crawlWorkflowNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// trial-run、replay、workflow-runs 留在 Nest。
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/candidates"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1/candidates/candidate-1/explanation"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflow-runs/run-1/replay"},
		// profiles 列表、创建、预览、回滚留回 Nest。
		{http.MethodGet, "/api/admin/crawl-frontier/profiles"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/match"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/preview"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodPatch, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/versions"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2"},
		// runs 与 nodes 留在 Nest。
		{http.MethodGet, "/api/admin/crawl-frontier/runs"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs"},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/run-1/cancel"},
		{http.MethodGet, "/api/admin/crawl-frontier/nodes/node-1"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry"},
		// Go 路由的未列出方法回落 Nest。
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/draft"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/publish"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/versions"},
		{http.MethodPut, "/api/admin/crawl-frontier/workflows"},
		{http.MethodDelete, "/api/admin/crawl-frontier/workflows/workflow-1"},
		{http.MethodPatch, "/api/admin/crawl-frontier/workflows/workflow-1/publish"},
		// 更长路径不落在 :id 规则上。
		{http.MethodPatch, "/api/admin/crawl-frontier/workflows/workflow-1/draft/extra"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-versions/version-1/extra"},
		{http.MethodGet, "/api/admin/crawl-frontier/news-sources/source-1/workflow-bridge/extra"},
		// 恰好两段不是一段，不匹配 bridge 的 :id 规则。
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/a/b/workflow-bridge"},
	}
}

func TestCrawlWorkflowsStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, "")
	rules = WithCrawlWorkflows(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(crawlWorkflowRoutes(), crawlWorkflowNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlWorkflowsGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlWorkflowRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != CrawlWorkflowsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	// node-schemas 与 compare 是精确路径，不能被当成 workflows/:id。
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/node-schemas"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/compare"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.Exact || got.OneSegment || got.Tail != "" {
			t.Fatalf("%s %s was treated as :id: %+v", tc.method, tc.path, got)
		}
	}
	// :id 的三条后缀路由与恰好一段的 :id 规则各自独立。
	for _, tc := range []struct {
		method, path, tail string
	}{
		{http.MethodPatch, "/api/admin/crawl-frontier/workflows/workflow-1/draft", "/draft"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/publish", "/publish"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1/versions", "/versions"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/workflow-1", ""},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-versions/version-1", ""},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge", "/workflow-bridge"},
		{http.MethodGet, "/api/admin/crawl-frontier/news-sources/source-1/workflow-bridge", "/workflow-bridge"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.OneSegment || got.Exact || got.Tail != tc.tail {
			t.Fatalf("%s %s rule=%+v, want one-segment tail=%q", tc.method, tc.path, got, tc.tail)
		}
	}
}

func TestCrawlWorkflowsUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlWorkflowNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答；无预检头的 OPTIONS 与未列出方法回落 Nest。
	for _, tc := range crawlWorkflowRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}
