package crawlmetadata

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// publicHost is a public IP literal: the production SSRF rules accept it
// without any DNS lookup, and the stubbed transport answers every request.
const (
	publicHost = "8.8.8.8"
	siteOrigin = "https://" + publicHost
)

// siteRoutes answers stubbed requests by full URL. Every host is the public IP
// literal 8.8.8.8, so the production SSRF rules accept it without DNS; the
// transport is intercepted so nothing leaves the process.
type siteRoutes struct {
	routes map[string]*http.Response
	page   string
}

func newSiteRoutes() *siteRoutes {
	return &siteRoutes{
		routes: map[string]*http.Response{},
		page:   "<html><head><title>page</title></head><body></body></html>",
	}
}

func (s *siteRoutes) set(url string, response *http.Response) { s.routes[url] = response }

func (s *siteRoutes) respond(req *http.Request) (*http.Response, error) {
	url := req.URL.String()
	if response, ok := s.routes[url]; ok {
		return response, nil
	}
	return textResponse(http.StatusNotFound, nil, "missing"), nil
}

func newDiscoveryService(t *testing.T, routes *siteRoutes) (*Service, *stubTransport, *memoryStateStore) {
	t.Helper()
	service, transport := newStubService(t, routes.respond)
	store := newMemoryStateStore()
	service.state = store
	return service, transport, store
}

func urlset(locs ...string) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)
	for _, loc := range locs {
		builder.WriteString("<url><loc>" + loc + "</loc></url>")
	}
	builder.WriteString("</urlset>")
	return builder.String()
}

func sitemapIndex(locs ...string) string {
	var builder strings.Builder
	builder.WriteString(`<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`)
	for _, loc := range locs {
		builder.WriteString("<sitemap><loc>" + loc + "</loc></sitemap>")
	}
	builder.WriteString("</sitemapindex>")
	return builder.String()
}

