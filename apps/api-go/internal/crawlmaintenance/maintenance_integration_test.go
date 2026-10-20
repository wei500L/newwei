//go:build integration

// Integration coverage for the five crawl maintenance units. It runs against
// the real MySQL 8.4, Redis 7.2 and Mongo 7.0 services of the
// api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// The fixtures recreate only the tables these crons touch. The assertions
// inspect the MySQL rows, the raw Redis structures (crawl:activity, the
// adaptive state JSON, the tick gate, the cron leases and the worker
// concurrency broadcast) and the Mongo documents. They do not run a NestJS
// worker and do not switch execution ownership in a deployment.
package crawlmaintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/runtimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

type maintenanceHarness struct {
	ctx      context.Context
	db       *sql.DB
	redis    *redis.Client
	mongoDB  *mongo.Database
	mongo    *mongo.Client
	queue    *crawlqueue.Producer
	activity *crawlqueue.Activity
	now      time.Time
}

func newMaintenanceHarness(t *testing.T) *maintenanceHarness {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if redisAddr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	mongoURI := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if mongoURI == "" {
		t.Skip("MONGO_URI not set — integration test requires MongoDB")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	createMaintenanceTables(t, db)
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr, DB: 11, Protocol: 2})
	ctx := context.Background()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	databaseName := "crawl_maintenance_it_" + time.Now().UTC().Format("20060102150405")
	database := mongoClient.Database(databaseName)
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(cleanupCtx)
		_ = mongoClient.Disconnect(cleanupCtx)
		_ = redisClient.Close()
		_ = db.Close()
	})

	harness := &maintenanceHarness{
		ctx:     ctx,
		db:      db,
		redis:   redisClient,
		mongoDB: database,
		mongo:   mongoClient,
		now:     time.Now().UTC().Truncate(time.Millisecond),
	}
	harness.queue = crawlqueue.NewProducer(crawlqueue.Options{
		Redis: redisClient,
		DB:    db,
		Now:   func() time.Time { return harness.now },
	})
	harness.activity = crawlqueue.NewActivity(redisClient)
	return harness
}

