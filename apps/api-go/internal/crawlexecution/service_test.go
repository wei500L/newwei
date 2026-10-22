package crawlexecution

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// This file exercises the exported RunTask path with an in-test database/sql
// driver (no external dependency) plus a scripted HTTP transport. The 304-reuse
// branch and the crawl-failure branch both avoid Mongo and Redis, so the full
// RunTask contract (task status updates, Summary projection and error
// classification) is covered without an integration database.

// ---------------------------------------------------------------------------
// fake database/sql driver
// ---------------------------------------------------------------------------

var fakeDriverRegistry sync.Map

func init() {
	sql.Register("crawlexecution-fake", &fakeDriver{})
}

type fakeDriver struct{}

func (d *fakeDriver) Open(name string) (driver.Conn, error) {
	value, ok := fakeDriverRegistry.Load(name)
	if !ok {
		return nil, errors.New("fake driver: unknown dsn " + name)
	}
	return &fakeConn{database: value.(*fakeDatabase)}, nil
}

type fakeDatabase struct {
	mu       sync.Mutex
	task     []driver.Value
	result   []driver.Value // id, fetchedAt, metadata
	executes []fakeExec
	queried  []string
	nextRows []fakeRowSet
}

type fakeRowSet struct {
	columns []string
	values  [][]driver.Value
}

type fakeExec struct {
	query string
	args  []any
}

type fakeConn struct {
	database *fakeDatabase
}

func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("fake driver: prepare unsupported")
}

func (c *fakeConn) Close() error { return nil }

func (c *fakeConn) Begin() (driver.Tx, error) { return &fakeTx{}, nil }

func (c *fakeConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.database.mu.Lock()
	defer c.database.mu.Unlock()
	c.database.queried = append(c.database.queried, query)
	switch {
	case strings.Contains(query, "FROM `CrawlTask` WHERE `id`"):
		if len(c.database.task) == 0 {
			return &fakeRows{}, nil
		}
		return &fakeRows{
			columns: []string{"id", "orgId", "newsSourceId", "createdById", "targetUrl", "displayName", "status", "config", "keywords", "lastResultAt", "lastCursor", "lastServerMemoryMb", "lastPeakMemoryMb", "lastMemoryEfficiency"},
			values:  [][]driver.Value{c.database.task},
		}, nil
	case strings.Contains(query, "FROM `CrawlResult`"):
		if len(c.database.result) == 0 {
			return &fakeRows{}, nil
		}
		return &fakeRows{
			columns: []string{"id", "fetchedAt", "metadata"},
			values:  [][]driver.Value{c.database.result},
		}, nil
	case len(c.database.nextRows) > 0:
		rows := c.database.nextRows[0]
		c.database.nextRows = c.database.nextRows[1:]
		return &fakeRows{columns: rows.columns, values: rows.values}, nil
	default:
		return &fakeRows{}, nil
	}
}

func (c *fakeConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.database.mu.Lock()
	defer c.database.mu.Unlock()
	values := make([]any, 0, len(args))
	for _, arg := range args {
		values = append(values, arg.Value)
	}
	c.database.executes = append(c.database.executes, fakeExec{query: query, args: values})
	return driver.RowsAffected(1), nil
}

type fakeTx struct{}

func (t *fakeTx) Commit() error   { return nil }
func (t *fakeTx) Rollback() error { return nil }

type fakeRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *fakeRows) Columns() []string { return r.columns }
func (r *fakeRows) Close() error      { return nil }

func (r *fakeRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	row := r.values[r.index]
	r.index++
	for index := range dest {
		if index < len(row) {
			dest[index] = row[index]
		} else {
			dest[index] = nil
		}
	}
	return nil
}

