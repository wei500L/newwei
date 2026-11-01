//go:build integration

package crawlfrontiernode

// integration_test.go exercises the Frontier node execution chain against the
// real MySQL 8.4, Redis 7.2 and Mongo 7.0 services of the api-go integration CI
// job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// The fixtures recreate only the tables this chain writes (CrawlFrontierRun,
// CrawlFrontierNode, the CrawlStrategyWorkflowRun family and CrawlSiteProfile)
// and create-if-missing the shared CrawlTask/CrawlResult tables, whose rows are
// scoped to the `task-frontier-node%` id prefix this package owns. crawl4ai is a
// local httptest server, so no test performs an outbound request; the sitemap
// branch is switched off with the profile's
// `seedDiscovery.strategy = "frontier_only"` instead of being stubbed, because
// internal/crawlmetadata has no injectable transport.
//
// What the fixtures do prove: the exact DB rows, BullMQ job structure and
// returned JSON the chain writes for each branch of processQueuedNode. They do
// not run a NestJS worker, they do not switch deployment ownership, and they do
// not compare against a golden NestJS execution.
//
// Every test is named with the TestFrontierNode prefix because the CI step runs
//
//	go test -tags=integration ./internal/crawlfrontiernode/ -run 'TestFrontierNode' -v -timeout 10m

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	testOrgID          = "org-frontier-node"
	testOtherOrgID     = "org-frontier-node-other"
	testTaskID         = "task-frontier-node-1"
	testRunID          = "run-frontier-node-1"
	testWorkflowRunID  = "wf-frontier-node-1"
	testProfileID      = "profile-frontier-node-1"
	testRootNodeID     = "node-frontier-node-root"
	testResultCollName = "crawlresultcontents"
)

// testClockTime is the pinned service clock. Every timestamp the chain writes
// (startedAt, crawledAt, fetchedAt, the summary's lastFetchedAt, the BullMQ job
// ids) is derived from it, so the expected JSON is byte-stable.
var testClockTime = time.Date(2025, 3, 4, 5, 6, 7, 500_000_000, time.UTC)

// testNodeHarness owns the MySQL/Redis/Mongo handles and the crawl4ai stub.
type testNodeHarness struct {
	t           *testing.T
	ctx         context.Context
	db          *sql.DB
	redis       *redis.Client
	mongoClient *mongo.Client
	mongoDB     *mongo.Database
	server      *httptest.Server
	requests    atomic.Int64
	// metadata, when set before calling service(), is the sitemap discovery
	// surface injected into the Service. The sitemap success scenario builds it
	// around a stub HTTP transport so robots/sitemap discovery runs for real
	// without leaving the process.
	metadata *crawlmetadata.Discovery
	// respond is the /crawl behaviour per target URL. It returns the HTTP status
	// and the raw body the stub writes back.
	respond func(targetURL string) (int, string)
}

func testNewNodeHarness(t *testing.T) *testNodeHarness {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set — integration test requires MySQL")
	}
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if redisAddr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set — integration test requires Redis")
	}
	mongoURI := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if mongoURI == "" {
		t.Skip("MONGO_URI is not set — integration test requires MongoDB")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr, Protocol: 2})
	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	mongoDatabase := mongoClient.Database("crawl_frontier_node_it_" + strconv.FormatInt(time.Now().UnixNano(), 36))

	h := &testNodeHarness{
		t:           t,
		ctx:         context.Background(),
		db:          db,
		redis:       redisClient,
		mongoClient: mongoClient,
		mongoDB:     mongoDatabase,
	}
	h.reset()
	t.Cleanup(func() {
		if h.server != nil {
			h.server.Close()
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = mongoDatabase.Drop(cleanupCtx)
		_ = mongoClient.Disconnect(cleanupCtx)
		_ = redisClient.Close()
		_ = db.Close()
	})
	return h
}

