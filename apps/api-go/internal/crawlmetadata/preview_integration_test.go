//go:build integration

// News-source preview integration test: real MySQL reads of NewsSource /
// CrawlTemplate / PipelineJob / Article, the real workflow overlay compilation,
// and the real RSS + metadata chain with a stubbed outbound HTTP transport (no
// request leaves the process). It asserts the single-page and seed-mode response
// shapes, the in-flight merge inside the lookback window, the crawl4ai-free
// degradation and that the entry is read-only.
//
// DATABASE_URL is required (CI injects it); a local run without MySQL skips.
package crawlmetadata

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	previewOrgID      = "org-preview-it"
	previewOtherOrgID = "org-preview-other"
)

func previewDatabase(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

var previewDDL = []string{
	"CREATE TABLE IF NOT EXISTS NewsSource (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"url VARCHAR(512) NOT NULL, config JSON NULL, crawlTemplateId VARCHAR(191) NULL," +
		"workflowId VARCHAR(191) NULL, workflowVersionId VARCHAR(191) NULL," +
		"workflowBindingMode VARCHAR(191) NOT NULL DEFAULT 'published'," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), UNIQUE INDEX NewsSource_orgId_url_key (orgId, url))",
	"CREATE TABLE IF NOT EXISTS CrawlTemplate (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"isActive BOOLEAN NOT NULL DEFAULT true, crawlOptions JSON NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id))",
	"CREATE TABLE IF NOT EXISTS PipelineJob (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, sourceId VARCHAR(191) NULL," +
		"url VARCHAR(512) NOT NULL, status VARCHAR(191) NOT NULL DEFAULT 'pending'," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), INDEX PipelineJob_sourceId_createdAt_idx (sourceId, createdAt))",
	"CREATE TABLE IF NOT EXISTS Article (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, url VARCHAR(512) NOT NULL," +
		"crawlAt DATETIME(3) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), INDEX Article_orgId_url_idx (orgId, url))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflow (" +
		"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL," +
		"description TEXT NULL, draftDefinition JSON NOT NULL, publishedVersionId VARCHAR(191) NULL," +
		"createdById VARCHAR(191) NOT NULL, updatedById VARCHAR(191) NULL," +
		"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflow_orgId_name_key (orgId, name))",
	"CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowVersion (" +
		"id VARCHAR(191) NOT NULL, workflowId VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL," +
		"version INT NOT NULL, name VARCHAR(191) NOT NULL, description TEXT NULL, definition JSON NOT NULL," +
		"createdById VARCHAR(191) NOT NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
		"PRIMARY KEY (id), UNIQUE INDEX CrawlStrategyWorkflowVersion_workflowId_version_key (workflowId, version))",
}

