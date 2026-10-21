package crawl4ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// pipelineStubTransport answers /health and /crawl without leaving the process.
// The URL uses a public IP literal so the shared SSRF rules accept it without a
// DNS lookup (same approach as client_test.go).
type pipelineStubTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
	respond  func(call int, req *http.Request, body string) (*http.Response, error)
}

func (p *pipelineStubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		_ = req.Body.Close()
		body = string(raw)
	}
	p.mu.Lock()
	call := len(p.requests)
	p.requests = append(p.requests, req.Clone(req.Context()))
	p.bodies = append(p.bodies, body)
	p.mu.Unlock()
	return p.respond(call, req, body)
}

func newPipelineTestClient(t *testing.T, respond func(call int, req *http.Request, body string) (*http.Response, error)) (*Client, *pipelineStubTransport) {
	t.Helper()
	transport := &pipelineStubTransport{respond: respond}
	client := New(Options{
		BaseURL:          "http://8.8.8.8:9999",
		APIKey:           "test-key",
		JSCodeEnabled:    true,
		HTTPClient:       &http.Client{Transport: transport},
		HealthCheckTTLMs: 60_000,
		TimeoutMs:        5_000,
	})
	return client, transport
}

func TestCrawlPipelineRequestShape(t *testing.T) {
	client, transport := newPipelineTestClient(t, func(call int, req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{
			"runId":"run-1",
			"nextCursor":"cursor-1",
			"serverMemoryMb":128.5,
			"peakMemoryMb":256.25,
			"memoryEfficiency":64.5,
			"warnings":["warn-1"],
			"results":[{
				"url":"https://example.com/article",
				"success":true,
				"statusCode":200,
				"publishedAt":"2026-10-20T10:00:00Z",
				"markdown":{"raw_markdown":"# Raw","markdown_with_citations":"# Cite","fit_markdown":"Fit"},
				"metadata":{"title":"Title","statusCode":200},
				"links":{"internal":[{"href":"https://example.com/next","intrinsic_score":8.5}]},
				"media":{"images":[{"src":"https://example.com/a.png"}]},
				"tables":[{"headers":["a"],"rows":[["b"]]}]
			}]
		}`), nil
	})

	session := "session-1"
	response, err := client.CrawlPipeline(context.Background(), PipelineRequest{
		URL:      "https://example.com/article",
		URLs:     []string{"https://example.com/article", "https://example.com/second"},
		Keywords: []string{"climate"},
		Options: CrawlOptions{
			CacheMode:          "bypass",
			SessionID:          &session,
			ScanFullPage:       true,
			ScrollDelayMs:      intPointer(200),
			WordCountThreshold: intPointer(120),
		},
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err != nil {
		t.Fatal(err)
	}

	if len(transport.requests) != 2 {
		t.Fatalf("requests = %d", len(transport.requests))
	}
	crawlRequest := transport.requests[1]
	if crawlRequest.URL.Path != "/crawl" {
		t.Fatalf("path = %q", crawlRequest.URL.Path)
	}
	if got := crawlRequest.Header.Get("x-api-key"); got != "test-key" {
		t.Fatalf("x-api-key = %q", got)
	}
	if got := crawlRequest.Header.Get("content-type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if deadline, ok := crawlRequest.Context().Deadline(); !ok || time.Until(deadline) <= 0 {
		t.Fatal("crawl request must carry the resolved timeout deadline")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(transport.bodies[1]), &payload); err != nil {
		t.Fatal(err)
	}
	urls, _ := payload["urls"].([]any)
	if len(urls) != 2 || urls[0] != "https://example.com/article" || urls[1] != "https://example.com/second" {
		t.Fatalf("urls = %#v", payload["urls"])
	}
	keywords, _ := payload["keywords"].([]any)
	if len(keywords) != 1 || keywords[0] != "climate" {
		t.Fatalf("keywords = %#v", payload["keywords"])
	}
	crawlerConfig, _ := payload["crawler_config"].(map[string]any)
	crawlerParams, _ := crawlerConfig["params"].(map[string]any)
	if crawlerParams["session_id"] != "session-1" {
		t.Fatalf("session_id = %#v", crawlerParams["session_id"])
	}
	if crawlerParams["scan_full_page"] != true {
		t.Fatalf("scan_full_page = %#v", crawlerParams["scan_full_page"])
	}
	if crawlerParams["word_count_threshold"] != float64(120) {
		t.Fatalf("word_count_threshold = %#v", crawlerParams["word_count_threshold"])
	}

	if response.RunID != "run-1" || response.NextCursor == nil || *response.NextCursor != "cursor-1" {
		t.Fatalf("run/cursor = %#v %#v", response.RunID, response.NextCursor)
	}
	if response.ServerMemoryMB == nil || *response.ServerMemoryMB != 128.5 {
		t.Fatalf("serverMemoryMb = %#v", response.ServerMemoryMB)
	}
	if response.PeakMemoryMB == nil || *response.PeakMemoryMB != 256.25 {
		t.Fatalf("peakMemoryMb = %#v", response.PeakMemoryMB)
	}
	if response.MemoryEfficiency == nil || *response.MemoryEfficiency != 64.5 {
		t.Fatalf("memoryEfficiency = %#v", response.MemoryEfficiency)
	}
	if len(response.Warnings) != 1 || response.Warnings[0] != "warn-1" {
		t.Fatalf("warnings = %#v", response.Warnings)
	}
	if len(response.Results) != 1 {
		t.Fatalf("results = %d", len(response.Results))
	}
	article := response.Results[0]
	if article.StatusCode == nil || *article.StatusCode != 200 {
		t.Fatalf("statusCode = %#v", article.StatusCode)
	}
	if !strings.Contains(string(article.Markdown), "raw_markdown") {
		t.Fatalf("raw markdown leaf lost: %s", string(article.Markdown))
	}
	if len(article.PublishedAt) == 0 || !strings.Contains(string(article.PublishedAt), "2026-10-20") {
		t.Fatalf("publishedAt = %s", string(article.PublishedAt))
	}
	if !strings.Contains(string(article.Media), "images") || !strings.Contains(string(article.Tables), "headers") {
		t.Fatal("media/tables leaves lost")
	}
	if !strings.Contains(string(article.Links), "intrinsic_score") {
		t.Fatal("links leaf lost")
	}
}

func TestCrawlPipelineRetriesWithoutPrefetch(t *testing.T) {
	client, transport := newPipelineTestClient(t, func(call int, req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		if !strings.Contains(body, `"prefetch"`) {
			return jsonResponse(http.StatusOK, `{"results":[]}`), nil
		}
		return jsonResponse(http.StatusBadRequest, `{"error":"TypeError: unexpected keyword argument 'prefetch'"}`), nil
	})
	prefetch := true
	response, err := client.CrawlPipeline(context.Background(), PipelineRequest{
		URL:     "https://example.com/list",
		Options: CrawlOptions{CacheMode: "bypass", Prefetch: prefetch},
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err != nil {
		t.Fatal(err)
	}
	if len(transport.bodies) != 3 {
		t.Fatalf("bodies = %d", len(transport.bodies))
	}
	if strings.Contains(transport.bodies[len(transport.bodies)-1], `"prefetch"`) {
		t.Fatal("the retry must drop prefetch")
	}
	found := false
	for _, event := range response.SystemEvents {
		if event.EventType == "prefetch_compatibility_fallback" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing prefetch_compatibility_fallback systemEvent")
	}
}

func TestCrawlPipelineClassifiesServerError(t *testing.T) {
	client, _ := newPipelineTestClient(t, func(call int, req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusServiceUnavailable, `{"message":"upstream unavailable"}`), nil
	})
	_, err := client.CrawlPipeline(context.Background(), PipelineRequest{
		URL: "https://example.com/article",
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err == nil {
		t.Fatal("expected an error")
	}
	if status := StatusOf(err); status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", status)
	}
	if !strings.Contains(err.Error(), "upstream unavailable") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestCrawlPipelineClassifiesTimeout(t *testing.T) {
	client, _ := newPipelineTestClient(t, func(call int, req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	_, err := client.CrawlPipeline(context.Background(), PipelineRequest{
		URL: "https://example.com/article",
	}, Settings{RequestTimeoutNormalMs: 1_200, HealthCheckTTLMs: 60_000})
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	if status := StatusOf(err); status != http.StatusRequestTimeout {
		t.Fatalf("status = %d", status)
	}
	if !strings.Contains(strings.ToLower(err.Error()), "timed out") {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestCrawlPipelineBlocksUnsafeURL(t *testing.T) {
	client, transport := newPipelineTestClient(t, func(call int, req *http.Request, body string) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{}`), nil
	})
	_, err := client.CrawlPipeline(context.Background(), PipelineRequest{
		URL: "http://127.0.0.1:6379/",
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err == nil {
		t.Fatal("expected an SSRF error")
	}
	if status := StatusOf(err); status != http.StatusBadRequest {
		t.Fatalf("status = %d", status)
	}
	for _, request := range transport.requests {
		if request.URL.Path == "/crawl" {
			t.Fatal("no /crawl request may be issued for a blocked URL")
		}
	}
}

func intPointer(value int) *int { return &value }
