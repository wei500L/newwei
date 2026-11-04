package httproute

import "net/http"

// CrawlWorkflowsKey 是采集策略工作流编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlWorkflowsKey = "/api/admin/crawl-frontier/workflows"

// WithCrawlWorkflows appends the crawl-strategy workflow editing routes: exact
// GET workflows/node-schemas, GET/POST workflows and POST workflows/compare;
// one-segment-plus-suffix PATCH workflows/:id/draft, POST workflows/:id/publish
// and GET workflows/:id/versions; and one-segment GET workflows/:id,
// workflow-versions/:versionId, profiles/:id/workflow-bridge and
// news-sources/:id/workflow-bridge. Exact paths are registered before the :id
// shapes so compare is never treated as an id.
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
