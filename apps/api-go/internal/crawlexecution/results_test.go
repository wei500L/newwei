package crawlexecution

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
)

func TestCanonicalURLFingerprint(t *testing.T) {
	allowlist := []string{"id", "story"}
	canonical := buildCanonicalURLFingerprint("HTTPS://News.Example.com:443/2026/10/story/?story=7&utm=1#frag", allowlist)
	if canonical == nil {
		t.Fatal("canonical is nil")
	}
	if canonical.CanonicalURL != "https://news.example.com/2026/10/story?story=7" {
		t.Fatalf("canonical = %q", canonical.CanonicalURL)
	}
	if len(canonical.Fingerprint) != 64 {
		t.Fatalf("fingerprint = %q", canonical.Fingerprint)
	}

	stripped := canonicalizeURLWithQueryAllowlist("https://news.example.com/a?id=1", []string{})
	if stripped != "https://news.example.com/a" {
		t.Fatalf("explicit empty allowlist must strip every query: %q", stripped)
	}

	if parsed := buildCanonicalURLFingerprint("not a url", nil); parsed != nil {
		t.Fatalf("invalid url must return nil: %#v", parsed)
	}

	same := buildCanonicalURLFingerprint("https://news.example.com/a/", allowlist)
	if same == nil || same.CanonicalURL != "https://news.example.com/a" {
		t.Fatalf("trailing slash normalization = %#v", same)
	}
}

func TestHashMarkdown(t *testing.T) {
	if hashMarkdown("hello") != hashMarkdown("hello") {
		t.Fatal("hash must be deterministic")
	}
	if hashMarkdown("hello") == hashMarkdown("hello ") {
		t.Fatal("hash must include whitespace")
	}
	if len(hashMarkdown("hello")) != 64 {
		t.Fatal("hash must be sha-256 hex")
	}
}

func TestExtractMarkdownResultPrefersCitationsBody(t *testing.T) {
	raw := json.RawMessage(`{
		"raw_markdown": "# Title\n\nThe body text is here and long enough to score.",
		"markdown_with_citations": "# Title [^1]\n\nA much richer body with citations and multiple paragraphs.\n\n[^1]: https://source.example.com/a",
		"fit_markdown": "Short fit body."
	}`)
	result := extractMarkdownResult(raw)
	if result.Primary == nil || !strings.Contains(*result.Primary, "richer body") {
		t.Fatalf("primary = %#v", result.Primary)
	}
	if result.Citations == nil || !strings.Contains(*result.Citations, "[^1]:") {
		t.Fatalf("citations = %#v", result.Citations)
	}
	if result.Fit == nil || *result.Fit != "Short fit body." {
		t.Fatalf("fit = %#v", result.Fit)
	}
}

func TestExtractMarkdownResultStringAndEmpty(t *testing.T) {
	plain := extractMarkdownResult(json.RawMessage(`"Hello world"`))
	if plain.Primary == nil || *plain.Primary != "Hello world" {
		t.Fatalf("plain = %#v", plain.Primary)
	}
	empty := extractMarkdownResult(json.RawMessage(`null`))
	if empty.Primary != nil {
		t.Fatalf("empty primary = %#v", empty.Primary)
	}
}

func TestClassifyResultAndPartition(t *testing.T) {
	success := crawl4ai.PipelineArticle{
		URL:      "https://news.example.com/a",
		Markdown: json.RawMessage(`"# Headline\n\nA long article body with several sentences. It has enough words to stay above the low-signal threshold and clearly looks like article content."`),
	}
	lowSignal := crawl4ai.PipelineArticle{
		URL:      "https://news.example.com/list",
		Markdown: json.RawMessage(`"Latest news"`),
	}
	blocked := crawl4ai.PipelineArticle{
		URL:        "https://news.example.com/b",
		StatusCode: intPtrOf(403),
		Markdown:   json.RawMessage(`"Access denied"`),
	}
	partition := partitionCrawlerResults([]crawl4ai.PipelineArticle{success, lowSignal, blocked})
	if len(partition.Successes) != 1 || len(partition.LowSignalCandidates) != 1 || len(partition.Failures) != 2 {
		t.Fatalf("partition = %#v", partition)
	}
	if partition.Failures[0].Retryable {
		t.Fatalf("low-signal failure must not be retryable: %#v", partition.Failures[0])
	}
	if !partition.Failures[1].Retryable || partition.Failures[1].StatusCode == nil || *partition.Failures[1].StatusCode != 403 {
		t.Fatalf("403 failure must be retryable: %#v", partition.Failures[1])
	}
	if partition.Failures[0].Message == "" || partition.Failures[1].Message == "" {
		t.Fatal("failure messages are required")
	}
}