// reset rebuilds the Frontier tables. Only the tables this chain touches are
// dropped; CrawlTask, CrawlResult and SystemSetting are shared with the earlier
// integration steps, so they are created when missing and their rows are left
// to the scoped DELETE below.
func (h *testNodeHarness) reset() {
	h.t.Helper()
	for _, table := range []string{
		"CrawlStrategyWorkflowRunCandidateTrace", "CrawlStrategyWorkflowRunCandidate",
		"CrawlStrategyWorkflowRunEvent", "CrawlStrategyWorkflowRunStep", "CrawlStrategyWorkflowRun",
		"CrawlFrontierNode", "CrawlFrontierRun", "CrawlSiteProfileVersion", "CrawlSiteProfile",
	} {
		if _, err := h.db.Exec("DROP TABLE IF EXISTS " + table); err != nil {
			h.t.Fatalf("drop %s: %v", table, err)
		}
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS CrawlTask (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, createdById VARCHAR(191) NOT NULL,
			newsSourceId VARCHAR(191) NULL, targetUrl VARCHAR(1024) NOT NULL, displayName VARCHAR(191) NULL,
			status VARCHAR(32) NOT NULL, timeRangeFrom DATETIME(3) NULL, timeRangeTo DATETIME(3) NULL,
			concurrency INT NOT NULL DEFAULT 1, keywords JSON NULL, config JSON NULL,
			lastRunAt DATETIME(3) NULL, lastSuccessAt DATETIME(3) NULL, lastResultAt DATETIME(3) NULL,
			lastCursor VARCHAR(191) NULL, lastError TEXT NULL, runCount INT NOT NULL DEFAULT 0,
			lastServerMemoryMb DOUBLE NULL, lastPeakMemoryMb DOUBLE NULL, lastMemoryEfficiency DOUBLE NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS CrawlResult (
			id VARCHAR(191) PRIMARY KEY, taskId VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL DEFAULT '',
			sourceUrl TEXT NOT NULL, sourceUrlFingerprint VARCHAR(64) NULL, fetchedAt DATETIME(3) NOT NULL,
			markdownRef VARCHAR(191) NOT NULL DEFAULT '', contentHash VARCHAR(64) NOT NULL DEFAULT '',
			metadata JSON NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			KEY CrawlResult_task_fetched (taskId, fetchedAt),
			KEY CrawlResult_org_fetched (orgId, fetchedAt))`,
		`CREATE TABLE IF NOT EXISTS SystemSetting (
			` + "`key`" + ` VARCHAR(191) PRIMARY KEY, value JSON NULL, isPublic TINYINT NOT NULL DEFAULT 0,
			description TEXT NULL, createdAt DATETIME(3) NULL, updatedAt DATETIME(3) NULL,
			updatedById VARCHAR(191) NULL)`,
		`CREATE TABLE CrawlSiteProfile (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, name VARCHAR(191) NOT NULL,
			description TEXT NULL, matchHost VARCHAR(191) NOT NULL, isActive TINYINT NOT NULL,
			executionMode VARCHAR(32) NOT NULL, workflowId VARCHAR(191) NULL,
			workflowVersionId VARCHAR(191) NULL, workflowBindingMode VARCHAR(32) NOT NULL,
			version INT NOT NULL, config JSON NOT NULL, createdById VARCHAR(191) NOT NULL,
			updatedById VARCHAR(191) NULL, publishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlSiteProfileVersion (
			id VARCHAR(191) PRIMARY KEY, profileId VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL,
			version INT NOT NULL, name VARCHAR(191) NOT NULL, description TEXT NULL,
			matchHost VARCHAR(191) NOT NULL, isActive TINYINT NOT NULL, executionMode VARCHAR(32) NOT NULL,
			workflowId VARCHAR(191) NULL, workflowVersionId VARCHAR(191) NULL,
			workflowBindingMode VARCHAR(32) NOT NULL, config JSON NOT NULL,
			createdById VARCHAR(191) NOT NULL, createdAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlFrontierRun (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, profileId VARCHAR(191) NULL,
			workflowRunId VARCHAR(191) NULL, seedUrl TEXT NOT NULL, crawlTaskId VARCHAR(191) NULL,
			executionMode VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, maxDepth INT NOT NULL,
			maxPages INT NOT NULL, keywords JSON NULL, pageCount INT NOT NULL, nodeCount INT NOT NULL,
			articleCount INT NOT NULL, failedCount INT NOT NULL, duplicateCount INT NOT NULL,
			nativeRunId VARCHAR(191) NULL, lastError TEXT NULL, metadata JSON NULL,
			createdById VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlFrontierNode (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, parentNodeId VARCHAR(191) NULL,
			orgId VARCHAR(191) NOT NULL, url TEXT NOT NULL, canonicalUrl TEXT NULL,
			urlFingerprint VARCHAR(64) NULL, pageType VARCHAR(32) NOT NULL, depth INT NOT NULL,
			queueClass VARCHAR(32) NOT NULL, status VARCHAR(32) NOT NULL, score DOUBLE NULL,
			freshnessScore DOUBLE NULL, attempts INT NOT NULL DEFAULT 0, queuedAt DATETIME(3) NULL,
			crawledAt DATETIME(3) NULL, crawlResultId VARCHAR(191) NULL, rejectionReason VARCHAR(191) NULL,
			lastError TEXT NULL, metadata JSON NULL, discoveredAt DATETIME(3) NOT NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_fingerprint (runId, urlFingerprint))`,
		`CREATE TABLE CrawlStrategyWorkflowRun (
			id VARCHAR(191) PRIMARY KEY, orgId VARCHAR(191) NOT NULL, workflowId VARCHAR(191) NULL,
			workflowVersionId VARCHAR(191) NULL, workflowOrigin VARCHAR(32) NOT NULL,
			profileId VARCHAR(191) NULL, newsSourceId VARCHAR(191) NULL, status VARCHAR(32) NOT NULL,
			runKind VARCHAR(32) NOT NULL, input JSON NULL, output JSON NULL, graphSnapshot JSON NULL,
			stepResults JSON NULL, candidates JSON NULL, parameterSources JSON NULL, error TEXT NULL,
			stepCount INT NOT NULL, candidateCount INT NOT NULL, selectedCount INT NOT NULL,
			createdById VARCHAR(191) NOT NULL, startedAt DATETIME(3) NULL, finishedAt DATETIME(3) NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlStrategyWorkflowRunStep (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, stepKey VARCHAR(191) NOT NULL,
			sequence INT NOT NULL, workflowNodeId VARCHAR(191) NULL, nodeType VARCHAR(64) NOT NULL,
			label VARCHAR(191) NOT NULL, status VARCHAR(32) NOT NULL, startedAt DATETIME(3) NULL,
			finishedAt DATETIME(3) NULL, durationMs INT NULL, inputCount INT NOT NULL,
			outputCount INT NOT NULL, rejectedCount INT NOT NULL, sampleUrls JSON NULL,
			metrics JSON NULL, error TEXT NULL, metadata JSON NULL,
			createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_step (runId, stepKey))`,
		`CREATE TABLE CrawlStrategyWorkflowRunEvent (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, sequence INT NOT NULL,
			level VARCHAR(32) NOT NULL, eventType VARCHAR(64) NOT NULL, nodeId VARCHAR(191) NULL,
			nodeType VARCHAR(64) NULL, message TEXT NOT NULL, triggerReason VARCHAR(191) NULL,
			beforeCount INT NULL, afterCount INT NULL, rescuedCount INT NULL, details JSON NULL,
			createdAt DATETIME(3) NOT NULL)`,
		`CREATE TABLE CrawlStrategyWorkflowRunCandidate (
			id VARCHAR(191) PRIMARY KEY, runId VARCHAR(191) NOT NULL, candidateKey VARCHAR(191) NOT NULL,
			externalId VARCHAR(191) NULL, sourceNodeId VARCHAR(191) NULL, sourceNodeType VARCHAR(64) NULL,
			url TEXT NOT NULL, title VARCHAR(191) NULL, description TEXT NULL, author VARCHAR(191) NULL,
			pageType VARCHAR(32) NULL, relevanceScore DOUBLE NULL, score DOUBLE NULL,
			freshnessScore DOUBLE NULL, qualityScore DOUBLE NULL, publishedAt DATETIME(3) NULL,
			crawledAt DATETIME(3) NULL, effectiveAt DATETIME(3) NULL, status VARCHAR(32) NOT NULL,
			rejectedByNodeId VARCHAR(191) NULL, rejectedReason VARCHAR(191) NULL, metadata JSON NULL,
			traceCount INT NOT NULL, createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL,
			UNIQUE KEY run_candidate (runId, candidateKey))`,
		`CREATE TABLE CrawlStrategyWorkflowRunCandidateTrace (
			id VARCHAR(191) PRIMARY KEY, candidateId VARCHAR(191) NOT NULL, sequence INT NOT NULL,
			timestamp DATETIME(3) NOT NULL, nodeId VARCHAR(191) NOT NULL, nodeType VARCHAR(64) NOT NULL,
			action VARCHAR(32) NOT NULL, message TEXT NOT NULL, accepted TINYINT NULL,
			scoreDelta DOUBLE NULL, freshnessDelta DOUBLE NULL, ruleHits JSON NULL,
			beforeSnapshot JSON NULL, afterSnapshot JSON NULL, details JSON NULL)`,
	}
	for _, statement := range statements {
		if _, err := h.db.Exec(statement); err != nil {
			h.t.Fatalf("create table: %v\n%s", err, statement)
		}
	}
	// An earlier integration step may have created CrawlResult with only
	// id/taskId/sourceUrl/fetchedAt/metadata. CREATE TABLE IF NOT EXISTS then does
	// nothing, so the columns persistResults writes are added when missing. All of
	// them carry defaults, which keeps the earlier steps' narrower inserts valid.
	h.ensureCrawlResultColumns()
	if _, err := h.db.Exec("DELETE FROM CrawlTask WHERE id LIKE 'task-frontier-node%'"); err != nil {
		h.t.Fatalf("clear CrawlTask: %v", err)
	}
	if _, err := h.db.Exec("DELETE FROM CrawlResult WHERE taskId LIKE 'task-frontier-node%'"); err != nil {
		h.t.Fatalf("clear CrawlResult: %v", err)
	}
	if err := h.redis.FlushDB(h.ctx).Err(); err != nil {
		h.t.Fatalf("flush redis: %v", err)
	}
}

// ensureCrawlResultColumns adds the CrawlResult columns this chain writes when a
// previous integration step created the shared table without them.
func (h *testNodeHarness) ensureCrawlResultColumns() {
	h.t.Helper()
	for _, column := range []struct {
		name       string
		definition string
	}{
		{"orgId", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"sourceUrlFingerprint", "VARCHAR(64) NULL"},
		{"markdownRef", "VARCHAR(191) NOT NULL DEFAULT ''"},
		{"contentHash", "VARCHAR(64) NOT NULL DEFAULT ''"},
		{"metadata", "JSON NULL"},
		{"createdAt", "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)"},
	} {
		var present int
		if err := h.db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns
			WHERE table_schema = DATABASE() AND table_name = 'CrawlResult' AND column_name = ?`,
			column.name).Scan(&present); err != nil {
			h.t.Fatalf("inspect CrawlResult.%s: %v", column.name, err)
		}
		if present > 0 {
			continue
		}
		if _, err := h.db.Exec("ALTER TABLE CrawlResult ADD COLUMN `" + column.name + "` " + column.definition); err != nil {
			h.t.Fatalf("add CrawlResult.%s: %v", column.name, err)
		}
	}
}

// startCrawl4ai starts the local crawl4ai stub. `/health` answers 200 so the
// client's health probe succeeds without leaving the process.
func (h *testNodeHarness) startCrawl4ai(respond func(targetURL string) (int, string)) {
	h.t.Helper()
	h.respond = respond
	h.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/health":
			writer.Header().Set("content-type", "application/json")
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		case "/crawl":
			body, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
			if err != nil {
				http.Error(writer, "read body", http.StatusBadRequest)
				return
			}
			h.requests.Add(1)
			status, payload := h.respond(testCrawlTarget(body))
			writer.Header().Set("content-type", "application/json")
			writer.WriteHeader(status)
			_, _ = writer.Write([]byte(payload))
		default:
			http.NotFound(writer, request)
		}
	}))
}

// service builds one crawlfrontiernode Service. A test that needs two
// concurrent workers builds two, so the per-instance client state (the health
// check cache) cannot couple them.
func (h *testNodeHarness) service() *Service {
	h.t.Helper()
	client := crawl4ai.New(crawl4ai.Options{
		BaseURL:          h.server.URL,
		TimeoutMs:        5_000,
		HealthCheckTTLMs: 60_000,
		Now:              func() int64 { return testClockTime.UnixMilli() },
	})
	producer := crawlqueue.NewProducer(crawlqueue.Options{
		Redis: h.redis,
		DB:    h.db,
		Now:   func() time.Time { return testClockTime },
	})
	service, err := New(Options{
		DB:         h.db,
		Mongo:      h.mongoDB,
		Redis:      h.redis,
		Crawl:      client,
		Enqueuer:   producer,
		Metadata:   h.metadata,
		Now:        func() time.Time { return testClockTime },
		ExecConfig: crawlexecution.Config{},
	})
	if err != nil {
		h.t.Fatalf("build service: %v", err)
	}
	return service
}

func (h *testNodeHarness) insertProfile(profileID, executionMode, config string) {
	h.t.Helper()
	now := testClockTime
	_, err := h.db.Exec(`INSERT INTO CrawlSiteProfile
		(id, orgId, name, description, matchHost, isActive, executionMode, workflowId, workflowVersionId,
		 workflowBindingMode, version, config, createdById, updatedById, publishedAt, createdAt, updatedAt)
		VALUES (?, ?, 'Example', NULL, 'example.com', 1, ?, NULL, NULL, 'published', 1, ?, 'actor-1', 'actor-1', ?, ?, ?)`,
		profileID, testOrgID, executionMode, []byte(config), now, now, now)
	if err != nil {
		h.t.Fatalf("insert profile: %v", err)
	}
}

func (h *testNodeHarness) insertTask(taskID string) {
	h.t.Helper()
	now := testClockTime
	_, err := h.db.Exec(`INSERT INTO CrawlTask
		(id, orgId, createdById, newsSourceId, targetUrl, displayName, status, concurrency, keywords, config,
		 runCount, createdAt, updatedAt)
		VALUES (?, ?, 'actor-1', NULL, 'https://example.com', 'Frontier node task', 'active', 1, '[]', NULL,
		        0, ?, ?)`,
		taskID, testOrgID, now, now)
	if err != nil {
		h.t.Fatalf("insert task: %v", err)
	}
}

