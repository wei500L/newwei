package newspipeline

// Unit tests for the clean stage: fetchArticle branch selection, the
// payload.metadata side channel, markdown selection and cleanArticle's cache and
// repair paths. The MySQL/Mongo collaborators are scripted through the internal
// contentSQL/contentReader interfaces so no service is required.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// --- scripted collaborators -------------------------------------------------

type contentTestRow struct {
	scan func(dest ...any) error
}

func (r contentTestRow) Scan(dest ...any) error {
	if r.scan == nil {
		return sql.ErrNoRows
	}
	return r.scan(dest...)
}

// contentTestScan assigns the supplied values to the scan destinations.
func contentTestScan(values ...any) func(dest ...any) error {
	return func(dest ...any) error {
		if len(values) != len(dest) {
			return fmt.Errorf("contentTestScan: got %d destinations, want %d", len(dest), len(values))
		}
		for index, value := range values {
			target := reflect.ValueOf(dest[index])
			if target.Kind() != reflect.Pointer || target.IsNil() {
				return fmt.Errorf("contentTestScan: destination %d is not a pointer", index)
			}
			element := target.Elem()
			if value == nil {
				element.Set(reflect.Zero(element.Type()))
				continue
			}
			source := reflect.ValueOf(value)
			if !source.Type().AssignableTo(element.Type()) {
				return fmt.Errorf("contentTestScan: cannot assign %s to %s", source.Type(), element.Type())
			}
			element.Set(source)
		}
		return nil
	}
}

type contentTestResult struct{}

func (contentTestResult) LastInsertId() (int64, error) { return 0, nil }
func (contentTestResult) RowsAffected() (int64, error) { return 1, nil }

type contentTestRows struct {
	rows  []contentRow
	index int
}

func (r *contentTestRows) Next() bool {
	if r.index >= len(r.rows) {
		return false
	}
	r.index++
	return true
}

func (r *contentTestRows) Scan(dest ...any) error { return r.rows[r.index-1].Scan(dest...) }
func (r *contentTestRows) Err() error             { return nil }
func (r *contentTestRows) Close() error           { return nil }

type contentTestExec struct {
	query string
	args  []any
}

type contentTestSQL struct {
	mu         sync.Mutex
	queryRowFn func(query string, args []any) contentRow
	queryFn    func(query string, args []any) (contentRows, error)
	execFn     func(query string, args []any) (sql.Result, error)
	executed   []contentTestExec
	queried    []string
}

func (s *contentTestSQL) queryRowContext(_ context.Context, query string, args ...any) contentRow {
	s.mu.Lock()
	s.queried = append(s.queried, query)
	s.mu.Unlock()
	if s.queryRowFn == nil {
		return contentTestRow{}
	}
	return s.queryRowFn(query, args)
}

func (s *contentTestSQL) queryContext(_ context.Context, query string, args ...any) (contentRows, error) {
	s.mu.Lock()
	s.queried = append(s.queried, query)
	s.mu.Unlock()
	if s.queryFn == nil {
		return &contentTestRows{}, nil
	}
	return s.queryFn(query, args)
}

func (s *contentTestSQL) execContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	s.mu.Lock()
	s.executed = append(s.executed, contentTestExec{query: query, args: args})
	s.mu.Unlock()
	if s.execFn == nil {
		return contentTestResult{}, nil
	}
	return s.execFn(query, args)
}

type contentTestReader struct {
	byID        map[string]*crawlbridgeContentDoc
	byResultIDs map[string]*crawlbridgeContentDoc
	processed   map[string]json.RawMessage
	byIDErr     error
}

func (r *contentTestReader) crawlResultContentByID(_ context.Context, contentID string) (*crawlbridgeContentDoc, error) {
	if r.byIDErr != nil {
		return nil, r.byIDErr
	}
	return r.byID[contentID], nil
}

func (r *contentTestReader) crawlResultContentsByResultIDs(_ context.Context, resultIDs []string) (map[string]*crawlbridgeContentDoc, error) {
	out := map[string]*crawlbridgeContentDoc{}
	for _, resultID := range resultIDs {
		if document, ok := r.byResultIDs[resultID]; ok {
			out[resultID] = document
		}
	}
	return out, nil
}

func (r *contentTestReader) processedItemResultByID(_ context.Context, ref string) (json.RawMessage, bool, error) {
	value, ok := r.processed[ref]
	return value, ok, nil
}