func TestParseSitemapXMLSupportsNamespacesCdataAndNewsDates(t *testing.T) {
	payload, ok := parseSitemapXML(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc><![CDATA[https://example.com/a]]></loc><lastmod>2024-01-02T03:04:05Z</lastmod>
<news:news><news:publication><news:publication_date>2024-02-03T00:00:00Z</news:publication_date></news:publication></news:news></url>
<url><loc>https://example.com/b</loc></url></urlset>`)
	if !ok || len(payload.URLs) != 2 {
		t.Fatalf("payload = %+v ok=%v", payload, ok)
	}
	if payload.URLs[0].Loc != "https://example.com/a" {
		t.Fatalf("loc = %q", payload.URLs[0].Loc)
	}
	if payload.URLs[0].LastmodTs == nil || payload.URLs[0].NewsPublishedAtTs == nil {
		t.Fatalf("timestamps = %+v", payload.URLs[0])
	}
	if *payload.URLs[0].NewsPublishedAtTs != time.Date(2024, 2, 3, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("news date = %d", *payload.URLs[0].NewsPublishedAtTs)
	}
	if payload.URLs[1].LastmodTs != nil {
		t.Fatal("missing lastmod must stay absent")
	}
}

func TestParseSitemapXMLIndexEntries(t *testing.T) {
	payload, ok := parseSitemapXML(sitemapIndex("https://example.com/child.xml"))
	if !ok || len(payload.ChildSitemaps) != 1 || payload.ChildSitemaps[0].Loc != "https://example.com/child.xml" {
		t.Fatalf("payload = %+v", payload)
	}
	if _, ok := parseSitemapXML("<urlset><url><loc>https://e.com/a</loc></url>"); !ok {
		t.Fatal("a lenient parser must still accept a document without a declaration")
	}
	if _, ok := parseSitemapXML(""); !ok {
		t.Fatal("an empty body parses to an empty payload")
	}
}

func TestDiscoverRobotsFirstThenNestedSitemapsInOrder(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil,
		"# comment\nSitemap: "+siteOrigin+"/sitemap-a.xml\nsitemap: "+siteOrigin+"/sitemap-b.xml\n"))
	routes.set(siteOrigin+"/sitemap-a.xml", textResponse(200, nil, urlset(siteOrigin+"/p1", siteOrigin+"/p2")))
	routes.set(siteOrigin+"/sitemap-b.xml", textResponse(200, nil, sitemapIndex(siteOrigin+"/child.xml")))
	routes.set(siteOrigin+"/child.xml", textResponse(200, nil, urlset(siteOrigin+"/p3", siteOrigin+"/p1")))
	service, transport, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{
		Source:  "sitemap",
		Domain:  publicHost,
		MaxURLs: intPtr(10),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := resultURLs(results)
	want := []string{siteOrigin + "/p1", siteOrigin + "/p2", siteOrigin + "/p3"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("discovered %v want %v", got, want)
	}
	// robots.txt is fetched first, then the two sitemaps, then the child.
	first := transport.requests()[0]
	if first != "GET "+siteOrigin+"/robots.txt" {
		t.Fatalf("first request = %q", first)
	}
	if strings.Contains(strings.Join(transport.requests(), " "), "/sitemap.xml") {
		t.Fatal("common paths must not be requested when robots discovered sitemaps")
	}
}

func TestDiscoverFallsBackToOrderedCommonPaths(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/sitemap.xml", textResponse(200, nil, urlset(siteOrigin+"/p1")))
	service, transport, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{
		Source: "sitemap",
		Domain: publicHost,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].URL != siteOrigin+"/p1" {
		t.Fatalf("results = %+v", resultURLs(results))
	}
	seeds := []string{}
	for _, request := range transport.requests() {
		if strings.Contains(request, "/robots.txt") || strings.HasSuffix(request, "/p1") {
			continue
		}
		seeds = append(seeds, strings.TrimPrefix(request, "GET "))
	}
	if len(seeds) < len(defaultSitemapSeeds) {
		t.Fatalf("seeds = %v", seeds)
	}
	for index, seed := range defaultSitemapSeeds {
		if seeds[index] != siteOrigin+"/"+seed {
			t.Fatalf("seed %d = %q want %q", index, seeds[index], seed)
		}
	}
}

func TestDiscoverDecodesGzippedSitemap(t *testing.T) {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	_, _ = writer.Write([]byte(urlset(siteOrigin + "/p1")))
	_ = writer.Close()

	routes := newSiteRoutes()
	routes.set(siteOrigin+"/robots.txt", textResponse(200, nil, "Sitemap: "+siteOrigin+"/sitemap.xml.gz\n"))
	routes.set(siteOrigin+"/sitemap.xml.gz", textResponse(200, map[string]string{
		"Content-Type": "application/gzip",
	}, buffer.String()))
	service, _, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{Source: "sitemap", Domain: publicHost})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].URL != siteOrigin+"/p1" {
		t.Fatalf("results = %v", resultURLs(results))
	}
}

func TestFetchMaybeReusesCachedBodyOn304(t *testing.T) {
	cached := urlset(siteOrigin + "/p1")
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/sitemap.xml", textResponse(http.StatusNotModified, map[string]string{
		"ETag": `"v2"`,
	}, ""))
	service, transport, store := newDiscoveryService(t, routes)

	parsed := parsedSitemapPayload{URLs: []parsedSitemapURL{{Loc: siteOrigin + "/p1"}}, ChildSitemaps: []parsedSitemapIndexEntry{}}
	target := siteOrigin + "/sitemap.xml"
	store.states[target] = discoveryHTTPState{
		ETag:                 `"v1"`,
		LastModified:         "Mon, 02 Jan 2006 15:04:05 GMT",
		Body:                 &cached,
		ParsedSitemapPayload: &parsed,
	}

	body, ok := service.fetchMaybe(context.Background(), target, 15000)
	if !ok || body != cached {
		t.Fatalf("fetchMaybe = %q,%v", body, ok)
	}
	if len(transport.requests()) != 1 {
		t.Fatalf("requests = %v", transport.requests())
	}
	headers := transport.requestHeaders()[0]
	if headers.Get("If-None-Match") != `"v1"` || headers.Get("If-Modified-Since") == "" {
		t.Fatalf("conditional headers = %v", headers)
	}
	state, _ := store.stored(target)
	if state.ETag != `"v2"` || state.ParsedSitemapPayload == nil {
		t.Fatalf("refreshed state = %+v", state)
	}

	// The cached parse is reused instead of re-parsing the body.
	reused, ok := service.parseSitemapPayload(context.Background(), target, cached)
	if !ok || len(reused.URLs) != 1 || reused.URLs[0].Loc != siteOrigin+"/p1" {
		t.Fatalf("reused payload = %+v", reused)
	}
}

