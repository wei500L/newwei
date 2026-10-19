package newsnowsources

import (
	"context"
	"crypto/md5"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ---- wallstreetcn ----

type wallstreetcnItem struct {
	ID           IDValue           `json:"id"`
	Title        string            `json:"title"`
	ContentText  string            `json:"content_text"`
	ContentShort string            `json:"content_short"`
	DisplayTime  int64             `json:"display_time"`
	Type         string            `json:"type"`
	ResourceType string            `json:"resource_type"`
	URI          string            `json:"uri"`
	Resource     *wallstreetcnItem `json:"resource"`
}

// fetchWallstreetcnLive maps the global live channel.
func (s *Service) fetchWallstreetcnLive(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Items []wallstreetcnItem `json:"items"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.Items))
	for _, entry := range response.Data.Items {
		items = append(items, newItem(entry.ID, pickNonEmpty(entry.Title, entry.ContentText), entry.URI).
			extra(dateExtra(Millis(entry.DisplayTime*1000))).
			build())
	}
	return items, nil
}

// fetchWallstreetcnNews keeps only article resources.
func (s *Service) fetchWallstreetcnNews(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://api-one.wallstcn.com/apiv1/content/information-flow?channel=global-channel&accept=article&limit=30", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Items []wallstreetcnItem `json:"items"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.Items))
	for _, entry := range response.Data.Items {
		if entry.Resource == nil {
			continue
		}
		if entry.ResourceType == "theme" || entry.ResourceType == "ad" || entry.Resource.Type == "live" || entry.Resource.URI == "" {
			continue
		}
		resource := *entry.Resource
		items = append(items, newItem(resource.ID, pickNonEmpty(resource.Title, resource.ContentShort), resource.URI).
			extra(dateExtra(Millis(resource.DisplayTime*1000))).
			build())
	}
	return items, nil
}

