package rbacapi

import (
	"net/http/httptest"
	"testing"
)

func auditLimit(query string) int {
	request := httptest.NewRequest("GET", "/api/rbac/audit-logs"+query, nil)
	return parseAuditLimit(request)
}

func TestParseAuditLimit(t *testing.T) {
	cases := []struct {
		query string
		want  int
	}{
		{"", 20},          // 缺省
		{"?limit=0", 20},  // 0
		{"?limit=-5", 20}, // 负数
		{"?limit=abc", 20},
		{"?limit=", 20},
		{"?limit=1.9", 1},
		{"?limit=200", 200},
		{"?limit=201", 200},
		{"?limit=20", 20},
	}
	for _, tc := range cases {
		if got := auditLimit(tc.query); got != tc.want {
			t.Fatalf("limit %q = %d, want %d", tc.query, got, tc.want)
		}
	}
}

func TestParseCreateRoleBody(t *testing.T) {
	name, description, permissions, err := parseCreateRoleBody([]byte(`{"name":"  Team Lead  ","description":" ops ","permissions":["roles.read","users.read"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if name != "  Team Lead  " {
		// name trim 由服务层完成（保留原始值），这里断言解析不改写。
		t.Fatalf("name = %q", name)
	}
	if description != " ops " {
		t.Fatalf("description = %q", description)
	}
	if len(permissions) != 2 || permissions[0] != "roles.read" {
		t.Fatalf("permissions = %v", permissions)
	}

	if _, _, _, err := parseCreateRoleBody([]byte(`{"name":42,"permissions":["roles.read"]}`)); err == nil {
		t.Fatal("non-string name was accepted")
	}
	if _, _, _, err := parseCreateRoleBody([]byte(`{"name":"x","permissions":[]}`)); err == nil {
		t.Fatal("empty permissions were accepted")
	}
	if _, _, _, err := parseCreateRoleBody([]byte(`{"name":"x"}`)); err == nil {
		t.Fatal("missing permissions were accepted")
	}
}
