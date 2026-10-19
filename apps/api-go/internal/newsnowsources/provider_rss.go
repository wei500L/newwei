package newsnowsources

import (
	"context"
	"encoding/json"
	"log"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/text/encoding/simplifiedchinese"
)

// ---- zaobao ----

// fetchZaobao decodes the GB2312 page and maps the list block.
func (s *Service) fetchZaobao(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.zaochenbao.com/realtime/", nil)
	if err != nil {
		return nil, err
	}
	decoded, decodeErr := simplifiedchinese.GB18030.NewDecoder().Bytes(body)
	if decodeErr != nil {
		return nil, decodeErr
	}
	root, err := parseHTML(decoded)
	if err != nil {
		return nil, err
	}
	baseURL := "https://www.zaochenbao.com"
	items := make([]NewsItem, 0)
	for _, anchor := range selectAll(root, "div.list-block>a.item") {
		href := attrValue(anchor, "href")
		title := nodeText(selectFirst(anchor, ".eps"))
		date := zaobaoDashSpace.ReplaceAllString(nodeText(selectFirst(anchor, ".pdt10")), " ")
		if href == "" || title == "" || date == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			pubDate(parseRelativeDate(date, shanghai(), s.now())).
			build())
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].PubDate == nil || items[j].PubDate == nil {
			return false
		}
		return compareDateGreater(*items[j].PubDate, *items[i].PubDate)
	})
	return items, nil
}

// zaobaoDashSpace mirrors /-\s/g.
var zaobaoDashSpace = regexp.MustCompile(`-\s`)

// ---- weibo ----

// weiboSecretKeys mirrors WEIBO_RUNTIME_SECRETS_CONFIG.suggestedKeys.
var weiboSecretKeys = []string{"cookie", "weibo.cookie", "weibo_cookie"}

// fetchWeibo maps the realtime hot search table.
func (s *Service) fetchWeibo(ctx context.Context, rc RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://s.weibo.com"
	endpoint := baseURL + "/top/summary?cate=realtimehot"
	cookie := firstSecret(rc.Secrets, weiboSecretKeys)
	if cookie == "" {
		cookie = strings.TrimSpace(s.env("WEIBO_COOKIE"))
	}
	if cookie == "" {
		return nil, &SecretRequiredError{
			SourceID:     requestedSourceID(rc, "weibo"),
			RequiredKeys: weiboSecretKeys,
			Message:      "Weibo cookie is required; configure a runtime secret or WEIBO_COOKIE",
		}
	}
	body, err := s.client.get(ctx, endpoint, map[string]string{
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
		"Cookie":     cookie,
		"referer":    endpoint,
	})
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	rows := selectAll(root, "#pl_top_realtimehot table tbody tr")
	if len(rows) > 0 {
		rows = rows[1:]
	}
	flags := map[string]string{
		"新": "https://simg.s.weibo.com/moter/flags/1_0.png",
		"热": "https://simg.s.weibo.com/moter/flags/2_0.png",
		"爆": "https://simg.s.weibo.com/moter/flags/4_0.png",
	}
	items := make([]NewsItem, 0, len(rows))
	for _, row := range rows {
		var link *html.Node
		for _, candidate := range selectAll(row, "td.td-02 a") {
			href := attrValue(candidate, "href")
			if href != "" && !strings.Contains(href, "javascript:void(0);") {
				link = candidate
				break
			}
		}
		if link == nil {
			continue
		}
		title := trimText(link)
		href := attrValue(link, "href")
		if title == "" || href == "" {
			continue
		}
		flag := trimText(selectFirst(row, "td.td-03"))
		extra := &Extra{}
		if iconURL, ok := flags[flag]; ok {
			extra.Icon = IconScaled(iconURL, json.RawMessage("1.5"))
		}
		url := baseURL + href
		items = append(items, newItem(StringID(title), title, url).mobile(url).extra(extra).build())
	}
	return items, nil
}

// ---- fastbull ----

