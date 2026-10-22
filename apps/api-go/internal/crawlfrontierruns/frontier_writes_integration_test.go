//go:build integration

// Crawl-frontier admin write-route integration tests (build tag integration; the
// normal `go test ./...` run does not need MySQL or Redis).
//
// The suite drives internal/crawlfrontierruns.WriteService against the real
// MySQL 8.4 and Redis 7.2 services the api-go-user-settings-integration CI job
// provides:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// What it proves against the real stores:
//   - CreateFrontierRun writes the four row families NestJS createRun writes
//     (the synthetic CrawlTask, CrawlFrontierRun, CrawlStrategyWorkflowRun and
//     the single root CrawlFrontierNode) with the WHATWG-normalised seed URL,
//     the merged keywords, the clamped budgets and the runRole/llmAssist
//     metadata patch; the returned runDetail is exactly what a second GetRun
//     reads back;
//   - the enqueue writes exactly one BullMQ frontier_node job to crawl4ai-hot,
//     with the NestJS job-id shape, the crawl4ai job payload and the
//     crawl-frontier-node:<nodeId> deduplication key;
//   - explicit profileId resolution keeps the NestJS 404/400 split;
//   - RetryNode/RetryNodes requeue the node, clear the failure columns, merge
//     the metadata patch (B2), append the frontier_node_requeued workflow event
//     and reset the workflow run, and refuse a terminal run (B4);
//   - a run creation that fails after the CrawlTask insert removes the synthetic
//     task again (B3).
//
// What it does not prove: no crawl4ai instance and no worker process runs in
// this suite. The job is asserted only as raw Redis/BullMQ protocol state; the
// queued node is never executed, so no crawl, no downstream item write and no
// node-completion path is covered here.
//
// The Redis address handling (env variable + skip) follows
// internal/gdeltsnapshot/snapshot_integration_test.go. The client uses
// Protocol 2 like the other BullMQ producer integration tests in this
// repository, because this file also evaluates the embedded BullMQ add script.
package crawlfrontierruns

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlworkflow"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// ---------------------------------------------------------------------------
// schema

