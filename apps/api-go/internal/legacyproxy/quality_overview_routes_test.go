package legacyproxy

import (
	"net/http"
	"testing"
)

// qualityOverviewRoutes 是质量面板开关为 go 时预期由 Go 接管的 5 条路径。
func qualityOverviewRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/quality/news-sources"},
		{http.MethodGet, "/api/admin/quality/pipeline"},
		{http.MethodGet, "/api/admin/quality/overview"},
		{http.MethodGet, "/api/admin/quality/task-logs"},
		{http.MethodGet, "/api/admin/quality/task-logs/summary"},
	}
}

// qualityOverviewNestRoutes 是开关为 go 时也必须回 NestJS 的方法与路径
// （未列出的方法、更长路径、classification 与 pipeline-recovery）。Go 不得
// 返回自己的 404。
func qualityOverviewNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// 只接管 GET：其它方法回落 Nest。
		{http.MethodPost, "/api/admin/quality/task-logs"},
		{http.MethodPost, "/api/admin/quality/pipeline"},
		{http.MethodDelete, "/api/admin/quality/overview"},
		// 更长路径、空段与父路径回落 Nest；精确匹配不得被更短前缀吃掉。
		{http.MethodGet, "/api/admin/quality/pipeline/runs"},
		{http.MethodPost, "/api/admin/quality/pipeline/replay"},
		{http.MethodPost, "/api/admin/quality/pipeline/rollback"},
		{http.MethodGet, "/api/admin/quality/classification/summary"},
		{http.MethodGet, "/api/admin/quality/classification/queue"},
		{http.MethodGet, "/api/admin/quality/task-logs/extra"},
		{http.MethodGet, "/api/admin/quality/news-sources/extra"},
		{http.MethodGet, "/api/admin/quality/"},
		{http.MethodGet, "/api/admin/quality"},
		{http.MethodGet, "/api/admin/quality/unknown"},
		// admin/logs 与 observability 不属于本开关。
		{http.MethodGet, "/api/admin/logs/task"},
		{http.MethodGet, "/api/observability/exception-events/clients"},
	}
}

func TestQualityOverviewStaysLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithQualityOverview(rules, "")
	rules = WithQualityOverview(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(qualityOverviewRoutes(), qualityOverviewNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestQualityOverviewGoOwnsFiveRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithQualityOverview(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range qualityOverviewRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact || got.OneSegment || got.TwoSegments || got.Tail != "" || got.TailSegment {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != QualityOverviewKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, QualityOverviewKey)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range qualityOverviewRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestQualityOverviewUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithQualityOverview(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range qualityOverviewNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
