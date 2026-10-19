package newsnowsources

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

// ---- 36kr ----

// fetch36krQuick maps the newsflash list.
func (s *Service) fetch36krQuick(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.36kr.com"
	body, err := s.client.get(ctx, baseURL+"/newsflashes", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".newsflash-item") {
		anchor := selectFirst(element, "a.item-title")
		if anchor == nil {
			continue
		}
		href := attrValue(anchor, "href")
		title := nodeText(anchor)
		relative := trimText(selectFirst(element, ".time"))
		if href == "" || title == "" || relative == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			extra(dateExtra(parseRelativeDate(relative, shanghai(), s.now()))).
			build())
	}
	return items, nil
}

// fetch36krRenqi maps the daily popularity list.
func (s *Service) fetch36krRenqi(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://36kr.com"
	endpoint := baseURL + "/hot-list/renqi/" + dayjsToday(s.now()) + "/1"
	body, err := s.client.get(ctx, endpoint, map[string]string{
		"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
		"Referer":    "https://www.freebuf.com/",
		"Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	})
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".article-item-info") {
		anchor := selectFirst(element, "a.article-item-title.weight-bold")
		if anchor == nil {
			continue
		}
		href := attrValue(anchor, "href")
		title := trimText(anchor)
		description := trimText(selectFirst(element, "a.article-item-description.ellipsis-2"))
		author := trimText(selectFirst(element, ".kr-flow-bar-author"))
		hot := trimText(selectFirst(element, ".kr-flow-bar-hot span"))
		if href == "" || title == "" {
			continue
		}
		url := href
		if !strings.HasPrefix(href, "http") {
			url = baseURL + href
		}
		id := href
		if len(id) > 3 {
			id = id[3:]
		} else {
			id = ""
		}
		items = append(items, newItem(StringID(id), title, url).
			extra(hoverInfoExtra(description, author+"  |  "+hot)).
			build())
	}
	return items, nil
}

// ---- gelonghui ----

// fetchGelonghui maps the article feed.
func (s *Service) fetchGelonghui(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.gelonghui.com"
	body, err := s.client.get(ctx, "https://www.gelonghui.com/news/", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".article-content") {
		anchor := selectFirst(element, ".detail-right>a")
		if anchor == nil {
			continue
		}
		href := attrValue(anchor, "href")
		title := nodeText(selectFirst(anchor, "h2"))
		info := nodeText(selectFirst(element, ".time > span:nth-child(1)"))
		relative := nodeText(selectFirst(element, ".time > span:nth-child(3)"))
		if href == "" || title == "" || relative == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			extra(&Extra{
				Date: datePointer(parseRelativeDate(relative, shanghai(), s.now())),
				Info: InfoText(info),
			}).
			build())
	}
	return items, nil
}

// datePointer boxes a DateValue for Extra.
func datePointer(value DateValue) *DateValue { return &value }

// ---- ithome ----

// newsAdKeywords are the sponsored-title markers IT之家 uses.
var newsAdKeywords = []string{"神券", "优惠", "补贴", "京东"}

// fetchIthome maps the article list and drops ads.
func (s *Service) fetchIthome(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://www.ithome.com/list/", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, "#list > div.fl > ul > li") {
		anchor := selectFirst(element, "a.t")
		if anchor == nil {
			continue
		}
		url := attrValue(anchor, "href")
		title := nodeText(anchor)
		date := nodeText(selectFirst(element, "i"))
		if url == "" || title == "" || date == "" {
			continue
		}
		if strings.Contains(url, "lapin") {
			continue
		}
		ad := false
		for _, keyword := range newsAdKeywords {
			if strings.Contains(title, keyword) {
				ad = true
				break
			}
		}
		if ad {
			continue
		}
		items = append(items, newItem(StringID(url), title, url).
			pubDate(parseRelativeDate(date, shanghai(), s.now())).
			build())
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].PubDate == nil || items[j].PubDate == nil {
			return false
		}
		return compareDateGreater(*items[i].PubDate, *items[j].PubDate)
	})
	return items, nil
}

// ---- solidot ----

