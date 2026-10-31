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

func TestCrawlProfilesGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithCrawlProfiles(rules)
	gateway := New(rules)
	for _, tc := range crawlProfileRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
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
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestCrawlProfilesUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithCrawlProfiles(rules)
	gateway := New(rules)
	for _, tc := range crawlProfileNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}

// 两个开关互不影响：画像路由归画像键，工作流与 bridge 归工作流键。
func TestCrawlProfilesIndependentFromWorkflows(t *testing.T) {
	rules := BaseRules()
	rules = WithCrawlWorkflows(rules)
	rules = WithCrawlProfiles(rules)
	rules = WithCrawlWorkflowTrial(rules)
	gateway := New(rules)
	for _, tc := range crawlProfileRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != CrawlProfilesKey {
			t.Fatalf("%s %s rule=%+v, want profiles key", tc.method, tc.path, got)
		}
	}
	// workflow routes and the profile workflow-bridge stay on the workflows key.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-frontier/profiles/profile-1/workflow-bridge"},
		{http.MethodGet, "/api/admin/crawl-frontier/workflows"},
	} {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" || got.HandlerKey != CrawlWorkflowsKey {
			t.Fatalf("%s %s rule=%+v, want workflows key", tc.method, tc.path, got)
		}
	}
	// The trial-run POST is owned by its own switch/handler key, independent of
	// the profiles and workflows keys.
	if got := gateway.match(http.MethodPost, "/api/admin/crawl-frontier/workflows/workflow-1/trial-run"); got.Prefix == "" || got.HandlerKey != CrawlWorkflowTrialKey {
		t.Fatalf("POST trial-run rule=%+v, want workflow-trial key", got)
	}
}
