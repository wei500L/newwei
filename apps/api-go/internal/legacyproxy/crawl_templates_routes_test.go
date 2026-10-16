package legacyproxy

import (
	"net/http"
	"testing"
)

// crawlTemplateRoutes 是采集模板开关为 go 时预期由 Go 接管的 4 条路径与方法。
func crawlTemplateRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-templates"},
		{http.MethodPost, "/api/admin/crawl-templates"},
		{http.MethodPatch, "/api/admin/crawl-templates/template-1"},
		{http.MethodDelete, "/api/admin/crawl-templates/template-1"},
	}
}

// crawlTemplateNestRoutes 是开关为 go 时也必须回 NestJS 的路径与方法
// （以及 Go 路由的未列出方法）。Go 不得返回自己的 404。
func crawlTemplateNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// GET 详情没有迁移：Go 路由只列 PATCH/DELETE，GET :id 回 Nest。
		{http.MethodGet, "/api/admin/crawl-templates/template-1"},
		// 未列出的方法回落 Nest。
		{http.MethodPut, "/api/admin/crawl-templates"},
		{http.MethodPut, "/api/admin/crawl-templates/template-1"},
		{http.MethodPost, "/api/admin/crawl-templates/template-1"},
		// 更长路径与空段/多段路径回落 Nest。
		{http.MethodGet, "/api/admin/crawl-templates/template-1/extra"},
		{http.MethodPatch, "/api/admin/crawl-templates/a/b"},
		{http.MethodDelete, "/api/admin/crawl-templates/a/b"},
		{http.MethodPatch, "/api/admin/crawl-templates/"},
		{http.MethodGet, "/api/admin/crawl-templates/"},
		// crawl-tasks、metadata、crawl4ai 队列与 media-assets 不属于本开关。
		{http.MethodGet, "/api/crawl-tasks"},
		{http.MethodPost, "/api/crawl-tasks"},
		{http.MethodPost, "/api/crawl-tasks/metadata"},
		{http.MethodPost, "/api/crawl4ai/queue"},
		{http.MethodGet, "/api/admin/crawl4ai/quality"},
	}
}

func TestCrawlTemplatesStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlTemplates(rules, "")
	rules = WithCrawlTemplates(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(crawlTemplateRoutes(), crawlTemplateNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestCrawlTemplatesGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlTemplates(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlTemplateRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != CrawlTemplatesKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	// 精确路径：列表/创建是 Exact，不是 OneSegment。
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/crawl-templates"},
		{http.MethodPost, "/api/admin/crawl-templates"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.Exact || got.OneSegment || got.Tail != "" {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
	}
	// :id 是恰好一段，不带 Tail。
	for _, tc := range []struct{ method, path string }{
		{http.MethodPatch, "/api/admin/crawl-templates/template-1"},
		{http.MethodDelete, "/api/admin/crawl-templates/template-1"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.OneSegment || got.Exact || got.Tail != "" || got.TailSegment {
			t.Fatalf("%s %s rule=%+v, want one-segment without tail", tc.method, tc.path, got)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range crawlTemplateRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestCrawlTemplatesUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithCrawlTemplates(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range crawlTemplateNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