func openFakeDB(t *testing.T, database *fakeDatabase) *sql.DB {
	t.Helper()
	dsn := "fake-" + t.Name()
	fakeDriverRegistry.Store(dsn, database)
	db, err := sql.Open("crawlexecution-fake", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func fakeTaskRow(targetURL, config string) []driver.Value {
	return []driver.Value{
		"task-1", "org-1", nil, "user-1", targetURL, nil, "pending",
		[]byte(config), []byte(`["keyword"]`), nil, nil, nil, nil, nil,
	}
}

// ---------------------------------------------------------------------------
// scripted HTTP transport shared by the preflight and crawl4ai clients
// ---------------------------------------------------------------------------

type runTransport struct {
	mu       sync.Mutex
	requests []*http.Request
	respond  func(req *http.Request) *http.Response
}

func (r *runTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.requests = append(r.requests, req.Clone(req.Context()))
	r.mu.Unlock()
	return r.respond(req), nil
}

func runResponse(status int, headers map[string]string, body string) *http.Response {
	header := http.Header{}
	for key, value := range headers {
		header.Set(key, value)
	}
	if header.Get("content-type") == "" {
		header.Set("content-type", "application/json")
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestRunTaskReusesResultOnHTTP304(t *testing.T) {
	database := &fakeDatabase{
		task:   fakeTaskRow("https://8.8.8.8/article/2026/10/20/a-story-title", `{"ingestToItems":false}`),
		result: []driver.Value{"result-1", time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC), []byte(`{"httpEtag":"\"abc\"","httpLastModified":"Wed, 21 Oct 2026 07:28:00 GMT"}`)},
	}
	db := openFakeDB(t, database)
	transport := &runTransport{respond: func(req *http.Request) *http.Response {
		if strings.HasSuffix(req.URL.Path, "/health") {
			return runResponse(http.StatusOK, nil, `{}`)
		}
		return runResponse(http.StatusNotModified, map[string]string{"etag": `"abc"`}, "")
	}}
	service := New(Options{
		DB: db,
		Config: Config{
			CrawlBaseURL:          "http://8.8.8.8:9999",
			CrawlHealthCheckTTLMs: 60_000,
		},
		HTTPClient: &http.Client{Transport: transport},
		Now:        func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
	summary, err := service.RunTask(context.Background(), "org-1", "task-1")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Inserted != 0 || summary.Skipped != 1 || summary.ReusedResultID != "result-1" {
		t.Fatalf("summary = %#v", summary)
	}
	if summary.LastFetchedAt == nil || !summary.LastFetchedAt.Equal(time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)) {
		t.Fatalf("lastFetchedAt = %#v", summary.LastFetchedAt)
	}
	completed := false
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "`status` = 'completed'") {
			completed = true
		}
	}
	if !completed {
		t.Fatalf("task completion update missing: %#v", database.executes)
	}
	// The 304 branch must not issue a /crawl request.
	for _, request := range transport.requests {
		if request.URL.Path == "/crawl" {
			t.Fatal("the 304 reuse branch must skip crawl4ai")
		}
	}
}

func TestRunTaskClassifiesCrawlFailure(t *testing.T) {
	database := &fakeDatabase{
		task: fakeTaskRow("https://8.8.8.8/article/2026/10/20/a-story-title", `{"ingestToItems":false}`),
	}
	db := openFakeDB(t, database)
	transport := &runTransport{respond: func(req *http.Request) *http.Response {
		switch {
		case strings.HasSuffix(req.URL.Path, "/health"):
			return runResponse(http.StatusOK, nil, `{}`)
		case strings.HasSuffix(req.URL.Path, "/crawl"):
			return runResponse(http.StatusInternalServerError, nil, `{"message":"crawl worker exploded"}`)
		default:
			return runResponse(http.StatusOK, nil, "<html></html>")
		}
	}}
	service := New(Options{
		DB: db,
		Config: Config{
			CrawlBaseURL:          "http://8.8.8.8:9999",
			CrawlHealthCheckTTLMs: 60_000,
		},
		HTTPClient: &http.Client{Transport: transport},
		Now:        func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
	_, err := service.RunTask(context.Background(), "org-1", "task-1")
	if err == nil {
		t.Fatal("expected the crawl failure to be returned")
	}
	if !strings.Contains(err.Error(), "crawl worker exploded") {
		t.Fatalf("error = %q", err.Error())
	}
	failed := false
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "`lastError` = ?") || strings.Contains(exec.query, "`status` = ?") {
			failed = true
		}
	}
	if !failed {
		t.Fatalf("task failure update missing: %#v", database.executes)
	}
	// Q3: runTask must never touch the crawl:activity counters. Redis is nil in
	// this wiring, so the only counter-adjacent write would be through the
	// source queue-count sync, and the task has no newsSourceId.
	for _, query := range database.queried {
		if strings.Contains(query, "crawl:activity") {
			t.Fatalf("unexpected activity counter query: %q", query)
		}
	}
}

func TestTruncateMessage(t *testing.T) {
	if got := truncateMessage("   ", 4000); got != "crawl job failed" {
		t.Fatalf("blank message = %q", got)
	}
	long := strings.Repeat("a", 4010)
	got := truncateMessage(long, 4000)
	runes := []rune(got)
	if len(runes) != 4000 || !strings.HasSuffix(got, "…") {
		t.Fatalf("truncated length = %d, suffix = %q", len(runes), got[len(got)-3:])
	}
	if got := truncateMessage("short", 4000); got != "short" {
		t.Fatalf("short = %q", got)
	}
}

func TestIsRetryableCrawlError(t *testing.T) {
	if !isRetryableCrawlError(errors.New("rate limit exceeded"), "rate limit exceeded") {
		t.Fatal("rate-limit error must be retryable")
	}
	if isRetryableCrawlError(errors.New("validation failed"), "validation failed") {
		t.Fatal("validation error must not be retryable")
	}
}

func TestRunTaskMissingTask(t *testing.T) {
	database := &fakeDatabase{}
	db := openFakeDB(t, database)
	service := New(Options{DB: db})
	summary, err := service.RunTask(context.Background(), "org-1", "missing")
	if err != nil {
		t.Fatal(err)
	}
	if summary.Inserted != 0 || summary.Skipped != 0 {
		t.Fatalf("summary = %#v", summary)
	}
	for _, exec := range database.executes {
		if strings.Contains(exec.query, "`status`") {
			t.Fatalf("missing task must not be updated: %#v", exec)
		}
	}
}

// recordingItemIngestor records the actor of every crawl-result ingest call.
type recordingItemIngestor struct {
	calls []string
}

func (r *recordingItemIngestor) CreateFromCrawlResult(_ context.Context, orgID, userID, crawlResultID string) (itemsreading.ItemMetaRow, error) {
	r.calls = append(r.calls, orgID+"|"+userID+"|"+crawlResultID)
	return itemsreading.ItemMetaRow{}, nil
}

func TestIngestActorUsesTriggeringUser(t *testing.T) {
	task := &taskRow{ID: "task-1", OrgID: "org-1", CreatedByID: "creator-1"}
	if actor := ingestUserID(task, "triggered-1"); actor != "triggered-1" {
		t.Fatalf("the BullMQ triggeredById must win: %q", actor)
	}
	if actor := ingestUserID(task, ""); actor != "creator-1" {
		t.Fatalf("the pipeline path keeps the task creator: %q", actor)
	}

	ingestor := &recordingItemIngestor{}
	service := New(Options{Items: ingestor})
	service.ingestReusedResult(context.Background(), "org-1", task, "result-1", ingestUserID(task, "triggered-1"))
	service.ingestReusedResult(context.Background(), "org-1", task, "result-2", ingestUserID(task, ""))
	want := []string{"org-1|triggered-1|result-1", "org-1|creator-1|result-2"}
	if len(ingestor.calls) != len(want) {
		t.Fatalf("ingest calls = %#v", ingestor.calls)
	}
	for index, value := range want {
		if ingestor.calls[index] != value {
			t.Fatalf("ingest call %d = %q, want %q", index, ingestor.calls[index], value)
		}
	}
}
