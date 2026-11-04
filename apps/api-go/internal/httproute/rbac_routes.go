package httproute

import "net/http"

// RbacKey 是组织访问控制六条路由的处理器注册键。六条都是精确路径，
// 没有动态段，键与静态前缀相同。
const RbacKey = "/api/rbac"

// WithRbac appends the six organisation access-control routes: GET
// /api/rbac/permissions, GET/POST /api/rbac/roles, POST /api/rbac/assign, GET
// /api/rbac/members and GET /api/rbac/audit-logs. All six are exact paths with a
// method whitelist (OPTIONS preflight included); updateRole has no HTTP route.
func WithRbac(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/permissions", http.MethodGet)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/roles", http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/assign", http.MethodPost)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/members", http.MethodGet)
	return appendExactKeyed(rules, RbacKey, "/api/rbac/audit-logs", http.MethodGet)
}
