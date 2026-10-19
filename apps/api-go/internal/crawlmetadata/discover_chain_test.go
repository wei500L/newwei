package crawlmetadata

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

// The discovery tests reuse the package's stub transport (testhelpers_test.go):
// every target is a public IP literal, the transport answers in-process, and the
// SSRF rules are never relaxed. The crawl4ai client points at a non-resolvable
// host so the shared SSRF DNS re-check treats it as "unresolved" (allowed).

// newDiscoveryWithCrawl4AI builds a Discovery whose crawl4ai client and direct
// fetches share the stub transport.
func newDiscoveryWithCrawl4AI(t *testing.T, respond func(*http.Request) (*http.Response, error)) (*Discovery, *stubTransport) {
	t.Helper()
	service, transport := newStubService(t, respond)
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          "https://crawl4ai.example.invalid",
		HTTPClient:       service.httpClient(),
		HealthCheckTTLMs: 60_000,
	})
	return NewDiscovery(service, client, nil), transport
}

func TestDiscoverRSSCandidatesParsesRSSAndAtom(t *testing.T) {
	feed := `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example</title>
    <item>
      <title>First story</title>
      <link>https://news.example.com/2026/10/19/first-story</link>
      <guid>https://news.example.com/2026/10/19/first-story</guid>
      <description><![CDATA[<p>First description</p>]]></description>
      <content:encoded><![CDATA[<p>First body</p>]]></content:encoded>
      <dc:creator>Jane Doe</dc:creator>
      <pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Relative link</title>
      <link>/2026/10/18/relative-link</link>
      <description>Second description</description>
      <author>John</author>
    </item>
    <item>
      <title>Duplicate</title>
      <link>https://news.example.com/2026/10/19/first-story</link>
    </item>
    <item>
      <title>Not http</title>
      <link>ftp://news.example.com/file</link>
    </item>
  </channel>
</rss>
<feed>
  <entry>
    <title>Atom one</title>
    <link rel="alternate" href="https://news.example.com/2026/10/17/atom-one"/>
    <summary>Atom summary</summary>
    <updated>2026-10-17T09:00:00Z</updated>
  </entry>
</feed>`

	discovery, transport := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, map[string]string{"content-type": "application/rss+xml"}, feed), nil
	})

	candidates, err := discovery.DiscoverRSSCandidates(context.Background(), RSSDiscoveryInput{
		FeedURL: "https://news.example.com/feed.xml",
		MaxURLs: intPtrValue(3),
	})
	if err != nil {
		t.Fatalf("DiscoverRSSCandidates: %v", err)
	}
	if len(candidates) != 3 {
		t.Fatalf("candidates = %d (%+v)", len(candidates), candidates)
	}
	first := candidates[0]
	if first.URL != "https://news.example.com/2026/10/19/first-story" {
		t.Errorf("first url = %q", first.URL)
	}
	if first.PublishedAtTs == nil {
		t.Error("first publishedAt missing")
	}
	if first.PrefetchedArticle == nil {
		t.Fatal("first prefetched article missing")
	}
	if first.PrefetchedArticle.Markdown != "First body" {
		t.Errorf("markdown = %q", first.PrefetchedArticle.Markdown)
	}
	if first.PrefetchedArticle.MarkdownSource != "content" {
		t.Errorf("markdownSource = %q", first.PrefetchedArticle.MarkdownSource)
	}
	if first.PrefetchedArticle.Author == nil || *first.PrefetchedArticle.Author != "Jane Doe" {
		t.Errorf("author = %v", first.PrefetchedArticle.Author)
	}
	// The feed keeps the CDATA markup in the description element; the markdown
	// body is the tag-free content:encoded value.
	if first.PrefetchedArticle.Description == nil || *first.PrefetchedArticle.Description != "<p>First description</p>" {
		t.Errorf("description = %v", first.PrefetchedArticle.Description)
	}

	second := candidates[1]
	if second.URL != "https://news.example.com/2026/10/18/relative-link" {
		t.Errorf("relative link = %q", second.URL)
	}
	if second.PublishedAtTs == nil {
		t.Error("second publishedAt must fall back to the path date")
	}
	if second.PrefetchedArticle == nil || second.PrefetchedArticle.MarkdownSource != "description" {
		t.Errorf("second prefetched = %+v", second.PrefetchedArticle)
	}

	if candidates[2].URL != "https://news.example.com/2026/10/17/atom-one" {
		t.Errorf("atom url = %q", candidates[2].URL)
	}
	if candidates[2].PublishedAtTs == nil {
		t.Error("atom publishedAt missing")
	}

	// One conditional fetch for the feed, no crawl4ai call.
	for _, request := range transport.requests() {
		if strings.Contains(request, "/crawl") || strings.Contains(request, "/health") {
			t.Fatalf("RSS discovery must not call crawl4ai: %s", request)
		}
	}
}