// fetchSolidot maps the block list.
func (s *Service) fetchSolidot(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.solidot.org"
	body, err := s.client.get(ctx, baseURL, nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	solidotDatePattern := regexp.MustCompile(`发表于(.*?分)`)
	items := make([]NewsItem, 0)
	for _, element := range selectAll(root, ".block_m") {
		anchors := selectAll(element, ".bg_htit a")
		if len(anchors) == 0 {
			continue
		}
		anchor := anchors[len(anchors)-1]
		href := attrValue(anchor, "href")
		title := nodeText(anchor)
		match := solidotDatePattern.FindStringSubmatch(trimText(selectFirst(element, ".talk_time")))
		if href == "" || title == "" || match == nil {
			continue
		}
		date := strings.ReplaceAll(match[1], "年", "-")
		date = strings.ReplaceAll(date, "月", "-")
		date = strings.Replace(date, "时", ":", 1)
		date = strings.ReplaceAll(date, "分", "")
		date = strings.ReplaceAll(date, "日", "")
		items = append(items, newItem(StringID(href), title, baseURL+href).
			pubDate(parseRelativeDate(date, shanghai(), s.now())).
			build())
	}
	return items, nil
}

// ---- steam ----

// fetchSteam maps the online-player rows.
func (s *Service) fetchSteam(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://store.steampowered.com/stats/stats/", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, row := range selectAll(root, "#detailStats tr.player_count_row") {
		anchor := selectFirst(row, "a.gameLink")
		if anchor == nil {
			continue
		}
		url := attrValue(anchor, "href")
		name := trimText(anchor)
		players := trimText(selectFirst(row, "td:first-child .currentServers"))
		if url == "" || name == "" || players == "" {
			continue
		}
		items = append(items, newItem(StringID(url), name, url).
			pubDate(Millis(millisOf(s.now()))).
			extra(&Extra{Info: InfoText(players)}).
			build())
	}
	return items, nil
}

// ---- github ----

var newlineRunPattern = regexp.MustCompile(`\n+`)
var whitespaceRunPattern = regexp.MustCompile(`\s+`)

// fetchGithubTrending maps the trending repository list.
func (s *Service) fetchGithubTrending(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://github.com"
	body, err := s.client.get(ctx, "https://github.com/trending?spoken_language_code=", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, article := range selectAll(root, "main .Box div[data-hpc] > article") {
		anchor := selectFirst(article, ">h2 a")
		if anchor == nil {
			continue
		}
		title := strings.TrimSpace(newlineRunPattern.ReplaceAllString(nodeText(anchor), ""))
		href := attrValue(anchor, "href")
		star := strings.TrimSpace(whitespaceRunPattern.ReplaceAllString(nodeText(selectFirst(article, "[href$=stargazers]")), ""))
		desc := strings.TrimSpace(newlineRunPattern.ReplaceAllString(nodeText(selectFirst(article, ">p")), ""))
		if href == "" || title == "" {
			continue
		}
		items = append(items, newItem(StringID(href), title, baseURL+href).
			extra(hoverInfoExtra(desc, "✰ "+star)).
			build())
	}
	return items, nil
}

// ---- hackernews ----

// fetchHackerNews maps the front page rows.
func (s *Service) fetchHackerNews(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://news.ycombinator.com"
	body, err := s.client.get(ctx, baseURL, nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, row := range selectAll(root, ".athing") {
		anchor := selectFirst(row, ".titleline a")
		if anchor == nil {
			continue
		}
		title := nodeText(anchor)
		id := attrValue(row, "id")
		if id == "" || title == "" {
			continue
		}
		score := nodeText(selectFirst(root, "#score_"+id))
		items = append(items, newItem(StringID(id), title, baseURL+"/item?id="+id).
			extra(&Extra{Info: InfoText(score)}).
			build())
	}
	return items, nil
}

// ---- sputniknewscn ----

// fetchSputnik maps the widget feed.
func (s *Service) fetchSputnik(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://sputniknews.cn/services/widget/lenta/", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, row := range selectAll(root, ".lenta__item") {
		anchor := selectFirst(row, "a")
		if anchor == nil {
			continue
		}
		href := attrValue(anchor, "href")
		title := nodeText(selectFirst(anchor, ".lenta__item-text"))
		date := attrValue(selectFirst(anchor, ".lenta__item-date"), "data-unixtime")
		if href == "" || title == "" || date == "" {
			continue
		}
		number, ok := jsNumberFromString(date + "000")
		if !ok || math.IsNaN(number) {
			items = append(items, newItem(StringID(href), title, "https://sputniknews.cn"+href).
				extra(dateExtra(NullDate())).
				build())
			continue
		}
		items = append(items, newItem(StringID(href), title, "https://sputniknews.cn"+href).
			extra(dateExtra(Millis(int64(number)))).
			build())
	}
	return items, nil
}

// ---- hupu ----

// hupuItemPattern mirrors the inline regex of the original provider.
var hupuItemPattern = regexp.MustCompile(`<li class="bbs-sl-web-post-body">[\s\S]*?<a href="(/[^"]+?\.html)"[^>]*?class="p-title"[^>]*>([^<]+)</a>`)

// fetchHupu maps the daily hot topic list.
func (s *Service) fetchHupu(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	body, err := s.client.get(ctx, "https://bbs.hupu.com/topic-daily-hot", nil)
	if err != nil {
		return nil, err
	}
	matches := hupuItemPattern.FindAllStringSubmatch(string(body), -1)
	items := make([]NewsItem, 0, len(matches))
	for _, match := range matches {
		path := match[1]
		title := match[2]
		if path == "" || title == "" {
			continue
		}
		url := "https://bbs.hupu.com" + path
		items = append(items, newItem(StringID(path), strings.TrimSpace(title), url).mobile(url).build())
	}
	return items, nil
}

// ---- chongbuluo ----

// fetchChongbuluoHot maps the guide hot table.
func (s *Service) fetchChongbuluoHot(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	baseURL := "https://www.chongbuluo.com/"
	body, err := s.client.get(ctx, baseURL+"forum.php?mod=guide&view=hot", nil)
	if err != nil {
		return nil, err
	}
	root, err := parseHTML(body)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0)
	for _, row := range selectAll(root, ".bmw table tr") {
		title := nodeText(selectFirst(row, ".common .xst"))
		href := attrValue(selectFirst(row, ".common a"), "href")
		url := baseURL + href
		items = append(items, newItem(StringID(url), title, url).
			extra(hoverExtra(title)).
			build())
	}
	return items, nil
}

