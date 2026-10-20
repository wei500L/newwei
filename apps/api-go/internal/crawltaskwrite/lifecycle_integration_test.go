//go:build integration

// Integration coverage for the crawl task lifecycle and queue control units.
// It runs against the real MySQL 8.4 and Redis 7.2 services of the
// api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// The assertions inspect the MySQL rows and the raw BullMQ Redis structures the
// producer writes (job hash, wait/prioritized lists, deduplication key, meta and
// events). They prove the protocol shape; they do not run a NestJS worker
// against the job (the deployment validation is reported separately).
package crawltaskwrite

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

type lifecycleHarness struct {
	ctx    context.Context
	db     *sql.DB
	redis  *redis.Client
	svc    *Service
	caller *authhttp.Identity
}

func newLifecycleHarness(t *testing.T) *lifecycleHarness {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if redisAddr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	createLifecycleTables(t, db)
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr, DB: 9, Protocol: 2})
	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	redisClient.FlushDB(context.Background())
	t.Cleanup(func() {
		_ = redisClient.Close()
		_ = db.Close()
	})

	svc := NewService(Options{
		DB:    db,
		Redis: redisClient,
		Queue: crawlqueue.NewProducer(crawlqueue.Options{Redis: redisClient, DB: db}),
		Config: Config{
			DefaultConcurrency:             3,
			RateLimitFailOpen:              true,
			RateLimitCrawlTaskCreate:       1000,
			RateLimitCrawlTaskCreateWindow: 60,
		},
		Validator: &crawloptions.URLValidator{},
	})
	return &lifecycleHarness{
		ctx:    context.Background(),
		db:     db,
		redis:  redisClient,
		svc:    svc,
		caller: authhttp.NewIdentity("user-1", "org-lifecycle", []string{"crawl.write", "items.write", "settings.manage", "crawl.read"}),
	}
}

func (h *lifecycleHarness) reset(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		"DELETE FROM CrawlResult WHERE taskId LIKE 'task-lifecycle-%'",
		"DELETE FROM CrawlTask WHERE id LIKE 'task-lifecycle-%' OR orgId LIKE 'org-lifecycle%'",
		"DELETE FROM AuditLog WHERE orgId LIKE 'org-lifecycle%'",
		"DELETE FROM MongoOutbox WHERE orgId LIKE 'org-lifecycle%'",
		"DELETE FROM AuditLogOutbox WHERE orgId LIKE 'org-lifecycle%'",
		"DELETE FROM SystemSetting WHERE `key` IN ('crawl_client_settings','rate_limit_crawl_create')",
		"DELETE FROM RateLimitPolicy WHERE feature = 'crawl_task'",
		"DELETE FROM MembershipRole WHERE orgId LIKE 'org-lifecycle%'",
		"DELETE FROM Membership WHERE orgId LIKE 'org-lifecycle%'",
		"DELETE FROM Role WHERE orgId LIKE 'org-lifecycle%'",
	} {
		if _, err := h.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("reset (%s): %v", statement, err)
		}
	}
	if err := h.redis.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
}

