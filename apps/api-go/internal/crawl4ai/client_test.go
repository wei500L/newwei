package crawl4ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// stubTransport serves the client's HTTP calls without touching the network. The
// target hostnames are deliberately non-resolvable (.invalid), so the shared SSRF
// DNS re-check treats them as "unresolved" (allowed) exactly like the NestJS
// allowUnresolved default, and no test depends on public DNS.
type stubTransport struct {
	mu       sync.Mutex
	requests []stubRequest
	handle   func(stubRequest) (*http.Response, error)
}

type stubRequest struct {
	Method string
	URL    string
	Header http.Header
	Body   []byte
}

func (s *stubTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	var body []byte
	if request.Body != nil {
		body, _ = io.ReadAll(request.Body)
		_ = request.Body.Close()
	}
	record := stubRequest{Method: request.Method, URL: request.URL.String(), Header: request.Header.Clone(), Body: body}
	s.mu.Lock()
	s.requests = append(s.requests, record)
	s.mu.Unlock()
	return s.handle(record)
}

func (s *stubTransport) snapshot() []stubRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]stubRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"content-type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    &http.Request{},
	}
}

// newTestClient builds a client whose base URL is a non-resolvable host and whose
// transport is the stub.
func newTestClient(transport *stubTransport) *Client {
	return New(Options{
		BaseURL:          "https://crawl4ai.example.invalid",
		APIKey:           "secret-key",
		TimeoutMs:        5_000,
		HealthCheckTTLMs: 60_000,
		HTTPClient:       &http.Client{Transport: transport},
	})
}

const crawlResponseBody = `{
  "results": [
    {
      "url": "https://news.example.invalid/list",
      "success": true,
      "statusCode": 200,
      "links": {
        "internal": [
          {"href": "https://news.example.invalid/article/one", "text": "One", "total_score": 0.8, "rel": ""},
          {"href": "/article/two", "title": "Two", "contextual_score": 1.4}
        ],
        "external": [
          {"url": "https://other.example.invalid/x", "text": "External"}
        ]
      },
      "metadata": {"title": "List"}
    }
  ],
  "warnings": [],
  "systemEvents": [
    {"level": "info", "eventType": "crawl_started", "message": "started", "timestamp": "2026-10-20T00:00:00.000Z"}
  ]
}`

func TestCrawlSendsDiscoveryPayloadAndParsesLinks(t *testing.T) {
	transport := &stubTransport{}
	transport.handle = func(request stubRequest) (*http.Response, error) {
		if strings.HasSuffix(request.URL, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, crawlResponseBody), nil
	}
	client := newTestClient(transport)

	prefetch := true
	scanFullPage := false
	response, err := client.Crawl(context.Background(), CrawlRequest{
		URL: "https://news.example.invalid/list",
		Options: CrawlOptions{
			Prefetch:     &prefetch,
			ScanFullPage: &scanFullPage,
			ScoreLinks:   &prefetch,
		},
	}, Settings{RequestTimeoutNormalMs: 10_000, HealthCheckTTLMs: 60_000})
	if err != nil {
		t.Fatalf("Crawl returned %v", err)
	}
	if len(response.Results) != 1 {
		t.Fatalf("results = %d", len(response.Results))
	}
	article := response.Results[0]
	if article.Success == nil || !*article.Success {
		t.Fatalf("success = %v", article.Success)
	}
	if len(article.Links) != 3 {
		t.Fatalf("links = %d (%+v)", len(article.Links), article.Links)
	}
	if article.Links[0].Href != "https://news.example.invalid/article/one" {
		t.Errorf("first link = %q", article.Links[0].Href)
	}
	if article.Links[1].Href != "/article/two" {
		t.Errorf("second link = %q", article.Links[1].Href)
	}
	if article.Links[2].Href != "https://other.example.invalid/x" {
		t.Errorf("third link = %q", article.Links[2].Href)
	}
	if article.Links[1].ContextualScore == nil || *article.Links[1].ContextualScore != 1.4 {
		t.Errorf("contextual score = %v", article.Links[1].ContextualScore)
	}
	if article.Links[0].TotalScore == nil || *article.Links[0].TotalScore != 0.8 {
		t.Errorf("total score = %v", article.Links[0].TotalScore)
	}

	requests := transport.snapshot()
	if len(requests) != 2 || !strings.HasSuffix(requests[0].URL, "/health") || !strings.HasSuffix(requests[1].URL, "/crawl") {
		t.Fatalf("request order = %+v", requests)
	}
	crawl := requests[1]
	if crawl.Method != http.MethodPost {
		t.Errorf("method = %s", crawl.Method)
	}
	if crawl.Header.Get("x-api-key") != "secret-key" {
		t.Errorf("x-api-key = %q", crawl.Header.Get("x-api-key"))
	}
	var payload map[string]any
	if err := json.Unmarshal(crawl.Body, &payload); err != nil {
		t.Fatalf("payload json: %v", err)
	}
	if payload["browser_config"].(map[string]any)["type"] != "BrowserConfig" {
		t.Errorf("browser_config.type = %v", payload["browser_config"])
	}
	params := payload["crawler_config"].(map[string]any)["params"].(map[string]any)
	if params["check_robots_txt"] != false {
		t.Errorf("check_robots_txt = %v", params["check_robots_txt"])
	}
	if params["prefetch"] != true {
		t.Errorf("prefetch = %v", params["prefetch"])
	}
	if params["score_links"] != true {
		t.Errorf("score_links = %v", params["score_links"])
	}
	if params["exclude_external_links"] != true {
		t.Errorf("exclude_external_links = %v", params["exclude_external_links"])
	}
	if params["scan_full_page"] != false {
		t.Errorf("scan_full_page = %v", params["scan_full_page"])
	}
}

