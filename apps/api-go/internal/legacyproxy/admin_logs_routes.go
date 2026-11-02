package legacyproxy

import "net/http"

// AdminLogsKey 是管理端日志与异常读取 7 条 GET 的处理器注册键。7 条都是
// 精确路径，没有动态段，键用稳定的静态前缀（与 rbac 同一种做法）。
const AdminLogsKey = "/api/admin/logs"

// WithAdminLogs 只在 mode 为 go 时接管管理端日志与异常读取的 7 条 GET：
//
//	GET /api/admin/logs/task
//	GET /api/admin/logs/task/summary
//	GET /api/admin/logs/errors
//	GET /api/admin/logs/errors/summary
//	GET /api/admin/logs/audit
//	GET /api/admin/errors
//	GET /api/admin/errors/stats
//
// 七条都是精确 path + 方法白名单（预检 OPTIONS 一并交给 Go）。任务日志、
// 异常事件、审计日志仍按当前 orgId 过滤。其他方法（例如 POST
// /api/admin/logs/task）与更长路径继续回落 NestJS——Go 不返回自己的 404。
// /api/admin/quality/（含 /api/admin/quality/task-logs）、/api/observability/
// 与 /api/metrics 不在这个开关里；异常上报 POST 也不在这里。默认（空 /
// legacy）不追加规则。
func WithAdminLogs(rules []Rule) []Rule {
	// 更长的路径先登记，语义上更具体；七条互不遮蔽（都是 Exact）。
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/logs/task/summary", http.MethodGet)
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/logs/errors/summary", http.MethodGet)
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/logs/task", http.MethodGet)
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/logs/errors", http.MethodGet)
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/logs/audit", http.MethodGet)
	rules = appendExactKeyed(rules, AdminLogsKey, "/api/admin/errors/stats", http.MethodGet)
	return appendExactKeyed(rules, AdminLogsKey, "/api/admin/errors", http.MethodGet)
}
