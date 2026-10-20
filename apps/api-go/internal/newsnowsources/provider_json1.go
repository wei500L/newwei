package newsnowsources

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// parallel runs fn for every index concurrently and returns results in index
// order. It mirrors Promise.all: every call is started, and the first error by
// index is returned.
func parallel[T any](count int, fn func(index int) (T, error)) ([]T, error) {
	results := make([]T, count)
	errs := make([]error, count)
	var wait sync.WaitGroup
	wait.Add(count)
	for index := 0; index < count; index++ {
		go func(i int) {
			defer wait.Done()
			results[i], errs[i] = fn(i)
		}(index)
	}
	wait.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}

// parseISODateMillis parses the ISO-ish timestamps the JSON APIs return.
func parseISODateMillis(value string) (int64, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return millisOf(parsed), true
		}
	}
	return 0, false
}

// itemBuilder is a tiny fluent helper that keeps provider mappings readable
// while preserving omitted-vs-empty member semantics.
type itemBuilder struct {
	item NewsItem
}

// newItem starts one item with the three mandatory members.
func newItem(id IDValue, title, url string) *itemBuilder {
	return &itemBuilder{item: NewsItem{ID: id, Title: title, URL: url}}
}

// mobile sets mobileUrl.
func (b *itemBuilder) mobile(url string) *itemBuilder {
	b.item.MobileURL = &url
	return b
}

// pubDate sets pubDate.
func (b *itemBuilder) pubDate(value DateValue) *itemBuilder {
	b.item.PubDate = &value
	return b
}

// extra attaches extension fields.
func (b *itemBuilder) extra(extra *Extra) *itemBuilder {
	b.item.Extra = extra
	return b
}

// build returns the assembled item.
func (b *itemBuilder) build() NewsItem { return b.item }

// hoverExtra builds an Extra with only hover.
func hoverExtra(hover string) *Extra { return &Extra{Hover: &hover} }

// hoverInfoExtra builds hover plus info.
func hoverInfoExtra(hover, info string) *Extra {
	return &Extra{Hover: &hover, Info: InfoText(info)}
}

// dateExtra builds an Extra with only date.
func dateExtra(date DateValue) *Extra { return &Extra{Date: &date} }

// ---- v2ex ----

type v2exFeedItem struct {
	ID            string  `json:"id"`
	Title         string  `json:"title"`
	URL           string  `json:"url"`
	DatePublished string  `json:"date_published"`
	DateModified  *string `json:"date_modified"`
}

type v2exFeed struct {
	Items []v2exFeedItem `json:"items"`
}

// fetchV2ex aggregates the four V2EX JSON feeds concurrently and sorts by the
// modified-or-published date string descending.
func (s *Service) fetchV2ex(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	feeds := []string{"create", "ideas", "programmer", "share"}
	documents, err := parallel(len(feeds), func(index int) (*v2exFeed, error) {
		body, fetchErr := s.client.get(ctx, "https://www.v2ex.com/feed/"+feeds[index]+".json", nil)
		if fetchErr != nil {
			return nil, fetchErr
		}
		document := &v2exFeed{}
		if decodeErr := json.Unmarshal(body, document); decodeErr != nil {
			return nil, decodeErr
		}
		return document, nil
	})
	if err != nil {
		return nil, err
	}

	type datedItem struct {
		item NewsItem
		date string
	}
	collected := make([]datedItem, 0)
	for _, document := range documents {
		for _, entry := range document.Items {
			date := entry.DatePublished
			if entry.DateModified != nil {
				date = *entry.DateModified
			}
			collected = append(collected, datedItem{
				item: newItem(StringID(entry.ID), entry.Title, entry.URL).
					extra(dateExtra(StringDate(date))).
					build(),
				date: date,
			})
		}
	}
	sort.SliceStable(collected, func(i, j int) bool { return collected[i].date > collected[j].date })
	items := make([]NewsItem, 0, len(collected))
	for _, entry := range collected {
		items = append(items, entry.item)
	}
	return items, nil
}

// ---- zhihu ----

type zhihuEntry struct {
	Target struct {
		TitleArea struct {
			Text string `json:"text"`
		} `json:"title_area"`
		ExcerptArea struct {
			Text string `json:"text"`
		} `json:"excerpt_area"`
		MetricsArea struct {
			Text string `json:"text"`
		} `json:"metrics_area"`
		Link struct {
			URL string `json:"url"`
		} `json:"link"`
	} `json:"target"`
}

type zhihuResponse struct {
	Data []zhihuEntry `json:"data"`
}