// frontierWritesCrawlTaskTable mirrors the CrawlTask columns createRunFromProfile
// writes plus every NOT NULL column without a default.
const frontierWritesCrawlTaskTable = `CREATE TABLE IF NOT EXISTS CrawlTask (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  orgId VARCHAR(191) NOT NULL,
  createdById VARCHAR(191) NOT NULL,
  newsSourceId VARCHAR(191) NULL,
  targetUrl VARCHAR(1024) NOT NULL,
  displayName VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  config JSON NULL,
  timeRangeFrom DATETIME(3) NULL,
  timeRangeTo DATETIME(3) NULL,
  concurrency INT NOT NULL DEFAULT 1,
  keywords JSON NULL,
  lastRunAt DATETIME(3) NULL,
  lastSuccessAt DATETIME(3) NULL,
  lastResultAt DATETIME(3) NULL,
  lastCursor VARCHAR(191) NULL,
  lastError TEXT NULL,
  runCount INT NOT NULL DEFAULT 0,
  lastServerMemoryMb DOUBLE NULL,
  lastPeakMemoryMb DOUBLE NULL,
  lastMemoryEfficiency DOUBLE NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesCrawlSiteProfileTable mirrors the profile columns loadProfile,
// findProfileForURL and the runDetail profile read select.
const frontierWritesCrawlSiteProfileTable = `CREATE TABLE IF NOT EXISTS CrawlSiteProfile (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  orgId VARCHAR(191) NOT NULL,
  name VARCHAR(191) NOT NULL,
  description TEXT NULL,
  matchHost VARCHAR(191) NOT NULL,
  isActive TINYINT NOT NULL DEFAULT 1,
  executionMode VARCHAR(32) NOT NULL DEFAULT 'layered',
  workflowId VARCHAR(191) NULL,
  workflowVersionId VARCHAR(191) NULL,
  workflowBindingMode VARCHAR(32) NOT NULL DEFAULT 'published',
  version INT NOT NULL DEFAULT 1,
  config JSON NOT NULL,
  createdById VARCHAR(191) NOT NULL,
  updatedById VARCHAR(191) NULL,
  publishedAt DATETIME(3) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesCrawlFrontierRunTable mirrors every CrawlFrontierRun column the
// write path, GetRun and requeueNode read or write.
const frontierWritesCrawlFrontierRunTable = `CREATE TABLE IF NOT EXISTS CrawlFrontierRun (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  orgId VARCHAR(191) NOT NULL,
  profileId VARCHAR(191) NULL,
  workflowRunId VARCHAR(191) NULL,
  seedUrl TEXT NOT NULL,
  crawlTaskId VARCHAR(191) NULL,
  executionMode VARCHAR(32) NOT NULL DEFAULT 'layered',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  maxDepth INT NOT NULL DEFAULT 3,
  maxPages INT NOT NULL DEFAULT 60,
  keywords JSON NULL,
  pageCount INT NOT NULL DEFAULT 0,
  nodeCount INT NOT NULL DEFAULT 0,
  articleCount INT NOT NULL DEFAULT 0,
  failedCount INT NOT NULL DEFAULT 0,
  duplicateCount INT NOT NULL DEFAULT 0,
  nativeRunId VARCHAR(191) NULL,
  lastError TEXT NULL,
  metadata JSON NULL,
  createdById VARCHAR(191) NOT NULL,
  startedAt DATETIME(3) NULL,
  finishedAt DATETIME(3) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL,
  UNIQUE KEY CrawlFrontierRun_workflowRunId_key (workflowRunId)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesCrawlFrontierNodeTable mirrors the node columns createNode,
// requeueNode and the runDetail node projection use.
const frontierWritesCrawlFrontierNodeTable = `CREATE TABLE IF NOT EXISTS CrawlFrontierNode (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  runId VARCHAR(191) NOT NULL,
  parentNodeId VARCHAR(191) NULL,
  orgId VARCHAR(191) NOT NULL,
  url TEXT NOT NULL,
  canonicalUrl TEXT NULL,
  urlFingerprint VARCHAR(64) NULL,
  pageType VARCHAR(32) NOT NULL,
  depth INT NOT NULL,
  queueClass VARCHAR(32) NOT NULL DEFAULT 'normal',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  score DOUBLE NULL,
  freshnessScore DOUBLE NULL,
  attempts INT NOT NULL DEFAULT 0,
  queuedAt DATETIME(3) NULL,
  crawledAt DATETIME(3) NULL,
  crawlResultId VARCHAR(191) NULL,
  rejectionReason VARCHAR(191) NULL,
  lastError TEXT NULL,
  metadata JSON NULL,
  discoveredAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL,
  UNIQUE KEY CrawlFrontierNode_runId_urlFingerprint_key (runId, urlFingerprint)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesCrawlStrategyWorkflowRunTable mirrors the workflow-run columns
// createWorkflowRunForFrontier writes and requeueNode resets.
const frontierWritesCrawlStrategyWorkflowRunTable = `CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRun (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  orgId VARCHAR(191) NOT NULL,
  workflowId VARCHAR(191) NULL,
  workflowVersionId VARCHAR(191) NULL,
  workflowOrigin VARCHAR(191) NOT NULL DEFAULT 'bound',
  profileId VARCHAR(191) NULL,
  newsSourceId VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  runKind VARCHAR(64) NOT NULL DEFAULT 'trial',
  input JSON NULL,
  output JSON NULL,
  graphSnapshot JSON NULL,
  stepResults JSON NULL,
  candidates JSON NULL,
  parameterSources JSON NULL,
  error TEXT NULL,
  stepCount INT NOT NULL DEFAULT 0,
  candidateCount INT NOT NULL DEFAULT 0,
  selectedCount INT NOT NULL DEFAULT 0,
  createdById VARCHAR(191) NOT NULL,
  startedAt DATETIME(3) NULL,
  finishedAt DATETIME(3) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesCrawlStrategyWorkflowRunEventTable mirrors the event columns
// appendRequeueEvent writes.
const frontierWritesCrawlStrategyWorkflowRunEventTable = `CREATE TABLE IF NOT EXISTS CrawlStrategyWorkflowRunEvent (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  runId VARCHAR(191) NOT NULL,
  sequence INT NOT NULL DEFAULT 0,
  level VARCHAR(16) NOT NULL,
  eventType VARCHAR(64) NOT NULL,
  nodeId VARCHAR(191) NULL,
  nodeType VARCHAR(64) NULL,
  message TEXT NOT NULL,
  triggerReason VARCHAR(64) NULL,
  beforeCount INT NULL,
  afterCount INT NULL,
  rescuedCount INT NULL,
  details JSON NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`

// frontierWritesSystemSettingTable keeps the crawlqueue SettingsReader fallback
// read (crawl_client_settings) on a real table instead of a logged query error;
// the row is absent, so the producer keeps the EnvDefaults passed to it.
const frontierWritesSystemSettingTable = "CREATE TABLE IF NOT EXISTS SystemSetting (" +
	"`key` VARCHAR(191) NOT NULL PRIMARY KEY, `value` JSON NULL, isPublic TINYINT NOT NULL DEFAULT 0, " +
	"description TEXT NULL, createdAt DATETIME(3) NULL, updatedAt DATETIME(3) NULL, updatedById VARCHAR(191) NULL" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// frontierWritesSchemaStatements is the table set this suite owns. The
// crawl-strategy integration test in this package declares CrawlFrontierRun with
// only (id, workflowRunId); the harness drops that table before recreating it
// here, so a run started by the previous CI step cannot hide the columns this
// suite writes.
var frontierWritesSchemaStatements = []string{
	frontierWritesCrawlTaskTable,
	frontierWritesCrawlSiteProfileTable,
	frontierWritesCrawlFrontierRunTable,
	frontierWritesCrawlFrontierNodeTable,
	frontierWritesCrawlStrategyWorkflowRunTable,
	frontierWritesCrawlStrategyWorkflowRunEventTable,
	frontierWritesSystemSettingTable,
}

// ---------------------------------------------------------------------------
// harness

// frontierWritesHarness wires the production write service exactly like
// cmd/api's crawl-frontier write path does, on the shared MySQL and Redis
// handles.
type frontierWritesHarness struct {
	ctx      context.Context
	db       *sql.DB
	redis    *redis.Client
	frontier *crawlfrontierllm.Service
	writes   *WriteService
}

// frontierWritesNewHarness resets the schema and Redis database, then builds the
// real crawlfrontierllm chain service and the WriteService under test.
func frontierWritesNewHarness(t *testing.T) *frontierWritesHarness {
	t.Helper()
	db, err := usersettings.OpenMySQLFromURL(integrationDatabaseURL(t))
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		_ = db.Close()
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
	}
	client := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		_ = db.Close()
		t.Fatalf("redis ping: %v", err)
	}
	h := &frontierWritesHarness{ctx: ctx, db: db, redis: client}
	t.Cleanup(func() {
		_ = client.Close()
		_ = db.Close()
	})
	h.frontierWritesReset(t)
	h.frontier = crawlfrontierllm.New(crawlfrontierllm.Options{
		DB:    db,
		Redis: client,
		Enqueuer: crawlqueue.NewProducer(crawlqueue.Options{
			Redis: client,
			DB:    db,
			Env: &crawlqueue.EnvDefaults{
				MaxConcurrency: 1, MaxRetries: 1, RetryBackoffMs: 0, RequestTimeoutMs: 1000,
			},
		}),
		Workflows: crawlworkflow.NewService(db),
	})
	h.writes = NewWriteService(db, h.frontier)
	return h
}

// frontierWritesReset recreates the tables this suite owns, clears their rows and
// flushes the Redis database so a leftover job from an earlier CI step cannot
// satisfy the single-job assertions.
func (h *frontierWritesHarness) frontierWritesReset(t *testing.T) {
	t.Helper()
	// See frontierWritesSchemaStatements: the other integration test in this
	// package leaves a two-column CrawlFrontierRun behind.
	if _, err := h.db.Exec("DROP TABLE IF EXISTS CrawlFrontierRun"); err != nil {
		t.Fatalf("drop CrawlFrontierRun: %v", err)
	}
	for _, statement := range frontierWritesSchemaStatements {
		if _, err := h.db.Exec(statement); err != nil {
			t.Fatalf("schema: %v\n%s", err, statement)
		}
	}
	for _, table := range []string{
		"CrawlFrontierNode", "CrawlStrategyWorkflowRunEvent", "CrawlStrategyWorkflowRun",
		"CrawlFrontierRun", "CrawlSiteProfile", "CrawlTask",
	} {
		if _, err := h.db.Exec("DELETE FROM " + table + " WHERE 1 = 1"); err != nil {
			t.Fatalf("clean %s: %v", table, err)
		}
	}
	if err := h.redis.FlushDB(h.ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
}

// ---------------------------------------------------------------------------
// fixture helpers

func frontierWritesNow() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

func frontierWritesExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("exec: %v\n%s", err, query)
	}
}

// frontierWritesSeedProfile inserts an active CrawlSiteProfile row, the columns
// loadProfile and findProfileForURL read.
func frontierWritesSeedProfile(t *testing.T, db *sql.DB, id, orgID, name, matchHost, executionMode, configJSON string) {
	t.Helper()
	now := frontierWritesNow()
	frontierWritesExec(t, db, `INSERT INTO CrawlSiteProfile
(id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId,
 workflowBindingMode, version, config, createdById, updatedById, publishedAt, createdAt, updatedAt)
VALUES (?, ?, ?, NULL, ?, 1, ?, NULL, NULL, 'published', 1, ?, 'actor-seed', NULL, ?, ?, ?)`,
		id, orgID, name, matchHost, executionMode, []byte(configJSON), now, now, now)
}

// frontierWritesRunSeed is the minimal CrawlFrontierRun row the retry paths read.
type frontierWritesRunSeed struct {
	ID            string
	OrgID         string
	ProfileID     *string
	WorkflowRunID *string
	SeedURL       string
	CrawlTaskID   *string
	Status        string
	FinishedAt    *time.Time
	Metadata      string
}

func frontierWritesNullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func frontierWritesNullableTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return *value
}

func frontierWritesSeedRun(t *testing.T, db *sql.DB, seed frontierWritesRunSeed) {
	t.Helper()
	now := frontierWritesNow()
	metadata := seed.Metadata
	if strings.TrimSpace(metadata) == "" {
		metadata = "{}"
	}
	seedURL := seed.SeedURL
	if seedURL == "" {
		seedURL = "https://example.com/seed"
	}
	frontierWritesExec(t, db, `INSERT INTO CrawlFrontierRun
(id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status, maxDepth, maxPages,
 keywords, pageCount, nodeCount, articleCount, failedCount, duplicateCount, nativeRunId, lastError,
 metadata, createdById, startedAt, finishedAt, createdAt, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, 'layered', ?, 3, 60, '[]', 0, 0, 0, 0, 0, NULL, NULL, ?, 'actor-seed', NULL, ?, ?, ?)`,
		seed.ID, seed.OrgID, frontierWritesNullableString(seed.ProfileID),
		frontierWritesNullableString(seed.WorkflowRunID), seedURL,
		frontierWritesNullableString(seed.CrawlTaskID), seed.Status, []byte(metadata),
		frontierWritesNullableTime(seed.FinishedAt), now, now)
}

// frontierWritesNodeSeed is the minimal CrawlFrontierNode row requeueNode reads.
type frontierWritesNodeSeed struct {
	ID              string
	RunID           string
	OrgID           string
	URL             string
	PageType        string
	QueueClass      string
	Status          string
	Depth           int
	LastError       *string
	RejectionReason *string
	Metadata        string
}

func frontierWritesSeedNode(t *testing.T, db *sql.DB, seed frontierWritesNodeSeed) {
	t.Helper()
	now := frontierWritesNow()
	if seed.URL == "" {
		seed.URL = "https://example.com/" + seed.ID
	}
	if seed.PageType == "" {
		seed.PageType = "article"
	}
	if seed.QueueClass == "" {
		seed.QueueClass = "normal"
	}
	metadata := seed.Metadata
	if strings.TrimSpace(metadata) == "" {
		metadata = "{}"
	}
	frontierWritesExec(t, db, `INSERT INTO CrawlFrontierNode
(id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth, queueClass,
 status, score, freshnessScore, attempts, queuedAt, crawledAt, crawlResultId, rejectionReason,
 lastError, metadata, discoveredAt, createdAt, updatedAt)
VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 2, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
		seed.ID, seed.RunID, seed.OrgID, seed.URL, seed.PageType, seed.Depth, seed.QueueClass,
		seed.Status, frontierWritesNullableString(seed.RejectionReason),
		frontierWritesNullableString(seed.LastError), []byte(metadata), now, now, now)
}

// frontierWritesSeedWorkflowRun inserts the workflow run requeueNode resets.
func frontierWritesSeedWorkflowRun(t *testing.T, db *sql.DB, id, orgID, status string, finishedAt *time.Time) {
	t.Helper()
	now := frontierWritesNow()
	frontierWritesExec(t, db, `INSERT INTO CrawlStrategyWorkflowRun
(id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId, status, runKind,
 input, output, graphSnapshot, stepResults, candidates, parameterSources, error, stepCount,
 candidateCount, selectedCount, createdById, startedAt, finishedAt, createdAt, updatedAt)
VALUES (?, ?, NULL, NULL, 'legacy_bridge', NULL, NULL, ?, 'frontier_run', '{}', NULL, '{}',
        NULL, NULL, '[]', NULL, 0, 0, 0, 'actor-seed', NULL, ?, ?, ?)`,
		id, orgID, status, frontierWritesNullableTime(finishedAt), now, now)
}

// frontierWritesSeedEvent inserts one prior workflow event so the requeue event
// sequence is proven to be count+1 instead of always 1.
func frontierWritesSeedEvent(t *testing.T, db *sql.DB, id, runID, nodeID, eventType string, sequence int) {
	t.Helper()
	now := frontierWritesNow()
	frontierWritesExec(t, db, `INSERT INTO CrawlStrategyWorkflowRunEvent
(id, runId, sequence, level, eventType, nodeId, nodeType, message, triggerReason,
 beforeCount, afterCount, rescuedCount, details, createdAt)
VALUES (?, ?, ?, 'warn', ?, ?, 'legacy.frontier_node', 'prior failure', 'crawl_failed', 0, 1, 0, '{}', ?)`,
		id, runID, sequence, eventType, nodeID, now)
}

// ---------------------------------------------------------------------------
// BullMQ read helpers

// frontierWritesQueuePrefix is keysFor: Prefix + ":" + queue + ":".
func frontierWritesQueuePrefix(queue string) string {
	return crawlqueue.Prefix + ":" + queue + ":"
}

func frontierWritesWaitKey(queue string) string {
	return frontierWritesQueuePrefix(queue) + "wait"
}

func frontierWritesJobKey(queue, jobID string) string {
	return frontierWritesQueuePrefix(queue) + jobID
}

// frontierWritesJob is one raw BullMQ job as the producer wrote it.
type frontierWritesJob struct {
	ID   string
	Data map[string]any
}

// frontierWritesReadJobs reads the wait list of one queue and every job hash it
// points at. Only the wait list is read: the suites always enqueue with no
// source priority, so the standard add script writes the job to the wait list
// and never to the prioritized zset.
func frontierWritesReadJobs(t *testing.T, client *redis.Client, queue string) []frontierWritesJob {
	t.Helper()
	ctx := context.Background()
	waitKey := frontierWritesWaitKey(queue)
	ids, err := client.LRange(ctx, waitKey, 0, -1).Result()
	if err != nil {
		t.Fatalf("read %s: %v", waitKey, err)
	}
	jobs := make([]frontierWritesJob, 0, len(ids))
	for _, id := range ids {
		jobKey := frontierWritesJobKey(queue, id)
		if exists, err := client.Exists(ctx, jobKey).Result(); err != nil || exists != 1 {
			t.Fatalf("job hash %s: exists=%d err=%v", jobKey, exists, err)
		}
		raw, err := client.HGet(ctx, jobKey, "data").Result()
		if err != nil {
			t.Fatalf("job data %s: %v", jobKey, err)
		}
		var data map[string]any
		if err := json.Unmarshal([]byte(raw), &data); err != nil {
			t.Fatalf("job data %s is not JSON: %v (%s)", jobKey, err, raw)
		}
		jobs = append(jobs, frontierWritesJob{ID: id, Data: data})
	}
	return jobs
}

// frontierWritesAssertJobID checks the `${nodeId}-${Date.now()}-${queueClass}`
// shape of FrontierNodeJobID without knowing the timestamp: the millisecond part
// is parsed back out and the production formatter is re-run on it.
func frontierWritesAssertJobID(t *testing.T, jobID, nodeID string, queueClass crawlqueue.PriorityClass) {
	t.Helper()
	prefix := nodeID + "-"
	suffix := "-" + string(queueClass)
	if !strings.HasPrefix(jobID, prefix) || !strings.HasSuffix(jobID, suffix) {
		t.Fatalf("job id %q does not look like %q<millis>%q", jobID, prefix, suffix)
	}
	millis, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(jobID, prefix), suffix), 10, 64)
	if err != nil || millis <= 0 {
		t.Fatalf("job id %q has no positive millisecond part: %v", jobID, err)
	}
	if want := crawlqueue.FrontierNodeJobID(nodeID, queueClass, time.UnixMilli(millis)); want != jobID {
		t.Fatalf("job id %q does not match FrontierNodeJobID(%q, %q, %d) = %q",
			jobID, nodeID, queueClass, millis, want)
	}
}