func (h *testNodeHarness) insertWorkflowRun(workflowRunID string) {
	h.t.Helper()
	now := testClockTime
	_, err := h.db.Exec(`INSERT INTO CrawlStrategyWorkflowRun
		(id, orgId, workflowId, workflowVersionId, workflowOrigin, profileId, newsSourceId, status,
		 runKind, input, output, graphSnapshot, stepResults, candidates, parameterSources, error,
		 stepCount, candidateCount, selectedCount, createdById, startedAt, finishedAt, createdAt, updatedAt)
		VALUES (?, ?, NULL, NULL, 'bound', NULL, NULL, 'queued', 'frontier_run', '{}', NULL, '{}',
		        NULL, NULL, '[]', NULL, 0, 0, 0, 'actor-1', NULL, NULL, ?, ?)`,
		workflowRunID, testOrgID, now, now)
	if err != nil {
		h.t.Fatalf("insert workflow run: %v", err)
	}
}

// testRunSeed is one CrawlFrontierRun fixture row.
type testRunSeed struct {
	ID            string
	ProfileID     string
	WorkflowRunID string
	CrawlTaskID   string
	SeedURL       string
	ExecutionMode string
	Status        string
	MaxDepth      int
	MaxPages      int
	Metadata      string
}

func (h *testNodeHarness) insertRun(seed testRunSeed) {
	h.t.Helper()
	now := testClockTime
	metadata := seed.Metadata
	if metadata == "" {
		metadata = "{}"
	}
	_, err := h.db.Exec(`INSERT INTO CrawlFrontierRun
		(id, orgId, profileId, workflowRunId, seedUrl, crawlTaskId, executionMode, status, maxDepth, maxPages,
		 keywords, pageCount, nodeCount, articleCount, failedCount, duplicateCount, nativeRunId, lastError,
		 metadata, createdById, startedAt, finishedAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, 0, 0, 0, NULL, NULL, ?, 'actor-1', NULL, NULL, ?, ?)`,
		seed.ID, testOrgID, testNullable(seed.ProfileID), testNullable(seed.WorkflowRunID),
		seed.SeedURL, testNullable(seed.CrawlTaskID), seed.ExecutionMode, seed.Status,
		seed.MaxDepth, seed.MaxPages, []byte(metadata), now, now)
	if err != nil {
		h.t.Fatalf("insert run: %v", err)
	}
}

// testNodeSeed is one CrawlFrontierNode fixture row.
type testNodeSeed struct {
	ID           string
	RunID        string
	ParentNodeID string
	URL          string
	PageType     string
	Depth        int
	QueueClass   string
	Status       string
	Metadata     string
}

