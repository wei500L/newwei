package newspipeline

// Unit tests for the crawl bridge: URL fingerprint canonicalization, the
// CrawlTask option document, display-name truncation, candidate selection and
// the branch errors the clean stage relies on.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
)

type contentTestAlternateLogger struct {
	calls []string
}

func (l *contentTestAlternateLogger) logAlternateSelection(_ context.Context, orgID, crawlTaskID, preferredResultID, selectedResultID, preferredSourceURL string) error {
	l.calls = append(l.calls, orgID+"/"+crawlTaskID+"/"+preferredResultID+"/"+selectedResultID+"/"+preferredSourceURL)
	return nil
}

func contentTestBridge(crawl CrawlExecutor) *crawlBridge {
	fixedNow := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	config := NewsPipelineConfig{Crawl4AI: Crawl4AIConfig{UserAgent: "ua-default"}}
	bridge := newCrawlBridge(nil, nil, crawl, config, func() time.Time { return fixedNow })
	sqlFake := &contentTestSQL{}
	reader := &contentTestReader{
		byID:        map[string]*crawlbridgeContentDoc{},
		byResultIDs: map[string]*crawlbridgeContentDoc{},
		processed:   map[string]json.RawMessage{},
	}
	logger := &contentTestAlternateLogger{}
	bridge.sql = sqlFake
	bridge.contents = reader
	bridge.alternate = logger
	return bridge
}

func contentTestBridgeParts(bridge *crawlBridge) (*contentTestSQL, *contentTestReader, *contentTestAlternateLogger) {
	return bridge.sql.(*contentTestSQL), bridge.contents.(*contentTestReader), bridge.alternate.(*contentTestAlternateLogger)
}

func TestCrawlbridgeCanonicalURLFingerprint(t *testing.T) {
	canonical, fingerprint, ok := crawlbridgeBuildCanonicalURLFingerprint(
		"https://Example.com//a/b/?b=2&a=1&utm_source=x#fragment",
		[]string{"b", "a"},
	)
	if !ok {
		t.Fatalf("canonicalization failed")
	}
	if canonical != "https://example.com/a/b?a=1&b=2" {
		t.Fatalf("canonical = %q", canonical)
	}
	sum := sha256.Sum256([]byte(canonical))
	if fingerprint != hex.EncodeToString(sum[:]) {
		t.Fatalf("fingerprint = %q", fingerprint)
	}

	// URLSearchParams serialization: a space is written as '+', '~' and '!' are
	// percent-encoded.
	encoded, _, ok := crawlbridgeBuildCanonicalURLFingerprint("https://x.com/?id=a+b~c", []string{"id"})
	if !ok || encoded != "https://x.com/?id=a+b%7Ec" {
		t.Fatalf("encoded canonical = %q", encoded)
	}

	// No scheme defaults to https; a non-http value fails.
	withScheme, _, ok := crawlbridgeBuildCanonicalURLFingerprint("Example.com/story", []string{})
	if !ok || withScheme != "https://example.com/story" {
		t.Fatalf("scheme default canonical = %q", withScheme)
	}
	if _, _, ok := crawlbridgeBuildCanonicalURLFingerprint("http://", nil); ok {
		t.Fatalf("a URL without a host must not canonicalize")
	}
}

func TestBuildCrawlTaskOptionsPreservesSpreadOrder(t *testing.T) {
	bridge := contentTestBridge(&contentTestCrawl{})
	bridge.config.Crawl4AI = Crawl4AIConfig{
		UserAgent:       "ua-default",
		Markdown:        json.RawMessage(`{"m":true}`),
		CleanMarkdown:   nil,
		CrawlerDefaults: json.RawMessage(`{"markdownOptions":{"x":1},"cleanMarkdown":{"a":2},"userAgent":"default-ua","jsCode":"z"}`),
	}
	payload := NormalizedPayload{
		URL:          "https://example.com/a",
		CrawlOptions: json.RawMessage(`{"userAgent":"payload-ua","extra":1}`),
	}
	options, err := bridge.buildCrawlTaskOptions(payload)
	if err != nil {
		t.Fatalf("buildCrawlTaskOptions: %v", err)
	}
	want := `{"markdownOptions":{"m":true},"cleanMarkdown":{"a":2},"userAgent":"payload-ua","jsCode":"z","extra":1}`
	if string(options) != want {
		t.Fatalf("options = %s, want %s", options, want)
	}

	// The crawl4ai LLM guard rejects extraction/LLM options.
	payload.CrawlOptions = json.RawMessage(`{"llmConfig":{"model":"x"}}`)
	if _, err := bridge.buildCrawlTaskOptions(payload); err == nil {
		t.Fatalf("expected the crawl4ai LLM guard to reject llmConfig")
	}
}