type contentTestCrawl struct {
	mu        sync.Mutex
	summaries []crawlexecution.Summary
	errors    []error
	calls     []string
}

func (c *contentTestCrawl) RunTask(_ context.Context, _ string, taskID string) (crawlexecution.Summary, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, taskID)
	index := len(c.calls) - 1
	if index < len(c.errors) && c.errors[index] != nil {
		return crawlexecution.Summary{}, c.errors[index]
	}
	if index < len(c.summaries) {
		return c.summaries[index], nil
	}
	return crawlexecution.Summary{}, nil
}

type contentTestCompletion struct {
	response litellmcompat.CompletionResponse
	err      error
}

type contentTestModels struct {
	mu          sync.Mutex
	completions []contentTestCompletion
	requests    []litellmcompat.CompletionRequest
	timeoutMS   int
	timeoutErr  error
}

func (m *contentTestModels) Completion(_ context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.requests = append(m.requests, req)
	index := len(m.requests) - 1
	if index < len(m.completions) {
		return m.completions[index].response, m.completions[index].err
	}
	return litellmcompat.CompletionResponse{}, fmt.Errorf("unexpected completion call %d", index)
}

func (m *contentTestModels) Embedding(context.Context, litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
	return litellmcompat.EmbeddingResponse{}, nil
}

func (m *contentTestModels) Rerank(context.Context, litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
	return litellmcompat.RerankResponse{}, nil
}

func (m *contentTestModels) RuntimeEmbeddingModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, nil
}

func (m *contentTestModels) RuntimeRerankModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, nil
}

func (m *contentTestModels) CompletionTimeoutMS(context.Context) (int, error) {
	return m.timeoutMS, m.timeoutErr
}

// --- helpers ----------------------------------------------------------------

func contentTestString(value string) *string { copy := value; return &copy }

func contentTestCleaner(t *testing.T, models Models, crawl CrawlExecutor) (*Cleaner, *contentTestSQL, *contentTestReader) {
	t.Helper()
	fixedNow := time.Date(2024, 5, 6, 7, 8, 9, 0, time.UTC)
	cleaner := NewCleaner(CleanerDeps{
		Config: NewsPipelineConfig{Pipeline: RuntimeConfig{CacheTTLSeconds: 3600, MaxInputChars: 48000}},
		Models: models,
		Crawl:  crawl,
		Now:    func() time.Time { return fixedNow },
	})
	sqlFake := &contentTestSQL{}
	reader := &contentTestReader{
		byID:        map[string]*crawlbridgeContentDoc{},
		byResultIDs: map[string]*crawlbridgeContentDoc{},
		processed:   map[string]json.RawMessage{},
	}
	cleaner.sql = sqlFake
	cleaner.contents = reader
	cleaner.bridge.sql = sqlFake
	cleaner.bridge.contents = reader
	cleaner.bridge.crawl = crawl
	cleaner.bridge.alternate = nil
	return cleaner, sqlFake, reader
}

func contentTestJob() Job {
	return Job{Queue: "itemPipeline", JobID: "job-1", OrgID: "org-1", ProcessedItemID: "pi-1"}
}

func contentTestDocument(markdown string, metadata string) *crawlbridgeContentDoc {
	document := &crawlbridgeContentDoc{Markdown: contentTestString(markdown)}
	if metadata != "" {
		document.Metadata = contentBSONJSON(metadata)
	}
	return document
}

func contentTestStoredRow(id, sourceURL string, fetchedAt time.Time, markdownRef, contentHash string, metadata []byte) contentRow {
	return contentTestRow{scan: contentTestScan(id, sourceURL, sql.NullTime{Time: fetchedAt, Valid: true}, markdownRef, contentHash, metadata)}
}

// --- fetchArticle -----------------------------------------------------------