func (h *testNodeHarness) insertNode(seed testNodeSeed) {
	h.t.Helper()
	now := testClockTime
	metadata := seed.Metadata
	if metadata == "" {
		metadata = "{}"
	}
	_, err := h.db.Exec(`INSERT INTO CrawlFrontierNode
		(id, runId, parentNodeId, orgId, url, canonicalUrl, urlFingerprint, pageType, depth, queueClass,
		 status, score, freshnessScore, attempts, queuedAt, crawledAt, crawlResultId, rejectionReason,
		 lastError, metadata, discoveredAt, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, 0, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
		seed.ID, seed.RunID, testNullable(seed.ParentNodeID), testOrgID, seed.URL, seed.PageType,
		seed.Depth, seed.QueueClass, seed.Status, now, []byte(metadata), now, now, now)
	if err != nil {
		h.t.Fatalf("insert node: %v", err)
	}
}

// testNullable writes NULL for the empty string, which is how the optional
// columns are spelled at the call sites.
func testNullable(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

// scalar reads one nullable text column.
func (h *testNodeHarness) scalar(query string, args ...any) string {
	h.t.Helper()
	var value sql.NullString
	if err := h.db.QueryRow(query, args...).Scan(&value); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	return value.String
}

// count runs a COUNT/SUM query and returns it as an int.
func (h *testNodeHarness) count(query string, args ...any) int {
	h.t.Helper()
	var value int
	if err := h.db.QueryRow(query, args...).Scan(&value); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	return value
}

// float reads a nullable numeric column.
func (h *testNodeHarness) nullableFloat(query string, args ...any) (float64, bool) {
	h.t.Helper()
	var value sql.NullFloat64
	if err := h.db.QueryRow(query, args...).Scan(&value); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	if !value.Valid {
		return 0, false
	}
	return value.Float64, true
}

// nullableTime reads a nullable DATETIME(3) column. The connection opens with
// parseTime=true (usersettings.OpenMySQLFromURL), so the driver hands back a
// time.Time.
func (h *testNodeHarness) nullableTime(query string, args ...any) (time.Time, bool) {
	h.t.Helper()
	var value sql.NullTime
	if err := h.db.QueryRow(query, args...).Scan(&value); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	if !value.Valid {
		return time.Time{}, false
	}
	return value.Time.UTC(), true
}

// jsonObject reads a JSON column as an ordered object.
func (h *testNodeHarness) jsonObject(query string, args ...any) *crawlfrontierllm.Object {
	h.t.Helper()
	var raw []byte
	if err := h.db.QueryRow(query, args...).Scan(&raw); err != nil {
		h.t.Fatalf("query %q: %v", query, err)
	}
	object, ok := crawlfrontierllm.ParseObject(raw)
	if !ok {
		h.t.Fatalf("column is not a JSON object: %s", raw)
	}
	return object
}

// waitList reads one BullMQ wait list.
func (h *testNodeHarness) waitList(queueName string) []string {
	h.t.Helper()
	values, err := h.redis.LRange(h.ctx, "bull:"+queueName+":wait", 0, -1).Result()
	if err != nil {
		h.t.Fatalf("read %s wait list: %v", queueName, err)
	}
	return values
}

// jobData reads the BullMQ job hash a wait-list entry points at.
func (h *testNodeHarness) jobData(queueName, jobID string) *crawlfrontierllm.Object {
	h.t.Helper()
	raw, err := h.redis.HGet(h.ctx, "bull:"+queueName+":"+jobID, "data").Result()
	if err != nil {
		h.t.Fatalf("read job %s/%s: %v", queueName, jobID, err)
	}
	object, ok := crawlfrontierllm.ParseObject(json.RawMessage(raw))
	if !ok {
		h.t.Fatalf("job data is not a JSON object: %s", raw)
	}
	return object
}

// ---------------------------------------------------------------------------
// crawl4ai stub payloads
// ---------------------------------------------------------------------------

// testLink is one crawl4ai links bucket entry.
type testLink struct {
	Href string `json:"href"`
	Text string `json:"text"`
}

// testCrawlResult is one /crawl result entry.
type testCrawlResult struct {
	URL        string                `json:"url"`
	Success    bool                  `json:"success"`
	StatusCode int                   `json:"statusCode"`
	Markdown   map[string]string     `json:"markdown"`
	Metadata   json.RawMessage       `json:"metadata,omitempty"`
	Links      map[string][]testLink `json:"links,omitempty"`
}

// testSystemEvent is one crawl4ai systemEvents entry.
type testSystemEvent struct {
	Level     string `json:"level"`
	EventType string `json:"eventType"`
	Message   string `json:"message"`
	Timestamp string `json:"timestamp"`
}

// testCrawlEnvelope is the /crawl response envelope.
type testCrawlEnvelope struct {
	RunID        string            `json:"runId"`
	Results      []testCrawlResult `json:"results"`
	Warnings     []string          `json:"warnings"`
	SystemEvents []testSystemEvent `json:"systemEvents,omitempty"`
}

// testCrawlBody encodes a /crawl response.
func testCrawlBody(envelope testCrawlEnvelope) string {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// testCrawlTarget extracts the primary target URL from the client payload (the
// pipeline sends `urls`, the single-URL form).
func testCrawlTarget(body []byte) string {
	var payload struct {
		URLs []string `json:"urls"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	if len(payload.URLs) == 0 {
		return ""
	}
	return payload.URLs[0]
}

// testHomeResultMessage is the root result the layered/native fixtures return.
const testHomeResultMessage = "# Example home\n\nFrontier node integration fixture"

// testHomeCrawlBody is the depth-0 home page response: one self result with two
// in-domain links (a category and a second category hub) plus one system event.
func testHomeCrawlBody(runID string) string {
	return testHomeCrawlBodyForURL(runID, "https://example.com")
}

// testHomeCrawlBodyForURL is testHomeCrawlBody with a caller-supplied self URL.
// The sitemap scenario uses a public IP literal as the seed origin so discovery
// never depends on DNS resolution.
func testHomeCrawlBodyForURL(runID, selfURL string) string {
	return testCrawlBody(testCrawlEnvelope{
		RunID: runID,
		Results: []testCrawlResult{{
			URL:        selfURL,
			Success:    true,
			StatusCode: 200,
			Markdown:   map[string]string{"raw_markdown": testHomeResultMessage},
			Metadata:   json.RawMessage(`{"title":"Example","frontierScore":0.8}`),
			Links: map[string][]testLink{
				"internal": {
					{Href: "/news", Text: "News"},
					{Href: "/section/world", Text: "World"},
				},
			},
		}},
		Warnings: []string{},
		SystemEvents: []testSystemEvent{{
			Level: "warn", EventType: "crawl_warning", Message: "slow page",
			Timestamp: "2025-03-04T05:06:07.500Z",
		}},
	})
}

// ---------------------------------------------------------------------------
// Scenario 1: layered happy path
// ---------------------------------------------------------------------------

func TestFrontierNodeLayeredHappyPath(t *testing.T) {
	h := testNewNodeHarness(t)
	// `seedDiscovery.strategy = "frontier_only"` keeps discoverSeedNodes away
	// from the sitemap chain, which has no injectable transport; every other
	// layered step (crawl, persist, discovery, materialization) runs for real.
	h.insertProfile(testProfileID, "layered",
		`{"sourceTier":"tier1","seedDiscovery":{"strategy":"frontier_only"},"layeredOptions":{"maxDepth":3,"maxPages":10}}`)
	h.insertTask(testTaskID)
	h.insertWorkflowRun(testWorkflowRunID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, WorkflowRunID: testWorkflowRunID, CrawlTaskID: testTaskID,
		SeedURL: "https://example.com", ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) { return http.StatusOK, testHomeCrawlBody("crawl-run-1") })
	service := h.service()

	summary, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err != nil {
		t.Fatalf("process node: %v", err)
	}

	// 1. The BullMQ return value: inserted/skipped plus the crawl4ai runId and
	// the fetchedAt the pinned clock produced.
	wantSummary := `{"inserted":1,"skipped":0,"lastFetchedAt":"2025-03-04T05:06:07.500Z","runId":"crawl-run-1"}`
	if string(summary) != wantSummary {
		t.Fatalf("summary = %s\nwant    = %s", summary, wantSummary)
	}

	// 2. The root node is completed, carries the self-result id, the self score
	// from the persisted CrawlResult metadata and the canonical URL/ fingerprint
	// derived from that same metadata.
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "completed" {
		t.Fatalf("root node status = %s", got)
	}
	resultID := h.scalar("SELECT crawlResultId FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	if resultID == "" {
		t.Fatal("root node has no crawlResultId")
	}
	if got := h.scalar("SELECT canonicalUrl FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "https://example.com/" {
		t.Fatalf("root node canonicalUrl = %q", got)
	}
	if got, ok := h.nullableFloat("SELECT score FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); !ok || got != 0.8 {
		t.Fatalf("root node score = %v (present=%v), want 0.8", got, ok)
	}
	if startedAt, ok := h.nullableTime("SELECT startedAt FROM CrawlFrontierRun WHERE id = ?", testRunID); !ok || !startedAt.Equal(testClockTime) {
		t.Fatalf("run startedAt = %v (present=%v), want the pinned clock", startedAt, ok)
	}
	rootMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	if got, _ := rootMetadata.String("sourceTier"); got != "tier1" {
		t.Fatalf("node metadata sourceTier = %q", got)
	}
	if got, _ := rootMetadata.String("seedStrategy"); got != "frontier_only" {
		t.Fatalf("node metadata seedStrategy = %q", got)
	}
	if got, ok := rootMetadata.Number("httpStatus"); !ok || got != 200 {
		t.Fatalf("node metadata httpStatus = %v (present=%v)", got, ok)
	}
	if got, ok := rootMetadata.Number("pendingLlmJudgeJobs"); !ok || got != 0 {
		raw, _ := rootMetadata.MarshalJSON()
		t.Fatalf("node metadata pendingLlmJudgeJobs = %v (present=%v); metadata=%s", got, ok, raw)
	}
	if raw, ok := rootMetadata.Raw("crawlError"); !ok || string(raw) != "null" {
		t.Fatalf("node metadata crawlError = %s (present=%v)", raw, ok)
	}
	// MySQL re-serializes JSON columns with its own spacing, so the array is
	// compared through the reader instead of as a byte substring.
	if paths, ok := rootMetadata.Strings("discoveryPath"); !ok || len(paths) != 1 || paths[0] != "home" {
		t.Fatalf("node metadata discoveryPath = %v (present=%v)", paths, ok)
	}

	// 3. The two in-domain links became queued child nodes of the root node.
	children := h.count(`SELECT COUNT(*) FROM CrawlFrontierNode
		WHERE runId = ? AND parentNodeId = ? AND status = 'queued'`, testRunID, testRootNodeID)
	if children != 2 {
		t.Fatalf("child nodes = %d, want 2", children)
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlFrontierNode
		WHERE runId = ? AND depth = 1 AND pageType = 'category' AND queueClass = 'hot'`, testRunID); got != 2 {
		t.Fatalf("child node shape count = %d, want 2", got)
	}
	childURL := h.scalar(`SELECT url FROM CrawlFrontierNode WHERE runId = ? AND url LIKE '%/news'`, testRunID)
	if childURL != "https://example.com/news" {
		t.Fatalf("child url = %q", childURL)
	}

	// 4. The CrawlResult row plus the CrawlResultContent document.
	if got := h.count("SELECT COUNT(*) FROM CrawlResult WHERE taskId = ?", testTaskID); got != 1 {
		t.Fatalf("CrawlResult rows = %d, want 1", got)
	}
	if got := h.scalar("SELECT sourceUrl FROM CrawlResult WHERE taskId = ?", testTaskID); got != "https://example.com" {
		t.Fatalf("CrawlResult sourceUrl = %q", got)
	}
	resultMetadata := h.jsonObject("SELECT metadata FROM CrawlResult WHERE taskId = ?", testTaskID)
	frontierExpectations := map[string]string{
		"frontierRunId":         testRunID,
		"frontierNodeId":        testRootNodeID,
		"frontierPageType":      "home",
		"frontierExecutionMode": "layered",
	}
	for key, want := range frontierExpectations {
		if got, _ := resultMetadata.UntrimmedString(key); got != want {
			t.Fatalf("CrawlResult metadata %s = %q, want %q", key, got, want)
		}
	}
	if got, ok := resultMetadata.Number("frontierDepth"); !ok || got != 0 {
		t.Fatalf("CrawlResult metadata frontierDepth = %v (present=%v)", got, ok)
	}
	if got, ok := resultMetadata.Number("frontierScore"); !ok || got != 0.8 {
		t.Fatalf("CrawlResult metadata frontierScore = %v (present=%v)", got, ok)
	}
	var content struct {
		SourceURL  string  `bson:"sourceUrl"`
		Markdown   string  `bson:"markdown"`
		CrawlRunID *string `bson:"crawlRunId"`
	}
	if err := h.mongoDB.Collection(testResultCollName).
		FindOne(h.ctx, bson.D{{Key: "resultId", Value: resultID}}).Decode(&content); err != nil {
		t.Fatalf("read CrawlResultContent: %v", err)
	}
	if content.SourceURL != "https://example.com" || !strings.Contains(content.Markdown, "Frontier node integration fixture") {
		t.Fatalf("CrawlResultContent = %+v", content)
	}
	if content.CrawlRunID == nil || *content.CrawlRunID != "crawl-run-1" {
		t.Fatalf("CrawlResultContent crawlRunId = %v", content.CrawlRunID)
	}

	// 5. The BullMQ frontier_node jobs: one per child, on the hot queue, with the
	// NodeJS job id shape and the exact job data the worker reads.
	waiting := h.waitList(crawlqueue.QueueHot)
	if len(waiting) != 2 {
		t.Fatalf("hot wait list = %v, want 2 jobs", waiting)
	}
	for _, jobID := range waiting {
		nodeID := ""
		for _, candidateID := range []string{
			h.scalar(`SELECT id FROM CrawlFrontierNode WHERE runId = ? AND url = 'https://example.com/news'`, testRunID),
			h.scalar(`SELECT id FROM CrawlFrontierNode WHERE runId = ? AND url = 'https://example.com/section/world'`, testRunID),
		} {
			if candidateID != "" && strings.HasPrefix(jobID, candidateID+"-") {
				nodeID = candidateID
				break
			}
		}
		if nodeID == "" {
			t.Fatalf("job id %q does not start with a child node id", jobID)
		}
		if !strings.HasSuffix(jobID, "-hot") {
			t.Fatalf("job id %q does not end with the hot queue class", jobID)
		}
		data := h.jobData(crawlqueue.QueueHot, jobID)
		if got, _ := data.String("jobKind"); got != "frontier_node" {
			t.Fatalf("job data jobKind = %q", got)
		}
		if got, _ := data.String("frontierNodeId"); got != nodeID {
			t.Fatalf("job data frontierNodeId = %q, want %q", got, nodeID)
		}
		if got, _ := data.String("frontierRunId"); got != testRunID {
			t.Fatalf("job data frontierRunId = %q", got)
		}
		if got, _ := data.String("priorityClass"); got != "hot" {
			t.Fatalf("job data priorityClass = %q", got)
		}
		if got, _ := data.String("taskId"); got != testTaskID {
			t.Fatalf("job data taskId = %q", got)
		}
		if got, _ := data.String("orgId"); got != testOrgID {
			t.Fatalf("job data orgId = %q", got)
		}
	}

	// 6. The workflow run/step/event/candidate/trace rows.
	if got := h.scalar("SELECT status FROM CrawlStrategyWorkflowRun WHERE id = ?", testWorkflowRunID); got != "running" {
		t.Fatalf("workflow run status = %s, want running (two children are still queued)", got)
	}
	for eventType, want := range map[string]int{
		"frontier_node_started":   1,
		"frontier_node_completed": 1,
		"crawl_warning":           1,
		"seed_branch_skipped":     1,
	} {
		if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent
			WHERE runId = ? AND eventType = ?`, testWorkflowRunID, eventType); got != want {
			t.Fatalf("%s events = %d, want %d", eventType, got, want)
		}
	}
	eventDetails := h.jsonObject(`SELECT details FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'crawl_warning'`, testWorkflowRunID)
	if got, _ := eventDetails.String("url"); got != "https://example.com" {
		t.Fatalf("crawl_warning details url = %q", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep
		WHERE runId = ? AND stepKey = ? AND status = 'completed'`, testWorkflowRunID,
		"frontier:"+testRootNodeID+":crawl"); got != 1 {
		t.Fatalf("node completion step rows = %d, want 1", got)
	}
	if got := h.scalar(`SELECT outputCount FROM CrawlStrategyWorkflowRunStep
		WHERE runId = ? AND stepKey = ?`, testWorkflowRunID, "frontier:"+testRootNodeID+":crawl"); got != "1" {
		t.Fatalf("step outputCount = %s, want 1", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunCandidate
		WHERE runId = ? AND status = 'selected'`, testWorkflowRunID); got != 2 {
		t.Fatalf("selected candidates = %d, want 2", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunCandidateTrace trace
		JOIN CrawlStrategyWorkflowRunCandidate candidate ON candidate.id = trace.candidateId
		WHERE candidate.runId = ?`, testWorkflowRunID); got == 0 {
		t.Fatal("no candidate trace rows were recorded")
	}

	// 7. The run counters refreshRunStatus recomputed from the node rows.
	counters := map[string]string{
		"nodeCount":    "3",
		"pageCount":    "1",
		"articleCount": "0",
		"failedCount":  "0",
		"status":       "running",
	}
	for column, want := range counters {
		if got := h.scalar("SELECT "+column+" FROM CrawlFrontierRun WHERE id = ?", testRunID); got != want {
			t.Fatalf("run %s = %s, want %s", column, got, want)
		}
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "" {
		t.Fatalf("run lastError = %q, want NULL", got)
	}
}

// staticSitemapTransport answers the sitemap discovery fixture URLs and 404s
// every other target. It is installed only on the injected crawlmetadata
// Discovery, so the crawl4ai httptest server is unaffected.
type staticSitemapTransport struct {
	routes map[string]string
	mu     sync.Mutex
	seen   []string
}

func (t *staticSitemapTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.seen = append(t.seen, req.URL.String())
	t.mu.Unlock()
	body, ok := t.routes[req.URL.String()]
	status := http.StatusNotFound
	if ok {
		status = http.StatusOK
	}
	header := http.Header{}
	header.Set("Content-Type", "application/xml")
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}, nil
}

// childNodeIDs lists the direct children of a node in depth then id order.
func (h *testNodeHarness) childNodeIDs(runID, parentNodeID string) []string {
	h.t.Helper()
	rows, err := h.db.Query(`SELECT id FROM CrawlFrontierNode
		WHERE runId = ? AND parentNodeId = ? ORDER BY depth, id`, runID, parentNodeID)
	if err != nil {
		h.t.Fatalf("query child nodes: %v", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			h.t.Fatalf("scan child node: %v", err)
		}
		ids = append(ids, id)
	}
	return ids
}

// TestFrontierNodeSitemapSeedMaterialization runs a non-disabled sitemap
// discovery through the real node chain: the crawlmetadata walk reads robots and
// the declared sitemap over a stub transport, the seed candidates materialize as
// queued article nodes, and the seed method plus the full sitemap diagnostics
// are projected onto the root node and the run metadata. Only the sitemap HTTP
// transport and the crawl4ai HTTP server are stubbed; the discovery walk,
// materialization, persistence and read projection are the production code.
func TestFrontierNodeSitemapSeedMaterialization(t *testing.T) {
	h := testNewNodeHarness(t)
	// A public IP literal keeps the production SSRF check active without any DNS
	// lookup, so the fixture is deterministic in an offline CI runner.
	const sitemapOrigin = "https://8.8.8.8"
	transport := &staticSitemapTransport{routes: map[string]string{
		sitemapOrigin + "/robots.txt": "Sitemap: " + sitemapOrigin + "/sitemap-articles.xml\n",
		sitemapOrigin + "/sitemap-articles.xml": `<?xml version="1.0" encoding="UTF-8"?>` +
			`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
			`<url><loc>` + sitemapOrigin + `/story/seed-one</loc><lastmod>2025-03-01T00:00:00Z</lastmod></url>` +
			`<url><loc>` + sitemapOrigin + `/story/seed-two</loc><lastmod>2025-03-02T00:00:00Z</lastmod></url>` +
			`</urlset>`,
	}}
	h.metadata = crawlmetadata.NewDiscovery(
		crawlmetadata.NewServiceWithHTTPClient(h.db, h.redis, &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}),
		nil,
		nil,
	)
	h.insertProfile(testProfileID, "layered",
		`{"sourceTier":"tier1","seedDiscovery":{"strategy":"seed_first","mode":"robots","maxSeedUrls":5,"freshnessWindowHours":168,"qualityThresholds":{"minCandidates":1,"minArticleRatio":0,"maxNoiseRatio":1,"minFreshRatio":0}},"layeredOptions":{"maxDepth":3,"maxPages":10}}`)
	h.insertTask(testTaskID)
	h.insertWorkflowRun(testWorkflowRunID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, WorkflowRunID: testWorkflowRunID, CrawlTaskID: testTaskID,
		SeedURL: sitemapOrigin, ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: sitemapOrigin, PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) {
		return http.StatusOK, testHomeCrawlBodyForURL("crawl-sitemap-run", sitemapOrigin)
	})
	service := h.service()

	if _, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0); err != nil {
		t.Fatalf("process node: %v", err)
	}

	// robots was requested first, then the declared sitemap.
	if len(transport.seen) < 2 || transport.seen[0] != sitemapOrigin+"/robots.txt" ||
		transport.seen[1] != sitemapOrigin+"/sitemap-articles.xml" {
		t.Fatalf("sitemap requests = %v", transport.seen)
	}

	// 1. The real sitemap candidates materialized as queued article nodes,
	// stamped with the seedMethod the sitemap walk actually produced.
	seedNodes := 0
	for _, nodeID := range h.childNodeIDs(testRunID, testRootNodeID) {
		metadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", nodeID)
		if origin, _ := metadata.String("seedOrigin"); origin != "sitemap" {
			continue
		}
		seedNodes++
		if candidate, _ := metadata.Bool("seedCandidate"); !candidate {
			t.Fatalf("seed node %s seedCandidate = false", nodeID)
		}
		if method, _ := metadata.String("seedMethod"); method != "robots" {
			t.Fatalf("seed node %s seedMethod = %q, want robots", nodeID, method)
		}
	}
	if seedNodes != 2 {
		t.Fatalf("seed nodes = %d, want 2", seedNodes)
	}

	// 2. The root node metadata carries the full sitemap diagnostics produced by
	// the walk, not a request-mode echo.
	rootMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	if got, _ := rootMetadata.String("seedMethod"); got != "robots" {
		t.Fatalf("root seedMethod = %q", got)
	}
	if got, _ := rootMetadata.String("seedDiscoveryMode"); got != "robots" {
		t.Fatalf("root seedDiscoveryMode = %q", got)
	}
	diagnostics, ok := rootMetadata.Object("seedDiagnostics")
	if !ok {
		raw, _ := rootMetadata.MarshalJSON()
		t.Fatalf("root metadata has no seedDiagnostics: %s", raw)
	}
	if got, _ := diagnostics.String("seedMethod"); got != "robots" {
		t.Fatalf("diagnostics seedMethod = %q", got)
	}
	if got, _ := diagnostics.String("robotsUrl"); got != sitemapOrigin+"/robots.txt" {
		t.Fatalf("diagnostics robotsUrl = %q", got)
	}
	if parsed, ok := diagnostics.Number("parsedSitemaps"); !ok || parsed != 1 {
		t.Fatalf("diagnostics parsedSitemaps = %v (present=%v), want 1", parsed, ok)
	}
	if candidates, ok := diagnostics.Number("candidateCount"); !ok || candidates != 2 {
		t.Fatalf("diagnostics candidateCount = %v (present=%v), want 2", candidates, ok)
	}
	if fetched, _ := diagnostics.Strings("fetchedSitemaps"); len(fetched) != 1 || fetched[0] != sitemapOrigin+"/sitemap-articles.xml" {
		t.Fatalf("diagnostics fetchedSitemaps = %v", fetched)
	}

	// 3. refreshRunStatus hoists the same seed fields onto the run metadata, which
	// is the document the Web console's run diagnostics tab reads.
	runMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierRun WHERE id = ?", testRunID)
	if got, _ := runMetadata.String("seedMethod"); got != "robots" {
		t.Fatalf("run seedMethod = %q", got)
	}
	if got, _ := runMetadata.String("seedDiscoveryMode"); got != "robots" {
		t.Fatalf("run seedDiscoveryMode = %q", got)
	}
	runDiagnostics, ok := runMetadata.Object("seedDiagnostics")
	if !ok {
		raw, _ := runMetadata.MarshalJSON()
		t.Fatalf("run metadata has no seedDiagnostics: %s", raw)
	}
	if got, _ := runDiagnostics.String("seedMethod"); got != "robots" {
		t.Fatalf("run diagnostics seedMethod = %q", got)
	}
	if got, _ := runDiagnostics.String("robotsUrl"); got != sitemapOrigin+"/robots.txt" {
		t.Fatalf("run diagnostics robotsUrl = %q", got)
	}

	// 4. The seed branch completion event was recorded for the root branch.
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'seed_branch_completed'`, testWorkflowRunID); got != 1 {
		t.Fatalf("seed_branch_completed events = %d, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// Scenario 2: native root branch
// ---------------------------------------------------------------------------

func TestFrontierNodeNativeRootBranch(t *testing.T) {
	h := testNewNodeHarness(t)
	// executionMode native + nativeOptions.deepCrawlStrategy (an object, because
	// the profile normalizer keeps only object-valued component members) selects
	// executeNativeRootNode at depth 0.
	h.insertProfile(testProfileID, "native",
		`{"seedDiscovery":{"strategy":"frontier_only"},"nativeOptions":{"deepCrawlStrategy":{"type":"bfs","params":{"max_depth":2}}}}`)
	h.insertTask(testTaskID)
	h.insertWorkflowRun(testWorkflowRunID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, WorkflowRunID: testWorkflowRunID, CrawlTaskID: testTaskID,
		SeedURL: "https://example.com", ExecutionMode: "native", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	// The native crawl returns every crawled URL as one result: the root plus two
	// deep-crawl discoveries.
	h.startCrawl4ai(func(string) (int, string) {
		return http.StatusOK, testCrawlBody(testCrawlEnvelope{
			RunID: "crawl-run-native-1",
			Results: []testCrawlResult{
				{URL: "https://example.com", Success: true, StatusCode: 200,
					Markdown: map[string]string{"raw_markdown": testHomeResultMessage}},
				{URL: "https://example.com/tech", Success: true, StatusCode: 200,
					Markdown: map[string]string{"raw_markdown": "# Tech hub\n\nnative child one"}},
				{URL: "https://example.com/article/a1", Success: true, StatusCode: 200,
					Markdown: map[string]string{"raw_markdown": "# Article one\n\nnative child two"}},
			},
			Warnings: []string{},
		})
	})
	service := h.service()

	summary, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err != nil {
		t.Fatalf("process native node: %v", err)
	}
	wantSummary := `{"inserted":3,"skipped":0,"lastFetchedAt":"2025-03-04T05:06:07.500Z","runId":"crawl-run-native-1"}`
	if string(summary) != wantSummary {
		t.Fatalf("summary = %s\nwant    = %s", summary, wantSummary)
	}

	// The native run id is stamped on the run row.
	if got := h.scalar("SELECT nativeRunId FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "crawl-run-native-1" {
		t.Fatalf("nativeRunId = %q", got)
	}
	// The root node records the native component block, and the two discoveries
	// became completed child nodes with their own crawlResultId.
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "completed" {
		t.Fatalf("root node status = %s", got)
	}
	rootMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	if got, ok := rootMetadata.Bool("nativeDiscovered"); !ok || !got {
		t.Fatalf("node metadata nativeDiscovered = %v (present=%v)", got, ok)
	}
	if got, _ := rootMetadata.String("nativeStrategyType"); got != "bfs" {
		t.Fatalf("node metadata nativeStrategyType = %q", got)
	}
	if got, ok := rootMetadata.Number("nativeSelectedResults"); !ok || got != 2 {
		t.Fatalf("node metadata nativeSelectedResults = %v (present=%v)", got, ok)
	}
	if got, ok := rootMetadata.Number("nativeAcceptedResults"); !ok || got != 2 {
		t.Fatalf("node metadata nativeAcceptedResults = %v (present=%v)", got, ok)
	}
	children := h.count(`SELECT COUNT(*) FROM CrawlFrontierNode
		WHERE runId = ? AND parentNodeId = ? AND status = 'completed'
		AND crawlResultId IS NOT NULL`, testRunID, testRootNodeID)
	if children != 2 {
		t.Fatalf("native child nodes = %d, want 2 completed rows with a crawlResultId", children)
	}
	// Native children take depth min(maxDepth, 1) unless they are articles, which
	// take min(maxDepth, 3).
	if got := h.scalar(`SELECT depth FROM CrawlFrontierNode WHERE runId = ? AND url = 'https://example.com/tech'`,
		testRunID); got != "1" {
		t.Fatalf("category child depth = %q, want 1", got)
	}
	if got := h.scalar(`SELECT depth FROM CrawlFrontierNode WHERE runId = ? AND url = 'https://example.com/article/a1'`,
		testRunID); got != "3" {
		t.Fatalf("article child depth = %q, want 3", got)
	}
	if got := h.scalar(`SELECT pageType FROM CrawlFrontierNode WHERE runId = ? AND url = 'https://example.com/article/a1'`,
		testRunID); got != "article" {
		t.Fatalf("article child pageType = %q", got)
	}
	if got := h.count("SELECT COUNT(*) FROM CrawlResult WHERE taskId = ?", testTaskID); got != 3 {
		t.Fatalf("CrawlResult rows = %d, want 3", got)
	}
	// The native branch records the native-root and materialize steps.
	for _, stepKey := range []string{
		"frontier:" + testRootNodeID + ":native-root",
		"frontier:" + testRootNodeID + ":materialize-native",
	} {
		if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunStep WHERE runId = ? AND stepKey = ?`,
			testWorkflowRunID, stepKey); got != 1 {
			t.Fatalf("step %s rows = %d, want 1", stepKey, got)
		}
	}
	// Every node is completed, so the run itself reaches completed.
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "completed" {
		t.Fatalf("run status = %q, want completed", got)
	}
	if got := h.scalar("SELECT pageCount FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "3" {
		t.Fatalf("run pageCount = %s, want 3", got)
	}
	if got := h.scalar("SELECT articleCount FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "1" {
		t.Fatalf("run articleCount = %s, want 1", got)
	}
	// The native branch materializes completed nodes, so it enqueues no job.
	if waiting := h.waitList(crawlqueue.QueueHot); len(waiting) != 0 {
		t.Fatalf("hot wait list = %v, want no native jobs", waiting)
	}
}

