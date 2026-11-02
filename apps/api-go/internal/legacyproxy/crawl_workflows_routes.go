package legacyproxy

import "net/http"

// CrawlWorkflowsKey 是采集策略工作流编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlWorkflowsKey = "/api/admin/crawl-frontier/workflows"

// WithCrawlWorkflows 只在 mode 为 go 时接管采集策略工作流的编辑接口：
//
//	GET  /api/admin/crawl-frontier/workflows/node-schemas（精确）
//	GET/POST /api/admin/crawl-frontier/workflows（精确）
//	POST /api/admin/crawl-frontier/workflows/compare（精确）
//	PATCH /api/admin/crawl-frontier/workflows/:id/draft（恰好一段 + /draft）
//	POST /api/admin/crawl-frontier/workflows/:id/publish（恰好一段 + /publish）
//	GET /api/admin/crawl-frontier/workflows/:id/versions（恰好一段 + /versions）
//	GET /api/admin/crawl-frontier/workflows/:id（恰好一段）
//	GET /api/admin/crawl-frontier/workflow-versions/:versionId（恰好一段）
//	GET /api/admin/crawl-frontier/profiles/:id/workflow-bridge（恰好一段 + /workflow-bridge）
//	GET /api/admin/crawl-frontier/news-sources/:id/workflow-bridge（恰好一段 + /workflow-bridge）
//
// 注册顺序：先精确路径 node-schemas 与 compare，再 :id 的 draft、publish、
// versions，最后才是恰好一段的 :id——compare 不得被当成 id。
//
// trial-run、replay、workflow-runs、profiles 列表/创建/预览/回滚、runs 与
// nodes 都不在这个开关里，继续回落 NestJS（Go 不返回自己的 404）。
func WithCrawlWorkflows(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier"
	// 精确路径先行：node-schemas 与 compare 不是 :id。
	rules = appendExactKeyed(rules, CrawlWorkflowsKey, base+"/workflows/node-schemas", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlWorkflowsKey, base+"/workflows", http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, CrawlWorkflowsKey, base+"/workflows/compare", http.MethodPost)
	// :id 的 draft、publish、versions 都是恰好一段 + 固定后缀。
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/workflows/", true, false, "/draft", http.MethodPatch)
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/workflows/", true, false, "/publish", http.MethodPost)
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/workflows/", true, false, "/versions", http.MethodGet)
	// 恰好一段的 :id 放最后，只匹配 GET。
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/workflows/", true, false, "", http.MethodGet)
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/workflow-versions/", true, false, "", http.MethodGet)
	rules = appendSegmentRule(rules, CrawlWorkflowsKey, base+"/profiles/", true, false, "/workflow-bridge", http.MethodGet)
	return appendSegmentRule(rules, CrawlWorkflowsKey, base+"/news-sources/", true, false, "/workflow-bridge", http.MethodGet)
}
