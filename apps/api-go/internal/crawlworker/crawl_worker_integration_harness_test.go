//go:build integration

// Shared harness of the crawl4ai BullMQ worker integration tests.
//
// The tests run against the MySQL 8.4, Redis 7.2 and Mongo 7.0 services of the
// api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// crawl4ai itself, the media origin and the object storage are fakes: every
// outbound call is served by a local httptest server, so no test reaches a real
// service and no test needs network access.
//
// The MySQL tables are rebuilt from a reduced copy of
// packages/db/prisma/schema.prisma inside the test (the #114 schema isolation
// pattern): this file drops and recreates exactly the tables it owns, so the
// narrow column set stays exact and a later step of the same CI job can rebuild
// its own tables on top.

package crawlworker

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	mongooptions "go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/objectstorage"
)

const (
	// crawlIntegrationOrgID is the tenant every seeded row belongs to.
	crawlIntegrationOrgID = "org-crawl-worker-it"
	// crawlIntegrationUserID is the triggeredById of the notification jobs.
	crawlIntegrationUserID = "user-crawl-worker-it"
	// crawlIntegrationTarget is the CrawlTask.targetUrl. The host is a public IP
	// literal, so the shared SSRF rules accept it without a DNS lookup while no
	// request ever leaves the process (every HTTP client is either the fake
	// crawl4ai client or a scripted transport).
	crawlIntegrationTarget = "https://8.8.8.8/article/2026/10/21/integration-story"
	// crawlIntegrationRunID is the runId of the fake crawl4ai response.
	crawlIntegrationRunID = "run-crawl-worker-it-1"

	// crawlNotificationChannel is the generic notification relay channel the
	// crawl notifications are published on.
	crawlNotificationChannel = "notification:events:v1"
	// crawlLegacyNotificationChannel is the legacy news source channel. The
	// crawl notifications must never be published there (double delivery).
	crawlLegacyNotificationChannel = "news-source:notifications:v1"

	// crawlResultContentsCollection is the Mongoose collection of
	// CrawlResultContent.
	crawlResultContentsCollection = "crawlresultcontents"
	// crawlTaskLogsCollection is the Mongoose collection of TaskLog.
	crawlTaskLogsCollection = "tasklogs"

	// crawlBullLimiterSentinel is the value BullMQ Worker.rateLimit writes.
	crawlBullLimiterSentinel = "9007199254740991"
)

// crawlIntegrationLogf writes the worker log lines to the test process log
// instead of t.Logf: the worker goroutines may still emit a line while the test
// finishes, and t.Logf panics afterwards.
func crawlIntegrationLogf(format string, args ...any) {
	log.Printf("[crawlworker-it] "+format, args...)
}

// crawlIntegrationTables are the tables the harness owns.
var crawlIntegrationTables = []string{
	"CrawlMediaAsset",
	"CrawlMediaBlob",
	"CrawlResult",
	"CrawlTask",
	"Notification",
	"NewsSource",
	"PipelineJob",
	"SystemSetting",
}