func createMaintenanceTables(t *testing.T, db *sql.DB) {
	t.Helper()
	statements := []string{
		"DROP TABLE IF EXISTS `CrawlQualityTaskSnapshot`",
		"DROP TABLE IF EXISTS `CrawlResult`",
		"DROP TABLE IF EXISTS `CrawlTask`",
		"DROP TABLE IF EXISTS `MongoOutbox`",
		"DROP TABLE IF EXISTS `AuditLogOutbox`",
		"DROP TABLE IF EXISTS `AuditLog`",
		"DROP TABLE IF EXISTS `SystemSetting`",
		"DROP TABLE IF EXISTS `Org`",
		"CREATE TABLE `Org` (`id` varchar(30) NOT NULL, `isActive` tinyint(1) NOT NULL, PRIMARY KEY (`id`))",
		"CREATE TABLE `CrawlTask` (" +
			"`id` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL," +
			"`newsSourceId` varchar(30) DEFAULT NULL, `displayName` varchar(191) DEFAULT NULL," +
			"`config` json DEFAULT NULL, `status` varchar(20) NOT NULL," +
			"`lastRunAt` datetime(3) DEFAULT NULL, `lastError` text," +
			"`lastServerMemoryMb` double DEFAULT NULL, `lastPeakMemoryMb` double DEFAULT NULL," +
			"`createdAt` datetime(3) NOT NULL, `updatedAt` datetime(3) NOT NULL," +
			"PRIMARY KEY (`id`)," +
			"KEY `CrawlTask_status_updatedAt_id_idx` (`status`,`updatedAt`,`id`)," +
			"KEY `CrawlTask_status_lastRunAt_id_idx` (`status`,`lastRunAt`,`id`)," +
			"KEY `CrawlTask_org_createdAt_idx` (`orgId`,`createdAt`)," +
			"KEY `CrawlTask_org_updatedAt_id_idx` (`orgId`,`updatedAt`,`id`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `CrawlResult` (" +
			"`id` varchar(30) NOT NULL, `taskId` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL," +
			"`fetchedAt` datetime(3) NOT NULL, PRIMARY KEY (`id`), KEY `CrawlResult_org_fetchedAt_idx` (`orgId`,`fetchedAt`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `MongoOutbox` (" +
			"`id` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL, `type` varchar(40) NOT NULL," +
			"`payload` json NOT NULL, `status` varchar(20) NOT NULL, `attempts` int NOT NULL DEFAULT 0," +
			"`lastError` text, `availableAt` datetime(3) NOT NULL, `lockedAt` datetime(3) DEFAULT NULL," +
			"`createdAt` datetime(3) NOT NULL, `updatedAt` datetime(3) NOT NULL, PRIMARY KEY (`id`)," +
			"KEY `MongoOutbox_type_status_availableAt_createdAt_idx` (`type`,`status`,`availableAt`,`createdAt`)," +
			"KEY `MongoOutbox_type_status_lockedAt_createdAt_idx` (`type`,`status`,`lockedAt`,`createdAt`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `AuditLog` (" +
			"`id` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL, `actorId` varchar(30) DEFAULT NULL," +
			"`resource` varchar(100) NOT NULL, `action` varchar(100) NOT NULL, `metadata` json DEFAULT NULL," +
			"`ipAddress` varchar(64) DEFAULT NULL, `createdAt` datetime(3) NOT NULL, PRIMARY KEY (`id`)," +
			"KEY `AuditLog_orgId_createdAt_idx` (`orgId`,`createdAt`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `AuditLogOutbox` (" +
			"`id` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL, `payload` json NOT NULL," +
			"`status` varchar(20) NOT NULL, `attempts` int NOT NULL DEFAULT 0, `lastError` text," +
			"`availableAt` datetime(3) NOT NULL, `lockedAt` datetime(3) DEFAULT NULL," +
			"`createdAt` datetime(3) NOT NULL, `updatedAt` datetime(3) NOT NULL, PRIMARY KEY (`id`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `SystemSetting` (" +
			"`key` varchar(191) NOT NULL, `value` json NOT NULL, `isPublic` tinyint(1) NOT NULL DEFAULT 0," +
			"`description` varchar(191) DEFAULT NULL, `createdAt` datetime(3) NOT NULL," +
			"`updatedAt` datetime(3) NOT NULL, `updatedById` varchar(30) DEFAULT NULL, PRIMARY KEY (`key`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE `CrawlQualityTaskSnapshot` (" +
			"`taskId` varchar(30) NOT NULL, `orgId` varchar(30) NOT NULL, `sourceId` varchar(30) NOT NULL," +
			"`taskCreatedAt` datetime(3) NOT NULL, `taskUpdatedAt` datetime(3) NOT NULL, `rolledAt` datetime(3) NOT NULL," +
			"`lowSignalTaskCount` int NOT NULL DEFAULT 0, `expansionTriggeredTaskCount` int NOT NULL DEFAULT 0," +
			"`expansionImprovedTaskCount` int NOT NULL DEFAULT 0, `markdownCount` int NOT NULL DEFAULT 0," +
			"`markdownCharsTotal` int NOT NULL DEFAULT 0, `emptyMarkdownCount` int NOT NULL DEFAULT 0," +
			"`candidateRejectIncludePatternCount` int NOT NULL DEFAULT 0, `candidateRejectExcludePatternCount` int NOT NULL DEFAULT 0," +
			"`candidateRejectPublishConfidenceCount` int NOT NULL DEFAULT 0, `publishConfidenceLt04Count` int NOT NULL DEFAULT 0," +
			"`publishConfidenceFrom04To06Count` int NOT NULL DEFAULT 0, `publishConfidenceFrom06To08Count` int NOT NULL DEFAULT 0," +
			"`publishConfidenceGte08Count` int NOT NULL DEFAULT 0, `fitMarkdownPreferenceTaskCount` int NOT NULL DEFAULT 0," +
			"`headSignalAttemptedCount` int NOT NULL DEFAULT 0, `headSignalSucceededCount` int NOT NULL DEFAULT 0," +
			"`headSignalSoftFailureCount` int NOT NULL DEFAULT 0, `headSignalTruncatedCount` int NOT NULL DEFAULT 0," +
			"`headSignalNoPublishSignalCount` int NOT NULL DEFAULT 0, `preflightRunCount` int NOT NULL DEFAULT 0," +
			"`preflightFailureCount` int NOT NULL DEFAULT 0, `preflight304HitCount` int NOT NULL DEFAULT 0," +
			"`dedupeEvaluatedCount` int NOT NULL DEFAULT 0, `dedupeOrgReuseCount` int NOT NULL DEFAULT 0," +
			"`createdAt` datetime(3) NOT NULL, `updatedAt` datetime(3) NOT NULL, PRIMARY KEY (`taskId`)" +
			") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("create fixture table: %v\n%s", err, statement)
		}
	}
}

func (h *maintenanceHarness) insertTask(t *testing.T, id, orgID, status string, lastRunAt *time.Time, updatedAt time.Time, serverMemory, peakMemory *float64) {
	t.Helper()
	_, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `CrawlTask` (`id`, `orgId`, `newsSourceId`, `displayName`, `config`, `status`,"+
			" `lastRunAt`, `lastError`, `lastServerMemoryMb`, `lastPeakMemoryMb`, `createdAt`, `updatedAt`)"+
			" VALUES (?, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)",
		id, orgID, status, lastRunAt, serverMemory, peakMemory, updatedAt, updatedAt)
	if err != nil {
		t.Fatalf("insert crawl task %s: %v", id, err)
	}
}