// ---------------------------------------------------------------------------
// Scenario 3: canceled run
// ---------------------------------------------------------------------------

func TestFrontierNodeCanceledRun(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, CrawlTaskID: testTaskID, SeedURL: "https://example.com",
		ExecutionMode: "layered", Status: "canceled", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) { return http.StatusOK, testHomeCrawlBody("unused") })
	service := h.service()

	summary, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err != nil {
		t.Fatalf("canceled run must not fail the job: %v", err)
	}
	if string(summary) != `{"inserted":0,"skipped":0}` {
		t.Fatalf("summary = %s, want {\"inserted\":0,\"skipped\":0}", summary)
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "canceled" {
		t.Fatalf("node status = %q, want canceled", got)
	}
	// The short-circuit runs before the profile/task/crawl steps: no crawl
	// request, no CrawlResult, no workflow event and no run status change.
	if got := h.requests.Load(); got != 0 {
		t.Fatalf("crawl requests = %d, want 0", got)
	}
	if got := h.count("SELECT COUNT(*) FROM CrawlResult WHERE taskId = ?", testTaskID); got != 0 {
		t.Fatalf("CrawlResult rows = %d, want 0", got)
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "canceled" {
		t.Fatalf("run status = %q, want canceled (untouched)", got)
	}
	if startedAt, ok := h.nullableTime("SELECT startedAt FROM CrawlFrontierRun WHERE id = ?", testRunID); ok {
		t.Fatalf("run startedAt = %v, want NULL", startedAt)
	}
	if got := h.count("SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent"); got != 0 {
		t.Fatalf("workflow events = %d, want 0", got)
	}
}

// ---------------------------------------------------------------------------
// Scenario 4: non-retryable failure
// ---------------------------------------------------------------------------

func TestFrontierNodeNonRetryableFailure(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertWorkflowRun(testWorkflowRunID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, WorkflowRunID: testWorkflowRunID, CrawlTaskID: testTaskID,
		SeedURL: "https://example.com", ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	// A normal-queue node: the demotion branch is hot-only, so this failure takes
	// the plain failed-node path.
	h.insertNode(testNodeSeed{
		ID: "node-frontier-node-article", RunID: testRunID, URL: "https://example.com/a1",
		PageType: "article", Depth: 1, QueueClass: "normal", Status: "queued",
	})
	// A "cloudflare challenge" body classifies as challenge_detected: retryable
	// status 403, but the failure-kind classifier must name it.
	h.startCrawl4ai(func(string) (int, string) {
		return http.StatusForbidden, `{"message":"cloudflare challenge required"}`
	})
	service := h.service()

	_, err := service.ProcessQueuedNode(h.ctx, "node-frontier-node-article", testOrgID, 0)
	if err == nil {
		t.Fatal("a non-retryable crawl failure must fail the job")
	}

	lastError := h.scalar("SELECT lastError FROM CrawlFrontierNode WHERE id = ?", "node-frontier-node-article")
	if lastError != err.Error() {
		t.Fatalf("node lastError = %q, want the returned error text %q", lastError, err.Error())
	}
	if !strings.Contains(lastError, "cloudflare challenge required") {
		t.Fatalf("node lastError = %q, want the crawl4ai message", lastError)
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", "node-frontier-node-article"); got != "failed" {
		t.Fatalf("node status = %s, want failed", got)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierRun WHERE id = ?", testRunID); got != lastError {
		t.Fatalf("run lastError = %q, want %q", got, lastError)
	}
	failedMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", "node-frontier-node-article")
	if got, _ := failedMetadata.String("failureKind"); got != "challenge_detected" {
		t.Fatalf("node metadata failureKind = %q, want challenge_detected", got)
	}
	flags, ok := failedMetadata.Strings("warningFlags")
	if !ok || len(flags) != 1 || flags[0] != "challenge_detected" {
		t.Fatalf("node metadata warningFlags = %v (present=%v), want [challenge_detected]", flags, ok)
	}
	// The frontier_node_failed event carries the message verbatim and the
	// classified trigger reason.
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'frontier_node_failed' AND level = 'error'`, testWorkflowRunID); got != 1 {
		t.Fatalf("frontier_node_failed events = %d, want 1", got)
	}
	if got := h.scalar(`SELECT message FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'frontier_node_failed'`, testWorkflowRunID); got != lastError {
		t.Fatalf("event message = %q, want %q", got, lastError)
	}
	if got := h.scalar(`SELECT triggerReason FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'frontier_node_failed'`, testWorkflowRunID); got != "challenge_detected" {
		t.Fatalf("event triggerReason = %q", got)
	}
	// refreshRunStatus turns the run failed: one failed node, no page.
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "failed" {
		t.Fatalf("run status = %q, want failed", got)
	}
	if got := h.scalar("SELECT failedCount FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "1" {
		t.Fatalf("run failedCount = %s, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// Scenario 5: crawl4ai 503 keeps its status through errors.As
// ---------------------------------------------------------------------------

func TestFrontierNodeCrawl4ai503KeepsStatus(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, CrawlTaskID: testTaskID, SeedURL: "https://example.com",
		ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "normal", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) {
		return http.StatusServiceUnavailable, `{"message":"crawl4ai upstream unavailable"}`
	})
	service := h.service()

	_, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err == nil {
		t.Fatal("a 503 must fail the job")
	}
	// The worker reads the retryability from the crawl4ai status, so the error
	// must still carry a *crawl4ai.Error after it travels through the state
	// machine.
	var crawlErr *crawl4ai.Error
	if !errors.As(err, &crawlErr) {
		t.Fatalf("error is not a *crawl4ai.Error: %T (%v)", err, err)
	}
	if crawlErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("crawl4ai status = %d, want 503", crawlErr.Status)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != err.Error() {
		t.Fatalf("node lastError = %q, want %q", got, err.Error())
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "failed" {
		t.Fatalf("run status = %q, want failed", got)
	}
}

// ---------------------------------------------------------------------------
// Scenario 6: hot retry demoted to the normal queue
// ---------------------------------------------------------------------------

func TestFrontierNodeHotRetryDemotedToNormal(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertWorkflowRun(testWorkflowRunID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, WorkflowRunID: testWorkflowRunID, CrawlTaskID: testTaskID,
		SeedURL: "https://example.com", ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	// ERR_CONNECTION_CLOSED classifies as network_tunnel_error, the only failure
	// kind shouldDemoteHotRetryToNormal demotes.
	h.startCrawl4ai(func(string) (int, string) {
		return http.StatusBadGateway, `{"message":"net::ERR_CONNECTION_CLOSED"}`
	})
	service := h.service()

	summary, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err != nil {
		t.Fatalf("a demoted retry resolves the job: %v", err)
	}
	if string(summary) != `{"inserted":0,"skipped":0}` {
		t.Fatalf("summary = %s, want zero counters", summary)
	}

	// The node is back to queued on the normal queue, with the failure cleared
	// and the demotion bookkeeping in metadata.
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "queued" {
		t.Fatalf("node status = %q, want queued", got)
	}
	if got := h.scalar("SELECT queueClass FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "normal" {
		t.Fatalf("node queueClass = %q, want normal", got)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "" {
		t.Fatalf("node lastError = %q, want NULL", got)
	}
	if queuedAt, ok := h.nullableTime("SELECT queuedAt FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); !ok || !queuedAt.Equal(testClockTime) {
		t.Fatalf("node queuedAt = %v (present=%v), want the pinned clock", queuedAt, ok)
	}
	metadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	cases := map[string]string{
		"retryDemotedFromQueue":   "hot",
		"retryDemotedFailureKind": "network_tunnel_error",
		"retryDemotedAt":          "2025-03-04T05:06:07.500Z",
	}
	for key, want := range cases {
		if got, _ := metadata.String(key); got != want {
			t.Fatalf("metadata %s = %q, want %q", key, got, want)
		}
	}
	if demoted, ok := metadata.Bool("retryDemotedToNormal"); !ok || !demoted {
		t.Fatalf("metadata retryDemotedToNormal = %v (present=%v)", demoted, ok)
	}
	if last := h.scalar("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); !strings.Contains(last, "ERR_CONNECTION_CLOSED") {
		t.Fatalf("metadata retryDemotedLastError missing: %s", last)
	}
	flags, ok := metadata.Strings("warningFlags")
	if !ok || len(flags) != 2 || flags[0] != "network_tunnel_error" || flags[1] != "retry_demoted_to_normal" {
		t.Fatalf("metadata warningFlags = %v (present=%v)", flags, ok)
	}

	// A new frontier_node job was added to the normal queue.
	waiting := h.waitList(crawlqueue.QueueNormal)
	if len(waiting) != 1 {
		t.Fatalf("normal wait list = %v, want exactly one demoted job", waiting)
	}
	if !strings.HasPrefix(waiting[0], testRootNodeID+"-") || !strings.HasSuffix(waiting[0], "-normal") {
		t.Fatalf("demoted job id = %q, want <nodeID>-<ms>-normal", waiting[0])
	}
	data := h.jobData(crawlqueue.QueueNormal, waiting[0])
	if got, _ := data.String("frontierNodeId"); got != testRootNodeID {
		t.Fatalf("demoted job frontierNodeId = %q", got)
	}
	if got, _ := data.String("priorityClass"); got != "normal" {
		t.Fatalf("demoted job priorityClass = %q", got)
	}

	// The retry_demoted_to_normal event and the reset workflow status.
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'retry_demoted_to_normal' AND level = 'warn'`, testWorkflowRunID); got != 1 {
		t.Fatalf("retry_demoted_to_normal events = %d, want 1", got)
	}
	if got := h.scalar(`SELECT triggerReason FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'retry_demoted_to_normal'`, testWorkflowRunID); got != "network_tunnel_error" {
		t.Fatalf("event triggerReason = %q", got)
	}
	// The demotion writes markRunStatus({status:"queued", finishedAt:null}) and
	// then calls refreshRunStatus, which — exactly like NestJS (crawl-frontier
	// .service.ts 1056-1061 then 3926-3935) — immediately re-marks the workflow
	// run "running" because the node is queued again. The observable end state is
	// therefore running with a cleared finishedAt, not queued.
	if got := h.scalar("SELECT status FROM CrawlStrategyWorkflowRun WHERE id = ?", testWorkflowRunID); got != "running" {
		t.Fatalf("workflow run status = %q, want running (refreshRunStatus re-marks it)", got)
	}
	if finishedAt, ok := h.nullableTime("SELECT finishedAt FROM CrawlStrategyWorkflowRun WHERE id = ?", testWorkflowRunID); ok {
		t.Fatalf("workflow run finishedAt = %v, want NULL (the demotion cleared it)", finishedAt)
	}
	// The transient queued write is still visible in the event trail: the
	// retry_demoted_to_normal event is appended with the failure kind.
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent
		WHERE runId = ? AND eventType = 'retry_demoted_to_normal'`, testWorkflowRunID); got != 1 {
		t.Fatalf("retry_demoted_to_normal events = %d, want 1", got)
	}
	// The frontier run itself is refreshed (the node is queued again).
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "running" {
		t.Fatalf("run status = %q, want running", got)
	}
	if got := h.scalar("SELECT nodeCount FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "1" {
		t.Fatalf("run nodeCount = %s, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// Scenario 7: B1 - concurrent metadata writes keep both patches
// ---------------------------------------------------------------------------

func TestFrontierNodeConcurrentMetadataPatches(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, CrawlTaskID: testTaskID, SeedURL: "https://example.com",
		ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued", Metadata: `{"warningFlags":["flag_a"]}`,
	})
	h.insertNode(testNodeSeed{
		ID: "node-frontier-node-b", RunID: testRunID, URL: "https://example.com/news", PageType: "category",
		Depth: 1, QueueClass: "hot", Status: "queued", Metadata: `{"warningFlags":["flag_b"]}`,
	})
	// Each node gets its own markdown so both CrawlResult inserts are real
	// inserts instead of a content-hash dedupe.
	h.startCrawl4ai(func(target string) (int, string) {
		return http.StatusOK, testCrawlBody(testCrawlEnvelope{
			RunID: "crawl-run-b1",
			Results: []testCrawlResult{{
				URL: target, Success: true, StatusCode: 200,
				Markdown: map[string]string{"raw_markdown": "# " + target + "\n\nb1 fixture"},
			}},
			Warnings: []string{},
		})
	})

	// Part A - the deterministic B1 proof. The node chain exposes
	// CrawlFrontierService.updateRunMetadata / updateNodeMetadata as
	// updateRunMetadataLocked / updateNodeMetadataLocked (record.go), which
	// delegate to the row-locked crawlfrontierllm writers. They are the package
	// path a node completion uses for a run/node metadata patch; today the only
	// run-level writer inside an execution is crawlfrontierllm.refreshRunStatus,
	// which keeps its unlocked read-compute-write, so these entry points are
	// called here directly. Eight concurrent patches to the same run row and the
	// same node row must all survive; an unlocked read-modify-write loses most of
	// them.
	const writers = 8
	lockService := h.service()
	var lockGroup sync.WaitGroup
	lockErrors := make([]error, writers)
	for index := 0; index < writers; index++ {
		lockGroup.Add(1)
		go func(index int) {
			defer lockGroup.Done()
			key := "b1RunMarker" + strconv.Itoa(index)
			runPatch := crawlfrontierllm.NewObject()
			runPatch.SetString(key, strconv.Itoa(index))
			nodePatch := crawlfrontierllm.NewObject()
			nodePatch.SetString("b1NodeMarker"+strconv.Itoa(index), strconv.Itoa(index))
			if err := lockService.updateRunMetadataLocked(h.ctx, testRunID, runPatch); err != nil {
				lockErrors[index] = err
				return
			}
			lockErrors[index] = lockService.updateNodeMetadataLocked(h.ctx, testRootNodeID, nodePatch)
		}(index)
	}
	lockGroup.Wait()
	for index, err := range lockErrors {
		if err != nil {
			t.Fatalf("locked metadata writer %d: %v", index, err)
		}
	}
	runMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierRun WHERE id = ?", testRunID)
	nodeMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	for index := 0; index < writers; index++ {
		if got, ok := runMetadata.String("b1RunMarker" + strconv.Itoa(index)); !ok || got != strconv.Itoa(index) {
			t.Fatalf("run metadata lost b1RunMarker%d: %s", index, testMarshalJSONForTest(t, runMetadata))
		}
		if got, ok := nodeMetadata.String("b1NodeMarker" + strconv.Itoa(index)); !ok || got != strconv.Itoa(index) {
			t.Fatalf("node metadata lost b1NodeMarker%d: %s", index, testMarshalJSONForTest(t, nodeMetadata))
		}
	}

	// Part B - the end-to-end shape: two nodes of the same run complete
	// concurrently, each through its own Service instance (standing in for two
	// crawl workers). The per-node metadata patches live on the node rows, which
	// is where the chain writes them, so both must survive unchanged.
	workers := []*Service{h.service(), h.service()}
	var executionGroup sync.WaitGroup
	executionErrors := make([]error, 2)
	for index, nodeID := range []string{testRootNodeID, "node-frontier-node-b"} {
		executionGroup.Add(1)
		go func(index int, nodeID string) {
			defer executionGroup.Done()
			if _, err := workers[index].ProcessQueuedNode(h.ctx, nodeID, testOrgID, 0); err != nil {
				executionErrors[index] = err
			}
		}(index, nodeID)
	}
	executionGroup.Wait()
	for index, err := range executionErrors {
		if err != nil {
			t.Fatalf("concurrent node %d failed: %v", index, err)
		}
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlFrontierNode
		WHERE runId = ? AND status = 'completed'`, testRunID); got != 2 {
		t.Fatalf("completed nodes = %d, want 2", got)
	}
	if got := h.count(`SELECT COUNT(DISTINCT crawlResultId) FROM CrawlFrontierNode
		WHERE runId = ? AND crawlResultId IS NOT NULL`, testRunID); got != 2 {
		t.Fatalf("distinct crawlResultIds = %d, want 2", got)
	}
	if got := h.count("SELECT COUNT(*) FROM CrawlResult WHERE taskId = ?", testTaskID); got != 2 {
		t.Fatalf("CrawlResult rows = %d, want 2", got)
	}
	// Each node row keeps its own pre-existing warning flag, i.e. neither
	// completion overwrote the other node's metadata patch.
	firstNodeMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", testRootNodeID)
	if flags, _ := firstNodeMetadata.Strings("warningFlags"); len(flags) == 0 || flags[0] != "flag_a" {
		t.Fatalf("node A warningFlags = %v", flags)
	}
	secondNodeMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierNode WHERE id = ?", "node-frontier-node-b")
	if flags, _ := secondNodeMetadata.Strings("warningFlags"); len(flags) == 0 || flags[0] != "flag_b" {
		t.Fatalf("node B warningFlags = %v", flags)
	}
	// The b1 markers from Part A are still on the rows after both completions.
	afterMetadata := h.jsonObject("SELECT metadata FROM CrawlFrontierRun WHERE id = ?", testRunID)
	for index := 0; index < writers; index++ {
		if _, ok := afterMetadata.String("b1RunMarker" + strconv.Itoa(index)); !ok {
			t.Fatalf("run metadata lost b1RunMarker%d after the concurrent completions: %s",
				index, testMarshalJSONForTest(t, afterMetadata))
		}
	}
}