// crawlIntegrationSchema is the reduced Prisma schema of the tables the crawl
// worker and the crawl execution path touch. The columns are the ones the
// queries of the two packages name; everything else stays out.
var crawlIntegrationSchema = []string{
	"DROP TABLE IF EXISTS `CrawlMediaAsset`",
	"DROP TABLE IF EXISTS `CrawlMediaBlob`",
	"DROP TABLE IF EXISTS `CrawlResult`",
	"DROP TABLE IF EXISTS `CrawlTask`",
	"DROP TABLE IF EXISTS `Notification`",
	"DROP TABLE IF EXISTS `NewsSource`",
	"DROP TABLE IF EXISTS `PipelineJob`",
	"DROP TABLE IF EXISTS `SystemSetting`",
	`CREATE TABLE ` + "`CrawlTask`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`createdById`" + ` varchar(40) NOT NULL DEFAULT '',
		` + "`newsSourceId`" + ` varchar(40) NULL,
		` + "`targetUrl`" + ` text NOT NULL,
		` + "`displayName`" + ` varchar(255) NULL,
		` + "`status`" + ` varchar(32) NOT NULL DEFAULT 'pending',
		` + "`config`" + ` json NULL,
		` + "`keywords`" + ` json NULL,
		` + "`lastRunAt`" + ` datetime(3) NULL,
		` + "`lastSuccessAt`" + ` datetime(3) NULL,
		` + "`lastResultAt`" + ` datetime(3) NULL,
		` + "`lastCursor`" + ` varchar(255) NULL,
		` + "`lastError`" + ` text NULL,
		` + "`runCount`" + ` int NOT NULL DEFAULT 0,
		` + "`lastServerMemoryMb`" + ` double NULL,
		` + "`lastPeakMemoryMb`" + ` double NULL,
		` + "`lastMemoryEfficiency`" + ` double NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`CrawlResult`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`taskId`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`sourceUrl`" + ` text NOT NULL,
		` + "`sourceUrlFingerprint`" + ` varchar(64) NULL,
		` + "`fetchedAt`" + ` datetime(3) NOT NULL,
		` + "`markdownRef`" + ` varchar(191) NOT NULL DEFAULT '',
		` + "`contentHash`" + ` varchar(64) NOT NULL,
		` + "`metadata`" + ` json NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `),
		UNIQUE KEY ` + "`CrawlResult_taskId_contentHash_key`" + ` (` + "`taskId`" + `, ` + "`contentHash`" + `),
		KEY ` + "`CrawlResult_orgId_contentHash_fetchedAt_idx`" + ` (` + "`orgId`" + `, ` + "`contentHash`" + `, ` + "`fetchedAt`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`CrawlMediaAsset`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`resultId`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`taskId`" + ` varchar(40) NOT NULL,
		` + "`blobId`" + ` varchar(40) NULL,
		` + "`provider`" + ` varchar(16) NOT NULL DEFAULT 'mysql',
		` + "`kind`" + ` varchar(64) NOT NULL,
		` + "`sourceUrl`" + ` text NOT NULL,
		` + "`bytes`" + ` int NOT NULL,
		` + "`contentType`" + ` varchar(191) NULL,
		` + "`blobData`" + ` longblob NULL,
		` + "`storageKey`" + ` varchar(512) NULL,
		` + "`width`" + ` int NULL,
		` + "`height`" + ` int NULL,
		` + "`alt`" + ` text NULL,
		` + "`title`" + ` text NULL,
		` + "`desc`" + ` text NULL,
		` + "`poster`" + ` text NULL,
		` + "`format`" + ` varchar(64) NULL,
		` + "`metadata`" + ` json NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`CrawlMediaBlob`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`sha256`" + ` varchar(64) NOT NULL,
		` + "`bytes`" + ` int NOT NULL,
		` + "`contentType`" + ` varchar(191) NULL,
		` + "`blobData`" + ` longblob NOT NULL,
		` + "`refCount`" + ` int NOT NULL DEFAULT 1,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `),
		UNIQUE KEY ` + "`CrawlMediaBlob_orgId_sha256_key`" + ` (` + "`orgId`" + `, ` + "`sha256`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`Notification`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`userId`" + ` varchar(40) NULL,
		` + "`type`" + ` varchar(32) NOT NULL,
		` + "`title`" + ` varchar(255) NOT NULL,
		` + "`body`" + ` text NULL,
		` + "`data`" + ` json NULL,
		` + "`readAt`" + ` datetime(3) NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`NewsSource`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`name`" + ` varchar(191) NOT NULL,
		` + "`url`" + ` text NOT NULL,
		` + "`isActive`" + ` tinyint(1) NOT NULL DEFAULT 1,
		` + "`lastRunAt`" + ` datetime(3) NULL,
		` + "`lastSuccessAt`" + ` datetime(3) NULL,
		` + "`lastFailureAt`" + ` datetime(3) NULL,
		` + "`consecutiveFailures`" + ` int NOT NULL DEFAULT 0,
		` + "`circuitOpenUntil`" + ` datetime(3) NULL,
		` + "`nextRunAt`" + ` datetime(3) NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`PipelineJob`" + ` (
		` + "`id`" + ` varchar(40) NOT NULL,
		` + "`orgId`" + ` varchar(40) NOT NULL,
		` + "`sourceId`" + ` varchar(40) NULL,
		` + "`url`" + ` text NOT NULL,
		` + "`priority`" + ` int NOT NULL DEFAULT 0,
		` + "`status`" + ` varchar(32) NOT NULL DEFAULT 'pending',
		` + "`queueName`" + ` varchar(64) NOT NULL DEFAULT 'crawl-queue',
		` + "`completedAt`" + ` datetime(3) NULL,
		` + "`attempts`" + ` int NOT NULL DEFAULT 0,
		` + "`error`" + ` text NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`id`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
	`CREATE TABLE ` + "`SystemSetting`" + ` (
		` + "`key`" + ` varchar(191) NOT NULL,
		` + "`value`" + ` json NOT NULL,
		` + "`isPublic`" + ` tinyint(1) NOT NULL DEFAULT 0,
		` + "`description`" + ` varchar(255) NULL,
		` + "`createdAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		` + "`updatedAt`" + ` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		PRIMARY KEY (` + "`key`" + `)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

// crawlIntegration is one test's shared handles plus the fake crawl4ai service.
type crawlIntegration struct {
	t     *testing.T
	ctx   context.Context
	db    *sql.DB
	redis *redis.Client
	mongo *mongo.Database
	crawl *fakeCrawl4ai
	// now is the fixed clock of the crawl execution service. The BullMQ worker
	// keeps the real clock: the delayed/backoff timestamps of the Lua scripts
	// are compared against the worker's own timestamp.
	now time.Time
}

// newCrawlIntegration opens the three services and the fake crawl4ai server.
func newCrawlIntegration(t *testing.T) *crawlIntegration {
	t.Helper()
	harness := &crawlIntegration{
		t:     t,
		ctx:   context.Background(),
		db:    openCrawlIntegrationDB(t),
		redis: openCrawlIntegrationRedis(t),
		mongo: openCrawlIntegrationMongo(t),
		crawl: newFakeCrawl4ai(t),
		now:   time.Now().UTC().Truncate(time.Millisecond),
	}
	return harness
}

// executionService builds the crawl execution service on the harness handles.
func (h *crawlIntegration) executionService(config crawlexecution.Config, relay crawlexecution.NotificationRelayPublisher) *crawlexecution.Service {
	return crawlexecution.New(crawlexecution.Options{
		DB:      h.db,
		Mongo:   h.mongo,
		Redis:   h.redis,
		Config:  config,
		Now:     func() time.Time { return h.now },
		Storage: mysqlStorageConfig{},
		Relay:   relay,
	})
}

// crawlConfig is the crawl4ai wiring of the fake server. Media persistence is
// enabled only for the success test.
func (h *crawlIntegration) crawlConfig(media bool) crawlexecution.Config {
	config := crawlexecution.Config{
		CrawlBaseURL:          h.crawl.baseURL(),
		CrawlTimeoutMs:        15_000,
		CrawlHealthCheckTTLMs: 60_000,
	}
	if media {
		config.MediaFetchTimeoutMs = 5_000
		config.MediaMaxBytes = 1 << 20
		config.MediaMaxPerResult = 6
	}
	return config
}

// setSettings stores the normalized crawl client settings document. The crawl
// settings reader prefers this cache over the SystemSetting row, so every test
// controls concurrency, retries and the conditional-request switch here.
func (h *crawlIntegration) setSettings(t *testing.T, document string) {
	t.Helper()
	if err := h.redis.Set(h.ctx, crawlqueue.CrawlSettingsCacheKey, document, 0).Err(); err != nil {
		t.Fatalf("seed crawl client settings: %v", err)
	}
}

// insertTask seeds one CrawlTask row.
func (h *crawlIntegration) insertTask(t *testing.T, seed crawlTaskSeed) {
	t.Helper()
	config := seed.Config
	if config == "" {
		config = "{}"
	}
	createdBy := seed.CreatedByID
	if createdBy == "" {
		createdBy = crawlIntegrationUserID
	}
	targetURL := seed.TargetURL
	if targetURL == "" {
		targetURL = crawlIntegrationTarget
	}
	status := seed.Status
	if status == "" {
		status = "queued"
	}
	if _, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `CrawlTask` (`id`, `orgId`, `createdById`, `newsSourceId`, `targetUrl`, `displayName`, `status`, `config`, `keywords`, `runCount`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?)",
		seed.ID, crawlIntegrationOrgID, createdBy, nullableCrawlString(seed.SourceID), targetURL,
		nullableCrawlString(seed.DisplayName), status, config, h.now, h.now); err != nil {
		t.Fatalf("insert crawl task %s: %v", seed.ID, err)
	}
}