func TestFetchArticlePrefetchedBranch(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, _ := contentTestCleaner(t, models, crawl)
	payload := NormalizedPayload{
		URL:          "https://example.com/a",
		Language:     contentTestString("zh"),
		Metadata:     json.RawMessage(`{"sourceId":"s1"}`),
		Prefetched:   &PrefetchedArticle{Markdown: contentTestString("  # Hello  "), Title: contentTestString("Hello"), PublishedAt: contentTestString("2024-01-02T03:04:05Z")},
		ForceRefresh: false,
	}

	result, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload)
	if err != nil {
		t.Fatalf("FetchArticle: %v", err)
	}
	if result.FromCache {
		t.Fatalf("prefetched article must not be reported from cache")
	}
	if result.Markdown != "# Hello" {
		t.Fatalf("markdown = %q", result.Markdown)
	}
	if result.SourceURL != payload.URL {
		t.Fatalf("sourceUrl = %q", result.SourceURL)
	}
	if result.FetchedAt != "2024-05-06T07:08:09.000Z" {
		t.Fatalf("fetchedAt = %q", result.FetchedAt)
	}
	if result.PublishedAt == nil || *result.PublishedAt != "2024-01-02T03:04:05.000Z" {
		t.Fatalf("publishedAt = %v", result.PublishedAt)
	}
	if result.ContentHash != hashContent("# Hello") {
		t.Fatalf("contentHash = %q", result.ContentHash)
	}
	wantMetadata := `{"sourceId":"s1","prefetchedArticle":true,"title":"Hello"}`
	if string(result.Metadata) != wantMetadata {
		t.Fatalf("metadata = %s, want %s", result.Metadata, wantMetadata)
	}
	if len(sqlFake.queried) != 0 {
		t.Fatalf("prefetched branch must not query mysql: %v", sqlFake.queried)
	}
	if len(crawl.calls) != 0 {
		t.Fatalf("prefetched branch must not run a crawl task")
	}
	if state := cleaner.takePendingState(contentTestJob(), payload.URL); state.patch != nil {
		t.Fatalf("prefetched branch must not store a metadata patch")
	}
}

func TestFetchArticleStoredCrawlResultBranch(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, reader := contentTestCleaner(t, models, crawl)
	fetchedAt := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		if strings.Contains(query, "FROM `CrawlResult` cr") {
			return contentTestStoredRow("cr1", "https://example.com/a", fetchedAt, "0123456789abcdef01234567", "", []byte(`{"fromMysql":true}`))
		}
		return contentTestRow{}
	}
	reader.byID["0123456789abcdef01234567"] = contentTestDocument("# Article\n\nBody text here", `{"fromMongo":1}`)

	payload := NormalizedPayload{URL: "https://example.com/a", Metadata: json.RawMessage(`{"crawlResultId":"cr1"}`)}
	result, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload)
	if err != nil {
		t.Fatalf("FetchArticle: %v", err)
	}
	if !result.FromCache {
		t.Fatalf("stored crawl result must be reported from cache")
	}
	if result.Markdown != "# Article\n\nBody text here" {
		t.Fatalf("markdown = %q", result.Markdown)
	}
	if result.ContentHash != hashContent(result.Markdown) {
		t.Fatalf("content hash fallback = %q", result.ContentHash)
	}
	wantMetadata := `{"fromMongo":1,"fromMysql":true,"crawlResultId":"cr1"}`
	if string(result.Metadata) != wantMetadata {
		t.Fatalf("metadata = %s, want %s", result.Metadata, wantMetadata)
	}
	if result.PublishedAt == nil || *result.PublishedAt != "2024-03-04T05:06:07.000Z" {
		t.Fatalf("publishedAt = %v", result.PublishedAt)
	}
	if result.FetchedAt != "2024-03-04T05:06:07.000Z" {
		t.Fatalf("fetchedAt = %q", result.FetchedAt)
	}
	state := cleaner.takePendingState(contentTestJob(), payload.URL)
	if !state.fromCache {
		t.Fatalf("a stored crawl result must carry fromCache=true into the clean prompt")
	}
	if state.patch == nil || len(state.patch.keys) != 0 {
		t.Fatalf("branch 2 must not write payload.metadata: %+v", state.patch)
	}
}

func TestFetchArticleRecentBranchStoresCrawlResultID(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, reader := contentTestCleaner(t, models, crawl)
	fetchedAt := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		switch {
		case strings.Contains(query, "sourceUrlFingerprint"):
			return contentTestRow{scan: contentTestScan("recent-1")}
		case strings.Contains(query, "FROM `CrawlResult` cr"):
			return contentTestStoredRow("recent-1", "https://example.com/a", fetchedAt, "0123456789abcdef01234567", "hash-recent", nil)
		}
		return contentTestRow{}
	}
	reader.byID["0123456789abcdef01234567"] = contentTestDocument("# Recent\n\nBody", "")

	payload := NormalizedPayload{URL: "https://example.com/a", Metadata: json.RawMessage(`{"sourceId":"s1"}`)}
	result, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload)
	if err != nil {
		t.Fatalf("FetchArticle: %v", err)
	}
	if !result.FromCache || result.ContentHash != "hash-recent" {
		t.Fatalf("recent result = %+v", result)
	}
	state := cleaner.takePendingState(contentTestJob(), payload.URL)
	if state.patch == nil {
		t.Fatalf("recent branch must store the crawlResultId metadata patch")
	}
	if string(state.patch.marshal()) != `{"crawlResultId":"recent-1"}` {
		t.Fatalf("patch = %s", state.patch.marshal())
	}
	if !state.fromCache {
		t.Fatalf("recent branch must carry fromCache=true for the clean prompt")
	}
	if second := cleaner.takePendingState(contentTestJob(), payload.URL); second.patch != nil {
		t.Fatalf("taking the pending state must consume it")
	}
}