// frontierWritesAssertJobData checks the CrawlJobData members the frontier_node
// producer writes (crawlqueue.FrontierNodeJobData).
func frontierWritesAssertJobData(t *testing.T, data map[string]any, orgID, taskID, runID, nodeID, queueClass string) {
	t.Helper()
	for field, want := range map[string]string{
		"jobKind":        "frontier_node",
		"orgId":          orgID,
		"taskId":         taskID,
		"frontierRunId":  runID,
		"frontierNodeId": nodeID,
		"priorityClass":  queueClass,
	} {
		got, ok := data[field].(string)
		if !ok || got != want {
			t.Fatalf("job data %s = %v, want %q (data=%v)", field, data[field], want, data)
		}
	}
	if traceID, ok := data["traceId"].(string); !ok || strings.TrimSpace(traceID) == "" {
		t.Fatalf("job data traceId is empty: %v", data)
	}
	if requeues, ok := data["memoryPressureRequeues"].(float64); !ok || requeues != 0 {
		t.Fatalf("job data memoryPressureRequeues = %v, want 0", data["memoryPressureRequeues"])
	}
}

// frontierWritesAssertSingleJob asserts exactly one job on the queue, its job-id
// shape, its payload and the task-scoped deduplication key, then returns it.
func frontierWritesAssertSingleJob(t *testing.T, client *redis.Client, queue, nodeID string, queueClass crawlqueue.PriorityClass,
	orgID, taskID, runID string) frontierWritesJob {
	t.Helper()
	jobs := frontierWritesReadJobs(t, client, queue)
	if len(jobs) != 1 {
		t.Fatalf("%s wait list holds %d jobs, want 1: %+v", queue, len(jobs), jobs)
	}
	job := jobs[0]
	frontierWritesAssertJobID(t, job.ID, nodeID, queueClass)
	frontierWritesAssertJobData(t, job.Data, orgID, taskID, runID, nodeID, string(queueClass))
	dedupKey := frontierWritesQueuePrefix(queue) + "de:crawl-frontier-node:" + nodeID
	dedupedID, err := client.Get(context.Background(), dedupKey).Result()
	if err != nil {
		t.Fatalf("read deduplication key %s: %v", dedupKey, err)
	}
	if dedupedID != job.ID {
		t.Fatalf("deduplication key %s = %q, want job id %q", dedupKey, dedupedID, job.ID)
	}
	return job
}

// ---------------------------------------------------------------------------
// JSON / SQL read helpers

func frontierWritesDecodeJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	object := map[string]any{}
	if len(raw) == 0 {
		return object
	}
	if err := json.Unmarshal(raw, &object); err != nil {
		t.Fatalf("decode JSON %s: %v", string(raw), err)
	}
	return object
}

func frontierWritesJSONString(t *testing.T, object map[string]any, key string) string {
	t.Helper()
	value, ok := object[key].(string)
	if !ok {
		t.Fatalf("%s = %v, want a string (object=%v)", key, object[key], object)
	}
	return value
}

func frontierWritesJSONNumber(t *testing.T, object map[string]any, key string) float64 {
	t.Helper()
	value, ok := object[key].(float64)
	if !ok {
		t.Fatalf("%s = %v, want a number (object=%v)", key, object[key], object)
	}
	return value
}

func frontierWritesJSONObject(t *testing.T, object map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := object[key].(map[string]any)
	if !ok {
		t.Fatalf("%s = %v, want an object (object=%v)", key, object[key], object)
	}
	return value
}

func frontierWritesCount(t *testing.T, ctx context.Context, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		t.Fatalf("count (%s): %v", query, err)
	}
	return count
}

// frontierWritesStatusError extracts the NestJS-shaped error the write service
// returns for a 4xx decision.
func frontierWritesStatusError(t *testing.T, err error, status int, message string) {
	t.Helper()
	if err == nil {
		t.Fatalf("want status %d %q, got nil error", status, message)
	}
	var target *statusError
	if !errors.As(err, &target) {
		t.Fatalf("want *statusError, got %T: %v", err, err)
	}
	if target.status != status || target.message != message {
		t.Fatalf("statusError = {%d %q}, want {%d %q}", target.status, target.message, status, message)
	}
}

// ---------------------------------------------------------------------------
// createRun

