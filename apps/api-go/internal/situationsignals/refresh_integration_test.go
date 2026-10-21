//go:build integration

// Integration coverage for POST /api/situation-monitor/refresh. It runs against
// the real MySQL 8.4 and Redis 7.2 services of the
// api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// The Telegram and OREF pollers are fixtures (no MTProto connection and no OREF
// request is made): they write the same cached state documents the real pollers
// write, so the refresh reads them through the production read path. The
// immediate dispatch is either a fixture that inserts the rows a real scheduler
// pass would insert, or the real Go news source scheduler when the shared
// cron:news-source-scheduler lease is already held (B1).
package situationsignals

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	refreshITRefreshScanRedisDB = 12
	refreshITOrgID              = "org-refresh-integration"
	refreshITSchedulerLockKey   = "lock:cron:news-source-scheduler"
)

// refreshITNewsSourceSchema is the narrow NewsSource projection the refresh
// writes (nextRunAt/circuitOpenUntil/consecutiveFailures).
const refreshITNewsSourceSchema = "CREATE TABLE `NewsSource` (" +
	"`id` VARCHAR(191) NOT NULL PRIMARY KEY," +
	"`orgId` VARCHAR(191) NOT NULL," +
	"`isActive` TINYINT(1) NOT NULL DEFAULT 1," +
	"`nextRunAt` DATETIME(3) NULL," +
	"`circuitOpenUntil` DATETIME(3) NULL," +
	"`consecutiveFailures` INT NOT NULL DEFAULT 0" +
	") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

// refreshITCrawlTaskSchema is the narrow CrawlTask projection the summary counts.
const refreshITCrawlTaskSchema = "CREATE TABLE `CrawlTask` (" +
	"`id` VARCHAR(191) NOT NULL PRIMARY KEY," +
	"`orgId` VARCHAR(191) NOT NULL," +
	"`newsSourceId` VARCHAR(191) NULL," +
	"`status` VARCHAR(32) NOT NULL," +
	"`createdAt` DATETIME(3) NOT NULL" +
	") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

// refreshITPipelineJobSchema is the narrow PipelineJob projection the summary
// counts.
const refreshITPipelineJobSchema = "CREATE TABLE `PipelineJob` (" +
	"`id` VARCHAR(191) NOT NULL PRIMARY KEY," +
	"`orgId` VARCHAR(191) NOT NULL," +
	"`sourceId` VARCHAR(191) NULL," +
	"`status` VARCHAR(32) NOT NULL," +
	"`createdAt` DATETIME(3) NOT NULL" +
	") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

type refreshITHarness struct {
	ctx   context.Context
	db    *sql.DB
	redis *redis.Client
	core  *Service
}

// refreshITMySQL creates a throwaway MySQL database for one test. The CI job runs
// other integration steps against the shared `app` schema, so a dedicated database
// keeps the three narrow tables (NewsSource/CrawlTask/PipelineJob are real
// production tables) local to this package and removes any dependency on the order
// the job steps run in. The pattern is the same as sitWorkerITMySQL in
// internal/situationsignalsworker.
func refreshITMySQL(t *testing.T) *sql.DB {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if baseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	base, err := usersettings.OpenMySQLFromURL(baseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	databaseName := "situation_refresh_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := base.ExecContext(ctx, "CREATE DATABASE `"+databaseName+"`"); err != nil {
		_ = base.Close()
		t.Fatalf("create integration database: %v", err)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		_ = base.Close()
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsed.Path = "/" + databaseName
	db, err := usersettings.OpenMySQLFromURL(parsed.String())
	if err != nil {
		_ = base.Close()
		t.Fatalf("open integration mysql: %v", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		_ = base.Close()
		t.Fatalf("ping integration mysql: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = db.Close()
		_, _ = base.ExecContext(cleanupCtx, "DROP DATABASE `"+databaseName+"`")
		_ = base.Close()
	})
	for _, statement := range []string{refreshITNewsSourceSchema, refreshITCrawlTaskSchema, refreshITPipelineJobSchema} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create narrow table: %v", err)
		}
	}
	return db
}

