package legacyproxy

import "net/http"

// QualityOverviewKey 是管理端质量面板 5 条只读 GET 的处理器注册键。5 条
// 都是精确路径，没有动态段，键用稳定的静态前缀（与 admin logs 同一种
// 做法）。
const QualityOverviewKey = "/api/admin/quality"

// WithQualityOverview 只在 mode 为 go 时接管管理端质量面板的 5 条 GET：
//
//	GET /api/admin/quality/news-sources
//	GET /api/admin/quality/pipeline
//	GET /api/admin/quality/overview
//	GET /api/admin/quality/task-logs
//	GET /api/admin/quality/task-logs/summary
//
// 五条都是精确 path + 方法白名单（预检 OPTIONS 一并交给 Go）。其他方法
// （如 POST /api/admin/quality/task-logs）与更长路径继续回落 NestJS——Go
// 不返回自己的 404。因此 /api/admin/quality/pipeline/runs（含 /replay、
// /rollback，pipeline-recovery.controller.ts）与
// /api/admin/quality/classification/*（classification-quality.controller.ts）
// 都不被 /api/admin/quality/pipeline 或 /api/admin/quality/task-logs 吃掉。
// 默认（空 / legacy）不追加规则。
func WithQualityOverview(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	// 更长的路径先登记，语义上更具体；五条互不遮蔽（都是 Exact）。
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/task-logs/summary", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/task-logs", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/news-sources", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/pipeline", http.MethodGet)
	return appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/overview", http.MethodGet)
}