func TestDiscoverRSSCandidatesHonorsBodyStrategyAndNoBodyPolicy(t *testing.T) {
	feed := `<rss><channel>
	  <item><title>Only title</title><link>https://news.example.com/a</link></item>
	  <item><title>With body</title><link>https://news.example.com/b</link><description>d</description></item>
	</channel></rss>`
	discovery, _ := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, nil, feed), nil
	})

	timeout := 9_000
	candidates, err := discovery.DiscoverRSSCandidates(context.Background(), RSSDiscoveryInput{
		FeedURL: "https://news.example.com/feed",
		RSSFetch: &RSSFetchOptions{
			RequestTimeoutMs:   &timeout,
			BodySourceStrategy: RSSBodySourceSummaryOnly,
			NoBodyPolicy:       RSSNoBodyPolicyTitleDescriptionStub,
		},
	})
	if err != nil {
		t.Fatalf("DiscoverRSSCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d", len(candidates))
	}
	if candidates[0].PrefetchedArticle == nil {
		t.Fatal("the stub policy must produce a prefetched article")
	}
	if candidates[0].PrefetchedArticle.MarkdownSource != "stub" {
		t.Errorf("markdownSource = %q", candidates[0].PrefetchedArticle.MarkdownSource)
	}
	if !strings.HasPrefix(candidates[0].PrefetchedArticle.Markdown, "# Only title") {
		t.Errorf("stub markdown = %q", candidates[0].PrefetchedArticle.Markdown)
	}
}

func TestDiscoverRSSCandidatesReturnsEmptyOnFetchFailure(t *testing.T) {
	discovery, _ := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusInternalServerError, nil, "boom"), nil
	})
	candidates, err := discovery.DiscoverRSSCandidates(context.Background(), RSSDiscoveryInput{FeedURL: "https://news.example.com/feed"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(candidates) != 0 {
		t.Fatalf("candidates = %d", len(candidates))
	}
}

const listPageHTML = `<html><body>
  <a href="/2026/10/19/html-one">One</a>
  <a href="https://news.example.com/2026/10/18/html-two">Two</a>
  <a href="https://news.example.com/about">About</a>
  <a href="javascript:void(0)">js</a>
  <a href="#fragment">fragment</a>
</body></html>`

func TestDiscoverListCandidatesUsesCrawl4aiAndPagination(t *testing.T) {
	crawlCalls := 0
	discovery, transport := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/health"):
			return textResponse(http.StatusOK, nil, `{}`), nil
		case strings.HasSuffix(request.URL.Path, "/crawl"):
			crawlCalls++
			body := `{"results":[{"url":"https://93.184.216.34/list","success":true,"links":{"internal":[
			  {"href":"https://93.184.216.34/2026/10/19/one","text":"One"},
			  {"href":"/2026/10/18/two","text":"Two"},
			  {"href":"https://93.184.216.34/list?page=2","text":"Next","rel":"next"}
			]}}]}`
			return textResponse(http.StatusOK, map[string]string{"content-type": "application/json"}, body), nil
		default:
			return textResponse(http.StatusNotFound, nil, "not found"), nil
		}
	})

	candidates, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL:                 "https://93.184.216.34/list",
		MaxURLs:             intPtrValue(10),
		ListMaxPages:        intPtrValue(2),
		ListPageConcurrency: intPtrValue(1),
	})
	if err != nil {
		t.Fatalf("DiscoverListCandidates: %v", err)
	}
	if len(candidates) < 2 {
		t.Fatalf("candidates = %d (%+v)", len(candidates), candidates)
	}
	if candidates[0].URL != "https://93.184.216.34/2026/10/19/one" {
		t.Errorf("first = %q", candidates[0].URL)
	}
	if candidates[1].URL != "https://93.184.216.34/2026/10/18/two" {
		t.Errorf("second = %q", candidates[1].URL)
	}
	if crawlCalls != 2 {
		t.Fatalf("crawl calls = %d, want 2 (seed + next page)", crawlCalls)
	}
	for _, request := range transport.requests() {
		if strings.Contains(request, "/2026/10") {
			t.Fatalf("list discovery must not fetch the article pages directly: %s", request)
		}
	}
}