func (h *maintenanceHarness) taskStatus(t *testing.T, id string) (string, sql.NullString) {
	t.Helper()
	var status string
	var lastError sql.NullString
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT `status`, `lastError` FROM `CrawlTask` WHERE `id` = ?", id).Scan(&status, &lastError); err != nil {
		t.Fatalf("read crawl task %s: %v", id, err)
	}
	return status, lastError
}

func (h *maintenanceHarness) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var value int
	if err := h.db.QueryRowContext(h.ctx, query, args...).Scan(&value); err != nil {
		t.Fatalf("count query failed: %v\n%s", err, query)
	}
	return value
}

func (h *maintenanceHarness) janitor(config JanitorConfig) *JanitorScheduler {
	return NewJanitorScheduler(JanitorDeps{
		DB:       h.db,
		Redis:    h.redis,
		Mongo:    h.mongoDB,
		Activity: h.activity,
		Queue:    h.queue,
		Config:   config,
		Now:      func() time.Time { return h.now },
		Logf:     t.Logf,
	})
}

func defaultJanitorConfig() JanitorConfig {
	return JanitorConfig{
		Enabled:          true,
		RunningTimeoutMs: 1_800_000,
		QueuedTimeoutMs:  43_200_000,
		BatchSize:        50,
		QueueScanLimit:   5_000,
		LockTTLMs:        120_000,
	}
}

// TestCrawlMaintenanceJanitorIntegration covers T1/A1/A2/B1/B2/B3.
func TestCrawlMaintenanceJanitorIntegration(t *testing.T) {
	h := newMaintenanceHarness(t)
	scheduler := h.janitor(defaultJanitorConfig())

	oldRunning := h.now.Add(-2 * time.Hour)
	oldQueued := h.now.Add(-13 * time.Hour)

	h.insertTask(t, "task-running", "org-j1", "running", &oldRunning, oldRunning, nil, nil)
	h.insertTask(t, "task-running-null", "org-j1", "running", nil, oldRunning, nil, nil)
	h.insertTask(t, "task-queued", "org-j2", "queued", nil, oldQueued, nil, nil)
	h.insertTask(t, "task-pending", "org-j2", "pending", nil, oldQueued, nil, nil)
	h.insertTask(t, "task-prioritized", "org-j1", "queued", nil, oldQueued, nil, nil)
	h.insertTask(t, "task-fresh", "org-j1", "queued", nil, h.now, nil, nil)

	if err := h.redis.HSet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField, "10").Err(); err != nil {
		t.Fatalf("seed activity counter: %v", err)
	}
	priority := 10
	enqueued, err := h.queue.EnqueueTask(h.ctx, "task-prioritized", "org-j1", crawlqueue.EnqueueOptions{
		PriorityClass:  crawlqueue.PriorityClassNormal,
		SourcePriority: &priority,
		TraceID:        "trace-janitor-it",
	})
	if err != nil {
		t.Fatalf("enqueue prioritized job: %v", err)
	}
	if enqueued.JobID == "" {
		t.Fatal("enqueue returned an empty job id")
	}

	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("janitor tick: %v", err)
	}

	for _, id := range []string{"task-running", "task-running-null", "task-queued", "task-pending"} {
		status, lastError := h.taskStatus(t, id)
		if status != "failed" {
			t.Errorf("%s status = %q, want failed", id, status)
		}
		if !lastError.Valid {
			t.Errorf("%s lastError is NULL", id)
		}
	}
	for _, id := range []string{"task-prioritized", "task-fresh"} {
		if status, _ := h.taskStatus(t, id); status != "queued" {
			t.Errorf("%s status = %q, want queued (B1: a prioritized job still counts)", id, status)
		}
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `AuditLog` WHERE `action` = 'auto_fail_stale'"); got != 3 {
		t.Errorf("audit rows = %d, want one per kind/organization group (3)", got)
	}
	rows, err := h.db.QueryContext(h.ctx, "SELECT `metadata` FROM `AuditLog` WHERE `action` = 'auto_fail_stale'")
	if err != nil {
		t.Fatalf("read audit metadata: %v", err)
	}
	kinds := make(map[string]bool)
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			t.Fatalf("scan audit metadata: %v", err)
		}
		var metadata janitorAuditMetadata
		if err := json.Unmarshal(raw, &metadata); err != nil {
			rows.Close()
			t.Fatalf("decode audit metadata: %v", err)
		}
		kinds[metadata.Kind] = true
		if len(metadata.TaskIDs) == 0 || metadata.Message == "" {
			rows.Close()
			t.Fatalf("incomplete audit metadata: %+v", metadata)
		}
	}
	rows.Close()
	if !kinds["running"] || !kinds["queued"] || !kinds["pending"] {
		t.Errorf("audit kinds = %v", kinds)
	}
	logs := h.mongoDB.Collection(taskLogsCollection)
	logCount, err := logs.CountDocuments(h.ctx, bson.D{{Key: "stage", Value: "cleanup"}, {Key: "status", Value: "failed"}})
	if err != nil {
		t.Fatalf("count task logs: %v", err)
	}
	if logCount != 4 {
		t.Errorf("cleanup task logs = %d, want 4", logCount)
	}
	activity := h.redis.HGet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField).Val()
	if activity != "7" {
		t.Errorf("activity count = %q, want 7 (10 seeded + 1 enqueue - 4 failed)", activity)
	}

	// B3: a task that is no longer in the scanned status is not failed, audited
	// or counted down.
	h.insertTask(t, "task-b3", "org-j1", "completed", nil, oldQueued, nil, nil)
	auditBefore := h.count(t, "SELECT COUNT(*) FROM `AuditLog`")
	activityBefore := h.redis.HGet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField).Val()
	if err := scheduler.failTasks(h.ctx, "queued", []staleTaskRow{
		{ID: "task-b3", OrgID: "org-j1", UpdatedAt: oldQueued},
	}, "should not apply"); err != nil {
		t.Fatalf("failTasks on a non-matching status: %v", err)
	}
	if status, _ := h.taskStatus(t, "task-b3"); status != "completed" {
		t.Fatalf("task-b3 status = %q, want completed (B3)", status)
	}
	if after := h.count(t, "SELECT COUNT(*) FROM `AuditLog`"); after != auditBefore {
		t.Fatalf("audit rows changed without an update: %d -> %d", auditBefore, after)
	}
	if after := h.redis.HGet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField).Val(); after != activityBefore {
		t.Fatalf("activity changed without an update: %q -> %q", activityBefore, after)
	}

	// Lock exclusivity: while the shared lease is held by another process the
	// tick cleans nothing.
	h.insertTask(t, "task-locked", "org-j3", "queued", nil, oldQueued, nil, nil)
	if err := h.redis.Set(h.ctx, "lock:"+janitorLockKey, "other-owner", time.Minute).Err(); err != nil {
		t.Fatalf("seed janitor lock: %v", err)
	}
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("locked janitor tick: %v", err)
	}
	if status, _ := h.taskStatus(t, "task-locked"); status != "queued" {
		t.Fatalf("task-locked status = %q, want queued while the lease is held", status)
	}
	if err := h.redis.Del(h.ctx, "lock:"+janitorLockKey).Err(); err != nil {
		t.Fatalf("release janitor lock: %v", err)
	}

	// B2: with a zero activity count a stale pending task is still reclaimed.
	if err := h.redis.HSet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField, "0").Err(); err != nil {
		t.Fatalf("reset activity counter: %v", err)
	}
	h.insertTask(t, "task-pending-idle", "org-j3", "pending", nil, oldQueued, nil, nil)
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("idle janitor tick: %v", err)
	}
	if status, _ := h.taskStatus(t, "task-pending-idle"); status != "failed" {
		t.Fatalf("task-pending-idle status = %q, want failed (B2)", status)
	}
	if status, _ := h.taskStatus(t, "task-fresh"); status != "queued" {
		t.Fatalf("task-fresh status = %q, want queued", status)
	}
}