// TestFrontierWritesIntegrationCreateRun covers POST /runs: the four written
// row families, the runDetail round trip and the single hot-queue job.
func TestFrontierWritesIntegrationCreateRun(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID     = "org-frontier-writes"
		actorID   = "user-frontier-writes"
		profileID = "cprofile-frontier-writes"
		seedInput = "https://Example.COM/seed?b=2#frag"
		wantSeed  = "https://example.com/seed?b=2#frag"
	)
	frontierWritesSeedProfile(t, h.db, profileID, orgID, "Writes Example", "example.com", "layered",
		`{"keywords":["alpha","beta"],"layeredOptions":{"maxDepth":4,"maxPages":40},`+
			`"llmAssist":{"enabled":true,"recallMode":"balanced"}}`)

	inputProfileID := profileID
	executionMode := "native"
	maxDepth := 10.0
	maxPages := 1000.0
	detail, err := h.writes.CreateFrontierRun(h.ctx, orgID, actorID, createRunInput{
		SeedURL:       seedInput,
		ProfileID:     &inputProfileID,
		ExecutionMode: &executionMode,
		MaxDepth:      &maxDepth,
		MaxPages:      &maxPages,
		Keywords:      []string{"beta", "gamma"},
	})
	if err != nil {
		t.Fatalf("CreateFrontierRun: %v", err)
	}
	runID := detail.ID
	if runID == "" {
		t.Fatal("CreateFrontierRun returned an empty run id")
	}
	// Array.from(new Set([...input.keywords, ...profile.keywords])).
	wantKeywords := []string{"beta", "gamma", "alpha"}

	// ---- CrawlFrontierRun
	var (
		runOrgID, runSeedURL, runExecutionMode, runStatus, runCreatedByID string
		runProfileID, runWorkflowRunID, runCrawlTaskID                    sql.NullString
		runKeywordsRaw, runMetadataRaw                                    []byte
		runMaxDepth, runMaxPages                                          int
		runFinishedAt                                                     sql.NullTime
	)
	if err := h.db.QueryRowContext(h.ctx, `
SELECT orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status, maxDepth, maxPages,
       keywords, createdById, finishedAt, metadata
FROM CrawlFrontierRun WHERE id = ?`, runID).Scan(
		&runOrgID, &runProfileID, &runWorkflowRunID, &runSeedURL, &runCrawlTaskID, &runExecutionMode,
		&runStatus, &runMaxDepth, &runMaxPages, &runKeywordsRaw, &runCreatedByID, &runFinishedAt, &runMetadataRaw,
	); err != nil {
		t.Fatalf("read CrawlFrontierRun: %v", err)
	}
	if runOrgID != orgID {
		t.Fatalf("run orgId = %q, want %q", runOrgID, orgID)
	}
	if !runProfileID.Valid || runProfileID.String != profileID {
		t.Fatalf("run profileId = %v, want %q", runProfileID, profileID)
	}
	if runSeedURL != wantSeed {
		t.Fatalf("run seedUrl = %q, want the WHATWG serialisation %q", runSeedURL, wantSeed)
	}
	if runExecutionMode != "native" {
		t.Fatalf("run executionMode = %q, want the request value %q", runExecutionMode, "native")
	}
	if runStatus != string(RunStatusQueued) {
		t.Fatalf("run status = %q, want %q", runStatus, RunStatusQueued)
	}
	if runMaxDepth != 8 || runMaxPages != 500 {
		t.Fatalf("run budgets = %d/%d, want the clamp 8/500", runMaxDepth, runMaxPages)
	}
	var runKeywords []string
	if err := json.Unmarshal(runKeywordsRaw, &runKeywords); err != nil {
		t.Fatalf("decode run keywords: %v", err)
	}
	if !reflect.DeepEqual(runKeywords, wantKeywords) {
		t.Fatalf("run keywords = %v, want %v", runKeywords, wantKeywords)
	}
	if runCreatedByID != actorID {
		t.Fatalf("run createdById = %q, want %q", runCreatedByID, actorID)
	}
	if runFinishedAt.Valid {
		t.Fatalf("run finishedAt = %v, want NULL", runFinishedAt.Time)
	}
	if !runCrawlTaskID.Valid || runCrawlTaskID.String == "" {
		t.Fatal("run crawlTaskId is NULL, want the synthetic task id")
	}
	if !runWorkflowRunID.Valid || runWorkflowRunID.String == "" {
		t.Fatal("run workflowRunId is NULL, want the workflow run id")
	}
	taskID := runCrawlTaskID.String
	workflowRunID := runWorkflowRunID.String

	runMetadata := frontierWritesDecodeJSON(t, runMetadataRaw)
	if got := frontierWritesJSONString(t, runMetadata, "runRole"); got != "active" {
		t.Fatalf("run metadata runRole = %q, want active", got)
	}
	assist := frontierWritesJSONObject(t, runMetadata, "llmAssist")
	if enabled, ok := assist["enabled"].(bool); !ok || !enabled {
		t.Fatalf("run metadata llmAssist.enabled = %v, want true", assist["enabled"])
	}
	if got := frontierWritesJSONString(t, assist, "recallMode"); got != "balanced" {
		t.Fatalf("run metadata llmAssist.recallMode = %q, want balanced", got)
	}
	if synthesized, ok := assist["synthesized"].(bool); !ok || synthesized {
		t.Fatalf("run metadata llmAssist.synthesized = %v, want false (profile llmAssist.enabled=true)", assist["synthesized"])
	}
	if got := frontierWritesJSONString(t, runMetadata, "workflowOrigin"); got != "legacy_bridge" {
		t.Fatalf("run metadata workflowOrigin = %q, want legacy_bridge", got)
	}
	if got := frontierWritesJSONString(t, runMetadata, "seedStrategy"); got != "auto" {
		t.Fatalf("run metadata seedStrategy = %q, want auto", got)
	}
	if got := frontierWritesJSONString(t, runMetadata, "seedDiscoveryMode"); got != "robots" {
		t.Fatalf("run metadata seedDiscoveryMode = %q, want robots", got)
	}
	if got := frontierWritesJSONString(t, runMetadata, "sourceTier"); got != "tier2" {
		t.Fatalf("run metadata sourceTier = %q, want tier2", got)
	}
	if got := frontierWritesJSONString(t, runMetadata, "hostScope"); got != "registrable_domain" {
		t.Fatalf("run metadata hostScope = %q, want registrable_domain", got)
	}
	if got := frontierWritesJSONNumber(t, runMetadata, "profileVersion"); got != 1 {
		t.Fatalf("run metadata profileVersion = %v, want 1", got)
	}
	if got := frontierWritesJSONNumber(t, runMetadata, "workflowGraphNodeCount"); got != 7 {
		t.Fatalf("run metadata workflowGraphNodeCount = %v, want 7", got)
	}
	if got := frontierWritesJSONNumber(t, runMetadata, "workflowGraphEdgeCount"); got != 6 {
		t.Fatalf("run metadata workflowGraphEdgeCount = %v, want 6", got)
	}
	budgets := frontierWritesJSONObject(t, runMetadata, "pageTypeBudgets")
	for _, pageType := range []string{"home", "category", "list", "article"} {
		if _, ok := budgets[pageType]; !ok {
			t.Fatalf("run metadata pageTypeBudgets has no %q: %v", pageType, budgets)
		}
	}

	// ---- synthetic CrawlTask
	var (
		taskOrgID, taskCreatedByID, taskTargetURL, taskStatus, taskDisplayName string
		taskConcurrency                                                        int
		taskKeywordsRaw, taskConfigRaw                                         []byte
	)
	if err := h.db.QueryRowContext(h.ctx, `
SELECT orgId, createdById, targetUrl, displayName, status, concurrency, keywords, config
FROM CrawlTask WHERE id = ?`, taskID).Scan(
		&taskOrgID, &taskCreatedByID, &taskTargetURL, &taskDisplayName, &taskStatus,
		&taskConcurrency, &taskKeywordsRaw, &taskConfigRaw,
	); err != nil {
		t.Fatalf("read CrawlTask: %v", err)
	}
	if taskOrgID != orgID || taskCreatedByID != actorID || taskTargetURL != wantSeed {
		t.Fatalf("task = {%q %q %q}, want {%q %q %q}", taskOrgID, taskCreatedByID, taskTargetURL, orgID, actorID, wantSeed)
	}
	if taskDisplayName != "Frontier: Writes Example" {
		t.Fatalf("task displayName = %q, want Frontier: Writes Example", taskDisplayName)
	}
	if taskStatus != "queued" || taskConcurrency != 1 {
		t.Fatalf("task status/concurrency = %q/%d, want queued/1", taskStatus, taskConcurrency)
	}
	var taskKeywords []string
	if err := json.Unmarshal(taskKeywordsRaw, &taskKeywords); err != nil {
		t.Fatalf("decode task keywords: %v", err)
	}
	if !reflect.DeepEqual(taskKeywords, wantKeywords) {
		t.Fatalf("task keywords = %v, want %v", taskKeywords, wantKeywords)
	}
	taskConfig := frontierWritesDecodeJSON(t, taskConfigRaw)
	if frontier, ok := taskConfig["frontier"].(bool); !ok || !frontier {
		t.Fatalf("task config.frontier = %v, want true", taskConfig["frontier"])
	}
	if got := frontierWritesJSONString(t, taskConfig, "frontierProfileId"); got != profileID {
		t.Fatalf("task config.frontierProfileId = %q, want %q", got, profileID)
	}
	if got := frontierWritesJSONString(t, taskConfig, "executionMode"); got != "native" {
		t.Fatalf("task config.executionMode = %q, want native", got)
	}
	if value, ok := taskConfig["workflowId"]; !ok || value != nil {
		t.Fatalf("task config.workflowId = %v, want an explicit null", taskConfig["workflowId"])
	}
	itemPayload := frontierWritesJSONObject(t, taskConfig, "itemPayload")
	itemMetadata := frontierWritesJSONObject(t, itemPayload, "metadata")
	if got := frontierWritesJSONString(t, itemMetadata, "crawlSiteProfileId"); got != profileID {
		t.Fatalf("task config.itemPayload.metadata.crawlSiteProfileId = %q, want %q", got, profileID)
	}

	// ---- CrawlStrategyWorkflowRun
	var (
		workflowStatus, workflowRunKind, workflowOrigin, workflowCreatedByID string
		workflowProfileID                                                    sql.NullString
		workflowInputRaw, workflowGraphRaw                                   []byte
		workflowFinishedAt                                                   sql.NullTime
	)
	if err := h.db.QueryRowContext(h.ctx, `
SELECT status, runKind, workflowOrigin, profileId, input, graphSnapshot, createdById, finishedAt
FROM CrawlStrategyWorkflowRun WHERE id = ?`, workflowRunID).Scan(
		&workflowStatus, &workflowRunKind, &workflowOrigin, &workflowProfileID,
		&workflowInputRaw, &workflowGraphRaw, &workflowCreatedByID, &workflowFinishedAt,
	); err != nil {
		t.Fatalf("read CrawlStrategyWorkflowRun: %v", err)
	}
	if workflowStatus != string(RunStatusQueued) || workflowRunKind != "frontier_run" {
		t.Fatalf("workflow run = {%q %q}, want {queued frontier_run}", workflowStatus, workflowRunKind)
	}
	if workflowOrigin != "legacy_bridge" || workflowCreatedByID != actorID {
		t.Fatalf("workflow run origin/createdBy = %q/%q, want legacy_bridge/%q",
			workflowOrigin, workflowCreatedByID, actorID)
	}
	if !workflowProfileID.Valid || workflowProfileID.String != profileID {
		t.Fatalf("workflow run profileId = %v, want %q", workflowProfileID, profileID)
	}
	if workflowFinishedAt.Valid {
		t.Fatalf("workflow run finishedAt = %v, want NULL", workflowFinishedAt.Time)
	}
	workflowInput := frontierWritesDecodeJSON(t, workflowInputRaw)
	if got := frontierWritesJSONString(t, workflowInput, "frontierRunId"); got != runID {
		t.Fatalf("workflow input frontierRunId = %q, want %q", got, runID)
	}
	if got := frontierWritesJSONString(t, workflowInput, "seedUrl"); got != wantSeed {
		t.Fatalf("workflow input seedUrl = %q, want %q", got, wantSeed)
	}
	if got := frontierWritesJSONString(t, workflowInput, "profileId"); got != profileID {
		t.Fatalf("workflow input profileId = %q, want %q", got, profileID)
	}
	if got := frontierWritesJSONString(t, workflowInput, "executionMode"); got != "native" {
		t.Fatalf("workflow input executionMode = %q, want native", got)
	}
	if got := frontierWritesJSONNumber(t, workflowInput, "maxDepth"); got != 8 {
		t.Fatalf("workflow input maxDepth = %v, want 8", got)
	}
	if got := frontierWritesJSONNumber(t, workflowInput, "maxPages"); got != 500 {
		t.Fatalf("workflow input maxPages = %v, want 500", got)
	}
	inputKeywords, ok := workflowInput["keywords"].([]any)
	if !ok || len(inputKeywords) != len(wantKeywords) {
		t.Fatalf("workflow input keywords = %v, want %v", workflowInput["keywords"], wantKeywords)
	}
	for index, keyword := range wantKeywords {
		if got, _ := inputKeywords[index].(string); got != keyword {
			t.Fatalf("workflow input keywords[%d] = %v, want %q", index, inputKeywords[index], keyword)
		}
	}
	workflowGraph := frontierWritesDecodeJSON(t, workflowGraphRaw)
	nodes, _ := workflowGraph["nodes"].([]any)
	edges, _ := workflowGraph["edges"].([]any)
	if len(nodes) != 7 || len(edges) != 6 {
		t.Fatalf("workflow graphSnapshot = %d nodes/%d edges, want 7/6", len(nodes), len(edges))
	}

	// ---- root CrawlFrontierNode
	rows, err := h.db.QueryContext(h.ctx, `
SELECT id, runId, orgId, url, pageType, depth, queueClass, status, parentNodeId, metadata
FROM CrawlFrontierNode WHERE runId = ? ORDER BY depth ASC, discoveredAt ASC`, runID)
	if err != nil {
		t.Fatalf("read CrawlFrontierNode: %v", err)
	}
	defer rows.Close()
	type frontierWritesNodeRow struct {
		ID         string
		RunID      string
		OrgID      string
		URL        string
		PageType   string
		Depth      int
		QueueClass string
		Status     string
		ParentID   sql.NullString
		Metadata   []byte
	}
	nodeRows := []frontierWritesNodeRow{}
	for rows.Next() {
		var row frontierWritesNodeRow
		if err := rows.Scan(&row.ID, &row.RunID, &row.OrgID, &row.URL, &row.PageType, &row.Depth,
			&row.QueueClass, &row.Status, &row.ParentID, &row.Metadata); err != nil {
			t.Fatalf("scan CrawlFrontierNode: %v", err)
		}
		nodeRows = append(nodeRows, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read CrawlFrontierNode: %v", err)
	}
	if len(nodeRows) != 1 {
		t.Fatalf("run has %d nodes, want exactly one root node", len(nodeRows))
	}
	root := nodeRows[0]
	if root.RunID != runID || root.OrgID != orgID || root.URL != wantSeed {
		t.Fatalf("root node = {%q %q %q}, want {%q %q %q}", root.RunID, root.OrgID, root.URL, runID, orgID, wantSeed)
	}
	if root.PageType != "home" || root.Depth != 0 || root.QueueClass != "hot" {
		t.Fatalf("root node pageType/depth/queueClass = %q/%d/%q, want home/0/hot",
			root.PageType, root.Depth, root.QueueClass)
	}
	if root.Status != string(NodeStatusQueued) {
		t.Fatalf("root node status = %q, want queued", root.Status)
	}
	if root.ParentID.Valid {
		t.Fatalf("root node parentNodeId = %q, want NULL", root.ParentID.String)
	}
	rootMetadata := frontierWritesDecodeJSON(t, root.Metadata)
	if seed, ok := rootMetadata["seed"].(bool); !ok || !seed {
		t.Fatalf("root node metadata.seed = %v, want true", rootMetadata["seed"])
	}
	if got := frontierWritesJSONString(t, rootMetadata, "seedOrigin"); got != "frontier_root" {
		t.Fatalf("root node metadata.seedOrigin = %q, want frontier_root", got)
	}
	if got := frontierWritesJSONString(t, rootMetadata, "workflowRunId"); got != workflowRunID {
		t.Fatalf("root node metadata.workflowRunId = %q, want %q", got, workflowRunID)
	}
	if got := frontierWritesJSONString(t, rootMetadata, "runRole"); got != "active" {
		t.Fatalf("root node metadata.runRole = %q, want active", got)
	}

	// ---- Redis: exactly one frontier_node job on crawl4ai-hot
	job := frontierWritesAssertSingleJob(t, h.redis, crawlqueue.QueueHot, root.ID, crawlqueue.PriorityClassHot,
		orgID, taskID, runID)
	if job.Data["jobKind"] != crawlqueue.JobKindFrontierNodeConstant {
		t.Fatalf("jobKind = %v, want %q", job.Data["jobKind"], crawlqueue.JobKindFrontierNodeConstant)
	}
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueNormal); len(jobs) != 0 {
		t.Fatalf("crawl4ai-normal holds %d jobs, want 0: %+v", len(jobs), jobs)
	}

	// ---- runDetail equals a fresh GET /runs/:id
	if detail.Status != RunStatusQueued || detail.MaxDepth != 8 || detail.MaxPages != 500 {
		t.Fatalf("detail run = {status:%q maxDepth:%d maxPages:%d}, want {queued 8 500}",
			detail.Status, detail.MaxDepth, detail.MaxPages)
	}
	if detail.ExecutionMode != ExecutionModeNative || detail.SeedURL != wantSeed || detail.CreatedByID != actorID {
		t.Fatalf("detail = {%q %q %q}, want {%q %q %q}",
			detail.ExecutionMode, detail.SeedURL, detail.CreatedByID, ExecutionModeNative, wantSeed, actorID)
	}
	if detail.Profile == nil || detail.Profile.ID != profileID {
		t.Fatalf("detail profile = %+v, want profile %q", detail.Profile, profileID)
	}
	if len(detail.Nodes) != 1 || detail.Nodes[0].ID != root.ID || detail.Nodes[0].Status != NodeStatusQueued {
		t.Fatalf("detail nodes = %+v, want the single queued root node %q", detail.Nodes, root.ID)
	}
	fresh, err := NewService(h.db).GetRun(h.ctx, orgID, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if !reflect.DeepEqual(detail, fresh) {
		t.Fatal("CreateFrontierRun detail differs from a fresh GetRun")
	}
}