func TestFetchMaybeRefetchesWhen304HasNoCachedBody(t *testing.T) {
	routes := newSiteRoutes()
	target := siteOrigin + "/sitemap.xml"
	var calls int
	var mu sync.Mutex
	handler := routes.respond
	service, transport := newStubService(t, func(req *http.Request) (*http.Response, error) {
		mu.Lock()
		calls++
		current := calls
		mu.Unlock()
		if current == 1 {
			if req.Header.Get("If-None-Match") != `"v1"` {
				t.Errorf("first request must be conditional, headers = %v", req.Header)
			}
			return textResponse(http.StatusNotModified, nil, ""), nil
		}
		return handler(req)
	})
	store := newMemoryStateStore()
	service.state = store
	store.states[target] = discoveryHTTPState{ETag: `"v1"`}
	routes.set(target, textResponse(200, nil, urlset(siteOrigin+"/p1")))

	body, ok := service.fetchMaybe(context.Background(), target, 15000)
	if !ok || !strings.Contains(body, "/p1") {
		t.Fatalf("fetchMaybe = %q,%v", body, ok)
	}
	if len(transport.requests()) != 2 {
		t.Fatalf("requests = %v", transport.requests())
	}
	if headers := transport.requestHeaders()[1]; headers.Get("If-None-Match") != "" {
		t.Fatalf("retry must be unconditional, headers = %v", headers)
	}
}