// ---------------------------------------------------------------------------
// Error contract: the two NestJS messages a crawl job can surface unchanged
// ---------------------------------------------------------------------------

func TestFrontierNodeMissingCrawlTaskID(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	// No crawlTaskId on the run: processQueuedNode throws the BadRequestException
	// text the worker classifies as non-retryable.
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, SeedURL: "https://example.com",
		ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) { return http.StatusOK, testHomeCrawlBody("unused") })
	service := h.service()

	_, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOrgID, 0)
	if err == nil {
		t.Fatal("a run without crawlTaskId must fail")
	}
	if got := err.Error(); got != "Crawl frontier run is missing crawlTaskId" {
		t.Fatalf("error = %q, want the NestJS message", got)
	}
	var nestErr *crawlfrontierllm.NestError
	if !errors.As(err, &nestErr) || nestErr.Status != 400 {
		t.Fatalf("error status = %+v, want a 400 NestError", nestErr)
	}
	if got := h.requests.Load(); got != 0 {
		t.Fatalf("crawl requests = %d, want 0", got)
	}
	// NestJS throws this BadRequest before its `try { ... } catch` block, so the
	// failed-node bookkeeping (node.lastError, run.lastError, the
	// frontier_node_failed event) never runs: the node stays queued and the run
	// stays queued.
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "queued" {
		t.Fatalf("node status = %q, want queued", got)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "" {
		t.Fatalf("node lastError = %q, want NULL", got)
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "queued" {
		t.Fatalf("run status = %q, want queued", got)
	}
	if got := h.scalar("SELECT lastError FROM CrawlFrontierRun WHERE id = ?", testRunID); got != "" {
		t.Fatalf("run lastError = %q, want NULL", got)
	}
	if got := h.count(`SELECT COUNT(*) FROM CrawlStrategyWorkflowRunEvent WHERE eventType = 'frontier_node_failed'`); got != 0 {
		t.Fatalf("frontier_node_failed events = %d, want 0", got)
	}
}

func TestFrontierNodeNotFoundForOtherOrg(t *testing.T) {
	h := testNewNodeHarness(t)
	h.insertProfile(testProfileID, "layered", `{"seedDiscovery":{"strategy":"frontier_only"}}`)
	h.insertTask(testTaskID)
	h.insertRun(testRunSeed{
		ID: testRunID, ProfileID: testProfileID, CrawlTaskID: testTaskID, SeedURL: "https://example.com",
		ExecutionMode: "layered", Status: "queued", MaxDepth: 3, MaxPages: 10,
	})
	h.insertNode(testNodeSeed{
		ID: testRootNodeID, RunID: testRunID, URL: "https://example.com", PageType: "home",
		Depth: 0, QueueClass: "hot", Status: "queued",
	})
	h.startCrawl4ai(func(string) (int, string) { return http.StatusOK, testHomeCrawlBody("unused") })
	service := h.service()

	_, err := service.ProcessQueuedNode(h.ctx, testRootNodeID, testOtherOrgID, 0)
	if err == nil {
		t.Fatal("a cross-tenant node id must fail")
	}
	// The same answer a missing node gets, so the worker cannot probe foreign
	// ids.
	if got := err.Error(); got != "Crawl frontier node not found" {
		t.Fatalf("error = %q, want the NestJS message", got)
	}
	var nestErr *crawlfrontierllm.NestError
	if !errors.As(err, &nestErr) || nestErr.Status != 404 {
		t.Fatalf("error status = %+v, want a 404 NestError", nestErr)
	}
	if got := h.scalar("SELECT status FROM CrawlFrontierNode WHERE id = ?", testRootNodeID); got != "queued" {
		t.Fatalf("node status = %q, want queued (untouched)", got)
	}
	if got := h.requests.Load(); got != 0 {
		t.Fatalf("crawl requests = %d, want 0", got)
	}
}

// testMarshalJSONForTest renders an ordered object for failure messages.
func testMarshalJSONForTest(t *testing.T, object *crawlfrontierllm.Object) string {
	t.Helper()
	encoded, err := object.MarshalJSON()
	if err != nil {
		return fmt.Sprintf("<marshal error: %v>", err)
	}
	return string(encoded)
}