func TestFetchArticleCrawlTaskBranchAndCleanArticleSeesPatchedMetadata(t *testing.T) {
	models := &contentTestModels{
		completions: []contentTestCompletion{{response: litellmcompat.CompletionResponse{
			Content: `{"title":"T","source":"S","author":"A","published_at":"2024-01-02T03:04:05Z","cleaned_markdown":"# T\n\nBody"}`,
			Model:   "gpt-test",
		}}},
		timeoutMS: 60000,
	}
	crawl := &contentTestCrawl{summaries: []crawlexecution.Summary{{}}}
	cleaner, sqlFake, reader := contentTestCleaner(t, models, crawl)
	fetchedAt := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		switch {
		case strings.Contains(query, "FROM `CrawlTask`"):
			return contentTestRow{} // no reusable NewsPipeline task
		case strings.Contains(query, "FROM `Membership`"):
			return contentTestRow{scan: contentTestScan("user-1")}
		case strings.Contains(query, "FROM `CrawlResult` WHERE `id` = ?"):
			return contentTestRow{} // no reused result
		case strings.Contains(query, "FROM `CrawlResult` WHERE `taskId` = ? AND `sourceUrl`"):
			return contentTestRow{scan: contentTestScan("cr1")}
		case strings.Contains(query, "FROM `CrawlResult` cr"):
			return contentTestStoredRow("cr1", "https://example.com/a", fetchedAt, "0123456789abcdef01234567", "hash-1", nil)
		}
		return contentTestRow{}
	}
	sqlFake.queryFn = func(query string, args []any) (contentRows, error) {
		if strings.Contains(query, "LIMIT 12") {
			return &contentTestRows{rows: []contentRow{
				contentTestRow{scan: contentTestScan("cr1", sql.NullString{String: "https://example.com/a", Valid: true})},
			}}, nil
		}
		return &contentTestRows{}, nil
	}
	reader.byID["0123456789abcdef01234567"] = contentTestDocument("# T\n\nBody", "")
	reader.byResultIDs["cr1"] = reader.byID["0123456789abcdef01234567"]

	payload := NormalizedPayload{URL: "https://example.com/a", Metadata: json.RawMessage(`{"sourceId":"s1"}`)}
	result, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload)
	if err != nil {
		t.Fatalf("FetchArticle: %v", err)
	}
	if result.FromCache {
		t.Fatalf("crawl-task branch must not be reported from cache")
	}
	if len(sqlFake.executed) != 1 || !strings.Contains(sqlFake.executed[0].query, "INSERT INTO `CrawlTask`") {
		t.Fatalf("expected one CrawlTask insert, got %+v", sqlFake.executed)
	}
	state := cleaner.takePendingState(contentTestJob(), payload.URL)
	if state.patch == nil {
		t.Fatalf("crawl branch must store crawlResultId/crawlTaskId")
	}
	patch := string(state.patch.marshal())
	if !strings.Contains(patch, `"crawlResultId":"cr1"`) || !strings.Contains(patch, `"crawlTaskId":"c`) {
		t.Fatalf("patch = %s", patch)
	}

	// Re-store the consumed state: CleanArticle must consume the patch written by
	// FetchArticle. The worker calls the two methods back to back, so re-run only
	// the fetch to populate the side channel again.
	sqlFake.executed = nil
	crawl.calls = nil
	if _, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload); err != nil {
		t.Fatalf("second FetchArticle: %v", err)
	}
	cleanResult, err := cleaner.CleanArticle(context.Background(), payload, result.CrawledArticle, contentTestJob(), "llm")
	if err != nil {
		t.Fatalf("CleanArticle: %v", err)
	}
	if cleanResult.Cleaned.Title == nil || *cleanResult.Cleaned.Title != "T" {
		t.Fatalf("cleaned title = %v", cleanResult.Cleaned.Title)
	}
	if len(models.requests) != 1 {
		t.Fatalf("expected one completion, got %d", len(models.requests))
	}
	userPrompt := models.requests[0].Messages[2].Content
	if !strings.Contains(userPrompt, `"crawlResultId":"cr1"`) {
		t.Fatalf("user prompt is missing the crawlResultId metadata: %s", userPrompt)
	}
	if !strings.Contains(userPrompt, `"sourceId":"s1"`) {
		t.Fatalf("user prompt is missing the payload metadata: %s", userPrompt)
	}
	if !strings.Contains(userPrompt, `"publishedAt":"2024-03-04T05:06:07.000Z"`) {
		t.Fatalf("user prompt is missing publishedAt: %s", userPrompt)
	}
	if models.requests[0].Timeout != 180*time.Second {
		t.Fatalf("completion timeout = %v, want the 180s floor", models.requests[0].Timeout)
	}
	if len(cleaner.pending) != 0 {
		t.Fatalf("pending state must be consumed by CleanArticle")
	}
}