// TestFrontierWritesIntegrationCreateRunProfileErrors covers the two profile
// resolution failures of POST /runs.
func TestFrontierWritesIntegrationCreateRunProfileErrors(t *testing.T) {
	h := frontierWritesNewHarness(t)
	t.Run("foreign profile is a 404", func(t *testing.T) {
		const (
			requestOrg = "org-writes-foreign-request"
			actorID    = "user-writes-foreign"
			foreignID  = "cprofile-writes-foreign"
		)
		frontierWritesSeedProfile(t, h.db, foreignID, "org-writes-foreign-owner", "Foreign", "foreign.example.com",
			"layered", `{"keywords":[]}`)
		foreignProfileID := foreignID
		_, err := h.writes.CreateFrontierRun(h.ctx, requestOrg, actorID, createRunInput{
			SeedURL:   "https://foreign.example.com/",
			ProfileID: &foreignProfileID,
		})
		frontierWritesStatusError(t, err, http.StatusNotFound, "Crawl site profile not found")
		if count := frontierWritesCount(t, h.ctx, h.db,
			"SELECT COUNT(*) FROM CrawlTask WHERE orgId = ?", requestOrg); count != 0 {
			t.Fatalf("failed create left %d CrawlTask rows, want 0", count)
		}
		if count := frontierWritesCount(t, h.ctx, h.db,
			"SELECT COUNT(*) FROM CrawlFrontierRun WHERE orgId = ?", requestOrg); count != 0 {
			t.Fatalf("failed create left %d CrawlFrontierRun rows, want 0", count)
		}
	})
	t.Run("unmatched seed URL is a 400", func(t *testing.T) {
		const (
			requestOrg = "org-writes-no-profile"
			actorID    = "user-writes-no-profile"
		)
		_, err := h.writes.CreateFrontierRun(h.ctx, requestOrg, actorID, createRunInput{
			SeedURL: "https://unmatched.example.com/",
		})
		frontierWritesStatusError(t, err, http.StatusBadRequest,
			"No active crawl site profile matches the provided seed URL")
		if count := frontierWritesCount(t, h.ctx, h.db,
			"SELECT COUNT(*) FROM CrawlTask WHERE orgId = ?", requestOrg); count != 0 {
			t.Fatalf("failed create left %d CrawlTask rows, want 0", count)
		}
	})
}

// ---------------------------------------------------------------------------
// retryNode