// fetchZhihu maps the hot list feed. The item id is the trailing numeric segment
// of the link, falling back to the whole URL.
func (s *Service) fetchZhihu(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web?limit=20&desktop=true", nil)
	if err != nil {
		return nil, err
	}
	response := zhihuResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		link := entry.Target.Link.URL
		id := link
		if index := strings.LastIndex(link, "/"); index >= 0 {
			last := link[index+1:]
			if isAllDigits(last) {
				id = last
			}
		}
		items = append(items, newItem(StringID(id), entry.Target.TitleArea.Text, link).
			extra(&Extra{
				Hover: &entry.Target.ExcerptArea.Text,
				Info:  InfoText(entry.Target.MetricsArea.Text),
			}).
			build())
	}
	return items, nil
}

// isAllDigits reports whether value is a non-empty digit run.
func isAllDigits(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

// ---- tieba ----

type tiebaResponse struct {
	Data struct {
		BangTopic struct {
			TopicList []struct {
				TopicID   IDValue `json:"topic_id"`
				TopicName string  `json:"topic_name"`
				TopicURL  string  `json:"topic_url"`
			} `json:"topic_list"`
		} `json:"bang_topic"`
	} `json:"data"`
}

// fetchTieba maps the hot topic list.
func (s *Service) fetchTieba(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://tieba.baidu.com/hottopic/browse/topicList", nil)
	if err != nil {
		return nil, err
	}
	response := tiebaResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	list := response.Data.BangTopic.TopicList
	items := make([]NewsItem, 0, len(list))
	for _, entry := range list {
		items = append(items, newItem(entry.TopicID, entry.TopicName, entry.TopicURL).build())
	}
	return items, nil
}

// ---- toutiao ----

type toutiaoResponse struct {
	Data []struct {
		ClusterID string `json:"ClusterIdStr"`
		Title     string `json:"Title"`
		LabelURI  *struct {
			URL string `json:"url"`
		} `json:"LabelUri"`
	} `json:"data"`
}

// fetchToutiao maps the hot board.
func (s *Service) fetchToutiao(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc", nil)
	if err != nil {
		return nil, err
	}
	response := toutiaoResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		builder := newItem(StringID(entry.ClusterID), entry.Title,
			"https://www.toutiao.com/trending/"+entry.ClusterID+"/")
		if entry.LabelURI != nil {
			builder.extra(&Extra{Icon: IconURL(entry.LabelURI.URL)})
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// ---- douban ----

type doubanResponse struct {
	Items []struct {
		ID           IDValue `json:"id"`
		Title        string  `json:"title"`
		CardSubtitle string  `json:"card_subtitle"`
	} `json:"items"`
}

// fetchDouban maps recent hot movies.
func (s *Service) fetchDouban(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie", map[string]string{
		"Referer": "https://movie.douban.com/",
		"Accept":  "application/json, text/plain, */*",
	})
	if err != nil {
		return nil, err
	}
	response := doubanResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Items))
	for _, movie := range response.Items {
		parts := strings.Split(movie.CardSubtitle, " / ")
		if len(parts) > 3 {
			parts = parts[:3]
		}
		info := strings.Join(parts, " / ")
		url := "https://movie.douban.com/subject/" + movie.ID.String()
		items = append(items, newItem(movie.ID, movie.Title, url).
			extra(hoverInfoExtra(movie.CardSubtitle, info)).
			build())
	}
	return items, nil
}

// ---- nowcoder ----

type nowcoderResponse struct {
	Data struct {
		Result []struct {
			ID    IDValue `json:"id"`
			Title string  `json:"title"`
			Type  int     `json:"type"`
			UUID  string  `json:"uuid"`
		} `json:"result"`
	} `json:"data"`
}

// fetchNowcoder maps the two link shapes; every other type has no URL and is
// dropped by normalizeItems, so it is skipped here.
func (s *Service) fetchNowcoder(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	url := fmt.Sprintf("https://gw-c.nowcoder.com/api/sparta/hot-search/top-hot-pc?size=20&_=%d&t=", s.now().UnixMilli())
	body, err := s.client.get(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	response := nowcoderResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.Result))
	for _, entry := range response.Data.Result {
		switch entry.Type {
		case 74:
			items = append(items, newItem(StringID(entry.UUID), entry.Title,
				"https://www.nowcoder.com/feed/main/detail/"+entry.UUID).build())
		case 0:
			items = append(items, newItem(entry.ID, entry.Title,
				"https://www.nowcoder.com/discuss/"+entry.ID.String()).build())
		}
	}
	return items, nil
}

// ---- sspai ----

type sspaiResponse struct {
	Data []struct {
		ID    IDValue `json:"id"`
		Title string  `json:"title"`
	} `json:"data"`
}

// fetchSspai maps the hot article tag page.
func (s *Service) fetchSspai(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	url := fmt.Sprintf("https://sspai.com/api/v1/article/tag/page/get?limit=30&offset=0&created_at=%d&tag=%%E7%%83%%AD%%E9%%97%%A8%%E6%%96%%87%%E7%%AB%%A0&released=false", s.now().UnixMilli())
	body, err := s.client.get(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	response := sspaiResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		items = append(items, newItem(entry.ID, entry.Title, "https://sspai.com/post/"+entry.ID.String()).build())
	}
	return items, nil
}