func TestDiscoverListCandidatesFallsBackToRawHTML(t *testing.T) {
	discovery, transport := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/health"):
			return textResponse(http.StatusOK, nil, `{}`), nil
		case strings.HasSuffix(request.URL.Path, "/crawl"):
			return textResponse(http.StatusInternalServerError, nil, "crawl exploded"), nil
		default:
			return textResponse(http.StatusOK, map[string]string{"content-type": "text/html"}, listPageHTML), nil
		}
	})

	candidates, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL:     "https://93.184.216.34/list",
		MaxURLs: intPtrValue(10),
		Pattern: "*2026*",
	})
	if err != nil {
		t.Fatalf("DiscoverListCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d (%+v)", len(candidates), candidates)
	}
	if candidates[0].URL != "https://93.184.216.34/2026/10/19/html-one" {
		t.Errorf("first = %q", candidates[0].URL)
	}
	// Exactly one /crawl attempt and one HTML fetch: no retry loop.
	crawls, pages := 0, 0
	for _, request := range transport.requests() {
		switch {
		case strings.Contains(request, "/crawl"):
			crawls++
		case strings.Contains(request, "/list") && strings.HasPrefix(request, "GET"):
			pages++
		}
	}
	if crawls != 1 || pages != 1 {
		t.Fatalf("crawl=%d pages=%d", crawls, pages)
	}
}

func TestDiscoverListCandidatesWithoutCrawl4AIReturnsHTMLParse(t *testing.T) {
	service, _ := newStubService(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, map[string]string{"content-type": "text/html"}, listPageHTML), nil
	})
	discovery := NewDiscovery(service, nil, nil)
	candidates, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL:     "https://93.184.216.34/list",
		MaxURLs: intPtrValue(10),
	})
	if err != nil {
		t.Fatalf("DiscoverListCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d", len(candidates))
	}
}

func TestDiscoverListCandidatesRejectsProxyOptions(t *testing.T) {
	discovery, _ := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, nil, `{}`), nil
	})
	_, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL:          "https://93.184.216.34/list",
		CrawlOptions: []byte(`{"proxyUrl":"http://127.0.0.1:8080"}`),
	})
	want := "Unsupported crawl config: crawlOptions.proxyUrl: custom upstream proxies are not supported"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
}

func TestDiscoverDeepCandidatesWithoutCrawl4AIReportsUnavailable(t *testing.T) {
	service, _ := newStubService(t, func(request *http.Request) (*http.Response, error) {
		return textResponse(http.StatusOK, nil, ""), nil
	})
	discovery := NewDiscovery(service, nil, nil)
	_, err := discovery.DiscoverDeepCandidates(context.Background(), DeepDiscoveryInput{URL: "https://93.184.216.34/"})
	var discoveryErr *DiscoveryError
	if !asDiscoveryError(err, &discoveryErr) {
		t.Fatalf("err = %v", err)
	}
	if discoveryErr.Code != DiscoveryCodeCrawl4AIUnavailable {
		t.Fatalf("code = %q", discoveryErr.Code)
	}
	want := "[SEED_DEEP_CRAWL4AI_UNAVAILABLE] Deep discovery requires crawl4ai service, but crawl4ai client is unavailable."
	if discoveryErr.Error() != want {
		t.Fatalf("message = %q", discoveryErr.Error())
	}
}