// TestCrawlMaintenanceCleanupOutboxIntegration covers T2/A3 and the dead-letter
// and backoff branches.
func TestCrawlMaintenanceCleanupOutboxIntegration(t *testing.T) {
	h := newMaintenanceHarness(t)
	scheduler := NewCleanupOutboxScheduler(CleanupOutboxDeps{
		DB:    h.db,
		Redis: h.redis,
		Mongo: h.mongoDB,
		Now:   func() time.Time { return h.now },
		Rand:  func() float64 { return 0.5 },
		Logf:  t.Logf,
	})

	insertOutbox := func(id, orgID, payload, status string, attempts int, availableAt time.Time) {
		if _, err := h.db.ExecContext(h.ctx,
			"INSERT INTO `MongoOutbox` (`id`, `orgId`, `type`, `payload`, `status`, `attempts`,"+
				" `lastError`, `availableAt`, `lockedAt`, `createdAt`, `updatedAt`)"+
				" VALUES (?, ?, 'cleanup_crawl_results', ?, ?, ?, NULL, ?, NULL, ?, ?)",
			id, orgID, payload, status, attempts, availableAt, h.now, h.now); err != nil {
			t.Fatalf("insert outbox %s: %v", id, err)
		}
	}
	insertOutbox("outbox-valid", "org-c1", `{"type":"cleanup_crawl_results","taskId":"task-cleanup"}`, "pending", 0, h.now.Add(-time.Minute))
	insertOutbox("outbox-invalid", "org-c1", `{"type":"processed_item","taskId":"task-cleanup"}`, "pending", 0, h.now.Add(-time.Minute))
	insertOutbox("outbox-mismatch", "org-c2", `{"type":"cleanup_crawl_results","taskId":"task-cleanup","orgId":"org-c3"}`, "pending", 0, h.now.Add(-time.Minute))

	for _, document := range []any{
		bson.D{{Key: "taskId", Value: "task-cleanup"}, {Key: "createdAt", Value: h.now}},
		bson.D{{Key: "taskId", Value: "task-other"}, {Key: "createdAt", Value: h.now}},
	} {
		if _, err := h.mongoDB.Collection(cleanupCrawlResultContents).InsertOne(h.ctx, document); err != nil {
			t.Fatalf("insert crawl result content: %v", err)
		}
	}
	for _, document := range []any{
		bson.D{{Key: "orgId", Value: "org-c1"}, {Key: "queue", Value: crawlQueueName}, {Key: "jobId", Value: "task-cleanup"}, {Key: "stage", Value: "cleanup"}, {Key: "status", Value: "failed"}, {Key: "createdAt", Value: h.now}},
		bson.D{{Key: "orgId", Value: "org-c1"}, {Key: "queue", Value: "news_pipeline"}, {Key: "jobId", Value: "task-cleanup-suffix"}, {Key: "stage", Value: "crawl"}, {Key: "status", Value: "completed"}, {Key: "createdAt", Value: h.now}},
		bson.D{{Key: "orgId", Value: "org-c9"}, {Key: "queue", Value: crawlQueueName}, {Key: "jobId", Value: "task-cleanup"}, {Key: "stage", Value: "cleanup"}, {Key: "status", Value: "failed"}, {Key: "createdAt", Value: h.now}},
	} {
		if _, err := h.mongoDB.Collection(taskLogsCollection).InsertOne(h.ctx, document); err != nil {
			t.Fatalf("insert task log: %v", err)
		}
	}

	if err := scheduler.replayBatch(h.ctx); err != nil {
		t.Fatalf("cleanup replay: %v", err)
	}

	if got := h.count(t, "SELECT COUNT(*) FROM `MongoOutbox` WHERE `id` = 'outbox-valid'"); got != 0 {
		t.Errorf("outbox-valid still present")
	}
	if got, _ := h.mongoDB.Collection(cleanupCrawlResultContents).CountDocuments(h.ctx, bson.D{{Key: "taskId", Value: "task-cleanup"}}); got != 0 {
		t.Errorf("crawl result content rows = %d, want 0", got)
	}
	if got, _ := h.mongoDB.Collection(taskLogsCollection).CountDocuments(h.ctx, bson.D{{Key: "orgId", Value: "org-c1"}}); got != 0 {
		t.Errorf("org-c1 task logs = %d, want 0 (the regex jobId match ignores the queue, like NestJS)", got)
	}
	if got, _ := h.mongoDB.Collection(taskLogsCollection).CountDocuments(h.ctx, bson.D{{Key: "orgId", Value: "org-c9"}}); got != 1 {
		t.Errorf("other-org task logs = %d, want 1", got)
	}

	var invalidStatus, invalidError string
	var invalidAttempts int
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT `status`, `lastError`, `attempts` FROM `MongoOutbox` WHERE `id` = 'outbox-invalid'").
		Scan(&invalidStatus, &invalidError, &invalidAttempts); err != nil {
		t.Fatalf("read invalid outbox: %v", err)
	}
	if invalidStatus != "dead" || invalidError != "Invalid outbox payload" || invalidAttempts != 1 {
		t.Fatalf("invalid outbox = %s/%s/%d", invalidStatus, invalidError, invalidAttempts)
	}
	var mismatchStatus string
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT `status` FROM `MongoOutbox` WHERE `id` = 'outbox-mismatch'").Scan(&mismatchStatus); err != nil {
		t.Fatalf("read mismatch outbox: %v", err)
	}
	if mismatchStatus != "dead" {
		t.Fatalf("cross-tenant payload status = %q, want dead", mismatchStatus)
	}

	// Delivery failure: the scheduler without Mongo collections fails inside
	// deleteTaskResults, so the row is rescheduled with the documented backoff
	// and never becomes dead.
	// Inserted after the batch so the successful scheduler does not claim it.
	insertOutbox("outbox-failure", "org-c4", `{"type":"cleanup_crawl_results","taskId":"task-cleanup-failure"}`, "pending", 0, h.now.Add(-time.Minute))
	failing := NewCleanupOutboxScheduler(CleanupOutboxDeps{
		DB:    h.db,
		Redis: h.redis,
		Now:   func() time.Time { return h.now },
		Rand:  func() float64 { return 0.5 },
		Logf:  t.Logf,
	})
	if err := failing.deliverOutboxPayload(h.ctx, cleanupOutboxEntry{
		ID:        "outbox-failure",
		OrgID:     "org-c4",
		Status:    "pending",
		Attempts:  sql.NullInt64{Int64: 0, Valid: true},
		CreatedAt: h.now,
	}, "task-cleanup-failure"); err != nil {
		t.Fatalf("failing delivery: %v", err)
	}
	var failureStatus, failureError string
	var failureAttempts int
	var availableAt time.Time
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT `status`, `lastError`, `attempts`, `availableAt` FROM `MongoOutbox` WHERE `id` = 'outbox-failure'").
		Scan(&failureStatus, &failureError, &failureAttempts, &availableAt); err != nil {
		t.Fatalf("read failure outbox: %v", err)
	}
	if failureStatus != "failed" || failureAttempts != 1 {
		t.Fatalf("failure outbox = %s/%d, want failed/1", failureStatus, failureAttempts)
	}
	if !strings.Contains(failureError, "mongo is not configured") {
		t.Fatalf("failure lastError = %q", failureError)
	}
	if delay := availableAt.Sub(h.now).Milliseconds(); delay != 30_000 {
		t.Fatalf("failure backoff = %dms, want 30000ms", delay)
	}
}

