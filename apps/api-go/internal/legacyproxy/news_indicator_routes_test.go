package legacyproxy

import (
	"net/http"
	"testing"
)

// newsIndicatorRoutes 是新闻指标开关为 go 时预期由 Go 接管的 3 条路径与方法。
func newsIndicatorRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/news-indicator/associations"},
		{http.MethodGet, "/api/news-indicator/associations/assoc-1"},
		{http.MethodPost, "/api/news-indicator/refresh"},
	}
}

// newsIndicatorNestRoutes 是开关为 go 时也必须回 NestJS 的路径与方法
// （以及 Go 路由的未列出方法）。Go 不得返回自己的 404。
func newsIndicatorNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodPost, "/api/news-indicator/associations"},
		{http.MethodPut, "/api/news-indicator/associations"},
		{http.MethodDelete, "/api/news-indicator/associations/assoc-1"},
		{http.MethodPost, "/api/news-indicator/associations/assoc-1"},
		{http.MethodGet, "/api/news-indicator/refresh"},
		{http.MethodGet, "/api/news-indicator/associations/assoc-1/extra"},
		{http.MethodGet, "/api/news-indicator/associations/a/b"},
		{http.MethodGet, "/api/news-indicator/associations/"},
		{http.MethodGet, "/api/news-indicator/settings"},
		{http.MethodPut, "/api/news-indicator/settings"},
		{http.MethodPatch, "/api/news-indicator/settings"},
	}
}

func TestNewsIndicatorsGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsIndicators(rules)
	gateway := New(rules)
	for _, tc := range newsIndicatorRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != NewsIndicatorsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	// 精确路径：列表与 refresh 是 Exact，不是 OneSegment；refresh 不得被当成
	// associations/:id。
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/news-indicator/associations"},
		{http.MethodPost, "/api/news-indicator/refresh"},
	} {
		got := gateway.match(tc.method, tc.path)
		if !got.Exact || got.OneSegment || got.Tail != "" {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
	}
	// :id 是恰好一段，不带 Tail。
	got := gateway.match(http.MethodGet, "/api/news-indicator/associations/assoc-1")
	if !got.OneSegment || got.Exact || got.Tail != "" || got.TailSegment {
		t.Fatalf("associations/:id rule=%+v, want one-segment without tail", got)
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range newsIndicatorRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestNewsIndicatorsUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithNewsIndicators(rules)
	gateway := New(rules)
	for _, tc := range newsIndicatorNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