func TestCrawlViaCrawlTaskDisplayNameUsesSourceNameAndHostname(t *testing.T) {
	bridge := contentTestBridge(&contentTestCrawl{})
	sqlFake, _, _ := contentTestBridgeParts(bridge)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		switch {
		case strings.Contains(query, "FROM `CrawlTask`"):
			return contentTestRow{scan: contentTestScan("task-1")}
		case strings.Contains(query, "FROM `CrawlResult`"):
			return contentTestRow{}
		}
		return contentTestRow{}
	}

	longSourceName := strings.Repeat("新闻来源", 30)
	payload := NormalizedPayload{URL: "https://example.com/a", SourceName: contentTestString(longSourceName)}
	if _, err := bridge.crawlViaCrawlTask(context.Background(), "org-1", payload.URL, payload); err == nil {
		t.Fatalf("expected the missing crawl results error")
	}
	if len(sqlFake.executed) != 1 || !strings.Contains(sqlFake.executed[0].query, "UPDATE `CrawlTask`") {
		t.Fatalf("expected one CrawlTask update, got %+v", sqlFake.executed)
	}
	displayName, ok := sqlFake.executed[0].args[0].(string)
	if !ok {
		t.Fatalf("displayName argument = %T", sqlFake.executed[0].args[0])
	}
	wantDisplayName := truncateUTF16("NewsPipeline: "+longSourceName, 80)
	if displayName != wantDisplayName {
		t.Fatalf("displayName = %q, want %q", displayName, wantDisplayName)
	}

	sqlFake.executed = nil
	hostPayload := NormalizedPayload{URL: "https://Fallback.Example.com/story?id=1"}
	if _, err := bridge.crawlViaCrawlTask(context.Background(), "org-1", hostPayload.URL, hostPayload); err == nil {
		t.Fatalf("expected the missing crawl results error")
	}
	hostDisplayName, _ := sqlFake.executed[0].args[0].(string)
	if hostDisplayName != "NewsPipeline: fallback.example.com" {
		t.Fatalf("hostname displayName = %q", hostDisplayName)
	}
}

func TestCrawlViaCrawlTaskFailsWithoutActor(t *testing.T) {
	bridge := contentTestBridge(&contentTestCrawl{})
	sqlFake, _, _ := contentTestBridgeParts(bridge)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		return contentTestRow{} // no existing task, no membership
	}
	payload := NormalizedPayload{URL: "https://example.com/a"}
	_, err := bridge.crawlViaCrawlTask(context.Background(), "org-1", payload.URL, payload)
	if err == nil || err.Error() != "crawl task actor unavailable" {
		t.Fatalf("error = %v", err)
	}
}