func newRefreshITHarness(t *testing.T) *refreshITHarness {
	t.Helper()
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if redisAddr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	db := refreshITMySQL(t)

	client := redis.NewClient(&redis.Options{Addr: redisAddr, DB: refreshITRefreshScanRedisDB, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	t.Cleanup(func() {
		_ = client.FlushDB(context.Background()).Err()
		_ = client.Close()
	})
	return &refreshITHarness{
		ctx:   context.Background(),
		db:    db,
		redis: client,
		core:  &Service{db: db, cache: redisCacheOps(client)},
	}
}

// refreshITPoller writes the cached signal state the refresh reads afterwards. It
// stands in for situationsignalsworker.Service: no MTProto connection is opened
// and no OREF request is issued.
type refreshITPoller struct {
	redis       *redis.Client
	telegramErr string
	orefErr     string
	telegramAt  int64
	orefAt      string
}

// refreshITTelegramDocument is the Telegram state document the refresh reads.
type refreshITTelegramDocument struct {
	ChannelSet     string            `json:"channelSet"`
	CursorByHandle map[string]int64  `json:"cursorByHandle"`
	Items          []json.RawMessage `json:"items"`
	LastPollAt     int64             `json:"lastPollAt"`
	LastError      string            `json:"lastError,omitempty"`
}

// refreshITOrefDocument is the OREF alerts document the refresh reads.
type refreshITOrefDocument struct {
	Scope             string            `json:"scope"`
	Configured        bool              `json:"configured"`
	Alerts            []json.RawMessage `json:"alerts"`
	HistoryCount24h   int               `json:"historyCount24h"`
	TotalHistoryCount int               `json:"totalHistoryCount"`
	Timestamp         string            `json:"timestamp"`
	Error             string            `json:"error,omitempty"`
}

func (p *refreshITPoller) PollTelegramWait(context.Context) error {
	payload, err := json.Marshal(refreshITTelegramDocument{
		ChannelSet:     "full",
		CursorByHandle: map[string]int64{},
		Items:          []json.RawMessage{},
		LastPollAt:     p.telegramAt,
		LastError:      p.telegramErr,
	})
	if err != nil {
		return err
	}
	return p.redis.Set(context.Background(), telegramStateKey, payload, 24*time.Hour).Err()
}

func (p *refreshITPoller) PollOref(context.Context) error {
	payload, err := json.Marshal(refreshITOrefDocument{
		Scope:      "global",
		Configured: true,
		Alerts:     []json.RawMessage{},
		Timestamp:  p.orefAt,
		Error:      p.orefErr,
	})
	if err != nil {
		return err
	}
	return p.redis.Set(context.Background(), orefAlertsKey, payload, time.Hour).Err()
}

// refreshITDispatcher stands in for the news source scheduler pass: it inserts one
// CrawlTask and three PipelineJob rows for the organization's first source and
// reports that the pass ran. The refresh reports analysisTaskCount as
// PipelineJob - CrawlTask, so the expected value is 2.
type refreshITDispatcher struct {
	db        *sql.DB
	orgID     string
	sourceIDs []string
	ran       bool
	err       error
	calls     int
}

func (d *refreshITDispatcher) RunScheduleOnce(context.Context) (bool, error) {
	d.calls++
	if d.err != nil {
		return false, d.err
	}
	if !d.ran {
		return false, nil
	}
	if len(d.sourceIDs) == 0 {
		return true, nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	sourceID := d.sourceIDs[0]
	if _, err := d.db.Exec(
		"INSERT INTO CrawlTask (id, orgId, newsSourceId, status, createdAt) VALUES (?, ?, ?, ?, ?)",
		"it-crawl-1", d.orgID, sourceID, string(crawlTaskPending), now); err != nil {
		return false, err
	}
	for index, jobID := range []string{"it-job-1", "it-job-2", "it-job-3"} {
		if _, err := d.db.Exec(
			"INSERT INTO PipelineJob (id, orgId, sourceId, status, createdAt) VALUES (?, ?, ?, ?, ?)",
			jobID, d.orgID, sourceID, string(pipelineJobPending), now.Add(time.Duration(index)*time.Millisecond)); err != nil {
			return false, err
		}
	}
	return true, nil
}

// insertRefreshITSource inserts one NewsSource row with an open circuit and a
// failure counter, so the test can prove the refresh resets both.
func insertRefreshITSource(t *testing.T, db *sql.DB, id, orgID string, active bool) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO NewsSource (id, orgId, isActive, nextRunAt, circuitOpenUntil, consecutiveFailures) VALUES (?, ?, ?, NULL, ?, 4)",
		id, orgID, active, time.Now().Add(time.Hour).UTC().Truncate(time.Millisecond)); err != nil {
		t.Fatalf("insert source: %v", err)
	}
}

// TestSituationRefreshIntegrationFullFlow covers T1 end to end: the active sources
// are reordered, the dispatch runs and its rows are counted, the Telegram/OREF
// state is read through the production read path, the record is written with the
// 900 second TTL and the GET refresh-runs read returns the same record and later
// the terminal state.
func TestSituationRefreshIntegrationFullFlow(t *testing.T) {
	harness := newRefreshITHarness(t)
	orgID := refreshITOrgID
	insertRefreshITSource(t, harness.db, "source-a", orgID, true)
	insertRefreshITSource(t, harness.db, "source-b", orgID, true)
	insertRefreshITSource(t, harness.db, "source-inactive", orgID, false)

	dispatcher := &refreshITDispatcher{db: harness.db, orgID: orgID, sourceIDs: []string{"source-a"}, ran: true}
	poller := &refreshITPoller{redis: harness.redis, telegramAt: 1_700_000_000_000, orefAt: "2023-11-14T22:13:20.000Z"}
	service := NewRefreshService(harness.core, poller, dispatcher)

	response, err := service.Refresh(harness.ctx, orgID, true)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if dispatcher.calls != 1 {
		t.Fatalf("dispatcher calls = %d, want 1", dispatcher.calls)
	}
	if response.Status != refreshStatusAccepted {
		t.Fatalf("status = %s, want accepted (warnings = %+v)", response.Status, response.Warnings)
	}
	if !response.Crawl.Attempted || !response.Crawl.Permitted || !response.Crawl.SchedulerTriggered {
		t.Fatalf("crawl flags = %+v", response.Crawl)
	}
	if response.Crawl.ActiveSourceCount != 2 || response.Crawl.ScheduledSourceCount != 2 {
		t.Fatalf("crawl source counts = %+v", response.Crawl)
	}
	if response.Crawl.CrawlTaskCount != 1 || response.Crawl.AnalysisTaskCount != 2 {
		t.Fatalf("crawl task counts = %+v", response.Crawl)
	}
	if want := buildCrawlDispatchMessage(2, 1, 2); response.Crawl.Message != want {
		t.Fatalf("crawl message = %q, want %q", response.Crawl.Message, want)
	}
	if response.Cache.InsightsCleared != 0 || response.Cache.ExternalCleared != 0 {
		t.Fatalf("cache counts = %+v", response.Cache)
	}
	if !response.Signals.Telegram.Attempted || !response.Signals.Telegram.OK {
		t.Fatalf("telegram result = %+v", response.Signals.Telegram)
	}
	if want := "Telegram refresh completed at 2023-11-14T22:13:20.000Z."; response.Signals.Telegram.Message != want {
		t.Fatalf("telegram message = %q, want %q", response.Signals.Telegram.Message, want)
	}
	if want := "OREF refresh completed at 2023-11-14T22:13:20.000Z."; response.Signals.Oref.Message != want {
		t.Fatalf("oref message = %q, want %q", response.Signals.Oref.Message, want)
	}
	if response.Terminal {
		t.Fatalf("terminal = true while crawl/analysis tasks are still pending")
	}
	if !response.Crawl.Attempted || response.RefreshID == "" || response.RequestedAt == "" || response.TaskWindowStart == "" {
		t.Fatalf("response envelope = %+v", response)
	}

	// The active sources were reordered (nextRunAt set, circuit closed, failures
	// reset) and the inactive source was left untouched.
	for _, sourceID := range []string{"source-a", "source-b"} {
		var nextRunAt sql.NullTime
		var circuitOpen sql.NullTime
		var failures int
		if err := harness.db.QueryRow(
			"SELECT nextRunAt, circuitOpenUntil, consecutiveFailures FROM NewsSource WHERE id = ?", sourceID,
		).Scan(&nextRunAt, &circuitOpen, &failures); err != nil {
			t.Fatalf("read source %s: %v", sourceID, err)
		}
		if !nextRunAt.Valid || circuitOpen.Valid || failures != 0 {
			t.Fatalf("source %s = %v/%v/%d, want a closed circuit and a reset counter", sourceID, nextRunAt, circuitOpen, failures)
		}
	}
	var inactiveCircuit sql.NullTime
	if err := harness.db.QueryRow(
		"SELECT circuitOpenUntil FROM NewsSource WHERE id = ?", "source-inactive",
	).Scan(&inactiveCircuit); err != nil {
		t.Fatalf("read inactive source: %v", err)
	}
	if !inactiveCircuit.Valid {
		t.Fatalf("the inactive source was reordered")
	}

	// The record is cached with the NestJS key and TTL and is readable through the
	// production read side.
	key := refreshRunPrefix + response.RefreshID
	ttl, err := harness.redis.TTL(harness.ctx, key).Result()
	if err != nil {
		t.Fatalf("record ttl: %v", err)
	}
	if ttl <= 0 || ttl > refreshRunTTL {
		t.Fatalf("record ttl = %s, want (0, %s]", ttl, refreshRunTTL)
	}
	raw, err := harness.redis.Get(harness.ctx, key).Result()
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	for _, fragment := range []string{
		`"refreshId":"` + response.RefreshID + `"`,
		`"orgId":"` + orgID + `"`,
		`"activeSourceIds":[`,
		`"schedulerTriggered":true`,
		`"crawlTaskCount":1`,
		`"analysisTaskCount":2`,
		`"terminal":false`,
	} {
		if !strings.Contains(raw, fragment) {
			t.Fatalf("record %s is missing %s", raw, fragment)
		}
	}

	read, err := harness.core.getRefreshRun(harness.ctx, orgID, response.RefreshID)
	if err != nil {
		t.Fatalf("getRefreshRun() error = %v", err)
	}
	if read.Status != refreshStatusRunning {
		t.Fatalf("read status = %s, want running while tasks are pending", read.Status)
	}
	if read.Progress.CrawlTasks.Pending != 1 || read.Progress.AnalysisTasks.Pending != 3 {
		t.Fatalf("read progress = %+v", read.Progress)
	}
	if read.Terminal {
		t.Fatalf("read terminal = true while tasks are pending")
	}

	// Completing the rows makes the run terminal on the next read, which is the
	// same state machine the NestJS GET /refresh-runs/:refreshId serves.
	if _, err := harness.db.Exec("UPDATE CrawlTask SET status = ?", string(crawlTaskCompleted)); err != nil {
		t.Fatalf("complete crawl task: %v", err)
	}
	if _, err := harness.db.Exec("UPDATE PipelineJob SET status = ?", string(pipelineJobCompleted)); err != nil {
		t.Fatalf("complete pipeline jobs: %v", err)
	}
	final, err := harness.core.getRefreshRun(harness.ctx, orgID, response.RefreshID)
	if err != nil {
		t.Fatalf("second getRefreshRun() error = %v", err)
	}
	if !final.Terminal || final.Status != refreshStatusCompleted {
		t.Fatalf("final read = %s/terminal=%t, want completed/terminal", final.Status, final.Terminal)
	}
	patched, err := harness.redis.Get(harness.ctx, key).Result()
	if err != nil {
		t.Fatalf("read patched record: %v", err)
	}
	if !strings.Contains(patched, `"terminal":true`) {
		t.Fatalf("terminal was not written back: %s", patched)
	}
}

// TestSituationRefreshIntegrationSchedulerBusy covers B1: while the shared
// cron:news-source-scheduler lease is held by another scheduler, the real Go
// scheduler reports that it did not run and the refresh answers with the busy
// warning instead of claiming a dispatch.
func TestSituationRefreshIntegrationSchedulerBusy(t *testing.T) {
	harness := newRefreshITHarness(t)
	orgID := refreshITOrgID
	insertRefreshITSource(t, harness.db, "source-a", orgID, true)

	acquired, err := harness.redis.SetNX(harness.ctx, refreshITSchedulerLockKey, "other-scheduler", 30*time.Second).Result()
	if err != nil {
		t.Fatalf("occupy the scheduler lease: %v", err)
	}
	if !acquired {
		t.Fatal("the scheduler lease was already held")
	}

	scheduler := newssourcescheduler.New(newssourcescheduler.Options{
		Redis:    harness.redis,
		Settings: newssourcescheduler.Settings{Enabled: true, LockTTL: 30 * time.Second},
	})
	ran, err := scheduler.RunScheduleOnce(harness.ctx)
	if err != nil {
		t.Fatalf("RunScheduleOnce() error = %v", err)
	}
	if ran {
		t.Fatal("RunScheduleOnce() reported a pass while another scheduler held the lease")
	}

	poller := &refreshITPoller{redis: harness.redis, telegramAt: 1_700_000_000_000, orefAt: "2023-11-14T22:13:20.000Z"}
	service := NewRefreshService(harness.core, poller, scheduler)
	response, err := service.Refresh(harness.ctx, orgID, true)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if len(response.Warnings) != 1 {
		t.Fatalf("warnings = %+v, want the busy warning only", response.Warnings)
	}
	warning := response.Warnings[0]
	if warning.Code != refreshWarningSchedulerBusy || warning.Source != refreshSourceCrawl ||
		warning.Severity != refreshSeverityWarning || warning.Message != refreshSchedulerBusyWarningMessage {
		t.Fatalf("busy warning = %+v", warning)
	}
	if response.Crawl.SchedulerTriggered {
		t.Fatal("schedulerTriggered = true while the lease was held")
	}
	if response.Crawl.CrawlTaskCount != 0 || response.Crawl.AnalysisTaskCount != 0 {
		t.Fatalf("crawl counts = %+v, want zero", response.Crawl)
	}
	if want := "Marked 1 active news source for refresh, but the crawl scheduler is already busy. Crawl and analysis will start on the next scheduler tick."; response.Crawl.Message != want {
		t.Fatalf("message = %q, want %q", response.Crawl.Message, want)
	}
	if response.Status != refreshStatusPartial {
		t.Fatalf("status = %s, want partial", response.Status)
	}
	if !response.Terminal {
		t.Fatal("terminal = false, want true once the busy branch skipped the dispatch")
	}
}

// TestSituationRefreshIntegrationPermissionBranches covers the two remaining crawl
// gates end to end: no crawl.write and no active source.
func TestSituationRefreshIntegrationPermissionBranches(t *testing.T) {
	harness := newRefreshITHarness(t)
	orgID := refreshITOrgID
	insertRefreshITSource(t, harness.db, "source-a", orgID, true)

	dispatcher := &refreshITDispatcher{db: harness.db, orgID: orgID, sourceIDs: []string{"source-a"}, ran: true}
	poller := &refreshITPoller{redis: harness.redis, telegramAt: 1_700_000_000_000, orefAt: "2023-11-14T22:13:20.000Z"}
	service := NewRefreshService(harness.core, poller, dispatcher)

	response, err := service.Refresh(harness.ctx, orgID, false)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if dispatcher.calls != 0 {
		t.Fatalf("dispatcher calls = %d, want none without crawl.write", dispatcher.calls)
	}
	if response.Crawl.Attempted || response.Crawl.Permitted || response.Crawl.SchedulerTriggered {
		t.Fatalf("crawl flags = %+v", response.Crawl)
	}
	if response.Crawl.Message != refreshCrawlPermissionMessage {
		t.Fatalf("message = %q", response.Crawl.Message)
	}
	if len(response.Warnings) != 1 || response.Warnings[0].Code != refreshWarningCrawlPermission {
		t.Fatalf("warnings = %+v", response.Warnings)
	}
	var nextRunAt sql.NullTime
	if err := harness.db.QueryRow("SELECT nextRunAt FROM NewsSource WHERE id = ?", "source-a").Scan(&nextRunAt); err != nil {
		t.Fatalf("read source: %v", err)
	}
	if nextRunAt.Valid {
		t.Fatal("a refresh without crawl.write reordered the sources")
	}

	emptyOrg := "org-refresh-integration-empty"
	response, err = service.Refresh(harness.ctx, emptyOrg, true)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if response.Crawl.Attempted || response.Crawl.ActiveSourceCount != 0 {
		t.Fatalf("crawl = %+v", response.Crawl)
	}
	if response.Crawl.Message != refreshNoActiveSourcesMessage {
		t.Fatalf("message = %q", response.Crawl.Message)
	}
	if len(response.Warnings) != 1 || response.Warnings[0].Code != refreshWarningNoActiveSources {
		t.Fatalf("warnings = %+v", response.Warnings)
	}
	if response.Cache.ExternalCleared != 0 {
		t.Fatalf("externalCleared = %d, want 0 (Q3: no key starts with the prefix)", response.Cache.ExternalCleared)
	}
}

// TestSituationRefreshIntegrationCacheClear covers the two prefix clears against
// the real Redis: the insights prefix removes the seeded core/external/learning
// revision keys of every organization, and the external prefix removes nothing
// because no key starts with it (Q2/Q3).
func TestSituationRefreshIntegrationCacheClear(t *testing.T) {
	harness := newRefreshITHarness(t)
	orgID := refreshITOrgID

	seeded := map[string]string{
		"situation-monitor:insights:v2:core:org-a:wh72:mi400:scall:gd1:dbg0:lr3": "{}",
		"situation-monitor:insights:v2:external:org-b":                           "{}",
		"situation-monitor:insights:learning-rev:v1:org-c":                       "7",
		"situation-monitor:external-snapshot:gdelt:fresh:v1":                     "{}",
		"situation-monitor:refresh-run:keep-me":                                  "{}",
	}
	for key, value := range seeded {
		if err := harness.redis.Set(harness.ctx, key, value, time.Hour).Err(); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}

	dispatcher := &refreshITDispatcher{db: harness.db, orgID: orgID, ran: true}
	poller := &refreshITPoller{redis: harness.redis, telegramAt: 1_700_000_000_000, orefAt: "2023-11-14T22:13:20.000Z"}
	service := NewRefreshService(harness.core, poller, dispatcher)
	response, err := service.Refresh(harness.ctx, orgID, true)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if response.Cache.InsightsCleared != 3 {
		t.Fatalf("insightsCleared = %d, want the three seeded insights keys", response.Cache.InsightsCleared)
	}
	if response.Cache.ExternalCleared != 0 {
		t.Fatalf("externalCleared = %d, want 0", response.Cache.ExternalCleared)
	}
	for key := range seeded {
		_, err := harness.redis.Get(harness.ctx, key).Result()
		removed := errors.Is(err, redis.Nil)
		switch {
		case strings.HasPrefix(key, insightsCachePrefix) && !removed:
			t.Fatalf("%s was not cleared", key)
		case !strings.HasPrefix(key, insightsCachePrefix) && removed:
			t.Fatalf("%s was cleared but does not belong to a cleared prefix", key)
		}
	}
}
