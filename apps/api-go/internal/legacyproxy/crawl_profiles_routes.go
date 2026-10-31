package legacyproxy

import "net/http"

// CrawlProfilesKey 是采集站点画像编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlProfilesKey = "/api/admin/crawl-frontier/profiles"

// WithCrawlProfiles 只在 mode 为 go 时接管采集站点画像（crawl-frontier
// profiles）的 8 条编辑接口：
//
//	GET/POST /api/admin/crawl-frontier/profiles（精确）
//	GET      /api/admin/crawl-frontier/profiles/match（精确）
//	POST     /api/admin/crawl-frontier/profiles/preview（精确）
//	GET      /api/admin/crawl-frontier/profiles/:id（恰好一段）
//	PATCH    /api/admin/crawl-frontier/profiles/:id（恰好一段）
//	GET      /api/admin/crawl-frontier/profiles/:id/versions（恰好一段 + /versions）
//	POST     /api/admin/crawl-frontier/profiles/:id/rollback/:version（恰好一段 + /rollback + 末尾恰好一段）
//
// 注册顺序：profiles/match 与 profiles/preview 是精确路径，先于 :id——
// match/preview 不会被当成 id。runs、nodes、workflows、trial-run、
// workflow-runs 与 /profiles/:id/workflow-bridge 都不在这个开关里，继续
// 回落 NestJS（Go 不返回自己的 404）。
func WithCrawlProfiles(rules []Rule) []Rule {
	base := "/api/admin/crawl-frontier/profiles"
	// 精确路径先行：match 与 preview 不是 :id。
	rules = appendExactKeyed(rules, CrawlProfilesKey, base, http.MethodGet, http.MethodPost)
	rules = appendExactKeyed(rules, CrawlProfilesKey, base+"/match", http.MethodGet)
	rules = appendExactKeyed(rules, CrawlProfilesKey, base+"/preview", http.MethodPost)
	// 回滚：:id 之后固定接 /rollback 和恰好一段 version。
	rules = appendTailSegmentRule(rules, CrawlProfilesKey, base+"/", "/rollback", http.MethodPost)
	// :id 的 versions 与恰好一段的 :id。
	rules = appendSegmentRule(rules, CrawlProfilesKey, base+"/", true, false, "/versions", http.MethodGet)
	return appendSegmentRule(rules, CrawlProfilesKey, base+"/", true, false, "", http.MethodGet, http.MethodPatch)
}

// appendTailSegmentRule 注册「恰好一段 + 固定中间段 + 末尾恰好一段」的
// 动态规则（Rule.TailSegment，例如 /profiles/:id/rollback/:version）。
func appendTailSegmentRule(rules []Rule, key, prefix, tail string, methods ...string) []Rule {
	set := map[string]bool{http.MethodOptions: true}
	for _, method := range methods {
		set[method] = true
	}
	return append(rules, Rule{
		Prefix:      prefix,
		OneSegment:  true,
		Tail:        tail,
		TailSegment: true,
		HandlerKey:  key,
		Methods:     set,
	})
}