// ---- juejin ----

type juejinResponse struct {
	Data []struct {
		Content struct {
			Title     string `json:"title"`
			ContentID string `json:"content_id"`
		} `json:"content"`
	} `json:"data"`
}

// fetchJuejin maps the hot article rank.
func (s *Service) fetchJuejin(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://api.juejin.cn/content_api/v1/content/article_rank?category_id=1&type=hot&spider=0", nil)
	if err != nil {
		return nil, err
	}
	response := juejinResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data))
	for _, entry := range response.Data {
		items = append(items, newItem(StringID(entry.Content.ContentID), entry.Content.Title,
			"https://juejin.cn/post/"+entry.Content.ContentID).build())
	}
	return items, nil
}

// ---- thepaper ----

type thepaperResponse struct {
	Data struct {
		HotNews []struct {
			ContID IDValue `json:"contId"`
			Name   string  `json:"name"`
		} `json:"hotNews"`
	} `json:"data"`
}

// fetchThepaper maps the right sidebar hot news.
func (s *Service) fetchThepaper(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://cache.thepaper.cn/contentapi/wwwIndex/rightSidebar", nil)
	if err != nil {
		return nil, err
	}
	response := thepaperResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(response.Data.HotNews))
	for _, entry := range response.Data.HotNews {
		contID := entry.ContID.String()
		items = append(items, newItem(entry.ContID, entry.Name,
			"https://www.thepaper.cn/newsDetail_forward_"+contID).
			mobile("https://m.thepaper.cn/newsDetail_forward_"+contID).
			build())
	}
	return items, nil
}

// ---- kaopu ----

type kaopuEntry struct {
	Description string `json:"description"`
	Link        string `json:"link"`
	PubDate     string `json:"pub_date"`
	Publisher   string `json:"publisher"`
	Title       string `json:"title"`
}

// fetchKaopu maps the public news list and drops the two excluded publishers.
func (s *Service) fetchKaopu(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://kaopustorage.blob.core.windows.net/news-prod/news_list_hans_0.json", nil)
	if err != nil {
		return nil, err
	}
	entries := make([]kaopuEntry, 0)
	if decodeErr := json.Unmarshal(body, &entries); decodeErr != nil {
		return nil, decodeErr
	}
	items := make([]NewsItem, 0, len(entries))
	for _, entry := range entries {
		if entry.Publisher == "财新" || entry.Publisher == "公视" {
			continue
		}
		items = append(items, newItem(StringID(entry.Link), entry.Title, entry.Link).
			pubDate(StringDate(entry.PubDate)).
			extra(hoverInfoExtra(entry.Description, entry.Publisher)).
			build())
	}
	return items, nil
}

// ---- mktnews ----

type mktnewsEntry struct {
	ID        IDValue `json:"id"`
	Time      string  `json:"time"`
	Important int     `json:"important"`
	Data      struct {
		Content string `json:"content"`
		Title   string `json:"title"`
	} `json:"data"`
}

type mktnewsResponse struct {
	Data []mktnewsEntry `json:"data"`
}

// fetchMktnewsFlash sorts the flash list newest first and maps the bracketed
// title fallback.
func (s *Service) fetchMktnewsFlash(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://api.mktnews.net/api/flash?type=0&limit=50", nil)
	if err != nil {
		return nil, err
	}
	response := mktnewsResponse{}
	if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
		return nil, decodeErr
	}
	sorted := make([]mktnewsEntry, len(response.Data))
	copy(sorted, response.Data)
	sort.SliceStable(sorted, func(i, j int) bool {
		left, leftOK := parseISODateMillis(sorted[i].Time)
		right, rightOK := parseISODateMillis(sorted[j].Time)
		if !leftOK || !rightOK {
			return false
		}
		return left > right
	})

	items := make([]NewsItem, 0, len(sorted))
	for _, entry := range sorted {
		title := entry.Data.Title
		if title == "" {
			if match := bracketTitlePattern.FindStringSubmatch(entry.Data.Content); match != nil {
				title = match[1]
			}
		}
		if title == "" {
			title = entry.Data.Content
		}
		extra := &Extra{Hover: &entry.Data.Content}
		if entry.Important == 1 {
			extra.Info = InfoText("Important")
		}
		items = append(items, newItem(entry.ID, title,
			"https://mktnews.net/flashDetail.html?id="+entry.ID.String()).
			pubDate(StringDate(entry.Time)).
			extra(extra).
			build())
	}
	return items, nil
}

// bracketTitlePattern mirrors /^【([^】]*)】(.*)$/.
var bracketTitlePattern = regexp.MustCompile(`^【([^】]*)】(.*)$`)