func createLifecycleTables(t *testing.T, db *sql.DB) {
	t.Helper()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `Role` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `description` TEXT NULL, " +
			"`isSystem` BOOLEAN NOT NULL DEFAULT false, `orgId` VARCHAR(191) NOT NULL, PRIMARY KEY (`id`), " +
			"UNIQUE KEY `Role_orgId_name_key` (`orgId`,`name`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `Membership` (" +
			"`id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, " +
			"`roleId` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true, " +
			"`createdAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`), " +
			"UNIQUE KEY `Membership_userId_orgId_key` (`userId`,`orgId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `MembershipRole` (" +
			"`membershipId` VARCHAR(191) NOT NULL, `roleId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, " +
			"`createdAt` DATETIME(3) NOT NULL, PRIMARY KEY (`membershipId`,`roleId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `CrawlTask` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `createdById` VARCHAR(191) NOT NULL, " +
			"`newsSourceId` VARCHAR(191) NULL, `targetUrl` VARCHAR(1024) NOT NULL, `displayName` VARCHAR(191) NULL, " +
			"`status` VARCHAR(32) NOT NULL DEFAULT 'pending', `config` JSON NULL, " +
			"`timeRangeFrom` DATETIME(3) NULL, `timeRangeTo` DATETIME(3) NULL, `concurrency` INT NOT NULL DEFAULT 1, " +
			"`keywords` JSON NULL, `lastRunAt` DATETIME(3) NULL, `lastSuccessAt` DATETIME(3) NULL, " +
			"`lastResultAt` DATETIME(3) NULL, `lastCursor` VARCHAR(191) NULL, `lastError` TEXT NULL, " +
			"`runCount` INT NOT NULL DEFAULT 0, `lastServerMemoryMb` DOUBLE NULL, `lastPeakMemoryMb` DOUBLE NULL, " +
			"`lastMemoryEfficiency` DOUBLE NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (`id`), KEY `CrawlTask_org_createdAt_idx` (`orgId`,`createdAt`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `CrawlResult` (" +
			"`id` VARCHAR(191) NOT NULL, `taskId` VARCHAR(191) NOT NULL, `sourceUrl` VARCHAR(1024) NOT NULL, " +
			"`fetchedAt` DATETIME(3) NOT NULL, `metadata` JSON NULL, PRIMARY KEY (`id`), KEY `CrawlResult_taskId_idx` (`taskId`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `MongoOutbox` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `type` VARCHAR(191) NOT NULL, " +
			"`payload` JSON NOT NULL, `status` VARCHAR(191) NOT NULL, `attempts` INT NOT NULL DEFAULT 0, " +
			"`lastError` TEXT NULL, `availableAt` DATETIME(3) NOT NULL, `lockedAt` DATETIME(3) NULL, " +
			"`createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `AuditLog` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `actorId` VARCHAR(191) NULL, " +
			"`resource` VARCHAR(191) NOT NULL, `action` VARCHAR(191) NOT NULL, `metadata` JSON NULL, " +
			"`ipAddress` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `AuditLogOutbox` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `payload` JSON NOT NULL, " +
			"`status` VARCHAR(191) NOT NULL, `attempts` INT NOT NULL DEFAULT 0, `lastError` TEXT NULL, " +
			"`availableAt` DATETIME(3) NOT NULL, `lockedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, " +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false, " +
			"`description` TEXT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
			"`updatedById` VARCHAR(191) NULL, PRIMARY KEY (`key`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `RateLimitPolicy` (" +
			"`feature` VARCHAR(191) NOT NULL, `userLimit` INT NOT NULL, `ipLimit` INT NOT NULL, " +
			"`windowSeconds` INT NOT NULL, `enabled` BOOLEAN NOT NULL DEFAULT true, `description` TEXT NULL, " +
			"`createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`feature`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

func taskInput(t *testing.T, body string) crawloptions.CreateTaskInput {
	t.Helper()
	validation := crawloptions.ValidateCreateTaskREST(context.Background(), []byte(body), &crawloptions.URLValidator{})
	if len(validation.Messages) > 0 {
		t.Fatalf("validation messages: %v", validation.Messages)
	}
	return validation.Input
}

func (h *lifecycleHarness) insertTask(t *testing.T, id, org, status, config string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	var configValue any
	if config != "" {
		configValue = []byte(config)
	}
	if _, err := h.db.Exec(
		"INSERT INTO CrawlTask (id, orgId, createdById, targetUrl, status, config, concurrency, keywords, runCount, createdAt, updatedAt) "+
			"VALUES (?, ?, 'user-1', 'https://example.com', ?, ?, 3, '[]', 0, ?, ?)",
		id, org, status, configValue, now, now); err != nil {
		t.Fatalf("insert task: %v", err)
	}
}

func (h *lifecycleHarness) taskStatus(t *testing.T, id string) string {
	t.Helper()
	var status string
	if err := h.db.QueryRow("SELECT status FROM CrawlTask WHERE id = ?", id).Scan(&status); err != nil {
		t.Fatalf("select status: %v", err)
	}
	return status
}

func (h *lifecycleHarness) waitJobs(t *testing.T, queue string) []string {
	t.Helper()
	ids, err := h.redis.LRange(context.Background(), "bull:"+queue+":wait", 0, -1).Result()
	if err != nil {
		t.Fatalf("lrange wait: %v", err)
	}
	return ids
}

func (h *lifecycleHarness) activityCount(t *testing.T) int {
	t.Helper()
	raw, err := h.redis.HGet(context.Background(), "crawl:activity", "activeTaskCount").Result()
	if err == redis.Nil {
		return 0
	}
	if err != nil {
		t.Fatalf("hget activity: %v", err)
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		t.Fatalf("activity value %q: %v", raw, err)
	}
	return value
}

func TestCrawlTaskLifecycleCreate(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)

	view, err := h.svc.CreateTask(h.ctx, h.caller, taskInput(t, `{
		"url":"https://example.com/news",
		"displayName":"Decoded coverage",
		"keywords":[" Climate ","climate","policy"],
		"concurrency":2,
		"options":{"markdownFilter":{"type":"pruning","threshold":0.4,"thresholdType":"fixed","minWordThreshold":20}}
	}`), nil)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if view.Status != "queued" || view.Concurrency != 2 || view.ResultCount != 0 {
		t.Fatalf("view = %#v", view)
	}
	if len(view.Keywords) != 2 || view.Keywords[0] != "climate" {
		t.Fatalf("keywords = %v", view.Keywords)
	}
	if h.taskStatus(t, view.ID) != "queued" {
		t.Fatal("database status must be queued")
	}

	var count int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM AuditLog WHERE orgId = ? AND resource = 'crawlTask' AND action = 'create'", h.caller.OrgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("create audit rows = %d", count)
	}

	ids := h.waitJobs(t, crawlqueue.QueueNormal)
	if len(ids) != 1 {
		t.Fatalf("waiting jobs = %v", ids)
	}
	jobKey := "bull:" + crawlqueue.QueueNormal + ":" + ids[0]
	fields, err := h.redis.HGetAll(context.Background(), jobKey).Result()
	if err != nil {
		t.Fatal(err)
	}
	if fields["name"] != "crawl-task" || fields["delay"] != "0" || fields["priority"] != "0" {
		t.Fatalf("job hash = %#v", fields)
	}
	var data crawlqueue.TaskJobData
	if err := json.Unmarshal([]byte(fields["data"]), &data); err != nil {
		t.Fatalf("job data: %v", err)
	}
	if data.TaskID != view.ID || data.OrgID != h.caller.OrgID || data.PriorityClass != "normal" || data.MemoryPressureRequeues != 0 {
		t.Fatalf("job data = %#v", data)
	}
	if data.TriggeredByID == nil || *data.TriggeredByID != "user-1" || data.TraceID == "" {
		t.Fatalf("job attribution = %#v", data)
	}
	dedupID, err := h.redis.Get(context.Background(), "bull:"+crawlqueue.QueueNormal+":de:crawl-task:"+view.ID).Result()
	if err != nil || dedupID != ids[0] {
		t.Fatalf("dedup key = %q, err = %v, job = %s", dedupID, err, ids[0])
	}
	if got := h.activityCount(t); got != 1 {
		t.Fatalf("activeTaskCount = %d", got)
	}
	enqueuedAt, err := h.redis.HGet(context.Background(), "crawl:activity", "lastEnqueuedAt").Result()
	if err != nil || !strings.HasSuffix(enqueuedAt, "Z") {
		t.Fatalf("lastEnqueuedAt = %q, err = %v", enqueuedAt, err)
	}
	events, err := h.redis.XRange(context.Background(), "bull:"+crawlqueue.QueueNormal+":events", "-", "+").Result()
	if err != nil {
		t.Fatalf("events: %v", err)
	}
	if len(events) < 2 {
		t.Fatalf("expected added + waiting events, got %v", events)
	}
	if events[0].Values["event"] != "added" || events[len(events)-1].Values["event"] != "waiting" {
		t.Fatalf("events = %v", events)
	}
}