type fixedConcurrency int

func (f fixedConcurrency) Read(context.Context) (int, error) { return int(f), nil }

// TestCrawlMaintenanceAdaptiveIntegration covers T3/A4/B4: the persisted
// setting, the global meta, the C2 broadcast and the cooldown branch.
func TestCrawlMaintenanceAdaptiveIntegration(t *testing.T) {
	h := newMaintenanceHarness(t)
	stored := `{"adaptiveConcurrencyEnabled":true,"adaptiveWindowMinutes":15,"adaptiveCooldownMinutes":5,` +
		`"adaptiveLatencyThresholdRatio":0.85,"adaptiveErrorRateThreshold":0.2,` +
		`"adaptiveMemoryHeadroomThreshold":0.12,"requestTimeoutNormalMs":1000,"maxConcurrency":3}`
	if _, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `SystemSetting` (`key`, `value`, `isPublic`, `description`, `createdAt`, `updatedAt`, `updatedById`)"+
			" VALUES ('crawl_client_settings', ?, 0, 'Crawl client runtime settings', ?, ?, NULL)",
		stored, h.now, h.now); err != nil {
		t.Fatalf("seed crawl settings: %v", err)
	}
	startedAt := h.now.Add(-2 * time.Minute)
	h.insertTask(t, "task-adaptive-1", "org-a1", "failed", &startedAt, h.now.Add(-time.Minute), nil, nil)
	h.insertTask(t, "task-adaptive-2", "org-a1", "completed", &startedAt, h.now.Add(-time.Minute), nil, nil)
	if err := h.redis.Del(h.ctx, adaptiveStateCacheKey).Err(); err != nil {
		t.Fatalf("clear adaptive state: %v", err)
	}
	if err := h.redis.HSet(h.ctx, crawlqueue.ActivityHashKey, crawlqueue.ActiveTaskCountField, "1").Err(); err != nil {
		t.Fatalf("seed activity counter: %v", err)
	}

	scheduler := NewAdaptiveScheduler(AdaptiveDeps{
		DB:       h.db,
		Redis:    h.redis,
		Settings: settingswrite.NewCrawlSettingsPort(h.db, h.redis),
		Activity: h.activity,
		Queue:    h.queue,
		Now:      func() time.Time { return h.now },
		Logf:     t.Logf,
	})
	pubsub := h.redis.Subscribe(h.ctx, crawlqueue.WorkerConcurrencyChannel)
	defer pubsub.Close()
	if _, err := pubsub.Receive(h.ctx); err != nil {
		t.Fatalf("subscribe worker concurrency channel: %v", err)
	}
	if err := scheduler.adjustConcurrency(h.ctx, h.now); err != nil {
		t.Fatalf("adaptive adjustment: %v", err)
	}

	messageCtx, cancel := context.WithTimeout(h.ctx, 5*time.Second)
	defer cancel()
	message, err := pubsub.ReceiveMessage(messageCtx)
	if err != nil {
		t.Fatalf("receive worker concurrency broadcast: %v", err)
	}
	if message.Payload != `{"version":1,"maxConcurrency":2}` {
		t.Fatalf("broadcast payload = %q", message.Payload)
	}

	var value []byte
	var updatedBy sql.NullString
	if err := h.db.QueryRowContext(h.ctx,
		"SELECT `value`, `updatedById` FROM `SystemSetting` WHERE `key` = 'crawl_client_settings'").
		Scan(&value, &updatedBy); err != nil {
		t.Fatalf("read crawl settings: %v", err)
	}
	var storedDocument struct {
		MaxConcurrency int `json:"maxConcurrency"`
	}
	if err := json.Unmarshal(value, &storedDocument); err != nil {
		t.Fatalf("decode crawl settings: %v", err)
	}
	if storedDocument.MaxConcurrency != 2 {
		t.Fatalf("stored maxConcurrency = %d, want 2", storedDocument.MaxConcurrency)
	}
	if updatedBy.Valid {
		t.Fatalf("updatedById = %q, want NULL for the machine write", updatedBy.String)
	}
	for _, queueName := range []string{crawlqueue.QueueHot, crawlqueue.QueueNormal, crawlqueue.QueueLegacy} {
		if got := h.redis.HGet(h.ctx, "bull:"+queueName+":meta", "concurrency").Val(); got != "2" {
			t.Errorf("%s meta concurrency = %q, want 2", queueName, got)
		}
	}
	rawState, err := h.redis.Get(h.ctx, adaptiveStateCacheKey).Bytes()
	if err != nil {
		t.Fatalf("read adaptive state: %v", err)
	}
	var state adaptiveStateDocument
	if err := json.Unmarshal(rawState, &state); err != nil {
		t.Fatalf("decode adaptive state: %v", err)
	}
	if state.LastDecision != "decrease" || state.CurrentMaxConcurrency != 2 ||
		state.LastAdjustedAt == nil || *state.LastAdjustedAt != formatISO(h.now) {
		t.Fatalf("adaptive state = %+v", state)
	}
	if state.Metrics.TaskCount != 2 || state.Metrics.FailedCount != 1 || state.Metrics.ErrorRate != 0.5 {
		t.Fatalf("adaptive metrics = %+v", state.Metrics)
	}
	if state.Metrics.P95LatencyMs == nil || *state.Metrics.P95LatencyMs != 60_000 {
		t.Fatalf("adaptive p95 = %v, want 60000", state.Metrics.P95LatencyMs)
	}
	if ttl := h.redis.TTL(h.ctx, adaptiveStateCacheKey).Val(); ttl <= 0 {
		t.Fatalf("adaptive state TTL = %v", ttl)
	}

	// A second adjustment inside the cooldown window only records the decision.
	if err := scheduler.adjustConcurrency(h.ctx, h.now); err != nil {
		t.Fatalf("second adaptive adjustment: %v", err)
	}
	rawState, err = h.redis.Get(h.ctx, adaptiveStateCacheKey).Bytes()
	if err != nil {
		t.Fatalf("read cooldown state: %v", err)
	}
	var cooldown adaptiveStateDocument
	if err := json.Unmarshal(rawState, &cooldown); err != nil {
		t.Fatalf("decode cooldown state: %v", err)
	}
	if cooldown.LastDecision != "cooldown" || cooldown.CurrentMaxConcurrency != 2 ||
		cooldown.LastAdjustedAt == nil || *cooldown.LastAdjustedAt != formatISO(h.now) {
		t.Fatalf("cooldown state = %+v", cooldown)
	}
}