func TestFetchArticleExpandsListLikeArticle(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{summaries: []crawlexecution.Summary{{}}}
	cleaner, sqlFake, reader := contentTestCleaner(t, models, crawl)
	fetchedAt := time.Date(2024, 3, 4, 5, 6, 7, 0, time.UTC)

	listMarkdown := "# World\n\n"
	for index := 0; index < 20; index++ {
		listMarkdown += fmt.Sprintf("- [Story %d](https://example.com/world/article-2024-01-%02d)\n", index, index+1)
	}
	detailURL := "https://example.com/world/article-2024-01-02"
	detailMarkdown := "# Detail\n\n" + strings.Repeat("This is a substantive detail sentence. ", 90)

	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		switch {
		case strings.Contains(query, "FROM `CrawlResult` WHERE `id` = ? AND `orgId` = ?"):
			return contentTestRow{}
		case strings.Contains(query, "FROM `CrawlResult` cr"):
			id, _ := args[0].(string)
			if id == "detail-1" {
				return contentTestStoredRow("detail-1", detailURL, fetchedAt, "aaaaaaaaaaaaaaaaaaaaaaaa", "hash-detail", nil)
			}
			return contentTestStoredRow("list-1", "https://example.com/world", fetchedAt, "bbbbbbbbbbbbbbbbbbbbbbbb", "hash-list", nil)
		case strings.Contains(query, "FROM `CrawlTask`"):
			return contentTestRow{scan: contentTestScan("task-detail")}
		case strings.Contains(query, "FROM `CrawlResult` WHERE `taskId` = ? AND `sourceUrl`"):
			return contentTestRow{scan: contentTestScan("detail-1")}
		}
		return contentTestRow{}
	}
	sqlFake.queryFn = func(query string, args []any) (contentRows, error) {
		if strings.Contains(query, "LIMIT 12") {
			return &contentTestRows{rows: []contentRow{
				contentTestRow{scan: contentTestScan("detail-1", sql.NullString{String: detailURL, Valid: true})},
			}}, nil
		}
		return &contentTestRows{}, nil
	}
	reader.byID["bbbbbbbbbbbbbbbbbbbbbbbb"] = contentTestDocument(listMarkdown, "")
	reader.byID["aaaaaaaaaaaaaaaaaaaaaaaa"] = contentTestDocument(detailMarkdown, "")
	reader.byResultIDs["detail-1"] = reader.byID["aaaaaaaaaaaaaaaaaaaaaaaa"]

	payload := NormalizedPayload{URL: "https://example.com/world", Metadata: json.RawMessage(`{"crawlResultId":"list-1"}`)}
	result, err := cleaner.FetchArticle(context.Background(), contentTestJob(), payload)
	if err != nil {
		t.Fatalf("FetchArticle: %v", err)
	}
	if result.SourceURL != detailURL {
		t.Fatalf("expanded sourceUrl = %q, want %q", result.SourceURL, detailURL)
	}
	if result.FromCache {
		t.Fatalf("expanded article must not be reported from cache")
	}
	state := cleaner.takePendingState(contentTestJob(), payload.URL)
	if state.patch == nil {
		t.Fatalf("expansion must store the metadata patch")
	}
	patch := string(state.patch.marshal())
	wantParts := []string{`"crawlResultId":"detail-1"`, `"crawlTaskId":"task-detail"`, `"expandedFromUrl":"https://example.com/world"`}
	for _, part := range wantParts {
		if !strings.Contains(patch, part) {
			t.Fatalf("patch %s is missing %s", patch, part)
		}
	}
}

