package httproute

import (
	"net/http"
	"testing"
)

// rbacRoutes are the RBAC routes this package's rule table must match.
func rbacRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		{http.MethodGet, "/api/rbac/permissions"},
		{http.MethodGet, "/api/rbac/roles"},
		{http.MethodPost, "/api/rbac/roles"},
		{http.MethodPost, "/api/rbac/assign"},
		{http.MethodGet, "/api/rbac/members"},
		{http.MethodGet, "/api/rbac/audit-logs"},
	}
}

// rbacNestRoutes are paths and methods the rule table must not claim; the router
// answers them with its 404 contract.
func rbacNestRoutes() []struct{ method, path string } {
	return []struct{ method, path string }{
		// 未列出的方法回落 Nest。
		{http.MethodDelete, "/api/rbac/roles"},
		{http.MethodPut, "/api/rbac/permissions"},
		{http.MethodGet, "/api/rbac/assign"},
		{http.MethodPost, "/api/rbac/members"},
		{http.MethodPatch, "/api/rbac/audit-logs"},
		// 更长路径回落 Nest。
		{http.MethodGet, "/api/rbac/roles/role-1"},
		{http.MethodPatch, "/api/rbac/roles/role-1"},
		{http.MethodPost, "/api/rbac/roles/role-1"},
		{http.MethodGet, "/api/rbac/permissions/extra"},
		{http.MethodPost, "/api/rbac/assign/extra"},
		{http.MethodGet, "/api/rbac/members/user-1"},
		{http.MethodGet, "/api/rbac/audit-logs/extra"},
	}
}

func TestRbacGoOwnsSixRoutes(t *testing.T) {
	rules := BaseRules()
	rules = WithRbac(rules)
	gateway := New(rules)
	for _, tc := range rbacRoutes() {
		got := gateway.match(tc.method, tc.path)
		if got.Prefix == "" {
			t.Fatalf("%s %s mode=%s, want go", tc.method, tc.path, got.Prefix)
		}
		if !got.Exact || got.OneSegment || got.Tail != "" {
			t.Fatalf("%s %s was not exact: %+v", tc.method, tc.path, got)
		}
		if got.HandlerKey != RbacKey {
			t.Fatalf("%s %s key=%s, want %s", tc.method, tc.path, got.HandlerKey, RbacKey)
		}
	}
	// 预检 OPTIONS 由 Go 路由回答。
	for _, tc := range rbacRoutes() {
		if got := gateway.match(http.MethodOptions, tc.path); got.Prefix == "" {
			t.Fatalf("OPTIONS %s mode=%s, want go", tc.path, got.Prefix)
		}
	}
}

func TestRbacUnmigratedRoutesStayNest(t *testing.T) {
	rules := BaseRules()
	rules = WithRbac(rules)
	gateway := New(rules)
	for _, tc := range rbacNestRoutes() {
		if got := gateway.match(tc.method, tc.path); got.Prefix != "" {
			t.Fatalf("%s %s mode=%s, want legacy", tc.method, tc.path, got.Prefix)
		}
	}
}
