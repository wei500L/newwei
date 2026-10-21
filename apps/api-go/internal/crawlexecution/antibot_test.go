package crawlexecution

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
)

// crawlStubTransport answers the crawl4ai /health and /crawl calls in process.
type crawlStubTransport struct {
	mu       sync.Mutex
	bodies   []string
	requests []*http.Request
	respond  func(call int, req *http.Request, body string) (*http.Response, error)
}

func (c *crawlStubTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		_ = req.Body.Close()
		body = string(raw)
	}
	c.mu.Lock()
	call := len(c.requests)
	c.requests = append(c.requests, req.Clone(req.Context()))
	c.bodies = append(c.bodies, body)
	c.mu.Unlock()
	return c.respond(call, req, body)
}

func crawlJSONResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func newCrawlTestService(transport http.RoundTripper) *Service {
	return New(Options{
		Config: Config{
			CrawlBaseURL:          "http://8.8.8.8:9999",
			CrawlAPIKey:           "test-key",
			CrawlTimeoutMs:        5_000,
			CrawlHealthCheckTTLMs: 60_000,
			CrawlJSCodeEnabled:    true,
		},
		HTTPClient: &http.Client{Transport: transport},
		Now:        func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
}

func testTask() *taskRow {
	return &taskRow{
		ID:          "task-1",
		OrgID:       "org-1",
		CreatedByID: "user-1",
		TargetURL:   "https://news.example.com/2026/10/20/story-slug-title",
	}
}

func TestRunCrawlWithHeadedFallbackRetriesHeadless(t *testing.T) {
	transport := &crawlStubTransport{respond: func(call int, req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return crawlJSONResponse(http.StatusOK, `{}`), nil
		}
		if call == 1 {
			return crawlJSONResponse(http.StatusInternalServerError, `{"message":"Cannot open display: :99"}`), nil
		}
		return crawlJSONResponse(http.StatusOK, `{"runId":"run-2","results":[{"url":"https://news.example.com/2026/10/20/story-slug-title","success":true,"markdown":"# Title\n\nA body with enough words to be considered article content for the classifier. It also has a couple of sentences."}]}`), nil
	}}
	service := newCrawlTestService(transport)
	headless := false
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		Headless:  &headless,
		UserAgent: stringPtr("Test UA"),
	})
	task := testTask()
	payload := service.buildRequestPayload(task, service.normalizer(), options)
	run, err := service.runCrawlWithHeadedFallback(context.Background(), crawlCall{
		Request:          payload,
		Options:          payload.Options,
		RequestTimeoutMs: 5_000,
		TaskID:           task.ID,
		OrgID:            task.OrgID,
		Stage:            "crawler",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(run.Successes) != 1 {
		t.Fatalf("successes = %d", len(run.Successes))
	}
	if run.Response.RunID != "run-2" {
		t.Fatalf("runId = %q", run.Response.RunID)
	}
	if len(transport.bodies) != 3 { // health + two crawl attempts
		t.Fatalf("bodies = %d", len(transport.bodies))
	}
	lastBody := transport.bodies[len(transport.bodies)-1]
	if !strings.Contains(lastBody, `"headless":true`) {
		t.Fatalf("fallback request must set headless=true: %s", lastBody)
	}
	var payloadBody map[string]any
	if err := json.Unmarshal([]byte(transport.bodies[1]), &payloadBody); err != nil {
		t.Fatal(err)
	}
	browserConfig, _ := payloadBody["browser_config"].(map[string]any)
	params, _ := browserConfig["params"].(map[string]any)
	if params == nil || params["headless"] != false {
		t.Fatalf("first request must keep headless=false: %#v", params)
	}
}

func TestClassifyResultKinds(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"success", `# Headline` + "\n\n" + `A sufficiently long article body with several sentences. It has plenty of words and paragraphs so the classifier accepts it as a normal article result.`, "success"},
		{"low", `Latest news`, "low_signal"},
		{"challenge", `Checking your browser before accessing. Cloudflare captcha verification required.`, "failure"},
		{"http", `# Error` + "\n\n" + `Access denied`, "failure"},
	}
	for _, testCase := range cases {
		item := crawl4aiArticle(`"` + escapeJSON(testCase.body) + `"`)
		if testCase.name == "http" {
			item.StatusCode = intPtrOf(403)
		}
		kind, _, _, _, _ := classifyResult(item)
		if kind != testCase.want {
			t.Fatalf("%s: kind = %q, want %q", testCase.name, kind, testCase.want)
		}
	}
}

func escapeJSON(value string) string {
	encoded, _ := json.Marshal(value)
	encodedString := string(encoded)
	return encodedString[1 : len(encodedString)-1]
}