// TestFrontierWritesIntegrationRetryNode covers POST /nodes/:id/retry: the node
// requeue, the metadata merge, the run and workflow-run resets, the workflow
// event and the queue job.
func TestFrontierWritesIntegrationRetryNode(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID        = "org-retry-node"
		runID        = "crun-retry-node"
		nodeID       = "cnode-retry-node"
		taskID       = "ctask-retry-node"
		workflowID   = "cworkflow-retry-node"
		priorEventID = "cevent-retry-node-prior"
	)
	finishedAt := frontierWritesNow().Add(-time.Minute)
	runWorkflowID := workflowID
	runTaskID := taskID
	lastError := "upstream 502"
	rejectionReason := "http_error"
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runID, OrgID: orgID, WorkflowRunID: &runWorkflowID, CrawlTaskID: &runTaskID,
		SeedURL: "https://example.com/seed", Status: string(RunStatusFailed),
		FinishedAt: &finishedAt, Metadata: `{"existingRunKey":"keep"}`,
	})
	priorMetadata, err := json.Marshal(map[string]any{
		"keepMe":              "yes",
		"failureKind":         "network",
		"warningFlags":        []string{"stale"},
		"pendingLlmJudgeJobs": 2,
	})
	if err != nil {
		t.Fatalf("marshal node metadata: %v", err)
	}
	frontierWritesSeedNode(t, h.db, frontierWritesNodeSeed{
		ID: nodeID, RunID: runID, OrgID: orgID, URL: "https://example.com/article",
		PageType: "article", QueueClass: "hot", Status: string(NodeStatusFailed), Depth: 1,
		LastError: &lastError, RejectionReason: &rejectionReason, Metadata: string(priorMetadata),
	})
	frontierWritesSeedWorkflowRun(t, h.db, workflowID, orgID, string(RunStatusFailed), &finishedAt)
	frontierWritesSeedEvent(t, h.db, priorEventID, workflowID, nodeID, "frontier_node_failed", 1)

	detail, err := h.writes.RetryNode(h.ctx, orgID, nodeID)
	if err != nil {
		t.Fatalf("RetryNode: %v", err)
	}
	if detail.ID != runID || detail.Status != RunStatusQueued {
		t.Fatalf("RetryNode detail = {%q %q}, want {%q queued}", detail.ID, detail.Status, runID)
	}
	if detail.FinishedAt != nil {
		t.Fatalf("RetryNode detail finishedAt = %v, want nil", detail.FinishedAt)
	}
	if len(detail.Nodes) != 1 || detail.Nodes[0].Status != NodeStatusQueued {
		t.Fatalf("RetryNode detail nodes = %+v, want the requeued node", detail.Nodes)
	}

	// ---- node row
	var (
		nodeStatus, nodeQueueClass   string
		nodeLastError, nodeRejection sql.NullString
		nodeQueuedAt                 sql.NullTime
		nodeMetadataRaw              []byte
	)
	if err := h.db.QueryRowContext(h.ctx, `
SELECT status, queueClass, lastError, rejectionReason, queuedAt, metadata
FROM CrawlFrontierNode WHERE id = ?`, nodeID).Scan(
		&nodeStatus, &nodeQueueClass, &nodeLastError, &nodeRejection, &nodeQueuedAt, &nodeMetadataRaw,
	); err != nil {
		t.Fatalf("read CrawlFrontierNode: %v", err)
	}
	if nodeStatus != string(NodeStatusQueued) {
		t.Fatalf("node status = %q, want queued", nodeStatus)
	}
	if nodeQueueClass != "hot" {
		t.Fatalf("node queueClass = %q, want the stored hot class", nodeQueueClass)
	}
	if nodeLastError.Valid || nodeRejection.Valid {
		t.Fatalf("node lastError/rejectionReason = %v/%v, want NULL/NULL", nodeLastError, nodeRejection)
	}
	if !nodeQueuedAt.Valid {
		t.Fatal("node queuedAt is NULL, want the requeue timestamp")
	}
	var metadataKeys map[string]json.RawMessage
	if err := json.Unmarshal(nodeMetadataRaw, &metadataKeys); err != nil {
		t.Fatalf("decode node metadata: %v", err)
	}
	if got, ok := metadataKeys["keepMe"]; !ok || string(got) != `"yes"` {
		t.Fatalf("node metadata keepMe = %s, want the pre-existing \"yes\" (metadata=%s)", got, nodeMetadataRaw)
	}
	failureKind, ok := metadataKeys["failureKind"]
	if !ok || string(failureKind) != "null" {
		t.Fatalf("node metadata failureKind = %s (present=%t), want an explicit null", failureKind, ok)
	}
	var warningFlags []string
	if err := json.Unmarshal(metadataKeys["warningFlags"], &warningFlags); err != nil {
		t.Fatalf("decode warningFlags: %v", err)
	}
	if len(warningFlags) != 0 {
		t.Fatalf("node metadata warningFlags = %v, want []", warningFlags)
	}
	var retryQueuedAt string
	if err := json.Unmarshal(metadataKeys["retryQueuedAt"], &retryQueuedAt); err != nil {
		t.Fatalf("decode retryQueuedAt: %v", err)
	}
	if strings.TrimSpace(retryQueuedAt) == "" {
		t.Fatal("node metadata retryQueuedAt is empty")
	}
	if got, ok := metadataKeys["pendingLlmJudgeJobs"]; !ok || string(got) != "2" {
		t.Fatalf("node metadata pendingLlmJudgeJobs = %s, want the pre-existing 2", got)
	}

	// ---- run row
	var runStatusValue string
	var runFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlFrontierRun WHERE id = ?", runID).Scan(&runStatusValue, &runFinishedAt); err != nil {
		t.Fatalf("read CrawlFrontierRun: %v", err)
	}
	if runStatusValue != string(RunStatusQueued) || runFinishedAt.Valid {
		t.Fatalf("run = {%q %v}, want {queued NULL}", runStatusValue, runFinishedAt)
	}

	// ---- workflow run row
	var workflowStatusValue string
	var workflowFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlStrategyWorkflowRun WHERE id = ?", workflowID).
		Scan(&workflowStatusValue, &workflowFinishedAt); err != nil {
		t.Fatalf("read CrawlStrategyWorkflowRun: %v", err)
	}
	if workflowStatusValue != string(RunStatusQueued) || workflowFinishedAt.Valid {
		t.Fatalf("workflow run = {%q %v}, want {queued NULL}", workflowStatusValue, workflowFinishedAt)
	}

	// ---- frontier_node_requeued event (sequence = existing count + 1)
	eventRows, err := h.db.QueryContext(h.ctx, `
SELECT sequence, level, eventType, nodeId, nodeType, message, triggerReason,
       beforeCount, afterCount, rescuedCount, details
FROM CrawlStrategyWorkflowRunEvent WHERE runId = ? ORDER BY sequence ASC`, workflowID)
	if err != nil {
		t.Fatalf("read CrawlStrategyWorkflowRunEvent: %v", err)
	}
	defer eventRows.Close()
	type frontierWritesEventRow struct {
		Sequence      int
		Level         string
		EventType     string
		NodeID        sql.NullString
		NodeType      sql.NullString
		Message       string
		TriggerReason sql.NullString
		BeforeCount   sql.NullInt64
		AfterCount    sql.NullInt64
		RescuedCount  sql.NullInt64
		Details       []byte
	}
	events := []frontierWritesEventRow{}
	for eventRows.Next() {
		var row frontierWritesEventRow
		if err := eventRows.Scan(&row.Sequence, &row.Level, &row.EventType, &row.NodeID, &row.NodeType,
			&row.Message, &row.TriggerReason, &row.BeforeCount, &row.AfterCount, &row.RescuedCount,
			&row.Details); err != nil {
			t.Fatalf("scan event: %v", err)
		}
		events = append(events, row)
	}
	if err := eventRows.Err(); err != nil {
		t.Fatalf("read events: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("workflow run has %d events, want the seeded one plus frontier_node_requeued", len(events))
	}
	requeued := events[1]
	if requeued.Sequence != 2 {
		t.Fatalf("requeue event sequence = %d, want 2 (existing count + 1)", requeued.Sequence)
	}
	if requeued.Level != "info" || requeued.EventType != "frontier_node_requeued" {
		t.Fatalf("requeue event level/type = %q/%q, want info/frontier_node_requeued",
			requeued.Level, requeued.EventType)
	}
	if !requeued.NodeID.Valid || requeued.NodeID.String != nodeID {
		t.Fatalf("requeue event nodeId = %v, want %q", requeued.NodeID, nodeID)
	}
	if !requeued.NodeType.Valid || requeued.NodeType.String != "legacy.frontier_node" {
		t.Fatalf("requeue event nodeType = %v, want legacy.frontier_node", requeued.NodeType)
	}
	if requeued.Message != "Frontier node was requeued for another execution attempt" {
		t.Fatalf("requeue event message = %q", requeued.Message)
	}
	if !requeued.TriggerReason.Valid || requeued.TriggerReason.String != "manual_retry" {
		t.Fatalf("requeue event triggerReason = %v, want manual_retry", requeued.TriggerReason)
	}
	if !requeued.BeforeCount.Valid || requeued.BeforeCount.Int64 != 1 ||
		!requeued.AfterCount.Valid || requeued.AfterCount.Int64 != 1 ||
		!requeued.RescuedCount.Valid || requeued.RescuedCount.Int64 != 1 {
		t.Fatalf("requeue event counts = %v/%v/%v, want 1/1/1",
			requeued.BeforeCount, requeued.AfterCount, requeued.RescuedCount)
	}
	eventDetails := frontierWritesDecodeJSON(t, requeued.Details)
	if got := frontierWritesJSONString(t, eventDetails, "queueClass"); got != "hot" {
		t.Fatalf("requeue event details.queueClass = %q, want hot", got)
	}

	// ---- one job on the node's stored queue class
	frontierWritesAssertSingleJob(t, h.redis, crawlqueue.QueueHot, nodeID, crawlqueue.PriorityClassHot,
		orgID, taskID, runID)
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueNormal); len(jobs) != 0 {
		t.Fatalf("crawl4ai-normal holds %d jobs, want 0: %+v", len(jobs), jobs)
	}
}

// ---------------------------------------------------------------------------
// retryNodes