// crawlTaskRow is the CrawlTask projection the assertions read.
type crawlTaskRow struct {
	Status             string
	RunCount           int
	LastError          sql.NullString
	LastResultAt       sql.NullTime
	LastSuccessAt      sql.NullTime
	LastRunAt          sql.NullTime
	LastCursor         sql.NullString
	LastServerMemoryMB sql.NullFloat64
	LastPeakMemoryMB   sql.NullFloat64
}

// readTask loads the CrawlTask projection of one task.
func (h *crawlIntegration) readTask(t *testing.T, taskID string) crawlTaskRow {
	t.Helper()
	var row crawlTaskRow
	err := h.db.QueryRowContext(h.ctx,
		"SELECT `status`, `runCount`, `lastError`, `lastResultAt`, `lastSuccessAt`, `lastRunAt`, `lastCursor`, `lastServerMemoryMb`, `lastPeakMemoryMb` "+
			"FROM `CrawlTask` WHERE `id` = ? AND `orgId` = ?", taskID, crawlIntegrationOrgID).
		Scan(&row.Status, &row.RunCount, &row.LastError, &row.LastResultAt, &row.LastSuccessAt, &row.LastRunAt,
			&row.LastCursor, &row.LastServerMemoryMB, &row.LastPeakMemoryMB)
	if err != nil {
		t.Fatalf("read crawl task %s: %v", taskID, err)
	}
	return row
}

// crawlTaskSeed is one seeded CrawlTask row.
type crawlTaskSeed struct {
	ID          string
	Status      string
	TargetURL   string
	DisplayName *string
	Config      string
	SourceID    *string
	CreatedByID string
}

// crawlEnqueueOptions is the per-job producer input of a test.
type crawlEnqueueOptions struct {
	TriggeredByID *string
	SourceID      *string
	// RetainCompleted patches removeOnComplete to false so the completed job
	// hash (the `returnvalue` this worker writes) survives for the assertions.
	// The production producer removes completed jobs immediately.
	RetainCompleted bool
}

// enqueueTask produces one crawl-task job through the real crawlqueue producer
// and returns its BullMQ job id.
func (h *crawlIntegration) enqueueTask(t *testing.T, taskID string, options crawlEnqueueOptions) string {
	t.Helper()
	producer := crawlqueue.NewProducer(crawlqueue.Options{Redis: h.redis, DB: h.db})
	result, err := producer.EnqueueTask(h.ctx, taskID, crawlIntegrationOrgID, crawlqueue.EnqueueOptions{
		PriorityClass: crawlqueue.PriorityClassNormal,
		TriggeredByID: options.TriggeredByID,
		SourceID:      options.SourceID,
		TraceID:       "trace-" + taskID,
	})
	if err != nil {
		t.Fatalf("enqueue crawl task %s: %v", taskID, err)
	}
	if result.Deduplicated {
		t.Fatalf("crawl task %s was deduplicated, want a fresh job", taskID)
	}
	if options.RetainCompleted {
		h.retainCompletedJob(t, crawlqueue.QueueNormal, result.JobID)
	}
	return result.JobID
}

// retainCompletedJob rewrites the job options so BullMQ keeps the finished job
// hash and its completed-set entry.
func (h *crawlIntegration) retainCompletedJob(t *testing.T, queue, jobID string) {
	t.Helper()
	jobKey := "bull:" + queue + ":" + jobID
	raw, err := h.redis.HGet(h.ctx, jobKey, "opts").Result()
	if err != nil {
		t.Fatalf("read job opts %s: %v", jobID, err)
	}
	var options map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		t.Fatalf("decode job opts %s: %v", jobID, err)
	}
	options["removeOnComplete"] = json.RawMessage("false")
	encoded, err := json.Marshal(options)
	if err != nil {
		t.Fatalf("encode job opts %s: %v", jobID, err)
	}
	if err := h.redis.HSet(h.ctx, jobKey, "opts", string(encoded)).Err(); err != nil {
		t.Fatalf("patch job opts %s: %v", jobID, err)
	}
}

// startWorker builds and starts one crawl worker on the harness handles.
func (h *crawlIntegration) startWorker(t *testing.T, execution TaskRunner) (*Worker, *crawlBlockingClients) {
	t.Helper()
	worker, clients := h.newWorker(t, execution)
	if err := worker.Start(context.Background()); err != nil {
		t.Fatalf("start crawl worker: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = worker.Close(ctx)
		clients.closeAll()
	})
	return worker, clients
}

