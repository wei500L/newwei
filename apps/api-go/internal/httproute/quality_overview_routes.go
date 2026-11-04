package httproute

import "net/http"

// QualityOverviewKey is the handler registration key for the five read-only
// quality-overview GET routes. All five are exact paths with no dynamic segment,
// so the key is a stable static prefix.
const QualityOverviewKey = "/api/admin/quality"

// WithQualityOverview appends the five read-only quality-overview GET routes:
// /api/admin/quality/news-sources, /pipeline, /overview, /task-logs and
// /task-logs/summary. All five are exact paths with a GET method whitelist
// (OPTIONS preflight included), so /pipeline/runs and /pipeline/classification/*
// are not claimed here.
func WithQualityOverview(rules []Rule) []Rule {
	// 更长的路径先登记，语义上更具体；五条互不遮蔽（都是 Exact）。
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/task-logs/summary", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/task-logs", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/news-sources", http.MethodGet)
	rules = appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/pipeline", http.MethodGet)
	return appendExactKeyed(rules, QualityOverviewKey, "/api/admin/quality/overview", http.MethodGet)
}