// TestFrontierWritesIntegrationRetryNodes covers POST /nodes/retry: tenant and
// existence filtering, the missing-crawlTaskId skip, id ordering and the runIds
// first-appearance order.
func TestFrontierWritesIntegrationRetryNodes(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID      = "org-retry-nodes"
		otherOrgID = "org-retry-nodes-other"
		runOneID   = "crun-retry-nodes-1"
		runTwoID   = "crun-retry-nodes-2"
		runNoTask  = "crun-retry-nodes-no-task"
		runOtherID = "crun-retry-nodes-other"
		taskOneID  = "ctask-retry-nodes-1"
		taskTwoID  = "ctask-retry-nodes-2"
	)
	runOneTask := taskOneID
	runTwoTask := taskTwoID
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runOneID, OrgID: orgID, CrawlTaskID: &runOneTask,
		SeedURL: "https://example.com/one", Status: string(RunStatusFailed),
	})
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runTwoID, OrgID: orgID, CrawlTaskID: &runTwoTask,
		SeedURL: "https://example.com/two", Status: string(RunStatusFailed),
	})
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runNoTask, OrgID: orgID, CrawlTaskID: nil,
		SeedURL: "https://example.com/no-task", Status: string(RunStatusFailed),
	})
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runOtherID, OrgID: otherOrgID, CrawlTaskID: &runOneTask,
		SeedURL: "https://example.com/other", Status: string(RunStatusFailed),
	})
	for _, seed := range []frontierWritesNodeSeed{
		{ID: "cnode-retry-nodes-a", RunID: runOneID, OrgID: orgID, QueueClass: "normal", Status: string(NodeStatusFailed)},
		{ID: "cnode-retry-nodes-b", RunID: runOneID, OrgID: orgID, QueueClass: "normal", Status: string(NodeStatusFailed)},
		{ID: "cnode-retry-nodes-c", RunID: runNoTask, OrgID: orgID, QueueClass: "normal", Status: string(NodeStatusFailed)},
		{ID: "cnode-retry-nodes-d", RunID: runTwoID, OrgID: orgID, QueueClass: "normal", Status: string(NodeStatusFailed)},
		{ID: "cnode-retry-nodes-z", RunID: runOtherID, OrgID: otherOrgID, QueueClass: "normal", Status: string(NodeStatusFailed)},
	} {
		frontierWritesSeedNode(t, h.db, seed)
	}

	result, err := h.writes.RetryNodes(h.ctx, orgID, []string{
		"cnode-retry-nodes-z", "cnode-retry-nodes-c", "cnode-retry-nodes-b",
		"cnode-retry-nodes-missing", "cnode-retry-nodes-d", "cnode-retry-nodes-a",
	})
	if err != nil {
		t.Fatalf("RetryNodes: %v", err)
	}
	wantRetried := []string{"cnode-retry-nodes-a", "cnode-retry-nodes-b", "cnode-retry-nodes-d"}
	if !reflect.DeepEqual(result.RetriedIDs, wantRetried) {
		t.Fatalf("RetriedIDs = %v, want ascending ids %v", result.RetriedIDs, wantRetried)
	}
	if result.RetriedCount != 3 {
		t.Fatalf("RetriedCount = %d, want 3", result.RetriedCount)
	}
	// The foreign node and the unknown id come back from neither query, so they
	// are in neither list; the node whose run has no crawlTaskId is skipped.
	if !reflect.DeepEqual(result.SkippedIDs, []string{"cnode-retry-nodes-c"}) {
		t.Fatalf("SkippedIDs = %v, want [cnode-retry-nodes-c]", result.SkippedIDs)
	}
	if result.SkippedCount != 1 {
		t.Fatalf("SkippedCount = %d, want 1", result.SkippedCount)
	}
	if !reflect.DeepEqual(result.RunIDs, []string{runOneID, runTwoID}) {
		t.Fatalf("RunIDs = %v, want first-appearance order %v", result.RunIDs, []string{runOneID, runTwoID})
	}

	statusByNode := map[string]string{}
	nodeRows, err := h.db.QueryContext(h.ctx,
		"SELECT id, status FROM CrawlFrontierNode WHERE id IN (?, ?, ?, ?, ?)", "cnode-retry-nodes-a",
		"cnode-retry-nodes-b", "cnode-retry-nodes-c", "cnode-retry-nodes-d", "cnode-retry-nodes-z")
	if err != nil {
		t.Fatalf("read nodes: %v", err)
	}
	defer nodeRows.Close()
	for nodeRows.Next() {
		var id, status string
		if err := nodeRows.Scan(&id, &status); err != nil {
			t.Fatalf("scan node: %v", err)
		}
		statusByNode[id] = status
	}
	if err := nodeRows.Err(); err != nil {
		t.Fatalf("read nodes: %v", err)
	}
	for _, id := range []string{"cnode-retry-nodes-a", "cnode-retry-nodes-b", "cnode-retry-nodes-d"} {
		if statusByNode[id] != string(NodeStatusQueued) {
			t.Fatalf("node %s status = %q, want queued", id, statusByNode[id])
		}
	}
	if statusByNode["cnode-retry-nodes-c"] != string(NodeStatusFailed) {
		t.Fatalf("skipped node status = %q, want the unchanged failed", statusByNode["cnode-retry-nodes-c"])
	}
	if statusByNode["cnode-retry-nodes-z"] != string(NodeStatusFailed) {
		t.Fatalf("foreign node status = %q, want the unchanged failed", statusByNode["cnode-retry-nodes-z"])
	}

	jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueNormal)
	if len(jobs) != 3 {
		t.Fatalf("crawl4ai-normal holds %d jobs, want one per retried node: %+v", len(jobs), jobs)
	}
	jobsByNode := map[string]frontierWritesJob{}
	for _, job := range jobs {
		nodeID, _ := job.Data["frontierNodeId"].(string)
		jobsByNode[nodeID] = job
		frontierWritesAssertJobID(t, job.ID, nodeID, crawlqueue.PriorityClassNormal)
	}
	if _, ok := jobsByNode["cnode-retry-nodes-a"]; !ok {
		t.Fatalf("no job for node a: %+v", jobs)
	}
	if _, ok := jobsByNode["cnode-retry-nodes-b"]; !ok {
		t.Fatalf("no job for node b: %+v", jobs)
	}
	if job, ok := jobsByNode["cnode-retry-nodes-d"]; !ok {
		t.Fatalf("no job for node d: %+v", jobs)
	} else {
		frontierWritesAssertJobData(t, job.Data, orgID, taskTwoID, runTwoID, "cnode-retry-nodes-d", "normal")
	}
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueHot); len(jobs) != 0 {
		t.Fatalf("crawl4ai-hot holds %d jobs, want 0: %+v", len(jobs), jobs)
	}
}

// ---------------------------------------------------------------------------
// B4: canceled runs are refused, completed runs stay retryable

// TestFrontierWritesIntegrationRetryTerminalRun is the B4 contract: a node of a
// canceled run is refused with 409 by the single route, reported as skipped by
// the bulk route, and the run and node stay untouched.
func TestFrontierWritesIntegrationRetryTerminalRun(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID      = "org-retry-terminal"
		runID      = "crun-retry-terminal"
		nodeID     = "cnode-retry-terminal"
		taskID     = "ctask-retry-terminal"
		workflowID = "cworkflow-retry-terminal"
	)
	finishedAt := frontierWritesNow().Add(-time.Minute)
	runWorkflowID := workflowID
	runTaskID := taskID
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runID, OrgID: orgID, WorkflowRunID: &runWorkflowID, CrawlTaskID: &runTaskID,
		SeedURL: "https://example.com/seed", Status: string(RunStatusCanceled), FinishedAt: &finishedAt,
	})
	// The run references a workflow run, so the row has to exist: the assertion
	// below proves the refused retry left it untouched rather than that it is
	// missing.
	frontierWritesSeedWorkflowRun(t, h.db, workflowID, orgID, string(RunStatusCanceled), &finishedAt)
	frontierWritesSeedNode(t, h.db, frontierWritesNodeSeed{
		ID: nodeID, RunID: runID, OrgID: orgID, PageType: "article", QueueClass: "normal",
		Status: string(NodeStatusFailed), Depth: 1,
	})

	_, err := h.writes.RetryNode(h.ctx, orgID, nodeID)
	frontierWritesStatusError(t, err, http.StatusConflict,
		"Crawl frontier run is canceled and cannot be retried")

	// The refused single retry must not change the run, the node, the workflow
	// run or the event log, and must not enqueue anything.
	frontierWritesAssertTerminalState(t, h, runID, nodeID, workflowID)

	result, err := h.writes.RetryNodes(h.ctx, orgID, []string{nodeID})
	if err != nil {
		t.Fatalf("RetryNodes: %v", err)
	}
	if len(result.RetriedIDs) != 0 || result.RetriedCount != 0 {
		t.Fatalf("RetryNodes retried a terminal run: %+v", result)
	}
	if !reflect.DeepEqual(result.SkippedIDs, []string{nodeID}) || result.SkippedCount != 1 {
		t.Fatalf("RetryNodes skipped = %v (count %d), want [%s]", result.SkippedIDs, result.SkippedCount, nodeID)
	}
	frontierWritesAssertTerminalState(t, h, runID, nodeID, workflowID)
}

// TestFrontierWritesIntegrationRetryCompletedRun is the other half of the retry
// guard: a completed run is NOT terminal for retries. refreshRunStatus completes
// a run as soon as one page succeeded, so a completed run routinely still owns
// failed nodes, and the admin console offers Retry on those nodes regardless of
// the run status. The retry must therefore requeue the node, rewind the run and
// its workflow run to queued, and enqueue exactly one job.
func TestFrontierWritesIntegrationRetryCompletedRun(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID      = "org-retry-completed"
		runID      = "crun-retry-completed"
		nodeID     = "cnode-retry-completed"
		taskID     = "ctask-retry-completed"
		workflowID = "cworkflow-retry-completed"
	)
	finishedAt := frontierWritesNow().Add(-time.Minute)
	runWorkflowID := workflowID
	runTaskID := taskID
	frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
		ID: runID, OrgID: orgID, WorkflowRunID: &runWorkflowID, CrawlTaskID: &runTaskID,
		SeedURL: "https://example.com/seed", Status: string(RunStatusCompleted), FinishedAt: &finishedAt,
	})
	frontierWritesSeedWorkflowRun(t, h.db, workflowID, orgID, string(RunStatusCompleted), &finishedAt)
	frontierWritesSeedNode(t, h.db, frontierWritesNodeSeed{
		ID: nodeID, RunID: runID, OrgID: orgID, PageType: "article", QueueClass: "normal",
		Status: string(NodeStatusFailed), Depth: 1,
	})

	detail, err := h.writes.RetryNode(h.ctx, orgID, nodeID)
	if err != nil {
		t.Fatalf("RetryNode on a completed run: %v", err)
	}
	if detail.ID != runID {
		t.Fatalf("returned run detail id = %q, want %q", detail.ID, runID)
	}
	if detail.Status != RunStatusQueued || detail.FinishedAt != nil {
		t.Fatalf("returned run = {%q %v}, want the requeued run without finishedAt", detail.Status, detail.FinishedAt)
	}

	var runStatusValue string
	var runFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlFrontierRun WHERE id = ?", runID).
		Scan(&runStatusValue, &runFinishedAt); err != nil {
		t.Fatalf("read CrawlFrontierRun: %v", err)
	}
	if runStatusValue != string(RunStatusQueued) || runFinishedAt.Valid {
		t.Fatalf("completed run = {%q %v}, want {queued NULL}", runStatusValue, runFinishedAt)
	}
	var nodeStatus string
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status FROM CrawlFrontierNode WHERE id = ?", nodeID).Scan(&nodeStatus); err != nil {
		t.Fatalf("read CrawlFrontierNode: %v", err)
	}
	if nodeStatus != string(NodeStatusQueued) {
		t.Fatalf("node status = %q, want queued", nodeStatus)
	}
	var workflowStatus string
	var workflowFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlStrategyWorkflowRun WHERE id = ?", workflowID).
		Scan(&workflowStatus, &workflowFinishedAt); err != nil {
		t.Fatalf("read CrawlStrategyWorkflowRun: %v", err)
	}
	if workflowStatus != string(RunStatusQueued) || workflowFinishedAt.Valid {
		t.Fatalf("workflow run = {%q %v}, want {queued NULL}", workflowStatus, workflowFinishedAt)
	}
	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ? AND eventType = 'frontier_node_requeued'",
		workflowID); count != 1 {
		t.Fatalf("frontier_node_requeued events = %d, want 1", count)
	}
	frontierWritesAssertSingleJob(t, h.redis, crawlqueue.QueueNormal, nodeID,
		crawlqueue.PriorityClassNormal, orgID, taskID, runID)
}