// newWorker builds (but does not start) one crawl worker.
func (h *crawlIntegration) newWorker(t *testing.T, execution TaskRunner) (*Worker, *crawlBlockingClients) {
	t.Helper()
	clients := &crawlBlockingClients{options: h.redis.Options()}
	t.Cleanup(clients.closeAll)
	worker, err := New(Options{
		Client:            h.redis,
		NewBlockingClient: clients.new,
		DB:                h.db,
		Execution:         execution,
		Frontier:          crawlFrontierProcessor{},
		Settings:          crawlqueue.NewSettingsReader(h.db, h.redis, nil),
		Activity:          crawlqueue.NewActivity(h.redis),
		Config: Config{
			MaxConcurrency:   1,
			DefaultTimeoutMs: 15_000,
			SettingsTTL:      100 * time.Millisecond,
		},
		Logger: crawlIntegrationLogf,
	})
	if err != nil {
		t.Fatalf("build crawl worker: %v", err)
	}
	return worker, clients
}

// crawlFrontierProcessor fails every Frontier node job: the tests never enqueue
// one, so a call means the worker routed a crawl-task job to the wrong branch.
type crawlFrontierProcessor struct{}

// ProcessQueuedNode implements FrontierNodeProcessor.
func (crawlFrontierProcessor) ProcessQueuedNode(context.Context, string, string, int) (json.RawMessage, error) {
	return nil, fmt.Errorf("crawlworker integration: unexpected frontier node job")
}

// crawlBlockingClients hands out and records the dedicated blocking
// connections. The count is the observable "one blocking connection per running
// queue worker" (the legacy-queue test asserts it).
type crawlBlockingClients struct {
	options *redis.Options

	mu      sync.Mutex
	clients []*redis.Client
}

// new creates one blocking client.
func (c *crawlBlockingClients) new() *redis.Client {
	client := redis.NewClient(c.options)
	c.mu.Lock()
	c.clients = append(c.clients, client)
	c.mu.Unlock()
	return client
}

// count reports how many blocking clients were created.
func (c *crawlBlockingClients) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.clients)
}

// closeAll closes every created client. Closing twice is a no-op error.
func (c *crawlBlockingClients) closeAll() {
	c.mu.Lock()
	clients := append([]*redis.Client(nil), c.clients...)
	c.mu.Unlock()
	for _, client := range clients {
		_ = client.Close()
	}
}

// mysqlStorageConfig is the objectstorage.ConfigReader of the media branch. It
// selects the MySQL provider, so the media branch never builds an S3 client.
type mysqlStorageConfig struct{}

// StorageRuntimeConfig implements objectstorage.ConfigReader.
func (mysqlStorageConfig) StorageRuntimeConfig(context.Context) (objectstorage.RuntimeConfig, error) {
	return objectstorage.RuntimeConfig{Provider: objectstorage.ProviderMySQL}, nil
}

// ---------------------------------------------------------------------------
// Redis assertions
// ---------------------------------------------------------------------------

// activityCount reads crawl:activity.activeTaskCount.
func (h *crawlIntegration) activityCount(t *testing.T) int64 {
	t.Helper()
	value, err := h.redis.HGet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField).Int64()
	if err != nil {
		if err == redis.Nil {
			return 0
		}
		t.Fatalf("read crawl activity counter: %v", err)
	}
	return value
}

// addActivity increments the crawl activity counter the way a producer does.
func (h *crawlIntegration) addActivity(t *testing.T, count int64) {
	t.Helper()
	if err := h.redis.HIncrBy(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField, count).Err(); err != nil {
		t.Fatalf("increment crawl activity counter: %v", err)
	}
}

// zcard reads the cardinality of one sorted set.
func (h *crawlIntegration) zcard(t *testing.T, key string) int64 {
	t.Helper()
	value, err := h.redis.ZCard(h.ctx, key).Result()
	if err != nil {
		t.Fatalf("zcard %s: %v", key, err)
	}
	return value
}

// listLength reads the length of one list.
func (h *crawlIntegration) listLength(t *testing.T, key string) int64 {
	t.Helper()
	value, err := h.redis.LLen(h.ctx, key).Result()
	if err != nil {
		t.Fatalf("llen %s: %v", key, err)
	}
	return value
}

// listContains reports whether one list holds the value.
func (h *crawlIntegration) listContains(t *testing.T, key, value string) bool {
	t.Helper()
	values, err := h.redis.LRange(h.ctx, key, 0, -1).Result()
	if err != nil {
		t.Fatalf("lrange %s: %v", key, err)
	}
	for _, entry := range values {
		if entry == value {
			return true
		}
	}
	return false
}

// jobField reads one field of a BullMQ job hash ("" when the field is absent).
func (h *crawlIntegration) jobField(t *testing.T, queue, jobID, field string) string {
	t.Helper()
	value, err := h.redis.HGet(h.ctx, "bull:"+queue+":"+jobID, field).Result()
	if err != nil {
		if err == redis.Nil {
			return ""
		}
		t.Fatalf("read job field %s/%s/%s: %v", queue, jobID, field, err)
	}
	return value
}

// jobExists reports whether the BullMQ job hash still exists.
func (h *crawlIntegration) jobExists(t *testing.T, queue, jobID string) bool {
	t.Helper()
	exists, err := h.redis.Exists(h.ctx, "bull:"+queue+":"+jobID).Result()
	if err != nil {
		t.Fatalf("exists job %s/%s: %v", queue, jobID, err)
	}
	return exists > 0
}

// crawlJobData is the `data` document of a BullMQ crawl job.
type crawlJobData struct {
	TaskID                 string `json:"taskId"`
	OrgID                  string `json:"orgId"`
	MemoryPressureRequeues int    `json:"memoryPressureRequeues"`
}

