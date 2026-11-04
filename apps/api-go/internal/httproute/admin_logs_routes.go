package httproute

import "net/http"

// AdminLogsKey is the handler registration key for the seven admin log and error
// GET routes. All seven are exact paths with no dynamic segment, so the key is a
// stable static prefix.
const AdminLogsKey = "/api/admin/logs"

// WithAdminLogs appends the seven admin log and error GET routes:
// /api/admin/logs/task, /logs/task/summary, /logs/errors, /logs/errors/summary,
// /logs/audit, /api/admin/errors and /api/admin/errors/stats. All seven are exact
// paths with a GET method whitelist (OPTIONS preflight included) and filter by the
// identity orgId.
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