func TestShouldFallbackToHeadless(t *testing.T) {
	headlessFalse := false
	headlessTrue := true
	if !shouldFallbackToHeadless(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{Headless: &headlessFalse}), fmt.Errorf("Cannot open display: :99")) {
		t.Fatal("display error with headless=false must fall back")
	}
	if shouldFallbackToHeadless(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{Headless: &headlessTrue}), fmt.Errorf("Cannot open display: :99")) {
		t.Fatal("headless=true must not fall back")
	}
	if shouldFallbackToHeadless(crawloptions.NormalizeOptions(&crawloptions.OptionsInput{Headless: &headlessFalse}), fmt.Errorf("connection refused")) {
		t.Fatal("non-display errors must not trigger the headless fallback")
	}
}

func TestBuildAntiBotWarmupURLs(t *testing.T) {
	urls := buildAntiBotWarmupURLs("https://news.example.com/world/europe/story-slug-123")
	if len(urls) == 0 {
		t.Fatal("warmup urls must not be empty")
	}
	if urls[0] != "https://news.example.com/" {
		t.Fatalf("origin = %q", urls[0])
	}
	for _, value := range urls {
		if normalizeComparableURL(value) == "https://news.example.com/world/europe/story-slug-123" {
			t.Fatalf("warmup must not include the target: %#v", urls)
		}
	}
}

func TestBuildHardenedAntiBotOptions(t *testing.T) {
	service := newCrawlTestService(http.DefaultTransport)
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		AntiBotMode: stringPtr("auto"),
		SessionID:   stringPtr("session-1"),
	})
	hardened := service.buildHardenedAntiBotOptions(options, "https://news.example.com/a/story-slug-title")
	if hardened.Headless == nil || *hardened.Headless {
		t.Fatalf("headless = %#v", hardened.Headless)
	}
	if !hardened.EnableUndetectedBrowser || !hardened.EnableStealthMode || !hardened.SimulateUser || !hardened.OverrideNavigator {
		t.Fatal("hardened flags must all be enabled")
	}
	if hardened.SessionID == nil || *hardened.SessionID != "session-1" {
		t.Fatalf("session reuse = %#v", hardened.SessionID)
	}
	if hardened.ScanFullPage {
		t.Fatal("hardened options must disable scanFullPage")
	}
	if hardened.VirtualScroll == nil || hardened.VirtualScroll.ScrollCount == nil || *hardened.VirtualScroll.ScrollCount != 8 {
		t.Fatalf("virtualScroll = %#v", hardened.VirtualScroll)
	}
	if hardened.WaitForTimeoutMs == nil || *hardened.WaitForTimeoutMs < 10_000 {
		t.Fatalf("waitForTimeoutMs = %#v", hardened.WaitForTimeoutMs)
	}
}

func TestEmptyMarkdownFallbackProfiles(t *testing.T) {
	service := newCrawlTestService(http.DefaultTransport)
	options := crawloptions.NormalizeOptions(&crawloptions.OptionsInput{
		MarkdownFilter: &crawloptions.MarkdownFilter{
			Type:      "bm25",
			UserQuery: stringPtr("climate policy"),
		},
	})
	profiles := service.buildEmptyMarkdownFallbackProfiles(options)
	if len(profiles) != 4 {
		t.Fatalf("profiles = %d", len(profiles))
	}
	labels := map[string]bool{}
	for _, profile := range profiles {
		labels[profile.Label] = true
	}
	for _, label := range []string{"raw_relaxed", "cleaned_balanced", "raw_relaxed_linkscan", "bm25_focus"} {
		if !labels[label] {
			t.Fatalf("missing profile %q: %#v", label, labels)
		}
	}
	rawRelaxed := profiles[0].Options
	if rawRelaxed.OnlyMainContent {
		t.Fatal("raw_relaxed must disable onlyMainContent")
	}
	if rawRelaxed.MarkdownOptions == nil || rawRelaxed.MarkdownOptions.ContentSource == nil ||
		*rawRelaxed.MarkdownOptions.ContentSource != "raw_html" {
		t.Fatalf("raw_relaxed contentSource = %#v", rawRelaxed.MarkdownOptions)
	}
	if rawRelaxed.WordCountThreshold == nil || *rawRelaxed.WordCountThreshold != 10 {
		t.Fatalf("raw_relaxed wordCountThreshold = %#v", rawRelaxed.WordCountThreshold)
	}
}

// crawl4aiArticle builds a PipelineArticle with a JSON-string markdown leaf.
func crawl4aiArticle(markdownJSON string) crawl4ai.PipelineArticle {
	return crawl4ai.PipelineArticle{Markdown: json.RawMessage(markdownJSON)}
}