func TestCrawlTaskLifecycleDedup(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)

	first, err := h.svc.Producer().EnqueueTask(h.ctx, "task-lifecycle-dedup", h.caller.OrgID, crawlqueue.EnqueueOptions{
		PriorityClass: crawlqueue.PriorityClassNormal,
		TraceID:       "trace-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Deduplicated {
		t.Fatal("first add must not be deduplicated")
	}
	if got := h.activityCount(t); got != 1 {
		t.Fatalf("activeTaskCount = %d", got)
	}
	// The deduplication key is written under the queue's own `de:` prefix, so a
	// duplicate is only recognised inside the same queue (same as NestJS).
	second, err := h.svc.Producer().EnqueueTask(h.ctx, "task-lifecycle-dedup", h.caller.OrgID, crawlqueue.EnqueueOptions{
		PriorityClass: crawlqueue.PriorityClassNormal,
		TraceID:       "trace-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Deduplicated || second.JobID != first.JobID {
		t.Fatalf("second = %#v, first = %#v", second, first)
	}
	if got := h.activityCount(t); got != 1 {
		t.Fatalf("a deduplicated add must not increment the counter: %d", got)
	}
}

func TestCrawlTaskLifecyclePriorityRouting(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)

	priority := 80
	result, err := h.svc.Producer().EnqueueTask(h.ctx, "task-lifecycle-hot", h.caller.OrgID, crawlqueue.EnqueueOptions{
		PriorityClass:  crawlqueue.PriorityClassHot,
		SourcePriority: &priority,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.JobID == "" {
		t.Fatal("missing job id")
	}
	members, err := h.redis.ZRange(context.Background(), "bull:"+crawlqueue.QueueHot+":prioritized", 0, -1).Result()
	if err != nil || len(members) != 1 || members[0] != result.JobID {
		t.Fatalf("prioritized = %v, err = %v", members, err)
	}
	score, err := h.redis.ZScore(context.Background(), "bull:"+crawlqueue.QueueHot+":prioritized", result.JobID).Result()
	if err != nil {
		t.Fatal(err)
	}
	// priority = 101 - 80 = 21; the score is priority * 2^32 + counter.
	if score < 21*(1<<32) || score >= 22*(1<<32) {
		t.Fatalf("priority score = %f", score)
	}
	if len(h.waitJobs(t, crawlqueue.QueueHot)) != 0 {
		t.Fatal("a prioritized job must not enter the wait list")
	}
}

func TestCrawlTaskLifecycleRetry(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	h.insertTask(t, "task-lifecycle-retry", h.caller.OrgID, "failed", `{"sourcePriority":75}`)

	view, err := h.svc.RetryTask(h.ctx, h.caller, "task-lifecycle-retry", nil)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if view.Status != "queued" {
		t.Fatalf("status = %s", view.Status)
	}
	prioritized, err := h.redis.ZRange(h.ctx, "bull:"+crawlqueue.QueueHot+":prioritized", 0, -1).Result()
	if err != nil || len(prioritized) != 1 {
		t.Fatalf("sourcePriority >= 50 must enqueue a prioritized hot job: %v, err = %v", prioritized, err)
	}
	var count int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM AuditLog WHERE orgId = ? AND action = 'retry'", h.caller.OrgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("retry audit rows = %d", count)
	}

	for _, status := range []string{"running", "queued"} {
		h.insertTask(t, "task-lifecycle-conflict-"+status, h.caller.OrgID, status, "")
		_, err := h.svc.RetryTask(h.ctx, h.caller, "task-lifecycle-conflict-"+status, nil)
		code, message, ok := HTTPStatus(err)
		if !ok || code != 409 || !strings.Contains(message, "Cannot retry a task that is currently "+status) {
			t.Fatalf("%s retry = %v (%d, %q)", status, err, code, message)
		}
	}

	if _, err := h.svc.RetryTask(h.ctx, h.caller, "task-lifecycle-missing", nil); err == nil {
		t.Fatal("missing task must fail")
	} else if code, message, ok := HTTPStatus(err); !ok || code != 404 || message != "crawl task not found" {
		t.Fatalf("missing retry = %d %q", code, message)
	}
}

func TestCrawlTaskLifecycleRetryRollback(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	h.insertTask(t, "task-lifecycle-rollback", h.caller.OrgID, "failed", `{"ingestToItems":false}`)

	// A closed Redis client makes the enqueue fail after the status update.
	brokenRedis := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	_ = brokenRedis.Close()
	broken := NewService(Options{
		DB:    h.db,
		Redis: brokenRedis,
		Queue: crawlqueue.NewProducer(crawlqueue.Options{Redis: brokenRedis, DB: h.db}),
		Config: Config{DefaultConcurrency: 3, RateLimitFailOpen: true,
			RateLimitCrawlTaskCreate: 1000, RateLimitCrawlTaskCreateWindow: 60},
		Validator: &crawloptions.URLValidator{},
	})
	_, err := broken.RetryTask(h.ctx, h.caller, "task-lifecycle-rollback", nil)
	if err == nil {
		t.Fatal("enqueue failure must surface")
	}
	if code, _, ok := HTTPStatus(err); !ok || code != 500 {
		t.Fatalf("retry failure = %v", err)
	}
	if status := h.taskStatus(t, "task-lifecycle-rollback"); status != "failed" {
		t.Fatalf("C1 must roll the status back, got %s", status)
	}
}

func TestCrawlTaskLifecycleDelete(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	h.insertTask(t, "task-lifecycle-delete", h.caller.OrgID, "queued", "")
	now := time.Now().UTC().Truncate(time.Millisecond)
	for _, id := range []string{"result-lifecycle-1", "result-lifecycle-2"} {
		if _, err := h.db.Exec(
			"INSERT INTO CrawlResult (id, taskId, sourceUrl, fetchedAt, metadata) VALUES (?, 'task-lifecycle-delete', 'https://example.com', ?, '{}')",
			id, now); err != nil {
			t.Fatal(err)
		}
	}
	enqueued, err := h.svc.Producer().EnqueueTask(h.ctx, "task-lifecycle-delete", h.caller.OrgID, crawlqueue.EnqueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(h.waitJobs(t, crawlqueue.QueueNormal)) != 1 {
		t.Fatal("setup job missing")
	}
	if got := h.activityCount(t); got != 1 {
		t.Fatalf("setup activity = %d", got)
	}

	if err := h.svc.DeleteTask(h.ctx, h.caller, "task-lifecycle-delete"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(h.waitJobs(t, crawlqueue.QueueNormal)) != 0 {
		t.Fatalf("queue job survived delete: %v", h.waitJobs(t, crawlqueue.QueueNormal))
	}
	if exists, err := h.redis.Exists(h.ctx, "bull:"+crawlqueue.QueueNormal+":"+enqueued.JobID).Result(); err != nil || exists != 0 {
		t.Fatalf("job hash still exists: %d %v", exists, err)
	}
	if got := h.activityCount(t); got != 0 {
		t.Fatalf("activeTaskCount = %d", got)
	}
	var tasks, results int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM CrawlTask WHERE id = 'task-lifecycle-delete'").Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow("SELECT COUNT(*) FROM CrawlResult WHERE taskId = 'task-lifecycle-delete'").Scan(&results); err != nil {
		t.Fatal(err)
	}
	if tasks != 0 || results != 0 {
		t.Fatalf("tasks = %d, results = %d", tasks, results)
	}
	var payload []byte
	if err := h.db.QueryRow(
		"SELECT payload FROM MongoOutbox WHERE orgId = ? AND type = 'cleanup_crawl_results' AND status = 'pending'",
		h.caller.OrgID).Scan(&payload); err != nil {
		t.Fatalf("cleanup outbox: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	if document["type"] != "cleanup_crawl_results" || document["taskId"] != "task-lifecycle-delete" || document["orgId"] != h.caller.OrgID {
		t.Fatalf("outbox payload = %s", payload)
	}
	var metadata []byte
	if err := h.db.QueryRow(
		"SELECT metadata FROM AuditLog WHERE orgId = ? AND action = 'delete'", h.caller.OrgID).Scan(&metadata); err != nil {
		t.Fatalf("delete audit: %v", err)
	}
	var deleteMetadata struct {
		TaskID             string `json:"taskId"`
		DeletedResultCount int    `json:"deletedResultCount"`
	}
	if err := json.Unmarshal(metadata, &deleteMetadata); err != nil {
		t.Fatalf("delete audit json: %v", err)
	}
	if deleteMetadata.TaskID != "task-lifecycle-delete" || deleteMetadata.DeletedResultCount != 2 {
		t.Fatalf("delete audit metadata = %s", metadata)
	}

	// Cross-organization delete is a 404 with no side effects.
	h.insertTask(t, "task-lifecycle-other", "org-lifecycle-other", "queued", "")
	err = h.svc.DeleteTask(h.ctx, h.caller, "task-lifecycle-other")
	if code, message, ok := HTTPStatus(err); !ok || code != 404 || message != "Crawl task not found" {
		t.Fatalf("cross-org delete = %v", err)
	}
	var stillThere int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM CrawlTask WHERE id = 'task-lifecycle-other'").Scan(&stillThere); err != nil {
		t.Fatal(err)
	}
	if stillThere != 1 {
		t.Fatal("cross-org delete must not remove the row")
	}

	h.insertTask(t, "task-lifecycle-running", h.caller.OrgID, "running", "")
	err = h.svc.DeleteTask(h.ctx, h.caller, "task-lifecycle-running")
	if code, message, ok := HTTPStatus(err); !ok || code != 409 ||
		message != "Cannot delete a crawl task that is currently running" {
		t.Fatalf("running delete = %v", err)
	}
}

func TestCrawlTaskLifecycleQueueControls(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	ctx := h.ctx

	if err := h.svc.Producer().Pause(ctx); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []string{crawlqueue.QueueHot, crawlqueue.QueueNormal, crawlqueue.QueueLegacy} {
		paused, err := h.redis.HExists(ctx, "bull:"+queue+":meta", "paused").Result()
		if err != nil || !paused {
			t.Fatalf("%s paused = %v, err = %v", queue, paused, err)
		}
	}
	status, err := h.svc.QueueStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Paused {
		t.Fatal("all three queues paused must report paused")
	}
	if status.QueueName != "crawl4ai-hot,crawl4ai-normal" || status.LegacyQueueName != "crawl4ai" ||
		status.QueueMode != "dual" || status.Queues.Legacy == nil {
		t.Fatalf("status shape = %#v", status)
	}
	if status.Adaptive.Enabled || status.Adaptive.LastDecision != "disabled" ||
		status.Adaptive.Reason == nil || *status.Adaptive.Reason != "adaptive concurrency is disabled" {
		t.Fatalf("adaptive = %#v", status.Adaptive)
	}

	// Hot + normal paused, legacy has a backlog but is resumed: legacyBlocksPause
	// makes the aggregate paused=false.
	if _, err := h.redis.HDel(ctx, "bull:"+crawlqueue.QueueLegacy+":meta", "paused").Result(); err != nil {
		t.Fatal(err)
	}
	if err := h.redis.LPush(ctx, "bull:"+crawlqueue.QueueLegacy+":wait", "legacy-job-1").Err(); err != nil {
		t.Fatal(err)
	}
	status, err = h.svc.QueueStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Paused {
		t.Fatal("a resumed legacy queue with backlog must unblock the aggregate pause")
	}
	if _, err := h.redis.HSet(ctx, "bull:"+crawlqueue.QueueLegacy+":meta", "paused", 1).Result(); err != nil {
		t.Fatal(err)
	}
	status, err = h.svc.QueueStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Paused {
		t.Fatal("a paused legacy queue with backlog must keep the aggregate paused")
	}

	if err := h.svc.Producer().Resume(ctx); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.Producer().SetGlobalConcurrency(ctx, 7); err != nil {
		t.Fatal(err)
	}
	for _, queue := range []string{crawlqueue.QueueHot, crawlqueue.QueueNormal, crawlqueue.QueueLegacy} {
		value, err := h.redis.HGet(ctx, "bull:"+queue+":meta", "concurrency").Result()
		if err != nil || value != "7" {
			t.Fatalf("%s concurrency = %q, err = %v", queue, value, err)
		}
	}
	status, err = h.svc.QueueStatus(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Queues.Hot.EffectiveConcurrency != 7 || status.Queues.Normal.EffectiveConcurrency != 7 ||
		status.Queues.Legacy.EffectiveConcurrency != 7 {
		t.Fatalf("effective concurrency = %#v", status.Queues)
	}
}

func TestCrawlTaskLifecycleConcurrencyBroadcast(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	ctx := h.ctx

	pubsub := h.redis.Subscribe(ctx, crawlqueue.WorkerConcurrencyChannel)
	defer pubsub.Close()
	if _, err := pubsub.Receive(ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	update, err := h.svc.UpdateQueueConcurrency(ctx, h.caller, 9)
	if err != nil {
		t.Fatalf("update concurrency: %v", err)
	}
	if update.MaxConcurrency != 9 {
		t.Fatalf("updated = %d", update.MaxConcurrency)
	}
	select {
	case message := <-pubsub.Channel():
		var payload crawlqueue.WorkerConcurrencyMessage
		if err := json.Unmarshal([]byte(message.Payload), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Version != 1 || payload.MaxConcurrency != 9 {
			t.Fatalf("broadcast = %s", message.Payload)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no worker concurrency broadcast")
	}
	var stored []byte
	if err := h.db.QueryRow("SELECT value FROM SystemSetting WHERE `key` = 'crawl_client_settings'").Scan(&stored); err != nil {
		t.Fatalf("stored settings: %v", err)
	}
	var storedSettings struct {
		MaxConcurrency int `json:"maxConcurrency"`
	}
	// MySQL's JSON column re-serializes the document (with spaces), so the
	// field is compared after decoding rather than by substring.
	if err := json.Unmarshal(stored, &storedSettings); err != nil || storedSettings.MaxConcurrency != 9 {
		t.Fatalf("stored settings = %s (err = %v)", stored, err)
	}
	value, err := h.redis.HGet(ctx, "bull:"+crawlqueue.QueueHot+":meta", "concurrency").Result()
	if err != nil || value != "9" {
		t.Fatalf("meta concurrency = %q, err = %v", value, err)
	}
	cached, err := h.redis.Get(ctx, "crawl_client:settings").Result()
	if err != nil || !strings.Contains(cached, `"maxConcurrency":9`) {
		t.Fatalf("settings cache = %q, err = %v", cached, err)
	}
	var audit int
	if err := h.db.QueryRow(
		"SELECT COUNT(*) FROM AuditLog WHERE orgId = ? AND action = 'crawl_client_settings_update'",
		h.caller.OrgID).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	if audit != 1 {
		t.Fatalf("settings audit rows = %d", audit)
	}
}

func TestCrawlTaskLifecycleAdminGate(t *testing.T) {
	h := newLifecycleHarness(t)
	h.reset(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	const (
		customOrg = "org-lifecycle-custom"
		systemOrg = "org-lifecycle-system"
	)
	role := func(orgID, id, name string, isSystem bool) {
		if _, err := h.db.Exec("INSERT INTO Role (id, name, isSystem, orgId) VALUES (?, ?, ?, ?)",
			id, name, isSystem, orgID); err != nil {
			t.Fatalf("insert role %s: %v", id, err)
		}
	}
	membership := func(orgID, id, userID, roleID string) {
		if _, err := h.db.Exec("INSERT INTO Membership (id, userId, orgId, roleId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)",
			id, userID, orgID, roleID, now); err != nil {
			t.Fatalf("insert membership %s: %v", id, err)
		}
	}
	// The MySQL collation is case-insensitive, so a custom "admin" role and a
	// system "Admin" role cannot coexist in one organization; the two actors use
	// separate organizations instead.
	role(customOrg, "role-custom-admin", "admin", false)
	role(customOrg, "role-custom-member", "member", true)
	membership(customOrg, "membership-custom", "user-custom-admin", "role-custom-admin")
	role(systemOrg, "role-system-admin", "Admin", true)
	role(systemOrg, "role-system-member", "member", true)
	membership(systemOrg, "membership-system", "user-system-admin", "role-system-member")
	if _, err := h.db.Exec("INSERT INTO MembershipRole (membershipId, roleId, orgId, createdAt) VALUES (?, ?, ?, ?)",
		"membership-system", "role-system-admin", systemOrg, now); err != nil {
		t.Fatalf("insert additional role: %v", err)
	}

	if h.svc.isActorAdmin(h.ctx, customOrg, "user-custom-admin") {
		t.Fatal("a custom role named admin must not pass the C3 gate")
	}
	if h.svc.isActorAdmin(h.ctx, systemOrg, "user-system-admin") != true {
		t.Fatal("a system role named Admin (case-insensitive) must pass the C3 gate")
	}
	if h.svc.isActorAdmin(h.ctx, customOrg, "user-system-admin") {
		t.Fatal("a membership in another organization must not pass the C3 gate")
	}

	// End to end: the custom-admin user's jsCode is stripped, the system
	// admin's jsCode survives.
	customCaller := authhttp.NewIdentity("user-custom-admin", customOrg, []string{"crawl.write"})
	customView, err := h.svc.CreateTask(h.ctx, customCaller, taskInput(t, `{
		"url":"https://example.com/custom",
		"options":{"jsCode":["document.querySelector('#more').click()"],"jsOnly":true}
	}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var customConfig []byte
	if err := h.db.QueryRow("SELECT config FROM CrawlTask WHERE id = ?", customView.ID).Scan(&customConfig); err != nil {
		t.Fatal(err)
	}
	var customDocument struct {
		JSCode json.RawMessage `json:"jsCode"`
		JSOnly *bool           `json:"jsOnly"`
	}
	if err := json.Unmarshal(customConfig, &customDocument); err != nil {
		t.Fatalf("custom config json: %v", err)
	}
	if len(customDocument.JSCode) > 0 && string(customDocument.JSCode) != "null" {
		t.Fatalf("custom admin kept jsCode: %s", customConfig)
	}
	if customDocument.JSOnly != nil && *customDocument.JSOnly {
		t.Fatalf("custom admin kept jsOnly: %s", customConfig)
	}

	systemCaller := authhttp.NewIdentity("user-system-admin", systemOrg, []string{"crawl.write"})
	systemView, err := h.svc.CreateTask(h.ctx, systemCaller, taskInput(t, `{
		"url":"https://example.com/system",
		"options":{"jsCode":["document.querySelector('#more').click()"],"jsOnly":true}
	}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var systemConfig []byte
	if err := h.db.QueryRow("SELECT config FROM CrawlTask WHERE id = ?", systemView.ID).Scan(&systemConfig); err != nil {
		t.Fatal(err)
	}
	var systemDocument struct {
		JSCode json.RawMessage `json:"jsCode"`
		JSOnly *bool           `json:"jsOnly"`
	}
	if err := json.Unmarshal(systemConfig, &systemDocument); err != nil {
		t.Fatalf("system config json: %v", err)
	}
	if len(systemDocument.JSCode) == 0 || string(systemDocument.JSCode) == "null" {
		t.Fatalf("system admin lost jsCode: %s", systemConfig)
	}
	if systemDocument.JSOnly == nil || !*systemDocument.JSOnly {
		t.Fatalf("system admin lost jsOnly: %s", systemConfig)
	}
}
