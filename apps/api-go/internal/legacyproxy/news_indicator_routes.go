package legacyproxy

import "net/http"

// NewsIndicatorsKey 是新闻指标关联分析接口的处理器注册键。
const NewsIndicatorsKey = "/api/news-indicator"

// WithNewsIndicators 只在 mode 为 go 时接管新闻指标关联分析的 3 条 HTTP：
//
//	GET  /api/news-indicator/associations（精确）
//	POST /api/news-indicator/refresh（精确）
//	GET  /api/news-indicator/associations/:id（恰好一段）
//
// 注册顺序：列表与 refresh 都是精确路径，先注册；关联详情是恰好一段的
// :id，只匹配 GET。GraphQL 的两个只读 query（newsIndicatorAssociations、
// newsIndicatorAssociation）落到 /graphql，由 API_GO_GRAPHQL_READ_MODE 与
// API_GO_NEWS_INDICATORS_MODE 共同决定，不在这个路由表里。未列出的方法
// （PUT/DELETE 等）与更长路径继续回落 NestJS（Go 不返回自己的 404）。
func WithNewsIndicators(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	base := "/api/news-indicator"
	rules = appendExactKeyed(rules, NewsIndicatorsKey, base+"/associations", http.MethodGet)
	rules = appendExactKeyed(rules, NewsIndicatorsKey, base+"/refresh", http.MethodPost)
	return appendSegmentRule(rules, NewsIndicatorsKey, base+"/associations/", true, false, "", http.MethodGet)
}