// fetchWallstreetcnHot maps the all-period hot articles.
func (s *Service) fetchWallstreetcnHot(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			DayItems []wallstreetcnItem `json:"day_items"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.DayItems))
	for _, entry := range response.Data.DayItems {
		items = append(items, newItem(entry.ID, entry.Title, entry.URI).build())
	}
	return items, nil
}

// ---- bilibili ----

type bilibiliVideo struct {
	Bvid    string  `json:"bvid"`
	Title   string  `json:"title"`
	Pubdate int64   `json:"pubdate"`
	Desc    *string `json:"desc"`
	Pic     *string `json:"pic"`
	Owner   struct {
		Name string `json:"name"`
	} `json:"owner"`
	Stat struct {
		View int64 `json:"view"`
		Like int64 `json:"like"`
	} `json:"stat"`
}

// fetchBilibiliHotSearch maps the search hot words.
func (s *Service) fetchBilibiliHotSearch(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://s.search.bilibili.com/main/hotword?limit=30", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		List []struct {
			Keyword  string  `json:"keyword"`
			ShowName string  `json:"show_name"`
			Icon     *string `json:"icon"`
		} `json:"list"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.List))
	for _, entry := range response.List {
		builder := newItem(StringID(entry.Keyword), entry.ShowName,
			"https://search.bilibili.com/all?keyword="+encodeURIComponent(entry.Keyword))
		if entry.Icon != nil {
			builder.extra(&Extra{Icon: IconURL(*entry.Icon)})
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// fetchBilibiliHotVideo maps the popular videos.
func (s *Service) fetchBilibiliHotVideo(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	return s.fetchBilibiliVideoList(ctx, "https://api.bilibili.com/x/web-interface/popular")
}

// fetchBilibiliRanking maps the ranking videos.
func (s *Service) fetchBilibiliRanking(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	return s.fetchBilibiliVideoList(ctx, "https://api.bilibili.com/x/web-interface/ranking/v2")
}

// fetchBilibiliVideoList shares the video mapping of both endpoints.
func (s *Service) fetchBilibiliVideoList(ctx context.Context, endpoint string) ([]NewsItem, error) {
	body, err := s.client.get(ctx, endpoint, nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			List []bilibiliVideo `json:"list"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.List))
	for _, video := range response.Data.List {
		info := video.Owner.Name + " · " + formatPlayCount(video.Stat.View) + "观看 · " +
			formatPlayCount(video.Stat.Like) + "点赞"
		extra := &Extra{Info: InfoText(info)}
		if video.Desc != nil {
			extra.Hover = video.Desc
		}
		if video.Pic != nil {
			extra.Icon = IconURL(*video.Pic)
		}
		items = append(items, newItem(StringID(video.Bvid), video.Title,
			"https://www.bilibili.com/video/"+video.Bvid).
			pubDate(Millis(video.Pubdate*1000)).
			extra(extra).
			build())
	}
	return items, nil
}

// formatPlayCount mirrors formatNumber: 10000+ becomes "<floor>w+".
func formatPlayCount(value int64) string {
	if value >= 10000 {
		return strconv.FormatInt(value/10000, 10) + "w+"
	}
	return strconv.FormatInt(value, 10)
}

// encodeURIComponent mirrors JS encodeURIComponent for the characters that can
// appear in search keywords.
func encodeURIComponent(value string) string {
	escaped := url.QueryEscape(value)
	escaped = strings.ReplaceAll(escaped, "+", "%20")
	// QueryEscape escapes these characters but encodeURIComponent does not.
	replacer := strings.NewReplacer(
		"%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*", "%7E", "~",
	)
	return replacer.Replace(escaped)
}

// ---- xueqiu ----

// fetchXueqiuHotStock bootstraps the anonymous cookie from the quote page and
// then reads the hot stock list.
func (s *Service) fetchXueqiuHotStock(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	cookie, err := s.client.rawCookies(ctx, "https://xueqiu.com/hq")
	if err != nil {
		return nil, err
	}
	body, err := s.client.get(ctx,
		"https://stock.xueqiu.com/v5/stock/hot_stock/list.json?size=30&_type=10&type=10",
		map[string]string{"cookie": cookie})
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Items []struct {
				Code     string  `json:"code"`
				Name     string  `json:"name"`
				Percent  float64 `json:"percent"`
				Exchange string  `json:"exchange"`
				Ad       int     `json:"ad"`
			} `json:"items"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.Items))
	for _, entry := range response.Data.Items {
		if entry.Ad != 0 {
			continue
		}
		items = append(items, newItem(StringID(entry.Code), entry.Name,
			"https://xueqiu.com/s/"+entry.Code).
			extra(&Extra{Info: InfoText(jsNumberString(entry.Percent) + "% " + entry.Exchange)}).
			build())
	}
	return items, nil
}

// ---- tencent ----

type tencentArticle struct {
	ID       IDValue `json:"id"`
	Title    string  `json:"title"`
	Desc     *string `json:"desc"`
	LinkInfo struct {
		URL string `json:"url"`
	} `json:"link_info"`
}

// fetchTencentHot maps the first tab of the morning paper tag.
func (s *Service) fetchTencentHot(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://i.news.qq.com/web_backend/v2/getTagInfo?tagId=aEWqxLtdgmQ%3D",
		map[string]string{"Referer": "https://news.qq.com/"})
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Tabs []struct {
				ArticleList []tencentArticle `json:"articleList"`
			} `json:"tabs"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	if len(response.Data.Tabs) == 0 || response.Data.Tabs[0].ArticleList == nil {
		return []NewsItem{}, nil
	}
	list := response.Data.Tabs[0].ArticleList
	items := make([]NewsItem, 0, len(list))
	for _, entry := range list {
		builder := newItem(entry.ID, entry.Title, entry.LinkInfo.URL)
		if entry.Desc != nil {
			builder.extra(hoverExtra(*entry.Desc))
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// ---- iqiyi ----

// fetchIqiyiHotRanklist maps the TV hot rank list.
func (s *Service) fetchIqiyiHotRanklist(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	endpoint := "https://mesh.if.iqiyi.com/portal/lw/v7/channel/card/videoTab?channelName=recommend" +
		"&data_source=v7_rec_sec_hot_rank_list&tempId=85&count=30&block_id=hot_ranklist" +
		"&device=14a4b5ba98e790dce6dc07482447cf48&from=webapp"
	body, err := s.client.get(ctx, endpoint, map[string]string{"Referer": "https://www.iqiyi.com"})
	if err != nil {
		return nil, err
	}
	var response struct {
		Items []struct {
			Video []struct {
				Data []struct {
					EntityID    IDValue `json:"entity_id"`
					Title       string  `json:"title"`
					PageURL     string  `json:"page_url"`
					ShowDate    string  `json:"showDate"`
					Desc        string  `json:"desc"`
					Description string  `json:"description"`
					Tag         *string `json:"tag"`
				} `json:"data"`
			} `json:"video"`
		} `json:"items"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	if len(response.Items) == 0 || len(response.Items[0].Video) == 0 {
		return []NewsItem{}, nil
	}
	list := response.Items[0].Video[0].Data
	items := make([]NewsItem, 0, len(list))
	for _, entry := range list {
		items = append(items, newItem(entry.EntityID, entry.Title, entry.PageURL).
			pubDate(StringDate(entry.ShowDate)).
			extra(&Extra{
				Hover: &entry.Description,
				Info:  InfoText(entry.Desc),
				Tag:   entry.Tag,
			}).
			build())
	}
	return items, nil
}

