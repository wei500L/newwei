package httproute

import "net/http"

// NewsIndicatorsKey 是新闻指标关联分析接口的处理器注册键。
const NewsIndicatorsKey = "/api/news-indicator"

// WithNewsIndicators appends the three news-indicator association routes:
// GET /api/news-indicator/associations (exact), POST /api/news-indicator/refresh
// (exact) and GET /api/news-indicator/associations/:id (one segment, GET only).
func WithNewsIndicators(rules []Rule) []Rule {
	base := "/api/news-indicator"
	rules = appendExactKeyed(rules, NewsIndicatorsKey, base+"/associations", http.MethodGet)
	rules = appendExactKeyed(rules, NewsIndicatorsKey, base+"/refresh", http.MethodPost)
	return appendSegmentRule(rules, NewsIndicatorsKey, base+"/associations/", true, false, "", http.MethodGet)
}