// TestCrawlMaintenanceQualitySnapshotIntegration covers T4/A5/O3: the tick
// gate, the organization lease, discovery and the snapshot upsert.
func TestCrawlMaintenanceQualitySnapshotIntegration(t *testing.T) {
	h := newMaintenanceHarness(t)
	if _, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `Org` (`id`, `isActive`) VALUES ('org-q1', 1)"); err != nil {
		t.Fatalf("seed org: %v", err)
	}
	createdAt := h.now.Add(-time.Minute)
	lastRunAt := h.now.Add(-2 * time.Minute)
	h.insertTask(t, "task-quality", "org-q1", "completed", &lastRunAt, createdAt, nil, nil)
	if _, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `CrawlResult` (`id`, `taskId`, `orgId`, `fetchedAt`) VALUES ('result-q1', 'task-quality', 'org-q1', ?)",
		createdAt); err != nil {
		t.Fatalf("seed crawl result: %v", err)
	}
	if _, err := h.mongoDB.Collection(taskLogsCollection).InsertOne(h.ctx, bson.D{
		{Key: "orgId", Value: "org-q1"},
		{Key: "queue", Value: crawlQueueName},
		{Key: "jobId", Value: "task-quality"},
		{Key: "stage", Value: "expansion"},
		{Key: "status", Value: "completed"},
		{Key: "createdAt", Value: createdAt},
	}); err != nil {
		t.Fatalf("seed task log: %v", err)
	}

	scheduler := NewQualitySnapshotScheduler(QualitySnapshotDeps{
		DB:          h.db,
		Redis:       h.redis,
		Mongo:       h.mongoDB,
		Snapshots:   crawlreadtelemetry.NewService(h.db, h.redis, h.mongoDB, "", nil),
		Concurrency: fixedConcurrency(2),
		Now:         func() time.Time { return h.now },
		Logf:        t.Logf,
	})
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("quality tick: %v", err)
	}
	if !h.redis.Exists(h.ctx, qualityTickGateKey).Val() {
		t.Fatal("tick gate was not claimed")
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `CrawlQualityTaskSnapshot` WHERE `taskId` = 'task-quality'"); got != 1 {
		t.Fatalf("snapshot rows = %d, want 1", got)
	}

	// A second tick inside the gate lifetime is skipped and keeps the snapshot.
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("second quality tick: %v", err)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `CrawlQualityTaskSnapshot`"); got != 1 {
		t.Fatalf("snapshot rows after gated tick = %d, want 1", got)
	}

	// The organization lease blocks a competing run.
	if err := h.redis.Del(h.ctx, qualityTickGateKey).Err(); err != nil {
		t.Fatalf("clear tick gate: %v", err)
	}
	if err := h.db.ExecContext(h.ctx, "DELETE FROM `CrawlQualityTaskSnapshot`"); err != nil {
		t.Fatalf("clear snapshots: %v", err)
	}
	orgLockKey := "lock:" + qualityOrgLockPrefix + "org-q1"
	if err := h.redis.Set(h.ctx, orgLockKey, "other-owner", time.Minute).Err(); err != nil {
		t.Fatalf("seed org lock: %v", err)
	}
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("leased quality tick: %v", err)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `CrawlQualityTaskSnapshot`"); got != 0 {
		t.Fatalf("snapshot rows while the org lease is held = %d, want 0", got)
	}
	if err := h.redis.Del(h.ctx, orgLockKey).Err(); err != nil {
		t.Fatalf("release org lock: %v", err)
	}
	if err := h.redis.Del(h.ctx, qualityTickGateKey).Err(); err != nil {
		t.Fatalf("clear tick gate again: %v", err)
	}
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("released quality tick: %v", err)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `CrawlQualityTaskSnapshot` WHERE `taskId` = 'task-quality'"); got != 1 {
		t.Fatalf("snapshot rows after releasing the lease = %d, want 1", got)
	}
}