// ---- cls ----

type clsItem struct {
	ID       IDValue `json:"id"`
	Title    string  `json:"title"`
	Brief    string  `json:"brief"`
	ShareURL string  `json:"shareurl"`
	CTime    int64   `json:"ctime"`
	IsAd     int     `json:"is_ad"`
}

// clsQuery builds the signed search params: sorted query string, SHA-1 hex, then
// MD5 hex appended as the last `sign` parameter.
func clsQuery() string {
	params := url.Values{}
	params.Set("appName", "CailianpressWeb")
	params.Set("os", "web")
	params.Set("sv", "7.7.5")
	sorted := params.Encode()
	sha := sha1.Sum([]byte(sorted))
	shaHex := hex.EncodeToString(sha[:])
	md5Value := md5.Sum([]byte(shaHex))
	return sorted + "&sign=" + hex.EncodeToString(md5Value[:])
}

// fetchCLSTelegraph maps the ad-free telegraph roll.
func (s *Service) fetchCLSTelegraph(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.cls.cn/nodeapi/updateTelegraphList?"+clsQuery(), nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			RollData []clsItem `json:"roll_data"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.RollData))
	for _, entry := range response.Data.RollData {
		if entry.IsAd != 0 {
			continue
		}
		items = append(items, clsItemToNews(entry, true))
	}
	return items, nil
}

// fetchCLSDepth maps the depth list sorted by creation time descending.
func (s *Service) fetchCLSDepth(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.cls.cn/v3/depth/home/assembled/1000?"+clsQuery(), nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			DepthList []clsItem `json:"depth_list"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	list := make([]clsItem, len(response.Data.DepthList))
	copy(list, response.Data.DepthList)
	sort.SliceStable(list, func(i, j int) bool { return list[i].CTime > list[j].CTime })
	items := make([]NewsItem, 0, len(list))
	for _, entry := range list {
		items = append(items, clsItemToNews(entry, true))
	}
	return items, nil
}

// fetchCLSHot maps the hot article list.
func (s *Service) fetchCLSHot(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.cls.cn/v2/article/hot/list?"+clsQuery(), nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data []clsItem `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		items = append(items, clsItemToNews(entry, false))
	}
	return items, nil
}

// clsItemToNews shares the title/detail mapping; only telegram/depth carry the
// publication time.
func clsItemToNews(entry clsItem, withTime bool) NewsItem {
	builder := newItem(entry.ID, pickNonEmpty(entry.Title, entry.Brief),
		"https://www.cls.cn/detail/"+entry.ID.String()).mobile(entry.ShareURL)
	if withTime {
		builder.pubDate(Millis(entry.CTime * 1000))
	}
	return builder.build()
}

// ---- producthunt ----

