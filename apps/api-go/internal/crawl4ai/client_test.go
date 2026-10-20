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

// publicBase is a public IP literal so the shared SSRF rules accept it without
// a DNS lookup; the stub transport answers every request, so nothing leaves the
// process.
const publicBase = "http://8.8.8.8:9999"

type stubTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	bodies   []string
	respond  func(req *http.Request, body string) (*http.Response, error)
}

func (s *stubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		_ = req.Body.Close()
		body = string(raw)
		req.Body = io.NopCloser(strings.NewReader(body))
	}
	s.mu.Lock()
	s.requests = append(s.requests, req.Clone(context.Background()))
	s.bodies = append(s.bodies, body)
	s.mu.Unlock()
	return s.respond(req, body)
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func newTestClient(t *testing.T, respond func(req *http.Request, body string) (*http.Response, error)) (*Client, *stubTransport) {
	t.Helper()
	transport := &stubTransport{respond: respond}
	client := New(Options{
		BaseURL:          publicBase,
		JSCodeEnabled:    true,
		HTTPClient:       &http.Client{Transport: transport},
		HealthCheckTTLMs: 60_000,
		TimeoutMs:        5_000,
	})
	return client, transport
}

// TestCrawlRetriesWithoutPrefetch pins fallback 1: a server that rejects the
// prefetch keyword gets one retry without it and a systemEvent.
func TestCrawlRetriesWithoutPrefetch(t *testing.T) {
	attempts := 0
	client, transport := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		attempts++
		if attempts == 1 {
			return jsonResponse(http.StatusBadRequest, `{"error":"TypeError: unexpected keyword argument 'prefetch'"}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[{"url":"https://example.com/a","success":true,"links":{}}]}`), nil
	})

	prefetch := true
	response, err := client.Crawl(context.Background(), CrawlRequest{
		URL:     "https://example.com/list",
		Options: CrawlOptions{CacheMode: "bypass", Prefetch: prefetch},
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d", attempts)
	}
	if len(transport.bodies) < 2 {
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

// TestCrawlRetriesWithBoundedVirtualScroll pins fallback 2: a scanFullPage
// timeout retries once with scan_full_page disabled and a bounded
// virtualScroll.
func TestCrawlRetriesWithBoundedVirtualScroll(t *testing.T) {
	attempts := 0
	client, transport := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		attempts++
		if attempts == 1 {
			return jsonResponse(http.StatusInternalServerError, `{"message":"Timeout 30000ms exceeded"}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[{"url":"https://example.com/a","success":true,"links":{}}]}`), nil
	})

	scanFullPage := true
	response, err := client.Crawl(context.Background(), CrawlRequest{
		URL: "https://example.com/list",
		Options: CrawlOptions{
			CacheMode:    "bypass",
			ScanFullPage: scanFullPage,
		},
	}, Settings{RequestTimeoutNormalMs: 5_000, HealthCheckTTLMs: 60_000})
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d", attempts)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(transport.bodies[len(transport.bodies)-1]), &payload); err != nil {
		t.Fatal(err)
	}
	params := payload["crawler_config"].(map[string]any)["params"].(map[string]any)
	if params["scan_full_page"] != false {
		t.Fatalf("scan_full_page = %v", params["scan_full_page"])
	}
	if _, ok := params["virtual_scroll_config"]; !ok {
		t.Fatal("missing virtual_scroll_config")
	}
	found := false
	for _, event := range response.SystemEvents {
		if event.EventType == "scan_full_page_virtual_scroll_fallback" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing scan_full_page_virtual_scroll_fallback systemEvent")
	}
}

// TestCrawlBlocksUnsafeURLs pins the shared SSRF guard: a loopback target fails
// with 400 before any HTTP request is issued.
func TestCrawlBlocksUnsafeURLs(t *testing.T) {
	client, transport := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		return jsonResponse(http.StatusOK, `{}`), nil
	})
	_, err := client.Crawl(context.Background(), CrawlRequest{URL: "http://127.0.0.1/internal", Options: CrawlOptions{CacheMode: "bypass"}}, Settings{})
	if err == nil {
		t.Fatal("expected an SSRF rejection")
	}
	if StatusOf(err) != http.StatusBadRequest || !strings.Contains(err.Error(), "URL blocked by SSRF protection") {
		t.Fatalf("err = %v", err)
	}
	for _, request := range transport.requests {
		if strings.HasSuffix(request.URL.Path, "/crawl") {
			t.Fatal("no /crawl request may be issued for a blocked URL")
		}
	}
}

// TestEnsureHealthyCachesWithinTTL pins the process-local health TTL: one
// /health probe per TTL, not per crawl.
func TestEnsureHealthyCachesWithinTTL(t *testing.T) {
	health := 0
	client, transport := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			health++
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	})
	now := time.Now().UnixMilli()
	client.options.Now = func() int64 { return now }

	for index := 0; index < 2; index++ {
		if _, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://example.com/a", Options: CrawlOptions{CacheMode: "bypass"}}, Settings{RequestTimeoutNormalMs: 5000, HealthCheckTTLMs: 60_000}); err != nil {
			t.Fatal(err)
		}
	}
	if health != 1 {
		t.Fatalf("health probes = %d", health)
	}
	// After the TTL expires one more probe is issued.
	now += 60_001
	if _, err := client.Crawl(context.Background(), CrawlRequest{URL: "https://example.com/a", Options: CrawlOptions{CacheMode: "bypass"}}, Settings{RequestTimeoutNormalMs: 5000, HealthCheckTTLMs: 60_000}); err != nil {
		t.Fatal(err)
	}
	if health != 2 {
		t.Fatalf("health probes after TTL = %d", health)
	}
	_ = transport
}

// TestNormalizeOptionsResolvesDiscoveryDefaults pins the normalization the
// payload builder relies on (prefetch/scoreLinks/discovery flags are set by the
// caller, waitUntil and the word count threshold default here).
func TestNormalizeOptionsResolvesDiscoveryDefaults(t *testing.T) {
	options := NormalizeOptions(json.RawMessage(`{"includeImages":false}`))
	if options.CacheMode != "bypass" {
		t.Fatalf("cache mode = %s", options.CacheMode)
	}
	if options.WordCountThreshold == nil || *options.WordCountThreshold != 80 {
		t.Fatalf("word count threshold = %v", options.WordCountThreshold)
	}
	if options.OnlyMainContent != true || !options.ExcludeExternalLinks || !options.RemoveOverlayElements || !options.ProcessIframes {
		t.Fatalf("booleans = %+v", options)
	}
	if options.IncludeImages {
		t.Fatal("includeImages must stay false")
	}
}
