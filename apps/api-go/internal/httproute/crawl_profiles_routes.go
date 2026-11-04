package httproute

import "net/http"

// CrawlProfilesKey 是采集站点画像编辑接口的处理器注册键。
// 动态路径的规则 Prefix 带尾部斜杠，键用稳定的静态前缀。
const CrawlProfilesKey = "/api/admin/crawl-frontier/profiles"

// WithCrawlProfiles appends the eight crawl-site profile editing routes: exact
// GET/POST profiles, GET profiles/match, POST profiles/preview; one-segment
// GET/PATCH profiles/:id, GET profiles/:id/versions, and POST
// profiles/:id/rollback/:version. Exact paths are registered before the :id
// shapes so match and preview are never treated as an id.
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