func previewCleanup(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, template := range []string{
		"DELETE FROM NewsSource WHERE orgId IN (?, ?)",
		"DELETE FROM CrawlTemplate WHERE orgId IN (?, ?)",
		"DELETE FROM PipelineJob WHERE orgId IN (?, ?)",
		"DELETE FROM Article WHERE orgId IN (?, ?)",
		"DELETE FROM CrawlStrategyWorkflow WHERE orgId IN (?, ?)",
		"DELETE FROM CrawlStrategyWorkflowVersion WHERE orgId IN (?, ?)",
	} {
		if _, err := db.Exec(template, previewOrgID, previewOtherOrgID); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
}

func TestNewsSourcePreviewMySQLIntegration(t *testing.T) {
	db := previewDatabase(t)
	for _, statement := range previewDDL {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("ddl: %v\n%s", err, statement)
		}
	}
	previewCleanup(t, db)
	t.Cleanup(func() { previewCleanup(t, db) })

	context := context.Background()
	feedXML := `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title>Queued story</title><link>https://93.184.216.34/2026/10/19/queued-story</link></item>
  <item><title>Free story</title><link>https://93.184.216.34/2026/10/18/free-story</link></item>
</channel></rss>`
	pageHTML := `<html><head><title>Page title</title></head><body></body></html>`

	transport := &previewTransport{respond: func(request *http.Request) (*http.Response, error) {
		if strings.HasSuffix(request.URL.Path, "feed.xml") {
			return previewResponse(http.StatusOK, "application/rss+xml", feedXML), nil
		}
		return previewResponse(http.StatusOK, "text/html", pageHTML), nil
	}}
	metadata := NewService(db, nil)
	metadata.client = &http.Client{Transport: transport}

	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO NewsSource (id, orgId, name, url, config, workflowBindingMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		"source-single", previewOrgID, "single", "https://93.184.216.34/single", []byte(`{}`), "published", now, now); err != nil {
		t.Fatalf("insert single source: %v", err)
	}
	if _, err := db.Exec("INSERT INTO CrawlTemplate (id, orgId, name, isActive, crawlOptions, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"template-1", previewOrgID, "template", true, []byte(`{"check_robots_txt":true,"locale":"en"}`), now, now); err != nil {
		t.Fatalf("insert template: %v", err)
	}
	seedConfig := `{"seed":{"enabled":true,"mode":"rss","maxNewUrlsPerRun":5,"maxUrls":10},"crawlOptions":{"check_robots_txt":false}}`
	if _, err := db.Exec("INSERT INTO NewsSource (id, orgId, name, url, config, crawlTemplateId, workflowBindingMode, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		"source-seed", previewOrgID, "seed", "https://93.184.216.34/feed.xml", []byte(seedConfig), "template-1", "published", now, now); err != nil {
		t.Fatalf("insert seed source: %v", err)
	}
	if _, err := db.Exec("INSERT INTO PipelineJob (id, orgId, sourceId, url, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"job-active", previewOrgID, "source-seed", "https://93.184.216.34/2026/10/19/queued-story", "running", now, now); err != nil {
		t.Fatalf("insert active job: %v", err)
	}
	stale := now.Add(-48 * time.Hour)
	if _, err := db.Exec("INSERT INTO PipelineJob (id, orgId, sourceId, url, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
		"job-stale", previewOrgID, "source-seed", "https://93.184.216.34/2026/10/18/free-story", "running", stale, stale); err != nil {
		t.Fatalf("insert stale job: %v", err)
	}
	if _, err := db.Exec("INSERT INTO Article (id, orgId, url, crawlAt, createdAt) VALUES (?, ?, ?, ?, ?)",
		"article-1", previewOrgID, "https://93.184.216.34/2026/10/18/free-story", now, now); err != nil {
		t.Fatalf("insert article: %v", err)
	}

	preview := NewPreviewService(PreviewOptions{
		Metadata:           metadata,
		Discovery:          NewDiscovery(metadata, nil, nil),
		Workflows:          crawlworkflow.NewService(db),
		InFlightLookbackMs: 21_600_000,
	})

	single, err := preview.Preview(context, previewOrgID, "source-single")
	if err != nil {
		t.Fatalf("Preview single: %v", err)
	}
	singleDocument, ok := single.(PreviewSingleResponse)
	if !ok {
		t.Fatalf("single preview type = %T", single)
	}
	if singleDocument.Mode != "single" || len(singleDocument.Candidates) != 1 {
		t.Fatalf("single preview = %+v", singleDocument)
	}
	if singleDocument.InFlightLimit != 1 || singleDocument.ScheduleCount != 1 || singleDocument.SkippedCount != 0 {
		t.Fatalf("single capacity = %+v", singleDocument)
	}
	if singleDocument.Candidates[0].AlreadyQueued || singleDocument.Candidates[0].InFlightStatus != nil {
		t.Fatal("the single-page source has no active job")
	}
	if singleDocument.Seed != nil {
		t.Fatalf("single mode must return a null seed: %+v", singleDocument.Seed)
	}

	seedDocument, err := preview.Preview(context, previewOrgID, "source-seed")
	if err != nil {
		t.Fatalf("Preview seed: %v", err)
	}
	seedPreview, ok := seedDocument.(PreviewSeedResponse)
	if !ok {
		t.Fatalf("seed preview type = %T", seedDocument)
	}
	if seedPreview.Mode != SeedModeRSS {
		t.Fatalf("mode = %q", seedPreview.Mode)
	}
	if seedPreview.InFlightLimit != 5 {
		t.Fatalf("inFlightLimit = %d", seedPreview.InFlightLimit)
	}
	if seedPreview.InFlightCount != 1 {
		t.Fatalf("inFlightCount = %d (only the job inside the lookback window counts)", seedPreview.InFlightCount)
	}
	if len(seedPreview.Candidates) != 2 {
		t.Fatalf("candidates = %d (%+v)", len(seedPreview.Candidates), seedPreview.Candidates)
	}
	queued := seedPreview.Candidates[0]
	free := seedPreview.Candidates[1]
	if queued.URL != "https://93.184.216.34/2026/10/19/queued-story" {
		t.Fatalf("first candidate = %s", queued.URL)
	}
	if !queued.AlreadyQueued || queued.InFlightStatus == nil || *queued.InFlightStatus != PipelineJobRunning {
		t.Fatalf("queued candidate = %+v", queued)
	}
	if queued.Title == nil || *queued.Title != "Page title" {
		t.Fatalf("metadata extract must fill the title: %v", queued.Title)
	}
	if queued.TimestampSource != TimestampSourcePublished || queued.PublishedAt == nil {
		t.Fatalf("timestamp = %+v", queued)
	}
	if !free.AlreadyCrawled || free.LastCrawlAt == nil {
		t.Fatalf("free candidate must be alreadyCrawled: %+v", free)
	}
	if free.AlreadyQueued {
		t.Fatal("a stale job must not mark the URL as queued")
	}
	if seedPreview.AvailableToSchedule != 0 {
		t.Fatalf("availableToSchedule = %d", seedPreview.AvailableToSchedule)
	}
	if seedPreview.ScheduleCount != 0 || seedPreview.SkippedCount != 2 {
		t.Fatalf("counts = %d/%d", seedPreview.ScheduleCount, seedPreview.SkippedCount)
	}
	if seedPreview.Workflow != nil {
		t.Fatalf("no workflow is bound, summary = %+v", seedPreview.Workflow)
	}
	if seedPreview.DeepFailureStats != nil || seedPreview.DeepPreviewError != nil {
		t.Fatalf("rss mode must not report deep stats: %+v", seedPreview)
	}

	// The preview is read-only.
	var jobs, articles, sources int
	if err := db.QueryRow("SELECT COUNT(*) FROM PipelineJob WHERE orgId = ?", previewOrgID).Scan(&jobs); err != nil {
		t.Fatalf("jobs: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM Article WHERE orgId = ?", previewOrgID).Scan(&articles); err != nil {
		t.Fatalf("articles: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM NewsSource WHERE orgId = ?", previewOrgID).Scan(&sources); err != nil {
		t.Fatalf("sources: %v", err)
	}
	if jobs != 2 || articles != 1 || sources != 2 {
		t.Fatalf("preview wrote rows: jobs=%d articles=%d sources=%d", jobs, articles, sources)
	}

	// A cross-tenant preview is the same 404 as a missing source.
	if _, err := preview.Preview(context, previewOtherOrgID, "source-seed"); err == nil {
		t.Fatal("a cross-tenant preview must fail")
	}

	// A bound workflow contributes the overlay summary and the compile-time
	// crawlOptions/seed defaults.
	workflowDefinition := `{"version":1,"metadata":{"description":"d","template":"blank","tags":[]},
	  "settings":{"executionMode":"hybrid","maxDepth":3,"maxPages":60,"timeoutMs":15000,"concurrency":2,"robotsPolicy":"respect","domainScope":"registrable_domain"},
	  "nodes":[{"id":"seed-discovery","type":"seed-discovery","label":"Seed","position":{"x":0,"y":0},"config":{"mode":"rss","maxUrls":20}},
	           {"id":"persist-result","type":"persist-result","label":"Persist","position":{"x":1,"y":0},"config":{"selectTopK":20}}],
	  "edges":[{"id":"e1","source":"seed-discovery","target":"persist-result"}]}`
	if _, err := db.Exec("INSERT INTO CrawlStrategyWorkflowVersion (id, workflowId, orgId, version, name, definition, createdById, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		"wf-version", "wf-1", previewOrgID, 1, "v1", []byte(workflowDefinition), "user", now); err != nil {
		t.Fatalf("insert version: %v", err)
	}
	if _, err := db.Exec("INSERT INTO CrawlStrategyWorkflow (id, orgId, name, draftDefinition, publishedVersionId, createdById, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		"wf-1", previewOrgID, "workflow", []byte(workflowDefinition), "wf-version", "user", now, now); err != nil {
		t.Fatalf("insert workflow: %v", err)
	}
	if _, err := db.Exec("UPDATE NewsSource SET workflowId = ?, workflowVersionId = ? WHERE id = ?", "wf-1", "wf-version", "source-seed"); err != nil {
		t.Fatalf("bind workflow: %v", err)
	}
	bound, err := preview.Preview(context, previewOrgID, "source-seed")
	if err != nil {
		t.Fatalf("Preview bound: %v", err)
	}
	boundPreview := bound.(PreviewSeedResponse)
	if boundPreview.Workflow == nil || boundPreview.Workflow.WorkflowID != "wf-1" || boundPreview.Workflow.WorkflowVersionID != "wf-version" {
		t.Fatalf("workflow summary = %+v", boundPreview.Workflow)
	}
	if boundPreview.Seed == nil || boundPreview.Seed.MaxURLs != 20 {
		t.Fatalf("the workflow seed overlay must win: %+v", boundPreview.Seed)
	}
}

// previewTransport intercepts the preview's outbound HTTP.
type previewTransport struct {
	respond func(*http.Request) (*http.Response, error)
}

func (t *previewTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return t.respond(request)
}

func previewResponse(status int, contentType, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"content-type": []string{contentType}},
		Body:       previewNopCloser{strings.NewReader(body)},
	}
}

type previewNopCloser struct {
	*strings.Reader
}

func (previewNopCloser) Close() error { return nil }