// fetchProductHunt maps the GraphQL votes-ordered posts and fails fast when no
// token is configured.
func (s *Service) fetchProductHunt(ctx context.Context, rc RuntimeContext) ([]NewsItem, error) {
	token := firstSecret(rc.Secrets, productHuntSecretKeys)
	if token == "" {
		token = strings.TrimSpace(s.env("PRODUCTHUNT_API_TOKEN"))
	}
	if token == "" {
		return nil, &SecretRequiredError{
			SourceID:     requestedSourceID(rc, "producthunt"),
			RequiredKeys: productHuntSecretKeys,
			Message:      "Product Hunt API token is required; configure a runtime secret or PRODUCTHUNT_API_TOKEN",
		}
	}
	bearer := "Bearer " + stripBearerPrefix(token)
	query := `
    query {
      posts(first: 30, order: VOTES) {
        edges {
          node {
            id
            name
            tagline
            votesCount
            url
            slug
          }
        }
      }
    }
  `
	payload, err := json.Marshal(struct {
		Query string `json:"query"`
	}{Query: query})
	if err != nil {
		return nil, err
	}
	body, err := s.client.postJSON(ctx, "https://api.producthunt.com/v2/api/graphql", map[string]string{
		"Authorization": bearer,
		"Content-Type":  "application/json",
		"Accept":        "application/json",
	}, payload)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Posts struct {
				Edges []struct {
					Node struct {
						ID         IDValue `json:"id"`
						Name       string  `json:"name"`
						Tagline    string  `json:"tagline"`
						VotesCount int64   `json:"votesCount"`
						URL        string  `json:"url"`
						Slug       string  `json:"slug"`
					} `json:"node"`
				} `json:"edges"`
			} `json:"posts"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0)
	for _, edge := range response.Data.Posts.Edges {
		post := edge.Node
		if post.ID.String() == "" || post.Name == "" {
			continue
		}
		url := post.URL
		if url == "" {
			url = "https://www.producthunt.com/posts/" + post.Slug
		}
		items = append(items, newItem(post.ID, post.Name, url).
			extra(&Extra{
				Hover: &post.Tagline,
				Info:  InfoText(" △︎ " + strconv.FormatInt(post.VotesCount, 10)),
			}).
			build())
	}
	return items, nil
}

// productHuntSecretKeys mirrors PRODUCTHUNT_RUNTIME_SECRETS_CONFIG.suggestedKeys.
var productHuntSecretKeys = []string{"token", "api_token", "producthunt.api_token", "producthunt.token"}

// firstSecret returns the first non-empty trimmed value in key order.
func firstSecret(secrets map[string]string, keys []string) string {
	for _, key := range keys {
		value := strings.TrimSpace(secrets[key])
		if value != "" {
			return value
		}
	}
	return ""
}

// stripBearerPrefix mirrors /^bearer\s+/i.
var bearerPrefixPattern = regexp.MustCompile(`(?i)^bearer\s+`)

// stripBearerPrefix removes one optional bearer prefix.
func stripBearerPrefix(value string) string {
	return strings.TrimSpace(bearerPrefixPattern.ReplaceAllString(value, ""))
}

// requestedSourceID mirrors context?.requestedSourceId ?? context?.sourceId.
func requestedSourceID(rc RuntimeContext, fallback string) string {
	if rc.RequestedSourceID != "" {
		return rc.RequestedSourceID
	}
	if rc.SourceID != "" {
		return rc.SourceID
	}
	return fallback
}

// ---- kuaishou ----

// fetchKuaishou parses the Apollo state embedded in the home page without
// executing any upstream JavaScript.
func (s *Service) fetchKuaishou(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.kuaishou.com/?isHome=1", nil)
	if err != nil {
		return nil, err
	}
	match := kuaishouApolloPattern.FindStringSubmatch(string(body))
	if match == nil {
		return nil, fmt.Errorf("无法获取快手热榜数据")
	}
	state := match[1]
	if state == "" {
		return nil, fmt.Errorf("无法解析快手热榜数据")
	}
	var document struct {
		DefaultClient map[string]json.RawMessage `json:"defaultClient"`
	}
	if decodeErr := json.Unmarshal([]byte(state), &document); decodeErr != nil {
		return nil, decodeErr
	}
	rootRaw, ok := document.DefaultClient["ROOT_QUERY"]
	if !ok {
		return nil, fmt.Errorf("无法解析快手热榜数据")
	}
	var root struct {
		VisionHotRank struct {
			ID string `json:"id"`
		} `json:"visionHotRank({\"page\":\"home\"})"`
	}
	if decodeErr := json.Unmarshal(rootRaw, &root); decodeErr != nil {
		return nil, decodeErr
	}
	rankRaw, ok := document.DefaultClient[root.VisionHotRank.ID]
	if !ok {
		return nil, fmt.Errorf("无法解析快手热榜数据")
	}
	var rank struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if decodeErr := json.Unmarshal(rankRaw, &rank); decodeErr != nil {
		return nil, decodeErr
	}

	items := make([]NewsItem, 0, len(rank.Items))
	for _, item := range rank.Items {
		raw, ok := document.DefaultClient[item.ID]
		if !ok {
			continue
		}
		var entry struct {
			Name    string  `json:"name"`
			TagType string  `json:"tagType"`
			IconURL *string `json:"iconUrl"`
		}
		if decodeErr := json.Unmarshal(raw, &entry); decodeErr != nil {
			return nil, decodeErr
		}
		if entry.TagType == "置顶" {
			continue
		}
		word := strings.Replace(item.ID, "VisionHotRankItem:", "", 1)
		builder := newItem(StringID(word), entry.Name,
			"https://www.kuaishou.com/search/video?searchKey="+encodeURIComponent(entry.Name))
		if entry.IconURL != nil {
			builder.extra(&Extra{Icon: IconURL(*entry.IconURL)})
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// kuaishouApolloPattern mirrors the non-dotall JS regular expression.
var kuaishouApolloPattern = regexp.MustCompile(`window\.__APOLLO_STATE__\s*=\s*(\{.+?\});`)

// ---- baidu ----

// fetchBaidu reads the JSON embedded in the HTML comment.
func (s *Service) fetchBaidu(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://top.baidu.com/board?tab=realtime", nil)
	if err != nil {
		return nil, err
	}
	match := baiduDataPattern.FindStringSubmatch(string(body))
	if match == nil {
		return []NewsItem{}, nil
	}
	var document struct {
		Data struct {
			Cards []struct {
				Content []struct {
					IsTop  bool    `json:"isTop"`
					Word   string  `json:"word"`
					RawURL string  `json:"rawUrl"`
					Desc   *string `json:"desc"`
				} `json:"content"`
			} `json:"cards"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal([]byte(match[1]), &document); decodeErr != nil {
		return nil, decodeErr
	}
	if len(document.Data.Cards) == 0 || document.Data.Cards[0].Content == nil {
		return []NewsItem{}, nil
	}
	items := make([]NewsItem, 0)
	for _, entry := range document.Data.Cards[0].Content {
		if entry.IsTop {
			continue
		}
		builder := newItem(StringID(entry.RawURL), entry.Word, entry.RawURL)
		if entry.Desc != nil {
			builder.extra(hoverExtra(*entry.Desc))
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// baiduDataPattern mirrors /<!--s-data:(.*?)-->/s.
var baiduDataPattern = regexp.MustCompile(`(?s)<!--s-data:(.*?)-->`)

// ---- ifeng ----

// fetchIfeng extracts the allData assignment and maps hotNews1.
func (s *Service) fetchIfeng(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.ifeng.com/", nil)
	if err != nil {
		return nil, err
	}
	match := ifengAllDataPattern.FindStringSubmatch(string(body))
	if match == nil {
		return []NewsItem{}, nil
	}
	var document struct {
		HotNews []struct {
			URL      string `json:"url"`
			Title    string `json:"title"`
			NewsTime string `json:"newsTime"`
		} `json:"hotNews1"`
	}
	if decodeErr := json.Unmarshal([]byte(match[1]), &document); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(document.HotNews))
	for _, entry := range document.HotNews {
		items = append(items, newItem(StringID(entry.URL), entry.Title, entry.URL).
			extra(dateExtra(StringDate(entry.NewsTime))).
			build())
	}
	return items, nil
}

// ifengAllDataPattern mirrors /var\s+allData\s*=\s*(\{[\s\S]*?\});/.
var ifengAllDataPattern = regexp.MustCompile(`var\s+allData\s*=\s*(\{[\s\S]*?\});`)

// ---- jin10 ----

// fetchJin10 strips the JavaScript variable wrapper and parses the array without
// executing upstream code.
func (s *Service) fetchJin10(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	endpoint := fmt.Sprintf("https://www.jin10.com/flash_newest.js?t=%d", s.now().UnixMilli())
	body, err := s.client.get(ctx, endpoint, nil)
	if err != nil {
		return nil, err
	}
	jsonText := strings.TrimSpace(jin10PrefixPattern.ReplaceAllString(string(body), ""))
	jsonText = strings.TrimRight(jsonText, ";")
	jsonText = strings.TrimSpace(jsonText)
	entries := make([]struct {
		ID        string `json:"id"`
		Time      string `json:"time"`
		Important int    `json:"important"`
		Data      struct {
			Title   *string `json:"title"`
			Content *string `json:"content"`
		} `json:"data"`
		Channel []int `json:"channel"`
	}, 0)
	if decodeErr := json.Unmarshal([]byte(jsonText), &entries); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(entries))
	for _, entry := range entries {
		title := ""
		if entry.Data.Title != nil {
			title = *entry.Data.Title
		}
		content := ""
		if entry.Data.Content != nil {
			content = *entry.Data.Content
		}
		if title == "" && content == "" {
			continue
		}
		if containsInt(entry.Channel, 5) {
			continue
		}
		text := title
		if text == "" {
			text = content
		}
		text = jin10BoldPattern.ReplaceAllString(text, "")
		cardTitle := text
		var hover *string
		if match := bracketTitlePattern.FindStringSubmatch(text); match != nil {
			cardTitle = match[1]
			desc := match[2]
			hover = &desc
		}
		extra := &Extra{Info: InfoBool(entry.Important != 0)}
		if hover != nil {
			extra.Hover = hover
		}
		items = append(items, newItem(StringID(entry.ID), cardTitle,
			"https://flash.jin10.com/detail/"+entry.ID).
			pubDate(parseRelativeDate(entry.Time, shanghai(), s.now())).
			extra(extra).
			build())
	}
	return items, nil
}

// jin10PrefixPattern removes the leading variable assignment.
var jin10PrefixPattern = regexp.MustCompile(`^var\s+newest\s*=\s*`)

// jin10BoldPattern removes inline bold tags the upstream text uses.
var jin10BoldPattern = regexp.MustCompile(`</?b>`)

// containsInt reports whether values contains target.
func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// ---- qqvideo ----

// qqVideoRequestBody is the exact POST body of the TV hot-search card.
type qqVideoRequestBody struct {
	PageParams struct {
		RankChannelID   string `json:"rank_channel_id"`
		RankName        string `json:"rank_name"`
		RankPageSize    string `json:"rank_page_size"`
		TabMvlSubModID  string `json:"tab_mvl_sub_mod_id"`
		TabName         string `json:"tab_name"`
		TabType         string `json:"tab_type"`
		TabVlDataSource string `json:"tab_vl_data_src"`
		PageID          string `json:"page_id"`
		PageType        string `json:"page_type"`
		SourceKey       string `json:"source_key"`
		TagID           string `json:"tag_id"`
		TagType         string `json:"tag_type"`
		NewMarkLabel    string `json:"new_mark_label_enabled"`
	} `json:"page_params"`
	PageContext struct {
		PageIndex string `json:"page_index"`
	} `json:"page_context"`
	FlipInfo struct {
		PageStrategyID string      `json:"page_strategy_id"`
		PageModuleID   string      `json:"page_module_id"`
		ModuleStrategy emptyObject `json:"module_strategy_id"`
		SubModuleID    string      `json:"sub_module_id"`
		FlipParams     struct {
			FoldingScreenShowNum string `json:"folding_screen_show_num"`
			IsMvl                string `json:"is_mvl"`
			MvlStrategyInfo      string `json:"mvl_strategy_info"`
			MvlSubModID          string `json:"mvl_sub_mod_id"`
			PadPostShowNum       string `json:"pad_post_show_num"`
			PadProPostShowNum    string `json:"pad_pro_post_show_num"`
			PadProSmallHorNum    string `json:"pad_pro_small_hor_pic_display_num"`
			PadSmallHorNum       string `json:"pad_small_hor_pic_display_num"`
			PageID               string `json:"page_id"`
			PageNum              string `json:"page_num"`
			PageType             string `json:"page_type"`
			PostShowNum          string `json:"post_show_num"`
			ShakeSize            string `json:"shake_size"`
			SmallHorNum          string `json:"small_hor_pic_display_num"`
			SourceKey            string `json:"source_key"`
			UnPolicyID           string `json:"un_policy_id"`
			UnStrategyID         string `json:"un_strategy_id"`
		} `json:"flip_params"`
		RelaceChildrenKey []string `json:"relace_children_key"`
	} `json:"flip_info"`
}

// emptyObject marshals as {} for the fixed empty module-strategy object.
type emptyObject struct{}

// fetchQQVideoTVHotSearch maps the TV hot-search rank card.
func (s *Service) fetchQQVideoTVHotSearch(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	var request qqVideoRequestBody
	request.PageParams.RankChannelID = "100113"
	request.PageParams.RankName = "HotSearch"
	request.PageParams.RankPageSize = "30"
	request.PageParams.TabMvlSubModID = "792ac_19e77Sub_1b2"
	request.PageParams.TabName = "热搜榜"
	request.PageParams.TabType = "hot_rank"
	request.PageParams.TabVlDataSource = "f5200deb4596bbf3"
	request.PageParams.PageID = "scms_shake"
	request.PageParams.PageType = "scms_shake"
	request.PageParams.NewMarkLabel = "1"
	request.PageContext.PageIndex = "1"
	request.FlipInfo.PageModuleID = "792ac_19e77"
	request.FlipInfo.SubModuleID = "20251106065177"
	request.FlipInfo.FlipParams.IsMvl = "1"
	request.FlipInfo.FlipParams.MvlStrategyInfo = `{"default_strategy_id":"06755800b45b49238582a6fa1ad0f5c5","default_version":"3836","hit_page_uuid":"b5080d97dc694a5fb50eb9e7c99326ac","hit_tab_info":null,"gray_status_info":null,"bypass_to_un_exp_id":""}`
	request.FlipInfo.FlipParams.MvlSubModID = "20251106065177"
	request.FlipInfo.FlipParams.PageID = "scms_shake"
	request.FlipInfo.FlipParams.PageNum = "0"
	request.FlipInfo.FlipParams.PageType = "scms_shake"
	request.FlipInfo.FlipParams.SourceKey = "100113"
	request.FlipInfo.FlipParams.UnPolicyID = "06755800b45b49238582a6fa1ad0f5c5"
	request.FlipInfo.FlipParams.UnStrategyID = "06755800b45b49238582a6fa1ad0f5c5"
	request.FlipInfo.RelaceChildrenKey = []string{}

	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	body, err := s.client.postJSON(ctx,
		"https://pbaccess.video.qq.com/trpc.vector_layout.page_view.PageService/getCard?video_appid=3000010&vversion_platform=2",
		map[string]string{"Referer": "https://v.qq.com/"}, payload)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			Card struct {
				ChildrenList struct {
					List struct {
						Cards []struct {
							ID     string `json:"id"`
							Params struct {
								Title       string  `json:"title"`
								PublishDate *string `json:"publish_date"`
								SubTitle    *string `json:"sub_title"`
							} `json:"params"`
						} `json:"cards"`
					} `json:"list"`
				} `json:"children_list"`
			} `json:"card"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	cards := response.Data.Card.ChildrenList.List.Cards
	items := make([]NewsItem, 0, len(cards))
	today := dayjsToday(s.now())
	for _, card := range cards {
		published := today
		if card.Params.PublishDate != nil {
			published = *card.Params.PublishDate
		}
		builder := newItem(StringID(card.ID), card.Params.Title,
			"https://v.qq.com/x/cover/"+card.ID+".html").
			pubDate(StringDate(published))
		if card.Params.SubTitle != nil {
			builder.extra(hoverExtra(*card.Params.SubTitle))
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// ---- coolapk ----

// fetchCoolapk generates the device token headers and maps the daily hot list.
func (s *Service) fetchCoolapk(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	endpoint := "https://api.coolapk.com/v6/page/dataList?url=%2Ffeed%2FstatList%3FcacheExpires%3D300%26statType%3Dday%26sortField%3Ddetailnum%26title%3D%E4%BB%8A%E6%97%A5%E7%83%AD%E9%97%A8&title=%E4%BB%8A%E6%97%A5%E7%83%AD%E9%97%A8&subTitle=&page=1"
	body, err := s.client.get(ctx, endpoint, coolapkHeaders(s.now(), randomBase36))
	if err != nil {
		return nil, err
	}
	var response struct {
		Data []struct {
			ID          string `json:"id"`
			Message     string `json:"message"`
			EditorTitle string `json:"editor_title"`
			URL         string `json:"url"`
			TargetRow   *struct {
				SubTitle string `json:"subTitle"`
			} `json:"targetRow"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	if len(response.Data) == 0 {
		return nil, fmt.Errorf("Failed to fetch")
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		if entry.ID == "" {
			continue
		}
		title := entry.EditorTitle
		if title == "" {
			text := ""
			if fragment, fragmentErr := parseHTMLFragment(entry.Message); fragmentErr == nil {
				text = nodeText(fragment)
			}
			title = strings.Split(text, "\n")[0]
		}
		builder := newItem(StringID(entry.ID), title, "https://www.coolapk.com"+entry.URL)
		if entry.TargetRow != nil {
			builder.extra(&Extra{Info: InfoText(entry.TargetRow.SubTitle)})
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// coolapkHeaders mirrors genHeaders: a random device id, a rounded second
// timestamp, and the base64/MD5 app token.
func coolapkHeaders(now time.Time, random func(int) string) map[string]string {
	deviceID := strings.Join([]string{
		random(8), random(4), random(4), random(4), random(12),
	}, "-")
	seconds := math.Floor(float64(now.UnixMilli())/1000 + 0.5)
	hexNow := fmt.Sprintf("0x%x", int64(seconds))
	md5Now := md5Hex(strconv.FormatInt(int64(seconds), 10))
	source := "token://com.coolapk.market/c67ef5943784d09750dcfbb31020f0ab?" + md5Now + "$" + deviceID + "&com.coolapk.market"
	encoded := base64.StdEncoding.EncodeToString([]byte(source))
	token := md5Hex(encoded) + deviceID + hexNow
	return map[string]string{
		"X-Requested-With": "XMLHttpRequest",
		"X-App-Id":         "com.coolapk.market",
		"X-App-Token":      token,
		"X-Sdk-Int":        "29",
		"X-Sdk-Locale":     "zh-CN",
		"X-App-Version":    "11.0",
		"X-Api-Version":    "11",
		"X-App-Code":       "2101202",
		"User-Agent":       "Dalvik/2.1.0 (Linux; U; Android 10; Redmi K30 5G MIUI/V12.0.3.0.QGICMXM) (#Build; Redmi; Redmi K30 5G; QKQ1.191222.002 test-keys; 10) +CoolMarket/11.0-2101202",
	}
}

// md5Hex returns the lowercase hex MD5 of value.
func md5Hex(value string) string {
	sum := md5.Sum([]byte(value))
	return hex.EncodeToString(sum[:])
}

// randomBase36 mirrors Math.random().toString(36).substring(2, 2+length).
func randomBase36(length int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	out := make([]byte, 0, length)
	for index := 0; index < length; index++ {
		out = append(out, alphabet[rand.Intn(len(alphabet))])
	}
	return string(out)
}

// ---- douyin ----

// fetchDouyin bootstraps the anonymous cookie and maps the hot search list.
func (s *Service) fetchDouyin(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	cookie, err := s.client.rawCookies(ctx, "https://login.douyin.com/")
	if err != nil {
		return nil, err
	}
	body, err := s.client.get(ctx,
		"https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1",
		map[string]string{"cookie": cookie})
	if err != nil {
		return nil, err
	}
	var response struct {
		Data struct {
			WordList []struct {
				SentenceID string `json:"sentence_id"`
				Word       string `json:"word"`
			} `json:"word_list"`
		} `json:"data"`
	}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.WordList))
	for _, entry := range response.Data.WordList {
		items = append(items, newItem(StringID(entry.SentenceID), entry.Word,
			"https://www.douyin.com/hot/"+entry.SentenceID).build())
	}
	return items, nil
}
