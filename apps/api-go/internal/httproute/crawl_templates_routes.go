package httproute

import "net/http"

// CrawlTemplatesKey 是采集模板编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlTemplatesKey = "/api/admin/crawl-templates"

// WithCrawlTemplates appends the four crawl-template editing routes: exact
// GET/POST /api/admin/crawl-templates and one-segment PATCH/DELETE
// /api/admin/crawl-templates/:id. The exact list/create path is registered before
// the :id shape.
func WithCrawlTemplates(rules []Rule) []Rule {
	base := "/api/admin/crawl-templates"
	// 精确路径先行：列表与创建不是 :id。
	rules = appendExactKeyed(rules, CrawlTemplatesKey, base, http.MethodGet, http.MethodPost)
	return appendSegmentRule(rules, CrawlTemplatesKey, base+"/", true, false, "", http.MethodPatch, http.MethodDelete)
}