// jobData decodes the `data` document of a BullMQ crawl job.
func (h *crawlIntegration) jobData(t *testing.T, queue, jobID string) crawlJobData {
	t.Helper()
	raw := h.jobField(t, queue, jobID, "data")
	if raw == "" {
		t.Fatalf("job %s/%s has no data field", queue, jobID)
	}
	var data crawlJobData
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		t.Fatalf("decode job data %s/%s: %v", queue, jobID, err)
	}
	return data
}

// limiterValue reads bull:<queue>:limiter plus its remaining TTL in
// milliseconds. A missing key reports ("", -2).
func (h *crawlIntegration) limiterValue(t *testing.T, queue string) (string, time.Duration) {
	t.Helper()
	key := "bull:" + queue + ":limiter"
	value, err := h.redis.Get(h.ctx, key).Result()
	if err != nil {
		if err == redis.Nil {
			return "", -2
		}
		t.Fatalf("read limiter %s: %v", key, err)
	}
	ttl, err := h.redis.PTTL(h.ctx, key).Result()
	if err != nil {
		t.Fatalf("read limiter ttl %s: %v", key, err)
	}
	return value, ttl
}

// eventsContain reports whether the BullMQ events stream of one queue holds an
// entry with the given event name (and job id when jobID is not empty).
func (h *crawlIntegration) eventsContain(t *testing.T, queue, event, jobID string) bool {
	t.Helper()
	entries, err := h.redis.XRange(h.ctx, "bull:"+queue+":events", "-", "+").Result()
	if err != nil {
		t.Fatalf("read queue events %s: %v", queue, err)
	}
	for _, entry := range entries {
		if fmt.Sprint(entry.Values["event"]) != event {
			continue
		}
		if jobID == "" || fmt.Sprint(entry.Values["jobId"]) == jobID {
			return true
		}
	}
	return false
}

// countEvents counts the entries of one queue event name (and job id when set).
func (h *crawlIntegration) countEvents(t *testing.T, queue, event, jobID string) int {
	t.Helper()
	entries, err := h.redis.XRange(h.ctx, "bull:"+queue+":events", "-", "+").Result()
	if err != nil {
		t.Fatalf("read queue events %s: %v", queue, err)
	}
	count := 0
	for _, entry := range entries {
		if fmt.Sprint(entry.Values["event"]) != event {
			continue
		}
		if jobID != "" && fmt.Sprint(entry.Values["jobId"]) != jobID {
			continue
		}
		count++
	}
	return count
}

// ---------------------------------------------------------------------------
// notification relay
// ---------------------------------------------------------------------------

// crawlNotificationSubscription is the Redis pub/sub observer of the notification
// relay channel. The subscription is created before the job runs so a message
// published by the worker is never missed.
type crawlNotificationSubscription struct {
	client *redis.Client
	pubsub *redis.PubSub
	// payloads receives every published message body.
	payloads chan string
	// publishes counts the relay publisher invocations.
	publishes atomic.Int32
}

// subscribeNotifications subscribes notification:events:v1 on a dedicated PubSub
// connection before a job runs, so the relay message cannot be missed.
func (h *crawlIntegration) subscribeNotifications(t *testing.T) *crawlNotificationSubscription {
	t.Helper()
	subscription := &crawlNotificationSubscription{
		client:   h.redis,
		payloads: make(chan string, 16),
	}
	subscription.pubsub = h.redis.Subscribe(h.ctx, crawlNotificationChannel)
	if _, err := subscription.pubsub.Receive(h.ctx); err != nil {
		t.Fatalf("subscribe %s: %v", crawlNotificationChannel, err)
	}
	go func() {
		for message := range subscription.pubsub.Channel() {
			subscription.payloads <- message.Payload
		}
	}()
	t.Cleanup(func() { _ = subscription.pubsub.Close() })
	return subscription
}

// publish is the NotificationRelayPublisher the execution service calls. It
// publishes the identifiers-only envelope the production
// classificationrssops.NewRedisNotificationRelayPublisher writes.
func (s *crawlNotificationSubscription) publish(ctx context.Context, notificationID, orgID, userID string) error {
	s.publishes.Add(1)
	payload, err := json.Marshal(struct {
		Version        int    `json:"version"`
		NotificationID string `json:"notificationId"`
		OrgID          string `json:"orgId"`
		UserID         string `json:"userId,omitempty"`
	}{Version: 1, NotificationID: notificationID, OrgID: orgID, UserID: userID})
	if err != nil {
		return err
	}
	return s.client.Publish(ctx, crawlNotificationChannel, payload).Err()
}

// next waits for one relay message.
func (s *crawlNotificationSubscription) next(t *testing.T, timeout time.Duration) string {
	t.Helper()
	select {
	case payload := <-s.payloads:
		return payload
	case <-time.After(timeout):
		t.Fatalf("no notification relay message on %s within %s", crawlNotificationChannel, timeout)
		return ""
	}
}

// expectQuiet fails when another message arrives inside the quiet window.
func (s *crawlNotificationSubscription) expectQuiet(t *testing.T, window time.Duration) {
	t.Helper()
	select {
	case payload := <-s.payloads:
		t.Fatalf("unexpected extra notification relay message on %s: %s", crawlNotificationChannel, payload)
	case <-time.After(window):
	}
}

// crawlNotificationRelayMessage is the notification relay envelope.
type crawlNotificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId"`
}

// crawlNotificationData is the Notification.data payload of a crawl
// notification.
type crawlNotificationData struct {
	TaskID       string  `json:"taskId"`
	Status       string  `json:"status"`
	LastResultAt *string `json:"lastResultAt"`
	Presentation struct {
		Kind   string `json:"kind"`
		Params struct {
			TaskID            string  `json:"taskId"`
			TaskLabel         string  `json:"taskLabel"`
			Inserted          int     `json:"inserted"`
			Skipped           int     `json:"skipped"`
			RetryableFailures *int    `json:"retryableFailures"`
			LastResultAt      *string `json:"lastResultAt"`
		} `json:"params"`
		TechnicalDetail string `json:"technicalDetail"`
	} `json:"presentation"`
}

