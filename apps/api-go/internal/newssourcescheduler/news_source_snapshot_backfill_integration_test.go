//go:build integration

// Integration coverage for the news-sources list backfill (GAP-SOURCE-SNAPSHOTS-001 /
// review NS-02). It runs against the real MySQL 8.4 and Redis 7.2 of the
// api-go-user-settings-integration CI job and exercises the production path:
// the list reads the current page's snapshots, asks the scheduler service to
// rebuild only the missing rows, re-reads those rows and merges them before the
// runtime block is attached. The aggregations and the upsert are the real ones
// from internal/newssourcescheduler; only the "was the refresher called" and
// "does an error propagate" rules use narrow fakes.
package newssourcescheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

// insertSnapshotJob writes one PipelineJob row.
func insertSnapshotJob(t *testing.T, db *sql.DB, id, orgID, sourceID, status, url string, createdAt time.Time, startedAt, completedAt *time.Time) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO PipelineJob (id, orgId, sourceId, url, status, attempts, startedAt, completedAt, metadata, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, ?, 1, ?, ?, JSON_OBJECT(), ?, ?)",
		id, orgID, sourceID, url, status, startedAt, completedAt, createdAt, createdAt); err != nil {
		t.Fatalf("insert pipeline job %s: %v", id, err)
	}
}

// insertSnapshotTask writes one CrawlTask row attached to a news source.
func insertSnapshotTask(t *testing.T, db *sql.DB, id, orgID, sourceID, status, targetURL string, at time.Time) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO CrawlTask (id, orgId, createdById, newsSourceId, targetUrl, status, concurrency, keywords, runCount, createdAt, updatedAt) "+
			"VALUES (?, ?, 'user-1', ?, ?, ?, 1, '[]', 1, ?, ?)",
		id, orgID, sourceID, targetURL, status, at, at); err != nil {
		t.Fatalf("insert crawl task %s: %v", id, err)
	}
}

// insertSnapshotArticle writes one Article row attached to a news source.
func insertSnapshotArticle(t *testing.T, db *sql.DB, id, orgID, sourceID, url, title string, crawlAt time.Time) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO Article (id, orgId, sourceId, url, titleGuess, crawlAt, contentHash, version, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
		id, orgID, sourceID, url, title, crawlAt, "hash-"+id, crawlAt, crawlAt); err != nil {
		t.Fatalf("insert article %s: %v", id, err)
	}
}

// recordingRefresher delegates to the real scheduler service so the SQL paths
// still run, while recording the exact source ids each call requested.
type recordingRefresher struct {
	inner *Service
	calls [][]string
}

func (r *recordingRefresher) RefreshSnapshotsForSources(ctx context.Context, orgID string, sourceIDs []string) error {
	r.calls = append(r.calls, append([]string(nil), sourceIDs...))
	return r.inner.RefreshSnapshotsForSources(ctx, orgID, sourceIDs)
}

// staticErrorRefresher always returns its error.
type staticErrorRefresher struct{ err error }

func (r staticErrorRefresher) RefreshSnapshotsForSources(context.Context, string, []string) error {
	return r.err
}

// dropTableRefresher simulates a failure after the refresh step: the initial
// snapshot read succeeds, then the re-read cannot find the table.
type dropTableRefresher struct{ db *sql.DB }

func (r dropTableRefresher) RefreshSnapshotsForSources(ctx context.Context, _ string, _ []string) error {
	_, err := r.db.ExecContext(ctx, "DROP TABLE IF EXISTS `NewsSourceOpsSnapshot`")
	return err
}

type listedOpsSummary struct {
	LatestJob *struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"latestJob"`
	LatestCrawlTask *struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"latestCrawlTask"`
	LatestArticle *struct {
		ID         string  `json:"id"`
		TitleGuess *string `json:"titleGuess"`
	} `json:"latestArticle"`
	Stats24h struct {
		Completed     int      `json:"completed"`
		Failed        int      `json:"failed"`
		SuccessRate   *float64 `json:"successRate"`
		AvgDurationMs *float64 `json:"avgDurationMs"`
	} `json:"stats24h"`
	Runtime struct {
		CrawlTaskQueuedCount  int `json:"crawlTaskQueuedCount"`
		CrawlTaskRunningCount int `json:"crawlTaskRunningCount"`
	} `json:"runtime"`
}