func asDiscoveryError(err error, target **DiscoveryError) bool {
	for err != nil {
		if typed, ok := err.(*DiscoveryError); ok {
			*target = typed
			return true
		}
		type unwrapper interface{ Unwrap() error }
		wrapped, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = wrapped.Unwrap()
	}
	return false
}

func TestDiscoverDeepCandidatesRanksFetchesPublishedAtAndCaps(t *testing.T) {
	discovery, transport := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		switch {
		case strings.HasSuffix(request.URL.Path, "/health"):
			return textResponse(http.StatusOK, nil, `{}`), nil
		case strings.HasSuffix(request.URL.Path, "/crawl"):
			body := `{"results":[{"url":"https://93.184.216.34/","success":true,"links":{"internal":[
			  {"href":"https://93.184.216.34/2026/10/19/newest-article-slug-here","text":"Newest"},
			  {"href":"https://93.184.216.34/2026/10/01/older-article-slug-here","text":"Older"},
			  {"href":"https://93.184.216.34/about","text":"About"}
			]}}]}`
			return textResponse(http.StatusOK, map[string]string{"content-type": "application/json"}, body), nil
		default:
			html := `<html><head><meta property="article:published_time" content="2026-10-19T08:00:00Z"></head><body></body></html>`
			return textResponse(http.StatusOK, map[string]string{"content-type": "text/html"}, html), nil
		}
	})

	candidates, err := discovery.DiscoverDeepCandidates(context.Background(), DeepDiscoveryInput{
		URL:     "https://93.184.216.34/",
		MaxURLs: intPtrValue(2),
		Deep: &DeepOptions{
			MaxPages: 1, MaxDepth: 1, TimeBudgetSeconds: 30, PageConcurrency: 1,
			ScoreThreshold: 0, CandidatePoolSize: 20, HeadFetchTopK: 10,
			PreferPathDate: true, EnableSecondaryHubs: true, IgnoreRobotsTxt: true,
		},
	})
	if err != nil {
		t.Fatalf("DiscoverDeepCandidates: %v", err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d (%+v)", len(candidates), candidates)
	}
	if candidates[0].URL != "https://93.184.216.34/2026/10/19/newest-article-slug-here" {
		t.Errorf("first = %q", candidates[0].URL)
	}
	crawls := 0
	for _, request := range transport.requests() {
		if strings.Contains(request, "/crawl") {
			crawls++
		}
	}
	if crawls != 1 {
		t.Fatalf("crawl calls = %d, want 1 (maxPages=1)", crawls)
	}
}

func TestDiscoverDeepCandidatesReportsNoCandidate(t *testing.T) {
	discovery, _ := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/health") {
			return textResponse(http.StatusOK, nil, `{}`), nil
		}
		return textResponse(http.StatusOK, map[string]string{"content-type": "application/json"}, `{"results":[]}`), nil
	})
	_, err := discovery.DiscoverDeepCandidates(context.Background(), DeepDiscoveryInput{URL: "https://93.184.216.34/"})
	var discoveryErr *DiscoveryError
	if !asDiscoveryError(err, &discoveryErr) {
		t.Fatalf("err = %v", err)
	}
	if discoveryErr.Code != DiscoveryCodeNoCandidate {
		t.Fatalf("code = %q", discoveryErr.Code)
	}
}

func TestDiscoverDeepCandidatesReportsCrawlFailed(t *testing.T) {
	discovery, _ := newDiscoveryWithCrawl4AI(t, func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "/health") {
			return textResponse(http.StatusOK, nil, `{}`), nil
		}
		return textResponse(http.StatusInternalServerError, nil, "crawl exploded"), nil
	})
	_, err := discovery.DiscoverDeepCandidates(context.Background(), DeepDiscoveryInput{URL: "https://93.184.216.34/"})
	var discoveryErr *DiscoveryError
	if !asDiscoveryError(err, &discoveryErr) {
		t.Fatalf("err = %v", err)
	}
	if discoveryErr.Code != DiscoveryCodeCrawlFailed {
		t.Fatalf("code = %q", discoveryErr.Code)
	}
	if !strings.HasPrefix(discoveryErr.Message, "Deep discovery crawl failed: ") {
		t.Fatalf("message = %q", discoveryErr.Message)
	}
}