// fetchFastbullExpress maps the express news list.
func (s *Service) fetchFastbullExpress(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.fastbull.com"
	body, err := s.client.get(ctx, baseURL+"/cn/express-news", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".news-list") {
		anchor := selectFirst(element, ".title_name")
		if anchor == nil {
			continue
		}
		href := attrValue(anchor, "href")
		titleText := nodeText(anchor)
		title := titleText
		if match := bracketTitlePattern.FindStringSubmatch(titleText); match != nil {
			title = match[1]
		}
		if utf16Length(title) < 4 {
			title = titleText
		}
		date := attrValue(element, "data-date")
		if href == "" || title == "" || date == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			pubDate(numberLiteralDate(date)).
			build())
	}
	return items, nil
}

// fetchFastbullNews maps the trending article list.
func (s *Service) fetchFastbullNews(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.fastbull.com"
	body, err := s.client.get(ctx, baseURL+"/cn/news", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".trending_type") {
		href := attrValue(element, "href")
		title := nodeText(selectFirst(element, ".title"))
		date := attrValue(selectFirst(element, "[data-date]"), "data-date")
		if href == "" || title == "" || date == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			pubDate(numberLiteralDate(date)).
			build())
	}
	return items, nil
}

// numberLiteralDate mirrors `Number(value)`: a numeric literal keeps its number
// shape and an unparsable value becomes null (NaN serialisation).
func numberLiteralDate(value string) DateValue {
	number, ok := jsNumberFromString(value)
	if !ok {
		return NullDate()
	}
	return DateValue{Kind: ValueNumber, Text: jsNumberString(number)}
}

// ---- freebuf ----

var freebufRSSHubInstances = []string{"https://rsshub.rssforever.com", "https://rsshub.app"}
var freebufRSSHubTypes = []string{"web", "system"}

type freebufRSSHubItem struct {
	ID            *string `json:"id"`
	URL           string  `json:"url"`
	Title         string  `json:"title"`
	DatePublished string  `json:"date_published"`
}

// fetchFreebuf tries both RSSHub instances, then the native feed.
func (s *Service) fetchFreebuf(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	for _, instance := range freebufRSSHubInstances {
		items := s.fetchFreebufInstance(ctx, instance)
		if len(items) > 0 {
			return mergeAndSortFreebuf(items), nil
		}
	}
	fallback := s.fetchFreebufNative(ctx)
	if len(fallback) > 0 {
		return mergeAndSortFreebuf(fallback), nil
	}
	return []NewsItem{}, nil
}

// fetchFreebufInstance fetches web and system concurrently from one RSSHub
// instance and keeps every fulfilled group.
func (s *Service) fetchFreebufInstance(ctx context.Context, instance string) []NewsItem {
	groups, _ := parallel(len(freebufRSSHubTypes), func(index int) ([]NewsItem, error) {
		kind := freebufRSSHubTypes[index]
		endpoint := instance + "/freebuf/articles/" + kind + "?format=json&limit=40&sorted=true"
		body, err := s.client.get(ctx, endpoint, nil)
		if err != nil {
			log.Printf("[freebuf] rsshub %s type=%s failed: %v", instance, kind, err)
			return nil, nil
		}
		var payload struct {
			Items []freebufRSSHubItem `json:"items"`
		}
		if decodeErr := json.Unmarshal(body, &payload); decodeErr != nil {
			log.Printf("[freebuf] rsshub %s type=%s failed: %v", instance, kind, decodeErr)
			return nil, nil
		}
		items := make([]NewsItem, 0, len(payload.Items))
		for _, entry := range payload.Items {
			id := entry.URL
			if entry.ID != nil {
				id = *entry.ID
			}
			builder := newItem(StringID(id), entry.Title, entry.URL)
			if entry.DatePublished != "" {
				builder.pubDate(StringDate(entry.DatePublished))
			}
			items = append(items, builder.build())
		}
		return items, nil
	})
	collected := make([]NewsItem, 0)
	for _, group := range groups {
		collected = append(collected, group...)
	}
	return collected
}