// --- cleanArticle -----------------------------------------------------------

func contentTestProcessedRow() contentRow {
	publishedAt := time.Date(2024, 2, 3, 4, 5, 6, 0, time.UTC)
	values := []any{
		"pa-1",             // pa.id
		nil, nil, nil, nil, // title, subtitle, author, source
		sql.NullTime{Time: publishedAt, Valid: true}, // publishedAt
		nil, nil, nil, nil, nil, nil, // category, summary, topics, keyPoints, entities, kgRelations
		contentTestString("0123456789abcdef01234567"), // cleanedMarkdownRef
		sql.NullFloat64{},                                        // qualityScore
		contentTestString("gpt-cached"), contentTestString("v1"), // llmModel, llmPromptVersion
		nil, nil, // language, location
		sql.NullInt64{}, sql.NullInt64{}, sql.NullInt64{}, // promptTokens, completionTokens, totalTokens
		sql.NullFloat64{}, sql.NullInt64{}, // costUsd, latencyMs
		"https://example.com/cached", "hash-cached", nil, nil, // url, contentHash, sourceLabel, language
	}
	return contentTestRow{scan: contentTestScan(values...)}
}

func TestCleanArticleUsesProcessedArticleCache(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, reader := contentTestCleaner(t, models, crawl)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		if strings.Contains(query, "FROM `ProcessedArticle`") {
			return contentTestProcessedRow()
		}
		return contentTestRow{}
	}
	reader.processed["0123456789abcdef01234567"] = json.RawMessage(`{"title":"Cached","cleaned_markdown":"# Cached\n\nBody","topics":["ai"]}`)

	payload := NormalizedPayload{URL: "https://example.com/cached"}
	article := CrawledArticle{SourceURL: payload.URL, Markdown: "# Cached\n\nBody", ContentHash: "hash-cached"}
	result, err := cleaner.CleanArticle(context.Background(), payload, article, contentTestJob(), "llm")
	if err != nil {
		t.Fatalf("CleanArticle: %v", err)
	}
	if len(models.requests) != 0 {
		t.Fatalf("cache reuse must not call the model")
	}
	if result.ProcessedArticleID == nil || *result.ProcessedArticleID != "pa-1" {
		t.Fatalf("processedArticleId = %v", result.ProcessedArticleID)
	}
	if result.ContentDuplicateOf == nil || *result.ContentDuplicateOf != "0123456789abcdef01234567" {
		t.Fatalf("contentDuplicateOf = %v", result.ContentDuplicateOf)
	}
	if result.Cleaned.Title == nil || *result.Cleaned.Title != "Cached" {
		t.Fatalf("cleaned title = %v", result.Cleaned.Title)
	}
	if result.LLM.Model == nil || *result.LLM.Model != "gpt-cached" {
		t.Fatalf("llm model = %v", result.LLM.Model)
	}
	wantPatch := `{"llmRepair":{"applied":false,"missingFields":[],"repairedFields":[],"model":null,"promptTokens":null,"completionTokens":null,"totalTokens":null,"costUsd":null,"latencyMs":null,"source":"processed_cache"}}`
	if string(result.ArticleMetadataPatch) != wantPatch {
		t.Fatalf("patch = %s, want %s", result.ArticleMetadataPatch, wantPatch)
	}

	// The provider check happens after the cache branch in NestJS: a cached
	// article is returned even when the caller passes an unsupported provider.
	cachedAgain, err := cleaner.CleanArticle(context.Background(), payload, article, contentTestJob(), "other")
	if err != nil {
		t.Fatalf("cached CleanArticle with unsupported provider: %v", err)
	}
	if cachedAgain.ProcessedArticleID == nil || *cachedAgain.ProcessedArticleID != "pa-1" {
		t.Fatalf("cached result lost the processed article id")
	}
}

