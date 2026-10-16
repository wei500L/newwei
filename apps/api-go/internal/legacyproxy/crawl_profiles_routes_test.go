package legacyproxy

import (
	"net/http"
	"testing"
)

// crawlProfileRoutes 是画像开关为 go 时预期由 Go 接管的 8 条路径与方法。
func crawlProfileRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/profiles"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/match"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/preview"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodPatch, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/versions"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2"},
		// parseInt 语义：版本段可以是 "10abc" 这类前缀数字。
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/10abc"},
	}
}

// crawlProfileNestRoutes 是画像开关为 go 时也必须回 NestJS 的路径与方法
// （以及 Go 路由的未列出方法）。Go 不得返回自己的 404。
func crawlProfileNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// runs 与 nodes 留在 Nest。
		{http.MethodGet, "/api/admin/crawl-frontier/runs"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs"},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/runs/run-1/workflow-run"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/cancel"},
		{http.MethodPost, "/api/admin/crawl-frontier/runs/run-1/cancel"},
		{http.MethodGet, "/api/admin/crawl-frontier/nodes/node-1"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/retry"},
		{http.MethodPost, "/api/admin/crawl-frontier/nodes/node-1/retry"},
		// workflows 与 workflow-runs 由工作流开关决定，不属于本开关。
		{http.MethodGet, "/api/admin/crawl-frontier/workflows"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows/node-schemas"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflow-runs/run-1"},
		// workflow-bridge 是工作流开关的路由。
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge"},
		// Go 路由未列出的方法与更长/更短路径回落 Nest。
		{http.MethodDelete, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodPut, "/api/admin/crawl-frontier/profiles"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2"},
		{http.MethodPatch, "/api/admin/crawl-frontier/profiles/profile-1/versions"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/versions"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/a/b"},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/versions/extra"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2/extra"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/a/b/rollback/2"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles//rollback/2"},
	}
}

func TestCrawlProfilesStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlProfiles(rules, "")
	rules = WithCrawlProfiles(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(crawlProfileRoutes(), crawlProfileNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlProfilesGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlProfileRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != CrawlProfilesKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	// match 与 preview 是精确路径，不能被当成 profiles/:id。
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/match"},
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/preview"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.Exact || got.OneSegment || got.Tail != "" {
			t.Fatalf("%s %s was treated as :id: %+v", tc.method, tc.path, got)
		}
	}
	// 回滚是 :id + /rollback + 恰好一段 version；versions 与详情各自独立。
	for _, tc := range []struct {
		method, path, tail string
		tailSegment        bool
	}{
		{http.MethodPost, "/api/admin/crawl-frontier/profiles/profile-1/rollback/2", "/rollback", true},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/versions", "/versions", false},
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1", "", false},
		{http.MethodPatch, "/api/admin/crawl-frontier/profiles/profile-1", "", false},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.OneSegment || got.Exact || got.Tail != tc.tail || got.TailSegment != tc.tailSegment {
			t.Fatalf("%s %s rule=%+v, want one-segment tail=%q tailSegment=%v", tc.method, tc.path, got, tc.tail, tc.tailSegment)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range crawlProfileRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestCrawlProfilesUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlProfileNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

// 两个开关互不影响：画像开关只加画像规则，不吞工作流与 bridge。
func TestCrawlProfilesIndependentFromWorkflows(t *testing.T) {
	// profiles=go、workflows=legacy：8 条画像路由接管；workflows 与
	// workflow-bridge 仍回 Nest。
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, "")
	rules = WithCrawlProfiles(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlProfileRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
	}
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows"},
		{http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"},
	} {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}

	// profiles=legacy、workflows=go：bridge 归工作流键；画像路由回落。
	rules = DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, string(ModeGo))
	rules = WithCrawlProfiles(rules, string(ModeLegacy))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlProfileRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
	bridge := gateway.match(http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge")
	if bridge.Mode != ModeGo || bridge.HandlerKey != CrawlWorkflowsKey {
		t.Fatalf("bridge rule=%+v, want workflows key", bridge)
	}

	// 两个都是 go：bridge 归工作流键，画像路由归画像键。
	rules = DefaultRules(ModeShadow, "")
	rules = WithCrawlWorkflows(rules, string(ModeGo))
	rules = WithCrawlProfiles(rules, string(ModeGo))
	gateway, err = New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlProfileRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo || got.HandlerKey != CrawlProfilesKey {
			t.Fatalf("%s %s rule=%+v, want profiles key", tc.method, tc.path, got)
		}
	}
	bridge = gateway.match(http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge")
	if bridge.Mode != ModeGo || bridge.HandlerKey != CrawlWorkflowsKey {
		t.Fatalf("bridge rule=%+v, want workflows key", bridge)
	}
}
