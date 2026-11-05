package httproute

import (
	"net/http"
	"testing"
)

// llmLogRoutes are the LLM request-log routes this package's rule table must
// match.
func llmLogRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/llm-logs"},
		{http.MethodGet, "/api/llm-logs/export"},
		{http.MethodGet, "/api/llm-logs/summary"},
	}
}

// llmLogNestRoutes are paths and methods the rule table must not claim; the
// router answers them with its 404 contract.
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

func TestLlmLogsGoOwnsRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithLlmLogs(rules)
	gateway := New(rules)
	for _, tc := range llmLogRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
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
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestLlmLogsUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithLlmLogs(rules)
	gateway := New(rules)
	for _, tc := range llmLogNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
