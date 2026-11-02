package legacyproxy

import "net/http"

// 分析工作台三个 HTTP 开关的处理器注册键。动态路径的规则 Prefix 带尾部
// 斜杠，查找键用这些静态值，这样看板处理器不会接到任务创建。
const (
	AnalysisViewsKey    = "/api/analysis/views"
	AnalysisBoardsKey   = "/api/analysis/boards"
	AnalysisColumnsKey  = "/api/analysis/columns"
	AnalysisTasksKey    = "/api/analysis/tasks"
	AnalysisThreadsKey  = "/api/analysis/threads"
	AnalysisCommentsKey = "/api/analysis/comments"
)

// WithAnalysisViews 在 mode 为 go 时接管 5 条保存视图路由。
// 集合是精确路径；详情恰好一个非空段。更长路径、其他方法和 exports 不在此列。
func WithAnalysisViews(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AnalysisViewsKey, "/api/analysis/views",
		http.MethodGet, http.MethodPost)
	return appendSegmentRule(rules, AnalysisViewsKey, "/api/analysis/views/", true, false, "",
		http.MethodGet, http.MethodPatch, http.MethodDelete)
}

// WithAnalysisBoards 在 mode 为 go 时接管 13 条看板、列和任务路由。
// 任务创建挂在 /boards/:id/tasks，但处理器键是 AnalysisTasksKey。
// 讨论计数和删除清理不由这个开关决定。
func WithAnalysisBoards(rules []Rule) []Rule {
	rules = appendExactKeyed(rules, AnalysisBoardsKey, "/api/analysis/boards",
		http.MethodGet, http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "",
		http.MethodGet, http.MethodPatch, http.MethodDelete)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "/columns",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisBoardsKey, "/api/analysis/boards/", true, false, "/columns/reorder",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/boards/", true, false, "/tasks",
		http.MethodPost)
	rules = appendSegmentRule(rules, AnalysisColumnsKey, "/api/analysis/columns/", true, false, "",
		http.MethodPatch, http.MethodDelete)
	rules = appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/tasks/", true, false, "",
		http.MethodPatch, http.MethodDelete)
	return appendSegmentRule(rules, AnalysisTasksKey, "/api/analysis/tasks/", true, false, "/move",
		http.MethodPost)
}

// WithAnalysisThreads 在 mode 为 go 时接管 5 条讨论和评论路由。
// 主体路径恰好两段；评论集合在这两段之后精确接 /comments。
func WithAnalysisThreads(rules []Rule) []Rule {
	rules = appendSegmentRule(rules, AnalysisThreadsKey, "/api/analysis/threads/", false, true, "",
		http.MethodGet, http.MethodPut)
	rules = appendSegmentRule(rules, AnalysisThreadsKey, "/api/analysis/threads/", false, true, "/comments",
		http.MethodPost)
	return appendSegmentRule(rules, AnalysisCommentsKey, "/api/analysis/comments/", true, false, "",
		http.MethodPatch, http.MethodDelete)
}

func appendExactKeyed(rules []Rule, key, path string, methods ...string) []Rule {
	set := map[string]bool{http.MethodOptions: true}
	for _, method := range methods {
		set[method] = true
	}
	return append(rules, Rule{
		Prefix:     path,
		Exact:      true,
		HandlerKey: key,
		Methods:    set,
	})
}

func appendSegmentRule(rules []Rule, key, prefix string, one, two bool, tail string, methods ...string) []Rule {
	set := map[string]bool{http.MethodOptions: true}
	for _, method := range methods {
		set[method] = true
	}
	return append(rules, Rule{
		Prefix:      prefix,
		OneSegment:  one,
		TwoSegments: two,
		Tail:        tail,
		HandlerKey:  key,
		Methods:     set,
	})
}
