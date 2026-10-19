package newsnowsources

import "context"

// buildGetters registers one getter per reachable registry id. Redirect parents
// (v2ex, mktnews, wallstreetcn, 36kr, pcbeta, cls, xueqiu, fastbull, github,
// bilibili, chongbuluo, tencent, qqvideo, iqiyi) are resolved before this map is
// queried, so they intentionally have no separate entry. The 64-id metadata
// itself comes from the generated registry port, not from this map.
func (s *Service) buildGetters() map[string]Getter {
	return map[string]Getter{
		"v2ex-share":            s.fetchV2ex,
		"zhihu":                 s.fetchZhihu,
		"weibo":                 s.fetchWeibo,
		"zaobao":                s.fetchZaobao,
		"coolapk":               s.fetchCoolapk,
		"mktnews-flash":         s.fetchMktnewsFlash,
		"wallstreetcn-quick":    s.fetchWallstreetcnLive,
		"wallstreetcn-news":     s.fetchWallstreetcnNews,
		"wallstreetcn-hot":      s.fetchWallstreetcnHot,
		"36kr-quick":            s.fetch36krQuick,
		"36kr-renqi":            s.fetch36krRenqi,
		"douyin":                s.fetchDouyin,
		"hupu":                  s.fetchHupu,
		"tieba":                 s.fetchTieba,
		"toutiao":               s.fetchToutiao,
		"ithome":                s.fetchIthome,
		"thepaper":              s.fetchThepaper,
		"sputniknewscn":         s.fetchSputnik,
		"cankaoxiaoxi":          s.fetchCankaoxiaoxi,
		"pcbeta-windows11":      s.fetchPcbetaWindows11,
		"cls-telegraph":         s.fetchCLSTelegraph,
		"cls-depth":             s.fetchCLSDepth,
		"cls-hot":               s.fetchCLSHot,
		"xueqiu-hotstock":       s.fetchXueqiuHotStock,
		"gelonghui":             s.fetchGelonghui,
		"fastbull-express":      s.fetchFastbullExpress,
		"fastbull-news":         s.fetchFastbullNews,
		"solidot":               s.fetchSolidot,
		"hackernews":            s.fetchHackerNews,
		"producthunt":           s.fetchProductHunt,
		"github-trending-today": s.fetchGithubTrending,
		"bilibili-hot-search":   s.fetchBilibiliHotSearch,
		"bilibili-hot-video":    s.fetchBilibiliHotVideo,
		"bilibili-ranking":      s.fetchBilibiliRanking,
		"kuaishou":              s.fetchKuaishou,
		"kaopu":                 s.fetchKaopu,
		"jin10":                 s.fetchJin10,
		"baidu":                 s.fetchBaidu,
		"nowcoder":              s.fetchNowcoder,
		"sspai":                 s.fetchSspai,
		"juejin":                s.fetchJuejin,
		"ifeng":                 s.fetchIfeng,
		"chongbuluo-hot":        s.fetchChongbuluoHot,
		"chongbuluo-latest":     s.fetchChongbuluoLatest,
		"douban":                s.fetchDouban,
		"steam":                 s.fetchSteam,
		"tencent-hot":           s.fetchTencentHot,
		"freebuf":               s.fetchFreebuf,
		"qqvideo-tv-hotsearch":  s.fetchQQVideoTVHotSearch,
		"iqiyi-hot-ranklist":    s.fetchIqiyiHotRanklist,
	}
}

// fetchPcbetaWindows11 maps the Windows 11 board RSS feed.
func (s *Service) fetchPcbetaWindows11(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	return s.fetchRSSSource(ctx, "https://bbs.pcbeta.com/forum.php?mod=rss&fid=563&auth=0")
}