// fetchChongbuluoLatest maps the new-thread RSS feed.
func (s *Service) fetchChongbuluoLatest(ctx context.Context, _ RuntimeContext) ([]NewsItem, error) {
	return s.fetchRSSSource(ctx, "https://www.chongbuluo.com/forum.php?mod=rss&view=newthread")
}

// fetchRSSSource mirrors defineRSSSource: an empty feed is an error and pubDate
// is the RSS created value.
func (s *Service) fetchRSSSource(ctx context.Context, endpoint string) ([]NewsItem, error) {
	document, err := fetchRSS(ctx, s.client, endpoint)
	if err != nil {
		return nil, err
	}
	if document == nil || len(document.Items) == 0 {
		return nil, fmt.Errorf("Cannot fetch rss data")
	}
	items := make([]NewsItem, 0, len(document.Items))
	for _, entry := range document.Items {
		builder := newItem(StringID(entry.Link), entry.Title, entry.Link)
		if entry.Created != "" {
			builder.pubDate(StringDate(entry.Created))
		}
		items = append(items, builder.build())
	}
	return items, nil
}

// compareDateGreater mirrors JavaScript's `a > b` for date unions: two numbers
// compare numerically, two strings lexicographically, and mixed shapes coerce
// the string to a number (NaN never compares greater).
func compareDateGreater(left, right DateValue) bool {
	leftString, leftIsString := left.StringValue()
	rightString, rightIsString := right.StringValue()
	if leftIsString && rightIsString {
		return leftString > rightString
	}
	if !leftIsString && !rightIsString {
		leftNumber, leftOK := left.Number()
		rightNumber, rightOK := right.Number()
		if !leftOK || !rightOK {
			return false
		}
		return leftNumber > rightNumber
	}
	if leftIsString {
		converted, ok := jsNumberFromString(leftString)
		return ok && converted > mustNumber(right)
	}
	converted, ok := jsNumberFromString(rightString)
	return ok && mustNumber(left) > converted
}

// mustNumber returns the numeric value or NaN.
func mustNumber(value DateValue) float64 {
	number, ok := value.Number()
	if !ok {
		return math.NaN()
	}
	return number
}