func TestCleanArticleRepairsMissingFields(t *testing.T) {
	cleanResponse := litellmcompat.CompletionResponse{
		Content: `{"cleaned_markdown":"# A\n\nBody"}`,
		Model:   "gpt-clean",
		Usage:   litellmcompat.Usage{PromptTokens: floatPointer(10), CompletionTokens: floatPointer(20), TotalTokens: floatPointer(30), CostUSD: floatPointer(0.001)},
	}
	repairResponse := litellmcompat.CompletionResponse{
		Content: `{"title":"Repaired","author":"Au","category":"cat","source":"Src","published_at":"2024-01-02T03:04:05Z"}`,
		Model:   "gpt-repair",
		Usage:   litellmcompat.Usage{PromptTokens: floatPointer(5), CompletionTokens: floatPointer(6), TotalTokens: floatPointer(11)},
	}
	models := &contentTestModels{completions: []contentTestCompletion{{response: cleanResponse}, {response: repairResponse}}}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, _ := contentTestCleaner(t, models, crawl)
	sqlFake.queryRowFn = func(query string, args []any) contentRow {
		return contentTestRow{} // no cached processed article
	}

	payload := NormalizedPayload{URL: "https://example.com/a"}
	article := CrawledArticle{SourceURL: payload.URL, Markdown: "# A\n\nBody", ContentHash: "hash-a"}
	result, err := cleaner.CleanArticle(context.Background(), payload, article, contentTestJob(), "llm")
	if err != nil {
		t.Fatalf("CleanArticle: %v", err)
	}
	if len(models.requests) != 2 {
		t.Fatalf("expected the clean call plus the repair call, got %d", len(models.requests))
	}
	repairPrompt := models.requests[1].Messages[1].Content
	if !strings.Contains(repairPrompt, `"missingFields"`) || !strings.Contains(repairPrompt, `"title"`) {
		t.Fatalf("repair prompt = %s", repairPrompt)
	}
	if result.Cleaned.Title == nil || *result.Cleaned.Title != "Repaired" {
		t.Fatalf("repaired title = %v", result.Cleaned.Title)
	}
	if result.Cleaned.Author == nil || *result.Cleaned.Author != "Au" {
		t.Fatalf("repaired author = %v", result.Cleaned.Author)
	}
	if result.Cleaned.Source == nil || *result.Cleaned.Source != "Src" {
		t.Fatalf("repaired source = %v", result.Cleaned.Source)
	}
	if result.Cleaned.PublishedAt == nil || *result.Cleaned.PublishedAt != "2024-01-02T03:04:05.000Z" {
		t.Fatalf("repaired published_at = %v", result.Cleaned.PublishedAt)
	}
	// Token metadata is the base call plus the repair delta.
	if result.LLM.TotalTokens == nil || *result.LLM.TotalTokens != 41 {
		t.Fatalf("total tokens = %v, want 41", result.LLM.TotalTokens)
	}
	if result.LLM.Model == nil || *result.LLM.Model != "gpt-clean" {
		t.Fatalf("llm model = %v", result.LLM.Model)
	}
	patch := string(result.ArticleMetadataPatch)
	if !strings.Contains(patch, `"applied":true`) {
		t.Fatalf("patch = %s", patch)
	}
	if !strings.Contains(patch, `"repairedFields":["title","author","source","category","published_at"]`) {
		t.Fatalf("repaired field order = %s", patch)
	}
	if !strings.Contains(patch, `"model":"gpt-repair"`) {
		t.Fatalf("repair model = %s", patch)
	}
}

func TestCleanArticleRepairFailureKeepsOriginalCleanedNews(t *testing.T) {
	cleanResponse := litellmcompat.CompletionResponse{Content: `{"cleaned_markdown":"# A\n\nBody"}`, Model: "gpt-clean"}
	repairResponse := litellmcompat.CompletionResponse{Content: "not json at all", Model: "gpt-repair"}
	models := &contentTestModels{completions: []contentTestCompletion{{response: cleanResponse}, {response: repairResponse}}}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, _ := contentTestCleaner(t, models, crawl)
	sqlFake.queryRowFn = func(query string, args []any) contentRow { return contentTestRow{} }

	payload := NormalizedPayload{URL: "https://example.com/a"}
	article := CrawledArticle{SourceURL: payload.URL, Markdown: "# A\n\nBody", ContentHash: "hash-a"}
	result, err := cleaner.CleanArticle(context.Background(), payload, article, contentTestJob(), "llm")
	if err != nil {
		t.Fatalf("CleanArticle: %v", err)
	}
	if result.Cleaned.Title != nil {
		t.Fatalf("failed repair must not invent a title: %v", result.Cleaned.Title)
	}
	patch := string(result.ArticleMetadataPatch)
	if !strings.Contains(patch, `"applied":false`) {
		t.Fatalf("patch = %s", patch)
	}
	if !strings.Contains(patch, `"error":"crawl_article_repair returned invalid JSON"`) {
		t.Fatalf("patch = %s", patch)
	}
}

