package crawlmetadata

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlprofile"
)

// rssFeed is a minimal RSS 2.0 document with one item carrying content:encoded.
const rssFeed = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<item>
  <title>First story</title>
  <link>` + siteOrigin + `/2024/01/02/first-story</link>
  <description>Short summary</description>
  <content:encoded><![CDATA[<p>Full <b>body</b> text</p>]]></content:encoded>
  <dc:creator>Jane Doe</dc:creator>
  <pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate>
</item>
</channel>
</rss>`

// TestDiscoverRSSCandidatesParsesPayloadAndPrefetch pins the RSS path: URL
// resolution, timestamp parsing and the prefetched article shape.
func TestDiscoverRSSCandidatesParsesPayloadAndPrefetch(t *testing.T) {
	// The feed URL must be answered by the stub routes.
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/feed.xml", textResponse(http.StatusOK, nil, rssFeed))
	service, _, _ := newDiscoveryService(t, routes)
	discovery := NewDiscovery(service, nil, nil)

	candidates, err := discovery.DiscoverRSSCandidates(context.Background(), RSSDiscoveryInput{
		FeedURL: siteOrigin + "/feed.xml",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidates = %+v", candidates)
	}
	candidate := candidates[0]
	if candidate.URL != siteOrigin+"/2024/01/02/first-story" {
		t.Fatalf("url = %s", candidate.URL)
	}
	if candidate.PublishedAtTs == nil {
		t.Fatal("missing publishedAtTs")
	}
	if candidate.CrawledAtTs == nil {
		t.Fatal("missing crawledAtTs")
	}
	if candidate.PrefetchedArticle == nil {
		t.Fatal("missing prefetchedArticle")
	}
	if len(candidate.PrefetchedArticle.Metadata) == 0 || !strings.Contains(string(candidate.PrefetchedArticle.Metadata), "markdownSource") {
		t.Fatalf("metadata = %s", candidate.PrefetchedArticle.Metadata)
	}
	if !strings.Contains(candidate.PrefetchedArticle.Markdown, "Full body text") {
		t.Fatalf("markdown = %q", candidate.PrefetchedArticle.Markdown)
	}
	if candidate.PrefetchedArticle.Title == nil || *candidate.PrefetchedArticle.Title != "First story" {
		t.Fatalf("title = %v", candidate.PrefetchedArticle.Title)
	}
}

// TestDiscoverListCandidatesFallsBackToHTMLWithoutCrawl4ai pins the fallback:
// without a configured client the seed page anchors are parsed directly.
func TestDiscoverListCandidatesFallsBackToHTMLWithoutCrawl4ai(t *testing.T) {
	routes := newSiteRoutes()
	page := `<html><body>
