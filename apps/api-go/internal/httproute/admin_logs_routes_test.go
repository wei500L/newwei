package httproute

import (
	"net/http"
	"testing"
)

// adminLogsRoutes are the admin log and error routes this package's rule table
// must match.
func adminLogsRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/admin/logs/task"},
		{http.MethodGet, "/api/admin/logs/task/summary"},
		{http.MethodGet, "/api/admin/logs/errors"},
		{http.MethodGet, "/api/admin/logs/errors/summary"},
		{http.MethodGet, "/api/admin/logs/audit"},
		{http.MethodGet, "/api/admin/errors"},
		{http.MethodGet, "/api/admin/errors/stats"},
	}
}

// adminLogsNestRoutes are paths and methods the rule table must not claim; the
// router answers them with its 404 contract.
func adminLogsNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// 只接管 GET：其它方法回落 Nest。
		{http.MethodPost, "/api/admin/logs/task"},
		{http.MethodPost, "/api/admin/logs/audit"},
		{http.MethodDelete, "/api/admin/errors"},
		{http.MethodPost, "/api/admin/errors/stats"},
		// 更长路径、空段与父路径回落 Nest。
		{http.MethodGet, "/api/admin/logs/task/extra"},
		{http.MethodGet, "/api/admin/logs/errors/extra"},
		{http.MethodGet, "/api/admin/logs/"},
		{http.MethodGet, "/api/admin/logs"},
		{http.MethodGet, "/api/admin/errors/extra"},
		// quality、observability、metrics 与异常上报 POST 不属于本开关。
		{http.MethodGet, "/api/admin/quality/task-logs"},
		{http.MethodGet, "/api/admin/quality/classification"},
		{http.MethodPost, "/api/admin/quality/task-logs"},
		{http.MethodGet, "/api/observability/exception-events/clients"},
		{http.MethodPost, "/api/internal/observability/exception-events"},
		{http.MethodGet, "/api/metrics"},
	}
}

func TestAdminLogsGoOwnsSevenRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithAdminLogs(rules)
	gateway := New(rules)
	for _, tc := range adminLogsRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact || got.OneSegment || got.TwoSegments || got.Tail != "" || got.TailSegment {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != AdminLogsKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, AdminLogsKey)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range adminLogsRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestAdminLogsUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithAdminLogs(rules)
	gateway := New(rules)
	for _, tc := range adminLogsNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