// crawlNotificationRow is one Notification row.
type crawlNotificationRow struct {
	ID     string
	OrgID  string
	UserID sql.NullString
	Type   string
	Title  string
	Body   sql.NullString
	Data   sql.NullString
}

// readNotifications loads every Notification row of the harness organization.
func (h *crawlIntegration) readNotifications(t *testing.T) []crawlNotificationRow {
	t.Helper()
	rows, err := h.db.QueryContext(h.ctx,
		"SELECT `id`, `orgId`, `userId`, `type`, `title`, `body`, `data` FROM `Notification` WHERE `orgId` = ? ORDER BY `createdAt`",
		crawlIntegrationOrgID)
	if err != nil {
		t.Fatalf("query notifications: %v", err)
	}
	defer func() { _ = rows.Close() }()
	notifications := make([]crawlNotificationRow, 0, 2)
	for rows.Next() {
		var row crawlNotificationRow
		if scanErr := rows.Scan(&row.ID, &row.OrgID, &row.UserID, &row.Type, &row.Title, &row.Body, &row.Data); scanErr != nil {
			t.Fatalf("scan notification: %v", scanErr)
		}
		notifications = append(notifications, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate notifications: %v", err)
	}
	return notifications
}

// decodeNotificationData decodes the Notification.data JSON.
func decodeCrawlNotificationData(t *testing.T, row crawlNotificationRow) crawlNotificationData {
	t.Helper()
	if !row.Data.Valid {
		t.Fatalf("notification %s has no data payload", row.ID)
	}
	var data crawlNotificationData
	if err := json.Unmarshal([]byte(row.Data.String), &data); err != nil {
		t.Fatalf("decode notification data %s: %v", row.ID, err)
	}
	return data
}

// ---------------------------------------------------------------------------
// TaskLog / CrawlResultContent assertions
// ---------------------------------------------------------------------------

// crawlTaskLogDocument is one TaskLog document.
type crawlTaskLogDocument struct {
	ID     bson.ObjectID `bson:"_id"`
	Queue  string        `bson:"queue"`
	JobID  string        `bson:"jobId"`
	OrgID  string        `bson:"orgId"`
	Stage  string        `bson:"stage"`
	Status string        `bson:"status"`
}

// readTaskLogs loads the TaskLog documents of one task.
func (h *crawlIntegration) readTaskLogs(t *testing.T, taskID string) []crawlTaskLogDocument {
	t.Helper()
	cursor, err := h.mongo.Collection(crawlTaskLogsCollection).Find(h.ctx, bson.D{{Key: "jobId", Value: taskID}})
	if err != nil {
		t.Fatalf("find task logs: %v", err)
	}
	defer func() { _ = cursor.Close(h.ctx) }()
	logs := make([]crawlTaskLogDocument, 0, 4)
	for cursor.Next(h.ctx) {
		var document crawlTaskLogDocument
		if err := cursor.Decode(&document); err != nil {
			t.Fatalf("decode task log: %v", err)
		}
		logs = append(logs, document)
	}
	if err := cursor.Err(); err != nil {
		t.Fatalf("iterate task logs: %v", err)
	}
	return logs
}

// crawlErrorTaskLogData is the data block of the error-stage TaskLog.
type crawlErrorTaskLogData struct {
	Attempt        int     `bson:"attempt"`
	MaxAttempts    int     `bson:"maxAttempts"`
	BackoffDelayMs *int    `bson:"backoffDelayMs"`
	Retryable      bool    `bson:"retryable"`
	WillRetry      bool    `bson:"willRetry"`
	NextRetryAt    *string `bson:"nextRetryAt"`
}

// taskLogErrorData reads the data block of the error-stage TaskLog. It returns
// nil when the stage was not written.
func (h *crawlIntegration) taskLogErrorData(t *testing.T, taskID string) *crawlErrorTaskLogData {
	t.Helper()
	var document struct {
		Data *crawlErrorTaskLogData `bson:"data"`
	}
	err := h.mongo.Collection(crawlTaskLogsCollection).
		FindOne(h.ctx, bson.D{{Key: "jobId", Value: taskID}, {Key: "stage", Value: "error"}}).
		Decode(&document)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil
		}
		t.Fatalf("read the error task log of %s: %v", taskID, err)
	}
	return document.Data
}

// crawlCompleteTaskLogData is the data block of the complete-stage TaskLog: the
// CrawlExecutionSummary itself.
type crawlCompleteTaskLogData struct {
	Inserted  int     `bson:"inserted"`
	Skipped   int     `bson:"skipped"`
	RunID     *string `bson:"runId"`
	Retryable *int    `bson:"retryableFailures"`
}

// taskLogCompleteData reads the data block of the complete-stage TaskLog. It
// returns nil when the stage was not written.
func (h *crawlIntegration) taskLogCompleteData(t *testing.T, taskID string) *crawlCompleteTaskLogData {
	t.Helper()
	var document struct {
		Data *crawlCompleteTaskLogData `bson:"data"`
	}
	err := h.mongo.Collection(crawlTaskLogsCollection).
		FindOne(h.ctx, bson.D{{Key: "jobId", Value: taskID}, {Key: "stage", Value: "complete"}}).
		Decode(&document)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return nil
		}
		t.Fatalf("read the complete task log of %s: %v", taskID, err)
	}
	return document.Data
}

// crawlResultContentDocument is the CrawlResultContent document projection.
type crawlResultContentDocument struct {
	ID         bson.ObjectID `bson:"_id"`
	TaskID     string        `bson:"taskId"`
	ResultID   string        `bson:"resultId"`
	Markdown   string        `bson:"markdown"`
	SourceURL  string        `bson:"sourceUrl"`
	CrawlRunID *string       `bson:"crawlRunId"`
	Media      *struct {
		Images []struct {
			Src  string  `bson:"src"`
			Alt  *string `bson:"alt"`
			Type *string `bson:"type"`
		} `bson:"images"`
	} `bson:"media"`
}

