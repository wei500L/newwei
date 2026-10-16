package legacyproxy

import "net/http"

// RbacKey 是组织访问控制六条路由的处理器注册键。六条都是精确路径，
// 没有动态段，键与静态前缀相同。
const RbacKey = "/api/rbac"

// WithRbac 只在 mode 为 go 时接管组织访问控制的六条 HTTP：
//
//	GET  /api/rbac/permissions
//	GET  /api/rbac/roles
//	POST /api/rbac/roles
//	POST /api/rbac/assign
//	GET  /api/rbac/members
//	GET  /api/rbac/audit-logs
//
// 六条都是精确 path + 方法白名单（预检 OPTIONS 一并交给 Go）。其他方法
// （例如 DELETE /api/rbac/roles）与更长路径（例如 /api/rbac/roles/:id）
// 不在此列，继续回落 NestJS——Go 不返回自己的 404。默认（空 / legacy）
// 不追加规则。本开关不新增 updateRole 的 HTTP。
func WithRbac(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/permissions", http.MethodGet)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/roles", http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/assign", http.MethodPost)
	rules = appendExactKeyed(rules, RbacKey, "/api/rbac/members", http.MethodGet)
	return appendExactKeyed(rules, RbacKey, "/api/rbac/audit-logs", http.MethodGet)
}