// TestCrawlMaintenanceAuditRetentionIntegration covers T5/A6/B5/O2: the lease,
// the 2500-row primary-key cursor and the untouched fresh rows.
func TestCrawlMaintenanceAuditRetentionIntegration(t *testing.T) {
	h := newMaintenanceHarness(t)
	if _, err := h.db.ExecContext(h.ctx,
		"INSERT INTO `SystemSetting` (`key`, `value`, `isPublic`, `description`, `createdAt`, `updatedAt`, `updatedById`)"+
			" VALUES ('audit_log_retention_days', '1', 0, 'Audit log retention in days', ?, ?, NULL)",
		h.now, h.now); err != nil {
		t.Fatalf("seed retention setting: %v", err)
	}
	if err := h.redis.Del(h.ctx, auditRetentionReaderCacheKey).Err(); err != nil {
		t.Fatalf("clear retention cache: %v", err)
	}
	expiredAt := h.now.Add(-48 * time.Hour)
	for index := 0; index < 2_500; index++ {
		id := fmt.Sprintf("c%024d", index)
		if _, err := h.db.ExecContext(h.ctx,
			"INSERT INTO `AuditLog` (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`)"+
				" VALUES (?, 'org-r1', NULL, 'x', 'y', NULL, NULL, ?)", id, expiredAt); err != nil {
			t.Fatalf("seed expired audit log %d: %v", index, err)
		}
	}
	for index := 0; index < 10; index++ {
		id := fmt.Sprintf("d%024d", index)
		if _, err := h.db.ExecContext(h.ctx,
			"INSERT INTO `AuditLog` (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`)"+
				" VALUES (?, 'org-r1', NULL, 'x', 'y', NULL, NULL, ?)", id, h.now); err != nil {
			t.Fatalf("seed fresh audit log %d: %v", index, err)
		}
	}

	scheduler := NewAuditRetentionScheduler(AuditRetentionDeps{
		DB:        h.db,
		Redis:     h.redis,
		Retention: runtimesettings.NewAuditLogRetentionReader(h.db, h.redis, 90),
		Now:       func() time.Time { return h.now },
		Logf:      t.Logf,
	})

	// The lease blocks a competing run.
	if err := h.redis.Set(h.ctx, "lock:"+auditRetentionLockKey, "other-owner", time.Minute).Err(); err != nil {
		t.Fatalf("seed retention lock: %v", err)
	}
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("leased retention tick: %v", err)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `AuditLog`"); got != 2_510 {
		t.Fatalf("rows while the lease is held = %d, want 2510", got)
	}
	if err := h.redis.Del(h.ctx, "lock:"+auditRetentionLockKey).Err(); err != nil {
		t.Fatalf("release retention lock: %v", err)
	}
	if err := scheduler.runTick(h.ctx); err != nil {
		t.Fatalf("retention tick: %v", err)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `AuditLog` WHERE `createdAt` < ?", h.now.Add(-24*time.Hour)); got != 0 {
		t.Fatalf("expired rows = %d, want 0", got)
	}
	if got := h.count(t, "SELECT COUNT(*) FROM `AuditLog`"); got != 10 {
		t.Fatalf("remaining rows = %d, want the 10 fresh rows", got)
	}
	if ttl := h.redis.TTL(h.ctx, auditRetentionReaderCacheKey).Val(); ttl <= 0 {
		t.Fatalf("retention cache TTL = %v", ttl)
	}
}

// auditRetentionReaderCacheKey is the shared cache key, duplicated here so the
// assertion does not depend on an unexported runtimesettings constant.
const auditRetentionReaderCacheKey = "audit_log:retention_days"