func TestSelectBestPipelineCrawlResultIDPrefersHigherQualityCandidate(t *testing.T) {
	crawl := &contentTestCrawl{}
	bridge := contentTestBridge(crawl)
	sqlFake, reader, logger := contentTestBridgeParts(bridge)
	sqlFake.queryFn = func(query string, args []any) (contentRows, error) {
		return &contentTestRows{rows: []contentRow{
			contentTestRow{scan: contentTestScan("short", sql.NullString{String: "https://example.com/short", Valid: true})},
			contentTestRow{scan: contentTestScan("long", sql.NullString{String: "https://example.com/other", Valid: true})},
		}}, nil
	}
	reader.byResultIDs["short"] = contentTestDocument("# Short\n\nTiny body.", "")
	longBody := "# Long\n\n" + strings.Repeat("Substantive detail sentence. ", 200)
	reader.byResultIDs["long"] = contentTestDocument(longBody, "")

	best, err := bridge.selectBestPipelineCrawlResultID(context.Background(), "org-1", "task-1", "short", "https://example.com/short")
	if err != nil {
		t.Fatalf("selectBestPipelineCrawlResultID: %v", err)
	}
	if best != "long" {
		t.Fatalf("best = %q, want long", best)
	}
	if len(logger.calls) != 1 || !strings.Contains(logger.calls[0], "/short/long/") {
		t.Fatalf("alternative selection log calls = %v", logger.calls)
	}
}

func TestSelectBestPipelineCrawlResultIDKeepsPreferredWhenNoContent(t *testing.T) {
	bridge := contentTestBridge(&contentTestCrawl{})
	_, _, _ = contentTestBridgeParts(bridge)
	// No queryFn rows means the preferred result survives selection.
	best, err := bridge.selectBestPipelineCrawlResultID(context.Background(), "org-1", "task-1", "preferred", "https://example.com/a")
	if err != nil {
		t.Fatalf("selectBestPipelineCrawlResultID: %v", err)
	}
	if best != "preferred" {
		t.Fatalf("best = %q, want preferred", best)
	}
}

func TestCrawlViaCrawlTaskUsesReusedResultID(t *testing.T) {
	crawl := &contentTestCrawl{summaries: []crawlexecution.Summary{{ReusedResultID: "cr-reused"}}}
	bridge := contentTestBridge(crawl)
	sqlFake, reader, _ := contentTestBridgeParts(bridge)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		switch {
		case strings.Contains(query, "FROM `CrawlTask`"):
			return contentTestRow{scan: contentTestScan("task-1")}
		case strings.Contains(query, "FROM `CrawlResult` WHERE `id` = ?"):
			return contentTestRow{scan: contentTestScan("cr-reused")}
		case strings.Contains(query, "FROM `CrawlResult` cr"):
			return contentTestStoredRow("cr-reused", "https://example.com/a", time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC), "0123456789abcdef01234567", "hash", nil)
		}
		return contentTestRow{}
	}
	sqlFake.queryFn = func(query string, args []any) (contentRows, error) {
		return &contentTestRows{rows: []contentRow{
			contentTestRow{scan: contentTestScan("cr-reused", sql.NullString{String: "https://example.com/a", Valid: true})},
		}}, nil
	}
	reader.byResultIDs["cr-reused"] = contentTestDocument("# Reused\n\nBody", "")
	reader.byID["0123456789abcdef01234567"] = contentTestDocument("# Reused\n\nBody", "")

	payload := NormalizedPayload{URL: "https://example.com/a"}
	result, err := bridge.crawlViaCrawlTask(context.Background(), "org-1", payload.URL, payload)
	if err != nil {
		t.Fatalf("crawlViaCrawlTask: %v", err)
	}
	if result.CrawlResultID != "cr-reused" || result.CrawlTaskID != "task-1" {
		t.Fatalf("result = %+v", result)
	}
}

func TestFindRecentStoredCrawlResultIDFallsBackToRawURL(t *testing.T) {
	bridge := contentTestBridge(&contentTestCrawl{})
	sqlFake, _, _ := contentTestBridgeParts(bridge)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		if strings.Contains(query, "sourceUrlFingerprint") {
			return contentTestRow{} // no fingerprint hit
		}
		return contentTestRow{scan: contentTestScan("fallback-1")}
	}
	id, err := bridge.findRecentStoredCrawlResultID(context.Background(), "org-1", "https://example.com/a", time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC), []string{"id"})
	if err != nil {
		t.Fatalf("findRecentStoredCrawlResultID: %v", err)
	}
	if id != "fallback-1" {
		t.Fatalf("id = %q", id)
	}
}