// readResultContent loads the CrawlResultContent document of one result.
func (h *crawlIntegration) readResultContent(t *testing.T, resultID string) crawlResultContentDocument {
	t.Helper()
	var document crawlResultContentDocument
	err := h.mongo.Collection(crawlResultContentsCollection).
		FindOne(h.ctx, bson.D{{Key: "resultId", Value: resultID}}).
		Decode(&document)
	if err != nil {
		t.Fatalf("read crawl result content %s: %v", resultID, err)
	}
	return document
}

// crawlResultRow is the CrawlResult row projection.
type crawlResultRow struct {
	ID          string
	MarkdownRef string
	ContentHash string
	SourceURL   string
	Metadata    sql.NullString
}

// readResult loads the single CrawlResult row of one task.
func (h *crawlIntegration) readResult(t *testing.T, taskID string) crawlResultRow {
	t.Helper()
	var row crawlResultRow
	err := h.db.QueryRowContext(h.ctx,
		"SELECT `id`, `markdownRef`, `contentHash`, `sourceUrl`, `metadata` FROM `CrawlResult` WHERE `taskId` = ?",
		taskID).Scan(&row.ID, &row.MarkdownRef, &row.ContentHash, &row.SourceURL, &row.Metadata)
	if err != nil {
		t.Fatalf("read crawl result of task %s: %v", taskID, err)
	}
	return row
}

// countResults counts the CrawlResult rows of one task.
func (h *crawlIntegration) countResults(t *testing.T, taskID string) int {
	t.Helper()
	var count int
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT COUNT(*) FROM `CrawlResult` WHERE `taskId` = ?", taskID).Scan(&count); err != nil {
		t.Fatalf("count crawl results of task %s: %v", taskID, err)
	}
	return count
}

// ---------------------------------------------------------------------------
// waiting
// ---------------------------------------------------------------------------