func TestCrawlSkipsHealthProbeWithinTTL(t *testing.T) {
	transport := &stubTransport{}
	transport.handle = func(request stubRequest) (*http.Response, error) {
		if strings.HasSuffix(request.URL, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	}
	client := newTestClient(transport)
	settings := Settings{RequestTimeoutNormalMs: 10_000, HealthCheckTTLMs: 60_000}
	for i := 0; i < 3; i++ {
		if _, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://news.example.invalid/a"}, settings); err != nil {
			t.Fatalf("crawl %d: %v", i, err)
		}
	}
	health := 0
	for _, request := range transport.snapshot() {
		if strings.HasSuffix(request.URL, "/health") {
			health++
		}
	}
	if health != 1 {
		t.Fatalf("health probes = %d, want 1", health)
	}
}

func TestCrawlProbesHealthAgainAfterTTL(t *testing.T) {
	transport := &stubTransport{}
	transport.handle = func(request stubRequest) (*http.Response, error) {
		if strings.HasSuffix(request.URL, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	}
	client := newTestClient(transport)
	now := int64(1_000_000)
	client.options.Now = func() int64 { return now }
	settings := Settings{RequestTimeoutNormalMs: 10_000, HealthCheckTTLMs: 5_000}
	if _, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://news.example.invalid/a"}, settings); err != nil {
		t.Fatalf("first crawl: %v", err)
	}
	now += 6_000
	if _, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://news.example.invalid/a"}, settings); err != nil {
		t.Fatalf("second crawl: %v", err)
	}
	health := 0
	for _, request := range transport.snapshot() {
		if strings.HasSuffix(request.URL, "/health") {
			health++
		}
	}
	if health != 2 {
		t.Fatalf("health probes = %d, want 2", health)
	}
}

type timeoutTransport struct{}

func (timeoutTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, &timeoutError{}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "i/o timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }

func TestCrawlClassifiesTimeoutAs408(t *testing.T) {
	client := New(Options{
		BaseURL:    "https://crawl4ai.example.invalid",
		HTTPClient: &http.Client{Transport: timeoutTransport{}},
	})
	_, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://news.example.invalid/a"}, Settings{RequestTimeoutNormalMs: 2_500})
	if err == nil {
		t.Fatal("expected an error")
	}
	if StatusOf(err) != http.StatusRequestTimeout {
		t.Fatalf("status = %d (%v)", StatusOf(err), err)
	}
	if !strings.Contains(err.Error(), "crawl4ai request timed out after 2500ms") {
		t.Fatalf("message = %q", err.Error())
	}
	if !strings.Contains(err.Error(), "https://news.example.invalid/a: ") {
		t.Fatalf("message is missing the url prefix: %q", err.Error())
	}
}

func TestCrawlBlocksUnsafeTargetBeforeSending(t *testing.T) {
	transport := &stubTransport{}
	transport.handle = func(request stubRequest) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	}
	client := newTestClient(transport)
	_, err := client.Crawl(context.Background(), CrawlRequest{URL: "http://127.0.0.1/internal"}, Settings{RequestTimeoutNormalMs: 10_000})
	if err == nil {
		t.Fatal("expected an error")
	}
	if StatusOf(err) != http.StatusBadRequest {
		t.Fatalf("status = %d (%v)", StatusOf(err), err)
	}
	if !strings.HasPrefix(err.Error(), "URL blocked by SSRF protection: ") {
		t.Fatalf("message = %q", err.Error())
	}
	for _, request := range transport.snapshot() {
		if strings.HasSuffix(request.URL, "/crawl") {
			t.Fatalf("crawl must not be sent for a blocked URL: %+v", request)
		}
	}
}