func TestBuildFailureDetailMessages(t *testing.T) {
	challenge := crawl4ai.PipelineArticle{
		URL:      "https://news.example.com/a",
		Markdown: json.RawMessage(`"Checking your browser before accessing. Cloudflare captcha verification required."`),
	}
	failure := buildFailureDetail(challenge)
	if !strings.Contains(failure.Message, "anti-bot") && !strings.Contains(failure.Message, "verification") {
		t.Fatalf("message = %q", failure.Message)
	}
	if failure.Retryable {
		t.Fatal("challenge failure is not retryable by status")
	}

	empty := buildFailureDetail(crawl4ai.PipelineArticle{URL: "https://news.example.com/a"})
	if !strings.Contains(empty.Message, "empty markdown") {
		t.Fatalf("empty message = %q", empty.Message)
	}
}

func TestBuildNoResultsError(t *testing.T) {
	if got := buildNoResultsError(nil).Error(); got != "crawl task produced no results (0 results returned)" {
		t.Fatalf("got %q", got)
	}
	status := 404
	message := buildNoResultsError([]Failure{{URL: "https://example.com/a", StatusCode: &status, Message: "not found"}}).Error()
	if !strings.Contains(message, "1 failure") || !strings.Contains(message, "HTTP 404") || !strings.Contains(message, "https://example.com/a") {
		t.Fatalf("got %q", message)
	}
}

func timePointer() *time.Time {
	value := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	return &value
}

func TestSummaryLogData(t *testing.T) {
	fetchedAt := timePointer()
	summary := Summary{
		Inserted:          2,
		Skipped:           1,
		ReusedResultID:    "result-1",
		RunID:             "run-1",
		LastFetchedAt:     fetchedAt,
		ItemsQueued:       2,
		ItemsQueueFailed:  1,
		RetryableFailures: 1,
	}
	data := summaryLogData(summary)
	if data["inserted"] != 2 || data["skipped"] != 1 || data["reusedResultId"] != "result-1" ||
		data["runId"] != "run-1" || data["itemsQueued"] != 2 || data["itemsQueueFailed"] != 1 ||
		data["retryableFailures"] != 1 {
		t.Fatalf("data = %#v", data)
	}
	if _, ok := data["lastFetchedAt"].(string); !ok {
		t.Fatalf("lastFetchedAt = %#v", data["lastFetchedAt"])
	}
}

func TestIsRetryableStatus(t *testing.T) {
	status := 429
	if !isRetryableStatus(&status, "") {
		t.Fatal("429 must be retryable")
	}
	if !isRetryableStatus(nil, "request Timeout exceeded") {
		t.Fatal("timeout message must be retryable")
	}
	if isRetryableStatus(nil, "not found") {
		t.Fatal("not found must not be retryable")
	}
}

func TestURLHelpers(t *testing.T) {
	if got := normalizeComparableURL("https://example.com/a/#frag"); got != "https://example.com/a" {
		t.Fatalf("normalizeComparableUrl = %q", got)
	}
	if isLikelyDetailArticleURL("https://example.com/", "https://example.com/", false, true) {
		t.Fatal("root path is not a detail url")
	}
	if !isLikelyDetailArticleURL("https://example.com/2026/10/20/some-story-title", "https://example.com/", false, true) {
		t.Fatal("date-path article must be a detail url")
	}
	if isLikelyDetailArticleURL("https://example.com/tag/climate", "https://example.com/", false, true) {
		t.Fatal("tag path is not a detail url")
	}
	if !urlMatchesPattern("https://example.com/a", "*example.com/a*") {
		t.Fatal("wildcard pattern must match")
	}
	if !urlMatchesPattern("https://example.com/a", "/example\\.com/") {
		t.Fatal("regex pattern must match")
	}
}