// frontierWritesAssertTerminalState asserts the canceled run and its failed node
// are unchanged and no job was queued.
func frontierWritesAssertTerminalState(t *testing.T, h *frontierWritesHarness, runID, nodeID, workflowID string) {
	t.Helper()
	var runStatusValue string
	var runFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlFrontierRun WHERE id = ?", runID).Scan(&runStatusValue, &runFinishedAt); err != nil {
		t.Fatalf("read CrawlFrontierRun: %v", err)
	}
	if runStatusValue != string(RunStatusCanceled) || !runFinishedAt.Valid {
		t.Fatalf("canceled run = {%q %v}, want {canceled <set>}", runStatusValue, runFinishedAt)
	}
	var nodeStatus string
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status FROM CrawlFrontierNode WHERE id = ?", nodeID).Scan(&nodeStatus); err != nil {
		t.Fatalf("read CrawlFrontierNode: %v", err)
	}
	if nodeStatus != string(NodeStatusFailed) {
		t.Fatalf("node status = %q, want the unchanged failed", nodeStatus)
	}
	var workflowStatus string
	var workflowFinishedAt sql.NullTime
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT status, finishedAt FROM CrawlStrategyWorkflowRun WHERE id = ?", workflowID).
		Scan(&workflowStatus, &workflowFinishedAt); err != nil {
		t.Fatalf("read CrawlStrategyWorkflowRun: %v", err)
	}
	if workflowStatus != string(RunStatusCanceled) || !workflowFinishedAt.Valid {
		t.Fatalf("workflow run = {%q %v}, want unchanged {canceled <set>}", workflowStatus, workflowFinishedAt)
	}
	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE runId = ?", workflowID); count != 0 {
		t.Fatalf("terminal retry appended %d workflow events, want 0", count)
	}
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueNormal); len(jobs) != 0 {
		t.Fatalf("terminal retry enqueued %d normal jobs, want 0", len(jobs))
	}
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueHot); len(jobs) != 0 {
		t.Fatalf("terminal retry enqueued %d hot jobs, want 0", len(jobs))
	}
}

// ---------------------------------------------------------------------------
// B2: concurrent metadata writes

// TestFrontierWritesIntegrationRetryMetadataMerge is the B2 contract: requeueNode
// merges its patch into the metadata document it reads under the node row lock,
// and UpdateNodeMetadataLocked takes the same lock, so a concurrent worker-only
// key (workerHeartbeat) and the three retry keys (failureKind:null,
// warningFlags:[], retryQueuedAt) always both survive.
//
// Determinism: whichever transaction takes the row lock second reads the first
// writer's committed document and merges on top of it, so the assertion is not a
// lucky interleaving; the loop only exercises both possible orders.
//
// Scope: both writers take the node row lock (requeueNode inside its own
// transaction, the worker through crawlfrontierllm.UpdateNodeMetadataLocked, whose
// implementation is the same row-locked merge the package's unlocked-looking
// helper uses), so the merge is serialised rather than merely ordered.
func TestFrontierWritesIntegrationRetryMetadataMerge(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const orgID = "org-retry-metadata"
	for iteration := 0; iteration < 3; iteration++ {
		suffix := strconv.Itoa(iteration)
		runID := "crun-retry-metadata-" + suffix
		nodeID := "cnode-retry-metadata-" + suffix
		taskID := "ctask-retry-metadata-" + suffix
		runTaskID := taskID
		frontierWritesSeedRun(t, h.db, frontierWritesRunSeed{
			ID: runID, OrgID: orgID, CrawlTaskID: &runTaskID,
			SeedURL: "https://example.com/metadata", Status: string(RunStatusFailed),
		})
		seedMetadata, err := json.Marshal(map[string]any{
			"workerBase":  "kept",
			"failureKind": "network",
		})
		if err != nil {
			t.Fatalf("marshal node metadata: %v", err)
		}
		frontierWritesSeedNode(t, h.db, frontierWritesNodeSeed{
			ID: nodeID, RunID: runID, OrgID: orgID, PageType: "article", QueueClass: "normal",
			Status: string(NodeStatusFailed), Depth: 1, Metadata: string(seedMetadata),
		})

		heartbeat := crawlfrontierllm.NewObject()
		heartbeat.SetString("workerHeartbeat", "2026-01-01T00:00:00.000Z")
		start := make(chan struct{})
		var wait sync.WaitGroup
		wait.Add(2)
		var retryErr error
		var metadataErr error
		go func() {
			defer wait.Done()
			<-start
			_, retryErr = h.writes.RetryNode(h.ctx, orgID, nodeID)
		}()
		go func() {
			defer wait.Done()
			<-start
			metadataErr = h.frontier.UpdateNodeMetadataLocked(h.ctx, nodeID, heartbeat)
		}()
		close(start)
		wait.Wait()
		if retryErr != nil {
			t.Fatalf("iteration %d: RetryNode: %v", iteration, retryErr)
		}
		if metadataErr != nil {
			t.Fatalf("iteration %d: UpdateNodeMetadataLocked: %v", iteration, metadataErr)
		}

		var metadataRaw []byte
		if err := h.db.QueryRowContext(h.ctx,
			"SELECT metadata FROM CrawlFrontierNode WHERE id = ?", nodeID).Scan(&metadataRaw); err != nil {
			t.Fatalf("iteration %d: read metadata: %v", iteration, err)
		}
		var metadata map[string]json.RawMessage
		if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
			t.Fatalf("iteration %d: decode metadata: %v", iteration, err)
		}
		if got, ok := metadata["workerHeartbeat"]; !ok || string(got) != `"2026-01-01T00:00:00.000Z"` {
			t.Fatalf("iteration %d: metadata workerHeartbeat = %s, want the concurrent writer's key (metadata=%s)",
				iteration, got, metadataRaw)
		}
		if got, ok := metadata["retryQueuedAt"]; !ok || len(got) == 0 {
			t.Fatalf("iteration %d: metadata retryQueuedAt = %s, want the retry key (metadata=%s)",
				iteration, got, metadataRaw)
		}
		if got, ok := metadata["failureKind"]; !ok || string(got) != "null" {
			t.Fatalf("iteration %d: metadata failureKind = %s, want null (metadata=%s)", iteration, got, metadataRaw)
		}
		if got, ok := metadata["warningFlags"]; !ok || string(got) != "[]" {
			t.Fatalf("iteration %d: metadata warningFlags = %s, want [] (metadata=%s)", iteration, got, metadataRaw)
		}
		if got, ok := metadata["workerBase"]; !ok || string(got) != `"kept"` {
			t.Fatalf("iteration %d: metadata workerBase = %s, want the pre-existing \"kept\" (metadata=%s)",
				iteration, got, metadataRaw)
		}
	}
}

// ---------------------------------------------------------------------------
// B3: failed run creation cleanup

// TestFrontierWritesIntegrationFailedCreationCleanup is the B3 contract: a run
// creation that fails after the synthetic CrawlTask insert leaves no
// config.frontier task behind.
//
// The table CrawlFrontierRun is dropped for this test, which makes the
// crawlTaskId-bearing CrawlFrontierRun INSERT (the step right after the
// CrawlTask insert) fail with MySQL error 1146. The cleanup then logs a failed
// DELETE for the missing run table; that log line is expected and not asserted
// here.
func TestFrontierWritesIntegrationFailedCreationCleanup(t *testing.T) {
	h := frontierWritesNewHarness(t)
	const (
		orgID     = "org-writes-cleanup"
		actorID   = "user-writes-cleanup"
		profileID = "cprofile-writes-cleanup"
	)
	frontierWritesSeedProfile(t, h.db, profileID, orgID, "Cleanup Example", "cleanup.example.com",
		"layered", `{"keywords":[]}`)

	if _, err := h.db.Exec("DROP TABLE IF EXISTS CrawlFrontierRun"); err != nil {
		t.Fatalf("drop CrawlFrontierRun: %v", err)
	}
	defer func() {
		// Leave the harness usable for a later test in the same database.
		if _, err := h.db.Exec(frontierWritesCrawlFrontierRunTable); err != nil {
			t.Logf("restore CrawlFrontierRun: %v", err)
		}
	}()

	inputProfileID := profileID
	_, err := h.writes.CreateFrontierRun(h.ctx, orgID, actorID, createRunInput{
		SeedURL:   "https://cleanup.example.com/seed",
		ProfileID: &inputProfileID,
	})
	if err == nil {
		t.Fatal("CreateFrontierRun succeeded although the CrawlFrontierRun INSERT must fail")
	}

	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlTask WHERE orgId = ?", orgID); count != 0 {
		t.Fatalf("failed create left %d CrawlTask rows for the org, want 0", count)
	}
	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlTask WHERE orgId = ? AND config->>'$.frontier' = 'true'", orgID); count != 0 {
		t.Fatalf("failed create left %d synthetic config.frontier CrawlTask rows, want 0", count)
	}
	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlStrategyWorkflowRun WHERE orgId = ?", orgID); count != 0 {
		t.Fatalf("failed create left %d CrawlStrategyWorkflowRun rows, want 0", count)
	}
	if count := frontierWritesCount(t, h.ctx, h.db,
		"SELECT COUNT(*) FROM CrawlFrontierNode WHERE orgId = ?", orgID); count != 0 {
		t.Fatalf("failed create left %d CrawlFrontierNode rows, want 0", count)
	}
	if jobs := frontierWritesReadJobs(t, h.redis, crawlqueue.QueueHot); len(jobs) != 0 {
		t.Fatalf("failed create enqueued %d hot jobs, want 0", len(jobs))
	}
}