func TestCleanArticleRejectsUnsupportedProvider(t *testing.T) {
	models := &contentTestModels{}
	crawl := &contentTestCrawl{}
	cleaner, sqlFake, _ := contentTestCleaner(t, models, crawl)
	sqlFake.queryRowFn = func(query string, args []any) contentRow { return contentTestRow{} }

	payload := NormalizedPayload{URL: "https://example.com/a"}
	article := CrawledArticle{SourceURL: payload.URL, Markdown: "# A\n\nBody", ContentHash: "hash-a"}
	_, err := cleaner.CleanArticle(context.Background(), payload, article, contentTestJob(), "rules")
	if err == nil || !strings.Contains(err.Error(), "Unsupported clean provider: rules") {
		t.Fatalf("error = %v", err)
	}
}

// --- markdown selection -----------------------------------------------------

func TestBuildMarkdownForLlmPrefersRicherCandidateAndAppliesReferences(t *testing.T) {
	article := CrawledArticle{
		Markdown:           "# Short\n\nTiny body.",
		RawMarkdown:        contentTestString("# Raw\n\n" + strings.Repeat("Long substantive raw sentence. ", 120)),
		ReferencesMarkdown: contentTestString("[^1]: source one"),
	}
	result := buildMarkdownForLlm(article, 48000)
	if result.Variant != "raw" {
		t.Fatalf("variant = %q, want raw", result.Variant)
	}
	if !strings.Contains(result.Markdown, "Long substantive raw sentence.") {
		t.Fatalf("markdown selection lost the raw body")
	}
	if result.ReferencesAppended {
		t.Fatalf("references must only be appended for citation markers")
	}

	cited := CrawledArticle{
		Markdown:           "# Cited\n\n" + strings.Repeat("Sentence with a claim [^1]. ", 60),
		ReferencesMarkdown: contentTestString("[^1]: https://example.com/source"),
	}
	citedResult := buildMarkdownForLlm(cited, 48000)
	if !citedResult.ReferencesAppended || !strings.Contains(citedResult.Markdown, "[^1]: https://example.com/source") {
		t.Fatalf("citation references were not appended: %+v", citedResult)
	}
	if citedResult.Source != "primary" {
		t.Fatalf("source = %q", citedResult.Source)
	}
}

func TestBuildMarkdownForLlmTruncatesUTF16Units(t *testing.T) {
	article := CrawledArticle{Markdown: "你好世界"}
	result := buildMarkdownForLlm(article, 2)
	if result.Markdown != "你好" {
		t.Fatalf("markdown = %q", result.Markdown)
	}
}

func TestExtractDetailLinkCandidatesFiltersSameHostDetailURLs(t *testing.T) {
	article := CrawledArticle{
		SourceURL: "https://example.com/world",
		Markdown: "# Index\n\n" +
			"- [One](https://example.com/world/article-2024-01-02)\n" +
			"- [Two](https://other.example.com/world/article-2024-01-03)\n" +
			"- [Image](https://example.com/world/photo.jpg)\n" +
			"- [Section](/world/business)\n",
	}
	candidates := extractDetailLinkCandidates(article)
	if len(candidates) != 1 {
		t.Fatalf("candidates = %v, want exactly the detail URL", candidates)
	}
	if candidates[0] != "https://example.com/world/article-2024-01-02" {
		t.Fatalf("candidate = %q", candidates[0])
	}
}

func TestAssessPipelineMarkdownQualityFlagsListPages(t *testing.T) {
	listMarkdown := "# Index\n\n"
	for index := 0; index < 20; index++ {
		listMarkdown += fmt.Sprintf("- [Story %d](https://example.com/story-%d)\n", index, index)
	}
	quality := assessPipelineMarkdownQuality(listMarkdown)
	if !quality.IsListLike {
		t.Fatalf("list page was not detected: %+v", quality)
	}
	emptyQuality := assessPipelineMarkdownQuality("   ")
	if emptyQuality.Words != 0 || emptyQuality.IsListLike {
		t.Fatalf("empty quality = %+v", emptyQuality)
	}
}