func TestCrawlRetriesOnceWithoutPrefetchOnCompatibilityError(t *testing.T) {
	transport := &stubTransport{}
	attempt := 0
	transport.handle = func(request stubRequest) (*http.Response, error) {
		if strings.HasSuffix(request.URL, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		attempt++
		if attempt == 1 {
			return jsonResponse(http.StatusInternalServerError, `{"message":"unexpected keyword argument 'prefetch'"}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[{"url":"https://news.example.invalid/a","success":true,"links":{}}]}`), nil
	}
	client := newTestClient(transport)
	prefetch := true
	response, err := client.Crawl(context.Background(), CrawlRequest{
		URL:     "https://news.example.invalid/a",
		Options: CrawlOptions{Prefetch: &prefetch},
	}, Settings{RequestTimeoutNormalMs: 10_000})
	if err != nil {
		t.Fatalf("Crawl returned %v", err)
	}
	if len(response.SystemEvents) != 1 || response.SystemEvents[0].EventType != "prefetch_compatibility_fallback" {
		t.Fatalf("system events = %+v", response.SystemEvents)
	}
	crawls := []stubRequest{}
	for _, request := range transport.snapshot() {
		if strings.HasSuffix(request.URL, "/crawl") {
			crawls = append(crawls, request)
		}
	}
	if len(crawls) != 2 {
		t.Fatalf("crawl attempts = %d, want 2", len(crawls))
	}
	var first map[string]any
	if err := json.Unmarshal(crawls[0].Body, &first); err != nil {
		t.Fatalf("first payload: %v", err)
	}
	if _, ok := first["crawler_config"].(map[string]any)["params"].(map[string]any)["prefetch"]; !ok {
		t.Fatalf("first payload lost prefetch: %v", first)
	}
	var second map[string]any
	if err := json.Unmarshal(crawls[1].Body, &second); err != nil {
		t.Fatalf("second payload: %v", err)
	}
	if _, ok := second["crawler_config"].(map[string]any)["params"].(map[string]any)["prefetch"]; ok {
		t.Fatalf("second payload still has prefetch: %v", second)
	}
}

func TestBuildPayloadAppliesCleanMarkdownOverride(t *testing.T) {
	waitUntil := "networkidle"
	waitForTimeout := 400
	selector := "nav, footer"
	removeOverlay := false
	wordCount := 12
	payload := buildPayload(CrawlRequest{
		URL: "https://news.example.invalid/a",
		Options: CrawlOptions{
			WaitUntil:        &waitUntil,
			WaitForTimeoutMs: &waitForTimeout,
			CleanMarkdown: &CleanMarkdown{
				ExcludedTags:          strings.Split(selector, ", "),
				RemoveOverlayElements: &removeOverlay,
				WordCountThreshold:    &wordCount,
			},
		},
	}, "")
	params, ok := payload.CrawlerConfig.Params.(crawlerParams)
	if !ok {
		t.Fatalf("params type = %T", payload.CrawlerConfig.Params)
	}
	if params.WaitUntil != "networkidle" {
		t.Errorf("wait_until = %q", params.WaitUntil)
	}
	// The client helper lifts networkidle to at least 5000 ms.
	if params.WaitForTimeout == nil || *params.WaitForTimeout != 5000 {
		t.Errorf("wait_for_timeout = %v", params.WaitForTimeout)
	}
	if len(params.ExcludedTags) != 2 || params.ExcludedTags[0] != "nav" || params.ExcludedTags[1] != "footer" {
		t.Errorf("excluded_tags = %+v", params.ExcludedTags)
	}
	if params.RemoveOverlayElements == nil || *params.RemoveOverlayElements {
		t.Errorf("remove_overlay_elements = %v", params.RemoveOverlayElements)
	}
	if params.WordCountThreshold == nil || *params.WordCountThreshold != 12 {
		t.Errorf("word_count_threshold = %v", params.WordCountThreshold)
	}
	if params.CacheMode != "bypass" {
		t.Errorf("cache_mode = %q", params.CacheMode)
	}
	if params.ScrollDelay != nil {
		t.Errorf("scroll_delay must stay absent without scanFullPage: %v", params.ScrollDelay)
	}
	browser, ok := payload.BrowserConfig.Params.(browserParams)
	if !ok {
		t.Fatalf("browser params type = %T", payload.BrowserConfig.Params)
	}
	if browser.Proxy != "" {
		t.Errorf("proxy = %q", browser.Proxy)
	}
}

func TestBuildPayloadForwardsSSRFProxyAndScanFullPageDefaults(t *testing.T) {
	scanFullPage := true
	payload := buildPayload(CrawlRequest{
		URL:     "https://news.example.invalid/a",
		Options: CrawlOptions{ScanFullPage: &scanFullPage},
	}, " http://127.0.0.1:18080 ")
	params := payload.CrawlerConfig.Params.(crawlerParams)
	if !params.ScanFullPage {
		t.Error("scan_full_page must be true")
	}
	if params.ScrollDelay == nil || *params.ScrollDelay != 0.35 {
		t.Errorf("scroll_delay = %v, want 0.35", params.ScrollDelay)
	}
	browser := payload.BrowserConfig.Params.(browserParams)
	if browser.Proxy != "http://127.0.0.1:18080" {
		t.Errorf("proxy = %q", browser.Proxy)
	}
}

func TestNormalizeResponseToleratesUnknownShapes(t *testing.T) {
	response, err := normalizeResponse([]byte(`{
	  "results": [
	    {"url": "https://a.example.invalid", "success": false, "errorMessage": "boom", "links": {"internal": "not-an-array"}},
	    {"url": "https://b.example.invalid", "status_code": 500}
	  ]
	}`))
	if err != nil {
		t.Fatalf("normalizeResponse: %v", err)
	}
	if len(response.Results) != 2 {
		t.Fatalf("results = %d", len(response.Results))
	}
	if response.Results[0].Error != "boom" {
		t.Errorf("error = %q", response.Results[0].Error)
	}
	if response.Results[0].Links != nil {
		t.Errorf("non-array bucket must be dropped: %+v", response.Results[0].Links)
	}
	if response.Results[1].StatusCode == nil || *response.Results[1].StatusCode != 500 {
		t.Errorf("status_code = %v", response.Results[1].StatusCode)
	}
	if _, err := normalizeResponse([]byte("not json")); err == nil {
		t.Fatal("invalid JSON must fail")
	}
}

func TestEnsureHealthyReportsServiceFailure(t *testing.T) {
	transport := &stubTransport{}
	transport.handle = func(request stubRequest) (*http.Response, error) {
		return nil, errors.New("connection refused")
	}
	client := newTestClient(transport)
	_, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://news.example.invalid/a"}, Settings{RequestTimeoutNormalMs: 10_000})
	if err == nil || err.Error() != "crawl4ai health check failed" {
		t.Fatalf("err = %v", err)
	}
	if !client.healthChecked() {
		t.Fatal("a failed probe must not be cached as healthy")
	}
}

func TestResolveRequestTimeoutUsesSettingsAndOverride(t *testing.T) {
	settings := Settings{RequestTimeoutNormalMs: 45_000}
	if got := resolveRequestTimeout(0, settings); got != 45_000 {
		t.Errorf("settings timeout = %d", got)
	}
	if got := resolveRequestTimeout(2_000, settings); got != 2_000 {
		t.Errorf("override = %d", got)
	}
	if got := resolveRequestTimeout(10, settings); got != 1_000 {
		t.Errorf("override floor = %d", got)
	}
	if got := resolveRequestTimeout(0, Settings{}); got != 120_000 {
		t.Errorf("default = %d", got)
	}
}

func TestNestNowFormatsMilliseconds(t *testing.T) {
	instant := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	if got := nestNow(instant); got != "2026-10-20T00:00:00.000Z" {
		t.Fatalf("nestNow = %q", got)
	}
}