func TestFetchWithStatusFollowsRedirectsAndCapsAtFive(t *testing.T) {
	target := siteOrigin + "/start"
	routes := newSiteRoutes()
	routes.set(target, redirectResponse("/hop0"))
	for index := 0; index < metadataMaxRedirect-1; index++ {
		routes.set(siteOrigin+"/hop"+strconv.Itoa(index), redirectResponse("/hop"+strconv.Itoa(index+1)))
	}
	routes.set(siteOrigin+"/hop"+strconv.Itoa(metadataMaxRedirect-1), textResponse(200, nil, "ok"))
	service, transport, _ := newDiscoveryService(t, routes)

	response, err := service.fetchWithStatus(context.Background(), target, 15000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.Body != "ok" || response.Status != 200 {
		t.Fatalf("response = %+v", response)
	}
	// The initial request plus five followed redirects.
	if len(transport.requests()) != metadataMaxRedirect+1 {
		t.Fatalf("requests = %d want %d", len(transport.requests()), metadataMaxRedirect+1)
	}
}

func redirectResponse(location string) *http.Response {
	return textResponse(http.StatusFound, map[string]string{"Location": location}, "")
}

func TestFetchWithStatusTooManyRedirects(t *testing.T) {
	target := siteOrigin + "/loop"
	routes := newSiteRoutes()
	routes.set(target, textResponse(http.StatusFound, map[string]string{"Location": "/loop"}, ""))
	service, transport, _ := newDiscoveryService(t, routes)

	_, err := service.fetchWithStatus(context.Background(), target, 15000, nil)
	if err == nil || err.Error() != "Metadata request failed: too many redirects" {
		t.Fatalf("error = %v", err)
	}
	if len(transport.requests()) != metadataMaxRedirect+1 {
		t.Fatalf("requests = %d want %d", len(transport.requests()), metadataMaxRedirect+1)
	}
}

func TestFetchWithStatusBlocksUnsafeRedirectTarget(t *testing.T) {
	target := siteOrigin + "/start"
	routes := newSiteRoutes()
	routes.set(target, textResponse(http.StatusFound, map[string]string{"Location": "http://127.0.0.1/latest/meta-data"}, ""))
	service, transport, _ := newDiscoveryService(t, routes)

	_, err := service.fetchWithStatus(context.Background(), target, 15000, nil)
	if err == nil || !strings.HasPrefix(err.Error(), "Blocked metadata target (potential SSRF): ") {
		t.Fatalf("error = %v", err)
	}
	if len(transport.requests()) != 1 {
		t.Fatalf("the blocked hop must not be requested: %v", transport.requests())
	}
}

func TestFetchWithStatusErrorBoundaries(t *testing.T) {
	target := siteOrigin + "/page"
	routes := newSiteRoutes()
	routes.set(target, textResponse(http.StatusInternalServerError, nil, "boom"))
	service, _, _ := newDiscoveryService(t, routes)
	if _, err := service.fetchWithStatus(context.Background(), target, 15000, nil); err == nil || err.Error() != "Metadata request failed with status 500" {
		t.Fatalf("status error = %v", err)
	}

	routes.set(target, textResponse(http.StatusFound, map[string]string{}, ""))
	if _, err := service.fetchWithStatus(context.Background(), target, 15000, nil); err == nil || err.Error() != "Metadata request failed with status 302" {
		t.Fatalf("redirect without location error = %v", err)
	}
}

func TestExtractFetchesPagesWithBotAgentAndNoCredentials(t *testing.T) {
	routes := newSiteRoutes()
	routes.set(siteOrigin+"/p1", textResponse(200, nil, "<html><head><title>One</title></head></html>"))
	service, transport, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{
		Source: "urls",
		URLs:   []string{siteOrigin + "/p1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Status != StatusSuccess || results[0].Title == nil || *results[0].Title != "One" {
		t.Fatalf("results = %+v", results)
	}
	if results[0].HTTPStatus == nil || *results[0].HTTPStatus != 200 || results[0].FetchedAt == nil {
		t.Fatalf("success fields = %+v", results[0])
	}
	headers := transport.requestHeaders()[0]
	if headers.Get("User-Agent") != metadataUserAgent {
		t.Fatalf("user agent = %q", headers.Get("User-Agent"))
	}
	if headers.Get("Authorization") != "" || headers.Get("Cookie") != "" {
		t.Fatalf("caller credentials must not be forwarded: %v", headers)
	}
}

func TestExtractKeepsOrderAndIsolatesFailures(t *testing.T) {
	routes := newSiteRoutes()
	urls := []string{siteOrigin + "/a", siteOrigin + "/b", siteOrigin + "/c", siteOrigin + "/d"}
	routes.set(urls[0], textResponse(200, nil, "<html><head><title>A</title></head></html>"))
	routes.set(urls[1], textResponse(404, nil, "nope"))
	routes.set(urls[2], textResponse(200, nil, "<html><head><title>C</title></head></html>"))
	routes.set(urls[3], textResponse(500, nil, "boom"))
	service, _, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{
		Source:      "urls",
		URLs:        urls,
		Concurrency: intPtr(4),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 4 {
		t.Fatalf("results = %d", len(results))
	}
	for index, result := range results {
		if result.URL != urls[index] {
			t.Fatalf("result %d url = %q want %q", index, result.URL, urls[index])
		}
	}
	failed := results[1]
	if failed.Status != StatusFailed || failed.Error == nil || *failed.Error != "Metadata request failed with status 404" {
		t.Fatalf("failed = %+v", failed)
	}
	if failed.HTTPStatus != nil || failed.FetchedAt != nil {
		t.Fatalf("a failed page must not report httpStatus/fetchedAt: %+v", failed)
	}
	if failed.MetaTags == nil || failed.OpenGraph == nil || failed.JSONLd == nil {
		t.Fatalf("failed lists must be empty, not null: %+v", failed)
	}
}

func TestExtractRelevanceThresholdAndMaxURLs(t *testing.T) {
	routes := newSiteRoutes()
	first := siteOrigin + "/alpha"
	second := siteOrigin + "/beta"
	routes.set(first, textResponse(200, nil, "<html><head><title>alpha news</title></head></html>"))
	routes.set(second, textResponse(200, nil, "<html><head><title>beta news</title></head></html>"))
	service, _, _ := newDiscoveryService(t, routes)

	results, err := service.Extract(context.Background(), ExtractionInput{
		Source:  "urls",
		URLs:    []string{first, second},
		Query:   "alpha beta",
		MaxURLs: intPtr(1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].URL != first {
		t.Fatalf("maxUrls slice = %v", resultURLs(results))
	}
	if results[0].RelevanceScore == nil || *results[0].RelevanceScore != 0.5 {
		t.Fatalf("score = %v", results[0].RelevanceScore)
	}

	threshold := 0.75
	results, err = service.Extract(context.Background(), ExtractionInput{
		Source:         "urls",
		URLs:           []string{first, second},
		Query:          "alpha beta",
		ScoreThreshold: &threshold,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("threshold must filter both pages: %v", resultURLs(results))
	}

	// A failing page scores 0 through the ?? 0 fallback, so a non-zero
	// threshold drops it while threshold 0 keeps it.
	routes.set(first, textResponse(500, nil, "boom"))
	threshold = 0.5
	results, err = service.Extract(context.Background(), ExtractionInput{
		Source:         "urls",
		URLs:           []string{first},
		Query:          "alpha",
		ScoreThreshold: &threshold,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("failed item must be filtered by a non-zero threshold: %v", resultURLs(results))
	}
	results, err = service.Extract(context.Background(), ExtractionInput{
		Source: "urls",
		URLs:   []string{first},
		Query:  "alpha",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Status != StatusFailed {
		t.Fatalf("threshold 0 must keep the failed item: %+v", results)
	}
}

func TestExtractEmptyDiscoveryReturnsEmptyList(t *testing.T) {
	routes := newSiteRoutes()
	service, _, _ := newDiscoveryService(t, routes)
	results, err := service.Extract(context.Background(), ExtractionInput{Source: "sitemap", Domain: publicHost})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("results = %v", resultURLs(results))
	}
}

func TestComputeRelevanceIgnoresQuerylessAndMissingFields(t *testing.T) {
	title := "Alpha"
	parsed := parsedMetadata{Title: &title}
	if score := computeRelevance("https://example.com/a", parsed, nil); score != nil {
		t.Fatalf("no query must produce no score: %v", *score)
	}
	score := computeRelevance("https://example.com/a", parsed, []string{"alpha", "beta", "alpha"})
	if score == nil || *score != 0.667 {
		t.Fatalf("score = %v", score)
	}
}

func TestMapWithConcurrencyKeepsInputOrder(t *testing.T) {
	items := []int{1, 2, 3, 4, 5, 6, 7}
	results := mapWithConcurrency(items, 3, func(item int) int {
		if item%2 == 0 {
			time.Sleep(time.Millisecond)
		}
		return item * 2
	})
	for index, result := range results {
		if result != items[index]*2 {
			t.Fatalf("results = %v", results)
		}
	}
	if len(mapWithConcurrency([]int{}, 3, func(int) int { return 0 })) != 0 {
		t.Fatal("empty input must produce an empty result")
	}
}

func TestFailedResultShape(t *testing.T) {
	result := failedResult("https://example.com/a", "boom")
	if result.Status != StatusFailed || result.Error == nil || *result.Error != "boom" {
		t.Fatalf("result = %+v", result)
	}
	if result.MetaTags == nil || result.OpenGraph == nil || result.JSONLd == nil {
		t.Fatal("failed lists must be empty, not null")
	}
	if result.HTTPStatus != nil || result.FetchedAt != nil || result.RelevanceScore != nil {
		t.Fatal("failed results must not invent fields")
	}
}

func TestNetworkFetchErrorKeepsGoWording(t *testing.T) {
	err := networkFetchError(errors.New("dial tcp: connection refused"))
	if err.Error() != "Metadata request failed: dial tcp: connection refused" {
		t.Fatalf("error = %v", err)
	}
}

func resultURLs(results []Result) []string {
	out := make([]string, 0, len(results))
	for _, result := range results {
		out = append(out, result.URL)
	}
	return out
}

func intPtr(value int) *int { return &value }