type listedSource struct {
	ID         string           `json:"id"`
	OpsSummary listedOpsSummary `json:"opsSummary"`
}

type listedPage struct {
	Sources  []listedSource `json:"sources"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
}

func decodeListedPage(t *testing.T, payload map[string]any) listedPage {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal list payload: %v", err)
	}
	var page listedPage
	if err := json.Unmarshal(encoded, &page); err != nil {
		t.Fatalf("unmarshal list payload: %v", err)
	}
	return page
}

func findListedSource(t *testing.T, page listedPage, id string) listedSource {
	t.Helper()
	for _, source := range page.Sources {
		if source.ID == id {
			return source
		}
	}
	t.Fatalf("source %s missing from list", id)
	return listedSource{}
}

func countSnapshots(t *testing.T, db *sql.DB, orgID, sourceID string) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM NewsSourceOpsSnapshot WHERE orgId = ? AND sourceId = ?", orgID, sourceID).Scan(&count); err != nil {
		t.Fatalf("count snapshots for %s: %v", sourceID, err)
	}
	return count
}

func TestNewsSourceSchedulerIntegrationListBackfillMissing(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-a"
	now := h.service.now()

	h.insertSource(t, "source-bf-1", orgID, "sitemap", h.seedConfig())
	h.insertSource(t, "source-bf-2", orgID, "sitemap", h.seedConfig())
	// A same-name source in another organization must not leak into this org's
	// list and must not be backfilled when we list orgID.
	h.insertSource(t, "source-bf-other", "org-scheduler-backfill-b", "sitemap", h.seedConfig())

	started := now.Add(-2 * time.Minute)
	completed := now.Add(-1 * time.Minute)
	insertSnapshotJob(t, h.db, "job-bf-1", orgID, "source-bf-1", "completed", "https://example.com/bf-1", now.Add(-3*time.Minute), &started, &completed)
	insertSnapshotTask(t, h.db, "task-bf-1", orgID, "source-bf-1", "queued", "https://example.com/bf-1", now)
	insertSnapshotArticle(t, h.db, "article-bf-1", orgID, "source-bf-1", "https://example.com/bf-1", "Backfilled title", now.Add(-time.Hour))
	insertSnapshotJob(t, h.db, "job-bf-2", orgID, "source-bf-2", "failed", "https://example.com/bf-2", now.Add(-3*time.Minute), &started, &completed)
	insertSnapshotArticle(t, h.db, "article-bf-2", orgID, "source-bf-2", "https://example.com/bf-2", "Second title", now.Add(-time.Hour))

	// The runtime block was written by the scheduler path before the list ran;
	// the backfill must not clear it.
	if err := h.service.SyncQueueCounts(h.ctx, orgID, "source-bf-1"); err != nil {
		t.Fatalf("sync queue counts: %v", err)
	}

	refresher := &recordingRefresher{inner: h.service}
	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, refresher)
	payload, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	page := decodeListedPage(t, payload)
	if page.Total != 2 || page.Page != 1 || page.PageSize != 10 {
		t.Fatalf("page = %+v, want total=2 page=1 pageSize=10", page)
	}
	if len(page.Sources) != 2 {
		t.Fatalf("listed sources = %d, want 2", len(page.Sources))
	}
	if len(refresher.calls) != 1 {
		t.Fatalf("refresher calls = %d, want 1", len(refresher.calls))
	}
	requested := refresher.calls[0]
	if len(requested) != 2 {
		t.Fatalf("refresher requested %v, want both page sources", requested)
	}
	requestedSet := map[string]bool{requested[0]: true, requested[1]: true}
	if !requestedSet["source-bf-1"] || !requestedSet["source-bf-2"] {
		t.Fatalf("refresher requested %v, want both page sources", requested)
	}

	first := findListedSource(t, page, "source-bf-1")
	if first.OpsSummary.LatestJob == nil || first.OpsSummary.LatestJob.Status != "completed" {
		t.Fatalf("source-bf-1 latestJob = %+v, want completed", first.OpsSummary.LatestJob)
	}
	if first.OpsSummary.LatestArticle == nil || first.OpsSummary.LatestArticle.TitleGuess == nil || *first.OpsSummary.LatestArticle.TitleGuess != "Backfilled title" {
		t.Fatalf("source-bf-1 latestArticle = %+v", first.OpsSummary.LatestArticle)
	}
	if first.OpsSummary.LatestCrawlTask == nil || first.OpsSummary.LatestCrawlTask.Status != "queued" {
		t.Fatalf("source-bf-1 latestCrawlTask = %+v, want queued", first.OpsSummary.LatestCrawlTask)
	}
	if first.OpsSummary.Stats24h.Completed != 1 || first.OpsSummary.Stats24h.Failed != 0 {
		t.Fatalf("source-bf-1 stats24h = %+v, want completed=1 failed=0", first.OpsSummary.Stats24h)
	}
	if first.OpsSummary.Stats24h.SuccessRate == nil || *first.OpsSummary.Stats24h.SuccessRate != 1 {
		t.Fatalf("source-bf-1 successRate = %v, want 1", first.OpsSummary.Stats24h.SuccessRate)
	}
	if first.OpsSummary.Stats24h.AvgDurationMs == nil || *first.OpsSummary.Stats24h.AvgDurationMs != float64(time.Minute/time.Millisecond) {
		t.Fatalf("source-bf-1 avgDurationMs = %v, want 60000", first.OpsSummary.Stats24h.AvgDurationMs)
	}
	// Runtime counters survive the backfill (NS-03 must not regress).
	if first.OpsSummary.Runtime.CrawlTaskQueuedCount != 1 {
		t.Fatalf("source-bf-1 runtime queued = %d, want 1", first.OpsSummary.Runtime.CrawlTaskQueuedCount)
	}

	second := findListedSource(t, page, "source-bf-2")
	if second.OpsSummary.LatestJob == nil || second.OpsSummary.LatestJob.Status != "failed" {
		t.Fatalf("source-bf-2 latestJob = %+v, want failed", second.OpsSummary.LatestJob)
	}
	if second.OpsSummary.Stats24h.Failed != 1 || second.OpsSummary.Stats24h.Completed != 0 {
		t.Fatalf("source-bf-2 stats24h = %+v, want failed=1", second.OpsSummary.Stats24h)
	}

	// DB rows are written with the correct orgId/sourceId and never for the
	// other organization's source.
	if got := countSnapshots(t, h.db, orgID, "source-bf-1"); got != 1 {
		t.Fatalf("source-bf-1 snapshot rows = %d, want 1", got)
	}
	if got := countSnapshots(t, h.db, orgID, "source-bf-2"); got != 1 {
		t.Fatalf("source-bf-2 snapshot rows = %d, want 1", got)
	}
	if got := countSnapshots(t, h.db, "org-scheduler-backfill-b", "source-bf-other"); got != 0 {
		t.Fatalf("other-org snapshot rows = %d, want 0", got)
	}
}

func TestNewsSourceSchedulerIntegrationListBackfillOnlyMissing(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-c"
	now := h.service.now()

	h.insertSource(t, "source-bf-existing", orgID, "sitemap", h.seedConfig())
	h.insertSource(t, "source-bf-missing", orgID, "sitemap", h.seedConfig())

	// Pre-write a snapshot for the first source with a sentinel latest job so we
	// can prove an existing row is not rebuilt.
	sentinel := json.RawMessage(`{"id":"job-existing","status":"stored","url":"https://example.com/old","createdAt":"2026-10-20T00:00:00.000Z","startedAt":null,"completedAt":null,"error":null,"metadata":null}`)
	if err := h.service.repo.UpsertOpsSnapshot(h.ctx, orgID, "source-bf-existing", sentinel, json.RawMessage("null"), json.RawMessage("null"), json.RawMessage(`{"completed":3,"failed":1,"successRate":0.75,"avgDurationMs":1234}`), now); err != nil {
		t.Fatalf("seed existing snapshot: %v", err)
	}
	insertSnapshotJob(t, h.db, "job-bf-missing", orgID, "source-bf-missing", "completed", "https://example.com/bf-missing", now.Add(-time.Minute), nil, nil)

	refresher := &recordingRefresher{inner: h.service}
	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, refresher)

	firstPayload, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("first list: %v", err)
	}
	if len(refresher.calls) != 1 || len(refresher.calls[0]) != 1 || refresher.calls[0][0] != "source-bf-missing" {
		t.Fatalf("first refresher calls = %v, want only source-bf-missing", refresher.calls)
	}
	first := decodeListedPage(t, firstPayload)
	existing := findListedSource(t, first, "source-bf-existing")
	if existing.OpsSummary.LatestJob == nil || existing.OpsSummary.LatestJob.Status != "stored" {
		t.Fatalf("existing latestJob = %+v, want the pre-stored sentinel", existing.OpsSummary.LatestJob)
	}
	if existing.OpsSummary.Stats24h.Completed != 3 || existing.OpsSummary.Stats24h.Failed != 1 {
		t.Fatalf("existing stats24h = %+v, want the pre-stored stats", existing.OpsSummary.Stats24h)
	}
	missing := findListedSource(t, first, "source-bf-missing")
	if missing.OpsSummary.LatestJob == nil || missing.OpsSummary.LatestJob.Status != "completed" {
		t.Fatalf("missing latestJob = %+v, want completed", missing.OpsSummary.LatestJob)
	}

	// A second list finds every row present and must not call the refresher.
	secondPayload, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("second list: %v", err)
	}
	if len(refresher.calls) != 1 {
		t.Fatalf("second list refresher calls = %d, want still 1", len(refresher.calls))
	}
	second := decodeListedPage(t, secondPayload)
	if got := findListedSource(t, second, "source-bf-missing").OpsSummary.LatestJob; got == nil || got.Status != "completed" {
		t.Fatalf("second list missing latestJob = %+v", got)
	}
}

func TestNewsSourceSchedulerIntegrationListBackfillEmptyOrg(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-empty"

	refresher := &recordingRefresher{inner: h.service}
	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, refresher)
	payload, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	page := decodeListedPage(t, payload)
	if page.Total != 0 || len(page.Sources) != 0 {
		t.Fatalf("empty page = %+v", page)
	}
	if len(refresher.calls) != 0 {
		t.Fatalf("empty page must not refresh, calls = %v", refresher.calls)
	}
}

func TestNewsSourceSchedulerIntegrationListBackfillNoHistory(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-nohist"

	h.insertSource(t, "source-bf-quiet", orgID, "sitemap", h.seedConfig())

	refresher := &recordingRefresher{inner: h.service}
	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, refresher)
	payload, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	page := decodeListedPage(t, payload)
	source := findListedSource(t, page, "source-bf-quiet")
	if source.OpsSummary.LatestJob != nil || source.OpsSummary.LatestCrawlTask != nil || source.OpsSummary.LatestArticle != nil {
		t.Fatalf("quiet source fabricated activity: %+v", source.OpsSummary)
	}
	if source.OpsSummary.Stats24h.Completed != 0 || source.OpsSummary.Stats24h.Failed != 0 {
		t.Fatalf("quiet source stats = %+v, want zeros", source.OpsSummary.Stats24h)
	}
	if source.OpsSummary.Stats24h.SuccessRate != nil {
		t.Fatalf("quiet source successRate = %v, want null", source.OpsSummary.Stats24h.SuccessRate)
	}
	// A valid empty snapshot row is persisted rather than skipping the source.
	if got := countSnapshots(t, h.db, orgID, "source-bf-quiet"); got != 1 {
		t.Fatalf("quiet source snapshot rows = %d, want 1", got)
	}
}

func TestNewsSourceSchedulerIntegrationListBackfillRefreshError(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-err"
	h.insertSource(t, "source-bf-err", orgID, "sitemap", h.seedConfig())

	boom := errors.New("refresh failed")
	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, staticErrorRefresher{err: boom})
	payload, err := readModel.ListDefault(h.ctx, orgID)
	if !errors.Is(err, boom) {
		t.Fatalf("list error = %v, want the refresh error", err)
	}
	if payload != nil {
		t.Fatalf("list payload = %v, want nil on refresh error", payload)
	}
}

func TestNewsSourceSchedulerIntegrationListBackfillRereadError(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-backfill-reread"
	h.insertSource(t, "source-bf-reread", orgID, "sitemap", h.seedConfig())

	readModel := newssources.NewServiceWithSnapshots(h.db, h.redis, dropTableRefresher{db: h.db})
	payload, err := readModel.ListDefault(h.ctx, orgID)
	if err == nil {
		t.Fatal("list must return the re-read error, not a fake success")
	}
	if payload != nil {
		t.Fatalf("list payload = %v, want nil on re-read error", payload)
	}
}
