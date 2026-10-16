package legacyproxy

import (
	"net/http"
	"testing"
)

// llmLogRoutes 是 LLM 请求日志开关为 go 时预期由 Go 接管的 3 条路径与方法。
func llmLogRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/llm-logs"},
		{http.MethodGet, "/api/llm-logs/export"},
		{http.MethodGet, "/api/llm-logs/summary"},
	}
}

// llmLogNestRoutes 是开关为 go 时也必须回 NestJS 的路径与方法（未列出的
// 方法与更长的路径），以及始终不属于本开关的日志设置接口。
func llmLogNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// 未列出的方法回落 Nest。
		{http.MethodPost, "/api/llm-logs"},
		{http.MethodPut, "/api/llm-logs"},
		{http.MethodDelete, "/api/llm-logs/export"},
		// 更长路径、尾部斜杠与多段路径回落 Nest。
		{http.MethodGet, "/api/llm-logs/export/extra"},
		{http.MethodGet, "/api/llm-logs/summary/"},
		{http.MethodGet, "/api/llm-logs/"},
		{http.MethodGet, "/api/llm-logs/a/b"},
		{http.MethodGet, "/api/llm-logs-other"},
		// 日志设置接口会改 Mongo TTL 索引，不在这个开关里。
		{http.MethodGet, "/api/system-settings/llm-request-logs"},
		{http.MethodPut, "/api/system-settings/llm-request-logs"},
	}
}

func TestLlmLogsStayLegacyByDefault(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLlmLogs(rules, "")
	rules = WithLlmLogs(rules, "legacy")
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range append(llmLogRoutes(), llmLogNestRoutes()...) {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}

func TestLlmLogsGoOwnsRoutes(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLlmLogs(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmLogRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Mode != ModeGo {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Mode)
		}
		if !got.Exact || got.OneSegment || got.TwoSegments || got.Tail != "" || got.TailSegment {
			t.Fatalf("%s %s rule=%+v, want exact without dynamic segments", tc.method, tc.path, got)
		}
		key := got.Prefix
		if got.HandlerKey != "" {
			key = got.HandlerKey
		}
		if key != LlmLogsKey {
			t.Fatalf("%s %s key=%s", tc.method, tc.path, key)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range llmLogRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Mode != ModeGo {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Mode)
		}
	}
}

func TestLlmLogsUnmigratedRoutesStayNest(t *testing.T) {
	rules := DefaultRules(ModeShadow, "")
	rules = WithLlmLogs(rules, string(ModeGo))
	gateway, err := New("http://legacy:4000", rules)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range llmLogNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Mode != ModeLegacy {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Mode)
		}
	}
}
