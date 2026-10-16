package legacyproxy

import "net/http"

// CrawlTemplatesKey 是采集模板编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlTemplatesKey = "/api/admin/crawl-templates"

// WithCrawlTemplates 只在 mode 为 go 时接管采集模板（admin/crawl-templates）
// 的 4 条编辑接口：
//
//	GET/POST /api/admin/crawl-templates（精确）
//	PATCH/DELETE /api/admin/crawl-templates/:id（恰好一段）
//
// 注册顺序：先精确路径列表/创建，再恰好一段的 :id（只匹配 PATCH 与
// DELETE）。GET /:id 详情没有迁移，未列出的方法（PUT、GET :id 等）与
// 更长路径都继续回落 NestJS（Go 不返回自己的 404）。crawl-tasks、
// crawl4ai 队列与 metadata 也不在这个开关里。
func WithCrawlTemplates(rules []Rule, mode string) []Rule {
	if mode != string(ModeGo) {
		return rules
	}
	base := "/api/admin/crawl-templates"
	// 精确路径先行：列表与创建不是 :id。
	rules = appendExactKeyed(rules, CrawlTemplatesKey, base, http.MethodGet, http.MethodPost)
	return appendSegmentRule(rules, CrawlTemplatesKey, base+"/", true, false, "", http.MethodPatch, http.MethodDelete)
}