// fetchFreebufNative maps the site feed and prefers the two article categories.
func (s *Service) fetchFreebufNative(ctx context.Context) []NewsItem {
	document, err := fetchRSS(ctx, s.client, "https://www.freebuf.com/feed")
	if err != nil {
		log.Printf("[freebuf] native feed failed: %v", err)
		return nil
	}
	if document == nil || len(document.Items) == 0 {
		return nil
	}
	mapped := make([]NewsItem, 0, len(document.Items))
	for _, entry := range document.Items {
		builder := newItem(StringID(entry.Link), entry.Title, entry.Link).
			extra(hoverExtra(stripHTML(entry.Description)))
		if entry.Created != "" {
			builder.pubDate(StringDate(entry.Created))
		}
		mapped = append(mapped, builder.build())
	}
	matched := make([]NewsItem, 0, len(mapped))
	for _, entry := range mapped {
		if strings.Contains(entry.URL, "/articles/web/") || strings.Contains(entry.URL, "/articles/system/") {
			matched = append(matched, entry)
		}
	}
	if len(matched) > 0 {
		return matched
	}
	return mapped
}

// mergeAndSortFreebuf de-duplicates by trimmed URL (falling back to the id) and
// sorts by publication timestamp descending.
func mergeAndSortFreebuf(items []NewsItem) []NewsItem {
	seen := make(map[string]struct{}, len(items))
	deduped := make([]NewsItem, 0, len(items))
	for _, item := range items {
		key := strings.TrimSpace(item.URL)
		if key == "" {
			key = item.ID.String()
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, item)
	}
	sort.SliceStable(deduped, func(i, j int) bool {
		return freebufTimestamp(deduped[i].PubDate) > freebufTimestamp(deduped[j].PubDate)
	})
	return deduped
}

// freebufTimestamp mirrors toTimestamp.
func freebufTimestamp(value *DateValue) int64 {
	if value == nil {
		return 0
	}
	switch value.Kind {
	case ValueNumber:
		number, ok := value.Number()
		if !ok {
			return 0
		}
		return int64(number)
	case ValueString:
		if parsed, ok := parseDateParseMillis(value.Text); ok {
			return parsed
		}
		return 0
	default:
		return 0
	}
}

// parseDateParseMillis mirrors Date.parse for the formats the feeds use.
func parseDateParseMillis(value string) (int64, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, false
	}
	layouts := []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
		"2006/01/02 15:04:05",
		"2006/01/02",
		time.RFC1123,
		time.RFC1123Z,
		"Mon, 2 Jan 2006 15:04:05 MST",
		"Mon, 2 Jan 2006 15:04:05 -0700",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			return millisOf(parsed), true
		}
	}
	return 0, false
}

// stripHTML mirrors stripHtml: wrap the fragment, take its text and trim.
func stripHTML(content string) string {
	if content == "" {
		return ""
	}
	wrapper, err := parseHTMLFragment(content)
	if err != nil {
		return ""
	}
	return trimText(wrapper)
}

// ---- cankaoxiaoxi ----

type cankaoxiaoxiEntry struct {
	Data struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		URL         string `json:"url"`
		PublishTime string `json:"publishTime"`
	} `json:"data"`
}

// fetchCankaoxiaoxi merges the three channels concurrently and sorts by the
// converted publication date descending.
func (s *Service) fetchCankaoxiaoxi(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	channels := []string{"zhongguo", "guandian", "gj"}
	documents, err := parallel(len(channels), func(index int) ([]cankaoxiaoxiEntry, error) {
		body, fetchErr := s.client.get(ctx, "https://china.cankaoxiaoxi.com/json/channel/"+channels[index]+"/list.json", nil)
		if fetchErr != nil {
			return nil, fetchErr
		}
		var response struct {
			List []cankaoxiaoxiEntry `json:"list"`
		}
		if decodeErr := json.Unmarshal(body, &response); decodeErr != nil {
			return nil, decodeErr
		}
		return response.List, nil
	})
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, document := range documents {
		for _, entry := range document {
			items = append(items, newItem(StringID(entry.Data.ID), entry.Data.Title, entry.Data.URL).
				extra(dateExtra(tranformToUTC(entry.Data.PublishTime, shanghai()))).
				build())
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Extra == nil || items[j].Extra == nil || items[i].Extra.Date == nil || items[j].Extra.Date == nil {
			return false
		}
		return compareDateGreater(*items[j].Extra.Date, *items[i].Extra.Date)
	})
	return items, nil
}