<a href="/2024/01/02/first-story">One</a>
<a href="` + siteOrigin + `/2024/01/03/second-story">Two</a>
<a href="#fragment">skip</a>
<a href="javascript:void(0)">skip</a>
<a href="https://other.example.com/2024/01/04/external">skip</a>
</body></html>`
	routes.set(siteOrigin+"/list", textResponse(http.StatusOK, nil, page))
	service, _, _ := newDiscoveryService(t, routes)
	discovery := NewDiscovery(service, nil, nil)

	candidates, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL: siteOrigin + "/list",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %+v", candidates)
	}
	if candidates[0].URL != siteOrigin+"/2024/01/02/first-story" {
		t.Fatalf("first = %s", candidates[0].URL)
	}
	if candidates[0].PublishedAtTs == nil {
		t.Fatal("the dated path must yield a publishedAtTs")
	}
}

// TestDiscoverDeepCandidatesWithoutClientReportsUnavailable pins the deep
// discovery error code used by the preview and the trial run.
func TestDiscoverDeepCandidatesWithoutClientReportsUnavailable(t *testing.T) {
	service, _, _ := newDiscoveryService(t, newSiteRoutes())
	discovery := NewDiscovery(service, nil, nil)
	_, err := discovery.DiscoverDeepCandidates(context.Background(), DeepDiscoveryInput{URL: siteOrigin + "/"})
	var discoveryError *DiscoveryError
	if !errors.As(err, &discoveryError) {
		t.Fatalf("err = %v", err)
	}
	if discoveryError.Code != DiscoveryCodeCrawl4AIUnavailable {
		t.Fatalf("code = %s", discoveryError.Code)
	}
}

// crawlTransport answers crawl4ai /health and /crawl requests.
type crawlTransport struct {
	pages map[string]string
}

func (c crawlTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if strings.HasSuffix(req.URL.Path, "/health") {
		return textResponse(http.StatusOK, nil, `{}`), nil
	}
	raw, _ := io.ReadAll(req.Body)
	_ = req.Body.Close()
	var payload struct {
		URLs []string `json:"urls"`
	}
	_ = json.Unmarshal(raw, &payload)
	target := ""
	if len(payload.URLs) > 0 {
		target = payload.URLs[0]
	}
	body := c.pages[target]
	if body == "" {
		body = `{"results":[]}`
	}
	return textResponse(http.StatusOK, nil, body), nil
}

// TestDiscoverListCandidatesUsesCrawl4aiResults pins the crawl4ai list walk:
// internal links become article candidates, a bare page does not.
func TestDiscoverListCandidatesUsesCrawl4aiResults(t *testing.T) {
	service, _, _ := newDiscoveryService(t, newSiteRoutes())
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL: "http://8.8.8.8:9999",
		HTTPClient: &http.Client{Transport: crawlTransport{pages: map[string]string{
			siteOrigin + "/list": `{"results":[{"url":"` + siteOrigin + `/list","success":true,"links":{"internal":[` +
				`{"href":"` + siteOrigin + `/2024/01/02/first-story","text":"One"},` +
				`{"href":"` + siteOrigin + `/2024/01/03/second-story","text":"Two"},` +
				`{"href":"https://other.example.com/2024/01/04/external","text":"Out"}]}}]}`,
		}}},
		JSCodeEnabled: true,
	})
	discovery := NewDiscovery(service, client, nil)

	candidates, err := discovery.DiscoverListCandidates(context.Background(), ListDiscoveryInput{
		URL: siteOrigin + "/list",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 2 {
		t.Fatalf("candidates = %+v", candidates)
	}
	if candidates[0].URL != siteOrigin+"/2024/01/02/first-story" || candidates[1].URL != siteOrigin+"/2024/01/03/second-story" {
		t.Fatalf("candidates = %+v", candidates)
	}
}

// TestNormalizeCrawlOptionsRejectsProxyAndForcesDiscoveryFlags pins the shared
// proxy guard and the forced discovery-only flags.
func TestNormalizeCrawlOptionsRejectsProxyAndForcesDiscoveryFlags(t *testing.T) {
	_, err := normalizeCrawlOptions(json.RawMessage(`{"proxyUrl":"http://proxy:8080"}`))
	var policy *crawlprofile.PolicyError
	if !errors.As(err, &policy) {
		t.Fatalf("err = %v", err)
	}
	options, err := normalizeCrawlOptions(json.RawMessage(`{"waitUntil":"load"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !options.ExtractLinks || !options.Prefetch {
		t.Fatalf("options = %+v", options)
	}
	if options.WaitUntil == nil || *options.WaitUntil != "load" {
		t.Fatalf("wait until = %v", options.WaitUntil)
	}
}

// TestDiscoverSitemapCandidatesMergeTimestamps pins the CrawlDiscoveryCandidate
// shape the preview and the workflow seed node consume: sitemap discovery keeps
// the publish timestamp of a repeated URL (the larger one wins, like the
// source's mergeDiscoveryCandidates) and stamps every candidate with the
// per-document crawl timestamp.
func TestDiscoverSitemapCandidatesMergeTimestamps(t *testing.T) {
	repeated := siteOrigin + "/2024/01/02/first-story"
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/sitemap.xml", textResponse(http.StatusOK, nil,
		`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`+
			`<url><loc>`+repeated+`</loc></url>`+
			`<url><loc>`+repeated+`</loc><lastmod>2024-01-02T03:04:05Z</lastmod></url>`+
			`</urlset>`))
	service, _, _ := newDiscoveryService(t, routes)
	discovery := NewDiscovery(service, nil, nil)

	candidates, err := discovery.DiscoverSitemapCandidates(context.Background(), siteOrigin, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidates = %+v", candidates)
	}
	if candidates[0].URL != repeated {
		t.Fatalf("url = %s", candidates[0].URL)
	}
	if candidates[0].PublishedAtTs == nil || *candidates[0].PublishedAtTs != 1704164645000 {
		t.Fatalf("publishedAtTs = %v", candidates[0].PublishedAtTs)
	}
	if candidates[0].CrawledAtTs == nil {
		t.Fatal("missing crawledAtTs")
	}
}
