package crawlexecution

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// preflightTransport is a scripted RoundTripper. The probed URL uses a public
// IP literal so the shared SSRF rules accept it without a DNS lookup.
type preflightTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	respond  func(req *http.Request) *http.Response
}

func (p *preflightTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	p.mu.Lock()
	p.requests = append(p.requests, req.Clone(context.Background()))
	p.mu.Unlock()
	return p.respond(req), nil
}

func preflightResponse(status int, headers map[string]string) *http.Response {
	header := http.Header{}
	for key, value := range headers {
		header.Set(key, value)
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader("")),
	}
}

func newPreflightService(transport http.RoundTripper) *Service {
	return New(Options{
		Config:     Config{},
		HTTPClient: &http.Client{Transport: transport},
		Now:        func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
}

func TestConditionalPreflightHEAD304(t *testing.T) {
	transport := &preflightTransport{respond: func(req *http.Request) *http.Response {
		return preflightResponse(http.StatusNotModified, map[string]string{"etag": "  \"abc\"  "})
	}}
	service := newPreflightService(transport)
	etag := `"abc"`
	lastModified := "Wed, 21 Oct 2026 07:28:00 GMT"
	outcome := service.runConditionalPreflight(context.Background(), conditionalPreflightInput{
		TargetURL:    "https://8.8.8.8/article/example-slug-1234567890",
		Options:      crawloptions.NormalizeOptions(&crawloptions.OptionsInput{UserAgent: stringPtr("Probe UA")}),
		ETag:         &etag,
		LastModified: &lastModified,
		TimeoutMs:    5_000,
		MaxRetries:   0,
	})
	if outcome == nil || outcome.Status != "completed" || outcome.Result == nil {
		t.Fatalf("outcome = %#v", outcome)
	}
	if outcome.Result.Status != http.StatusNotModified || outcome.Result.Method != http.MethodHead {
		t.Fatalf("result = %#v", outcome.Result)
	}
	if outcome.Result.ETag == nil || *outcome.Result.ETag != `"abc"` {
		t.Fatalf("etag = %#v", outcome.Result.ETag)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("requests = %d", len(transport.requests))
	}
	request := transport.requests[0]
	if got := request.Header.Get("if-none-match"); got != etag {
		t.Fatalf("if-none-match = %q", got)
	}
	if got := request.Header.Get("if-modified-since"); got != lastModified {
		t.Fatalf("if-modified-since = %q", got)
	}
	if got := request.Header.Get("user-agent"); got != "Probe UA" {
		t.Fatalf("user-agent = %q", got)
	}
}

func TestConditionalPreflightFallsBackToGET(t *testing.T) {
	var methods []string
	transport := &preflightTransport{respond: func(req *http.Request) *http.Response {
		methods = append(methods, req.Method)
		if req.Method == http.MethodHead {
			return preflightResponse(http.StatusMethodNotAllowed, nil)
		}
		return preflightResponse(http.StatusNotModified, map[string]string{"last-modified": "Wed, 21 Oct 2026 07:28:00 GMT"})
	}}
	service := newPreflightService(transport)
	outcome := service.runConditionalPreflight(context.Background(), conditionalPreflightInput{
		TargetURL:  "https://8.8.8.8/article/example",
		Options:    crawloptions.NormalizeOptions(&crawloptions.OptionsInput{}),
		TimeoutMs:  5_000,
		MaxRetries: 0,
	})
	if outcome == nil || outcome.Status != "completed" || outcome.Result == nil {
		t.Fatalf("outcome = %#v", outcome)
	}
	if outcome.Result.Method != http.MethodGet || outcome.Result.Status != http.StatusNotModified {
		t.Fatalf("result = %#v", outcome.Result)
	}
	if len(methods) != 2 || methods[0] != http.MethodHead || methods[1] != http.MethodGet {
		t.Fatalf("methods = %#v", methods)
	}
}

func TestConditionalPreflightRetriesTransientStatus(t *testing.T) {
	attempts := 0
	transport := &preflightTransport{respond: func(req *http.Request) *http.Response {
		attempts++
		if attempts == 1 {
			return preflightResponse(http.StatusServiceUnavailable, nil)
		}
		return preflightResponse(http.StatusOK, nil)
	}}
	service := newPreflightService(transport)
	outcome := service.runConditionalPreflight(context.Background(), conditionalPreflightInput{
		TargetURL:  "https://8.8.8.8/article/example",
		Options:    crawloptions.NormalizeOptions(&crawloptions.OptionsInput{}),
		TimeoutMs:  5_000,
		MaxRetries: 1,
	})
	if outcome == nil || outcome.Status != "completed" || outcome.Result == nil {
		t.Fatalf("outcome = %#v", outcome)
	}
	if outcome.Attempts != 2 || outcome.Failures != 1 || outcome.Result.Status != http.StatusOK {
		t.Fatalf("outcome = %#v", outcome)
	}
}

func TestConditionalPreflightBlocksPrivateRedirectHop(t *testing.T) {
	transport := &preflightTransport{respond: func(req *http.Request) *http.Response {
		return preflightResponse(http.StatusFound, map[string]string{"location": "http://127.0.0.1:6379/"})
	}}
	service := newPreflightService(transport)
	outcome := service.runConditionalPreflight(context.Background(), conditionalPreflightInput{
		TargetURL:  "https://8.8.8.8/article/example",
		Options:    crawloptions.NormalizeOptions(&crawloptions.OptionsInput{}),
		TimeoutMs:  5_000,
		MaxRetries: 0,
	})
	if outcome == nil || outcome.Status != "failed" {
		t.Fatalf("outcome = %#v", outcome)
	}
}

func TestAttachHTTPValidationMetadataOnlyTarget(t *testing.T) {
	metadata := map[string]any{
		"httpValidationStatus": 200,
		"httpValidationMethod": "HEAD",
		"httpEtag":             `"abc"`,
	}
	successes := []crawl4ai.PipelineArticle{
		{URL: "https://news.example.com/2026/10/20/target-story", Metadata: []byte(`{"title":"target"}`)},
		{URL: "https://news.example.com/other/detail-story", Metadata: []byte(`{"title":"other"}`)},
	}
	attached := attachHTTPValidationMetadata(successes, metadata, "https://news.example.com/2026/10/20/target-story")
	if len(attached) != 2 {
		t.Fatalf("attached = %d", len(attached))
	}
	var target map[string]any
	if err := json.Unmarshal(attached[0].Metadata, &target); err != nil {
		t.Fatal(err)
	}
	if target["httpEtag"] != `"abc"` || target["title"] != "target" {
		t.Fatalf("target metadata = %#v", target)
	}
	var other map[string]any
	if err := json.Unmarshal(attached[1].Metadata, &other); err != nil {
		t.Fatal(err)
	}
	if _, exists := other["httpEtag"]; exists {
		t.Fatalf("detail article must not receive target validators: %#v", other)
	}
}