// waitFor polls a condition until the deadline.
func waitFor(t *testing.T, timeout time.Duration, description string, probe func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		if probe() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", timeout, description)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitForTaskStatus waits until the CrawlTask row reaches a status.
func (h *crawlIntegration) waitForTaskStatus(t *testing.T, taskID, status string, timeout time.Duration) {
	t.Helper()
	waitFor(t, timeout, "crawl task "+taskID+" status "+status, func() bool {
		return h.readTask(t, taskID).Status == status
	})
}

// waitForActivity waits until crawl:activity.activeTaskCount reaches a value.
func (h *crawlIntegration) waitForActivity(t *testing.T, expected int64, timeout time.Duration) {
	t.Helper()
	waitFor(t, timeout, fmt.Sprintf("crawl activity counter %d", expected), func() bool {
		return h.activityCount(t) == expected
	})
}

// waitForNotifications waits until at least count Notification rows exist.
func (h *crawlIntegration) waitForNotifications(t *testing.T, count int, timeout time.Duration) []crawlNotificationRow {
	t.Helper()
	var notifications []crawlNotificationRow
	waitFor(t, timeout, fmt.Sprintf("%d notification rows", count), func() bool {
		notifications = h.readNotifications(t)
		return len(notifications) >= count
	})
	return notifications
}

// waitForCompletedJob waits until the job hash carries the given BullMQ state
// set entry.
func (h *crawlIntegration) waitForCompletedJob(t *testing.T, queue, jobID string, timeout time.Duration) {
	t.Helper()
	waitFor(t, timeout, "completed job "+jobID, func() bool {
		_, err := h.redis.ZScore(h.ctx, "bull:"+queue+":completed", jobID).Result()
		return err == nil
	})
}

// ---------------------------------------------------------------------------
// fake crawl4ai
// ---------------------------------------------------------------------------

// fakeCrawl4ai serves /health, /crawl and a media object. The /crawl handler is
// scripted per call so the retry tests can answer 503/400 first and succeed
// later.
type fakeCrawl4ai struct {
	server *httptest.Server

	mu               sync.Mutex
	calls            int
	respond          func(call int) (status int, body string)
	media            []byte
	mediaContentType string
}

// newFakeCrawl4ai starts the fake crawl4ai server.
func newFakeCrawl4ai(t *testing.T) *fakeCrawl4ai {
	t.Helper()
	fake := &fakeCrawl4ai{
		media:            []byte("crawl-worker-integration-media-bytes"),
		mediaContentType: "image/png",
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(writer, "{}")
	})
	mux.HandleFunc("/crawl", func(writer http.ResponseWriter, _ *http.Request) {
		fake.mu.Lock()
		fake.calls++
		call := fake.calls
		respond := fake.respond
		fake.mu.Unlock()
		status, body := http.StatusOK, "{}"
		if respond != nil {
			status, body = respond(call)
		}
		writer.Header().Set("content-type", "application/json")
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, body)
	})
	mux.HandleFunc("/media/", func(writer http.ResponseWriter, _ *http.Request) {
		fake.mu.Lock()
		media := fake.media
		contentType := fake.mediaContentType
		fake.mu.Unlock()
		writer.Header().Set("content-type", contentType)
		writer.Header().Set("content-length", strconv.Itoa(len(media)))
		_, _ = writer.Write(media)
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

// baseURL is the crawl4ai base URL handed to the execution service.
func (f *fakeCrawl4ai) baseURL() string { return f.server.URL }

// mediaURL is the absolute media source URL returned inside the article.
func (f *fakeCrawl4ai) mediaURL() string { return f.server.URL + "/media/one.png" }

// mediaBytes returns the served media payload.
func (f *fakeCrawl4ai) mediaBytes() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.media
}

// crawlCalls reports how many /crawl requests were served.
func (f *fakeCrawl4ai) crawlCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// setRespond stores the /crawl script.
func (f *fakeCrawl4ai) setRespond(respond func(call int) (status int, body string)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.respond = respond
}

// ---------------------------------------------------------------------------
// crawl4ai wire payloads
// ---------------------------------------------------------------------------

// crawlWireResponse is the /crawl envelope the fake server returns.
type crawlWireResponse struct {
	RunID            string             `json:"runId"`
	ServerMemoryMB   float64            `json:"serverMemoryMb"`
	PeakMemoryMB     float64            `json:"peakMemoryMb"`
	MemoryEfficiency float64            `json:"memoryEfficiency"`
	Warnings         []string           `json:"warnings"`
	SystemEvents     []any              `json:"systemEvents"`
	Results          []crawlWireArticle `json:"results"`
}

// crawlWireArticle is one /crawl result entry.
type crawlWireArticle struct {
	URL         string          `json:"url"`
	Success     bool            `json:"success"`
	StatusCode  int             `json:"statusCode"`
	Markdown    string          `json:"markdown"`
	Metadata    json.RawMessage `json:"metadata"`
	PublishedAt string          `json:"publishedAt"`
	Media       json.RawMessage `json:"media"`
}

// crawlSuccessBody builds a successful /crawl body with one high-signal article.
// The markdown carries three sentence-bearing paragraphs so the quality
// assessment classifies it as a detail page instead of a low-signal aggregate,
// and the media bucket carries one absolute image URL of the fake server.
func crawlSuccessBody(index int, targetURL, mediaURL string) string {
	markdown := fmt.Sprintf(
		"## Integration story %d\n\n"+
			"The first paragraph of the integration story describes the crawl worker. It contains enough sentences to look like a real article.\n\n"+
			"The second paragraph keeps the word count above the low-signal threshold. It also mentions details of the crawl result persistence.\n\n"+
			"The third paragraph closes the story. Media assets, markdown references and notifications are all asserted by the tests.",
		index)
	media := json.RawMessage(fmt.Sprintf(
		`{"images":[{"src":%q,"alt":"Integration image","type":"image","width":640,"height":480}]}`,
		mediaURL))
	metadata := json.RawMessage(fmt.Sprintf(`{"title":"Integration story %d","source":"crawl-worker-it"}`, index))
	body, err := json.Marshal(crawlWireResponse{
		RunID:            crawlIntegrationRunID,
		ServerMemoryMB:   512,
		PeakMemoryMB:     640,
		MemoryEfficiency: 0.82,
		Warnings:         []string{},
		SystemEvents:     []any{},
		Results: []crawlWireArticle{{
			URL:         targetURL,
			Success:     true,
			StatusCode:  http.StatusOK,
			Markdown:    markdown,
			Metadata:    metadata,
			PublishedAt: "2026-10-20T08:00:00.000Z",
			Media:       media,
		}},
	})
	if err != nil {
		panic(err)
	}
	return string(body)
}

// crawlFailureBody is the JSON error body of a failing /crawl response.
func crawlFailureBody(message string) string {
	encoded, err := json.Marshal(struct {
		Message string `json:"message"`
	}{Message: message})
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

// crawlStringPointer returns a pointer to value.
func crawlStringPointer(value string) *string { return &value }

// nullableCrawlString maps an optional string onto a SQL NULL-able argument.
func nullableCrawlString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

// ---------------------------------------------------------------------------
// service handles
// ---------------------------------------------------------------------------

// openCrawlIntegrationDB opens MySQL and rebuilds the reduced schema.
func openCrawlIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL is not set")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	password, _ := parsed.User.Password()
	dsn := fmt.Sprintf("%s:%s@tcp(%s)/%s?parseTime=true&loc=UTC&charset=utf8mb4",
		parsed.User.Username(), password, parsed.Host, strings.TrimPrefix(parsed.Path, "/"))
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	for _, statement := range crawlIntegrationSchema {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("rebuild crawl worker schema: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, table := range crawlIntegrationTables {
			_, _ = db.Exec("DROP TABLE IF EXISTS `" + table + "`")
		}
		_ = db.Close()
	})
	return db
}

// openCrawlIntegrationRedis opens Redis and clears the crawl worker keys.
func openCrawlIntegrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	resetCrawlIntegrationRedis(t, client)
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// resetCrawlIntegrationRedis deletes the crawl queue keys, the activity counter
// and the crawl settings cache. The notification channel is pub/sub only, so it
// carries no state; its subscriptions are closed by their owner.
func resetCrawlIntegrationRedis(t *testing.T, client *redis.Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	keys, err := client.Keys(ctx, "bull:crawl4ai*").Result()
	if err != nil {
		t.Fatalf("list crawl queue keys: %v", err)
	}
	keys = append(keys, crawlqueue.ActivityHashKey, crawlqueue.CrawlSettingsCacheKey)
	if err := client.Del(ctx, keys...).Err(); err != nil {
		t.Fatalf("delete crawl worker keys: %v", err)
	}
}

// openCrawlIntegrationMongo connects Mongo and isolates one database per run.
func openCrawlIntegrationMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI is not set")
	}
	client, err := mongo.Connect(mongooptions.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	name := "app"
	if parsed, parseErr := url.Parse(uri); parseErr == nil {
		if trimmed := strings.TrimPrefix(parsed.Path, "/"); trimmed != "" {
			name = trimmed
		}
	}
	database := client.Database(name + "_crawlworker_it")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Fatalf("ping mongo: %v", err)
	}
	for _, collection := range []string{crawlResultContentsCollection, crawlTaskLogsCollection} {
		_, _ = database.Collection(collection).DeleteMany(ctx, bson.D{})
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_ = database.Drop(cleanupCtx)
		_ = client.Disconnect(cleanupCtx)
	})
	return database
}
