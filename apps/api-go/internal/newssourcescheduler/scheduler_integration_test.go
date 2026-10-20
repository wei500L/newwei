//go:build integration

// Integration coverage for the news-source scheduler and operations unit. It
// runs against the real MySQL 8.4 and Redis 7.2 services of the
// api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// The assertions inspect the MySQL rows, the raw BullMQ Redis structures the
// crawl-queue producer writes, the scheduler's Redis keys/TTLs/values, the
// Notification row plus its relay message, and the round-trip through the Go
// news-sources read model. Discovery is a fixture (no external site and no
// crawl4ai call is made), and the crawl worker / item pipeline worker are not
// started.
package newssourcescheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

type schedulerHarness struct {
	ctx       context.Context
	db        *sql.DB
	redis     *redis.Client
	service   *Service
	discovery *fakeDiscovery
	queue     *crawlqueue.Producer
	pipeline  *fakePipeline
	items     *fakeItems
	retry     *fakeCrawlTaskRetry
}

func newSchedulerHarness(t *testing.T) *schedulerHarness {
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
	createSchedulerTables(t, db)
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr, DB: 11, Protocol: 2})
	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := redisClient.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	t.Cleanup(func() {
		_ = redisClient.Close()
		_ = db.Close()
	})
	// Registered last so it runs FIRST (LIFO), while the MySQL handle is still
	// open: leave the shared tables absent for the later integration steps in
	// this job, which recreate their own narrow versions with IF NOT EXISTS.
	t.Cleanup(func() { dropSchedulerTables(db) })

	discovery := &fakeDiscovery{}
	queue := crawlqueue.NewProducer(crawlqueue.Options{Redis: redisClient, DB: db})
	pipeline := newFakePipeline()
	items := &fakeItems{result: true}
	retry := &fakeCrawlTaskRetry{status: "queued"}
	service := newServiceWithPorts(
		newMySQLRepository(db, itemsingest.WriteRawItemOutboxTx),
		newRedisCache(redisClient),
		Options{
			DB:              db,
			Redis:           redisClient,
			Discovery:       discovery,
			Queue:           queue,
			Pipeline:        pipeline,
			Items:           items,
			CrawlTasks:      retry,
			Settings:        integrationSettings(),
			ScheduleEnabled: true,
			Now:             func() time.Time { return time.Date(2026, 10, 20, 13, 30, 25, 123_000_000, time.UTC) },
			Random:          func() float64 { return 0 },
		},
	)
	return &schedulerHarness{
		ctx:       context.Background(),
		db:        db,
		redis:     redisClient,
		service:   service,
		discovery: discovery,
		queue:     queue,
		pipeline:  pipeline,
		items:     items,
		retry:     retry,
	}
}

func integrationSettings() Settings {
	settings := testSettings()
	settings.BatchSize = 20
	settings.BackpressureMaxPendingJobs = 100
	return settings
}

func (h *schedulerHarness) reset(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		"DELETE FROM PipelineJob WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM CrawlTask WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM NewsSourceOpsSnapshot WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM NewsSource WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM Article WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM Notification WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM Membership WHERE orgId LIKE 'org-scheduler%'",
		"DELETE FROM SystemSetting WHERE `key` = 'news_source_scheduler_settings'",
	} {
		if _, err := h.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("reset (%s): %v", statement, err)
		}
	}
	if err := h.redis.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
}

func createSchedulerTables(t *testing.T, db *sql.DB) {
	t.Helper()
	// Earlier integration steps in the same job create narrow versions of these
	// shared tables (for example a PipelineJob without createdAt). Drop and
	// recreate them with the columns this unit projects, exactly like the other
	// integration harnesses do.
	if err := dropSchedulerTablesErr(db); err != nil {
		t.Fatalf("drop tables: %v", err)
	}
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `CrawlTemplate` (" +
			"`id` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true, `crawlOptions` JSON NULL, " +
			"PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `NewsSource` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, " +
			"`url` VARCHAR(191) NOT NULL, `siteType` VARCHAR(32) NOT NULL DEFAULT 'general', `language` VARCHAR(191) NULL, " +
			"`crawlTemplateId` VARCHAR(191) NULL, `workflowId` VARCHAR(191) NULL, `workflowVersionId` VARCHAR(191) NULL, " +
			"`workflowBindingMode` VARCHAR(32) NOT NULL DEFAULT 'published', `frequencySeconds` INT NOT NULL DEFAULT 3600, " +
			"`priority` INT NOT NULL DEFAULT 0, `isActive` BOOLEAN NOT NULL DEFAULT true, `config` JSON NULL, " +
			"`group` VARCHAR(191) NULL, `lastRunAt` DATETIME(3) NULL, `lastSuccessAt` DATETIME(3) NULL, " +
			"`lastFailureAt` DATETIME(3) NULL, `consecutiveFailures` INT NOT NULL DEFAULT 0, " +
			"`circuitOpenUntil` DATETIME(3) NULL, `nextRunAt` DATETIME(3) NULL, " +
			"`createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`), " +
			"UNIQUE KEY `NewsSource_orgId_url_key` (`orgId`,`url`), KEY `NewsSource_isActive_nextRunAt_idx` (`isActive`,`nextRunAt`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
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
		"CREATE TABLE IF NOT EXISTS `PipelineJob` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `sourceId` VARCHAR(191) NULL, " +
			"`url` VARCHAR(1024) NOT NULL, `urlFingerprint` VARCHAR(64) NULL, `priority` INT NOT NULL DEFAULT 0, " +
			"`status` VARCHAR(32) NOT NULL DEFAULT 'pending', `queueName` VARCHAR(191) NOT NULL DEFAULT 'crawl-queue', " +
			"`scheduledFor` DATETIME(3) NULL, `startedAt` DATETIME(3) NULL, `completedAt` DATETIME(3) NULL, " +
			"`attempts` INT NOT NULL DEFAULT 0, `error` TEXT NULL, `crawlRunId` VARCHAR(191) NULL, " +
			"`articleId` VARCHAR(191) NULL, `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL, " +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`), KEY `PipelineJob_sourceId_idx` (`sourceId`,`createdAt`)) " +
			"ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `Article` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `sourceId` VARCHAR(191) NULL, " +
			"`url` VARCHAR(512) NOT NULL, `urlFingerprint` VARCHAR(64) NULL, `sourceLabel` VARCHAR(191) NULL, " +
			"`language` VARCHAR(191) NULL, `titleGuess` VARCHAR(512) NULL, `crawlAt` DATETIME(3) NOT NULL, " +
			"`contentHash` VARCHAR(191) NOT NULL, `markdownRef` VARCHAR(191) NULL, `version` INT NOT NULL DEFAULT 1, " +
			"`metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (`id`), UNIQUE KEY `Article_orgId_url_key` (`orgId`,`url`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `NewsSourceOpsSnapshot` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `sourceId` VARCHAR(191) NOT NULL, " +
			"`latestJob` JSON NULL, `latestCrawlTask` JSON NULL, `latestArticle` JSON NULL, `stats24h` JSON NULL, " +
			"`createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`), " +
			"UNIQUE KEY `NewsSourceOpsSnapshot_sourceId_key` (`sourceId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `Notification` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NULL, " +
			"`type` VARCHAR(32) NOT NULL, `title` VARCHAR(191) NOT NULL, `body` TEXT NULL, `data` JSON NULL, " +
			"`readAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `Membership` (" +
			"`id` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, " +
			"`roleId` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true, " +
			"`createdAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`), " +
			"UNIQUE KEY `Membership_userId_orgId_key` (`userId`,`orgId`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false, " +
			"`description` TEXT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, " +
			"`updatedById` VARCHAR(191) NULL, PRIMARY KEY (`key`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

func (h *schedulerHarness) insertSource(t *testing.T, id, orgID, mode string, config map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.db.Exec(
		"INSERT INTO NewsSource (id, orgId, name, url, siteType, workflowBindingMode, frequencySeconds, priority, isActive, config, nextRunAt, createdAt, updatedAt) "+
			"VALUES (?, ?, ?, ?, 'general', 'published', 3600, 0, 1, ?, NULL, ?, ?)",
		id, orgID, "Source "+id, "https://example.com/"+id, encoded, now, now); err != nil {
		t.Fatalf("insert source: %v", err)
	}
}

func (h *schedulerHarness) seedConfig() map[string]any {
	return map[string]any{
		"seed": map[string]any{
			"enabled":           true,
			"mode":              "sitemap",
			"domain":            "https://example.com",
			"maxNewUrlsPerRun":  5,
			"dedupeWindowHours": 24,
		},
	}
}

// queueSnapshotJobIDs returns the crawl4ai-normal job ids from the prioritized
// zset (where priority-bearing jobs live) and the wait list.
func (h *schedulerHarness) queueSnapshotJobIDs() ([]string, error) {
	prefix := "bull:" + crawlqueue.QueueNormal + ":"
	prioritized, err := h.redis.ZRange(h.ctx, prefix+"prioritized", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	waiting, err := h.redis.LRange(h.ctx, prefix+"wait", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	return append(prioritized, waiting...), nil
}

// schedulerTables are the shared tables this unit recreates.
var schedulerTables = []string{
	"NewsSourceOpsSnapshot", "PipelineJob", "CrawlTask", "Article",
	"NewsSource", "CrawlTemplate", "Notification", "Membership", "SystemSetting",
}

// dropSchedulerTablesErr removes the shared tables.
func dropSchedulerTablesErr(db *sql.DB) error {
	for _, table := range schedulerTables {
		if _, err := db.Exec("DROP TABLE IF EXISTS `" + table + "`"); err != nil {
			return err
		}
	}
	return nil
}

// dropSchedulerTables is the test-cleanup wrapper.
func dropSchedulerTables(db *sql.DB) {
	_ = dropSchedulerTablesErr(db)
}

func TestNewsSourceSchedulerIntegrationDispatch(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-1"
	h.insertSource(t, "source-int-1", orgID, "sitemap", h.seedConfig())
	h.discovery.candidates = []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/a", int64(1789000000000)),
		discoveryCandidate("https://example.com/b", int64(1789000000000)),
	}

	outcome, locked, err := h.service.DispatchNow(h.ctx, orgID, "source-int-1", "user-int")
	if err != nil {
		t.Fatalf("DispatchNow: %v", err)
	}
	if !locked || outcome.Reason != pipelineDispatchReasonOK || outcome.ScheduledCount != 2 {
		t.Fatalf("outcome = %+v locked=%v", outcome, locked)
	}

	rows, err := h.db.Query(
		"SELECT t.id, t.status, t.config, j.id, j.status, j.metadata FROM CrawlTask t "+
			"JOIN PipelineJob j ON j.orgId = t.orgId AND j.url = t.targetUrl "+
			"WHERE t.orgId = ? AND t.newsSourceId = 'source-int-1'", orgID)
	if err != nil {
		t.Fatalf("select tasks: %v", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		count++
		var taskID, taskStatus, jobID, jobStatus string
		var configRaw, metadataRaw []byte
		if err := rows.Scan(&taskID, &taskStatus, &configRaw, &jobID, &jobStatus, &metadataRaw); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if taskStatus != "queued" || jobStatus != "queued" {
			t.Fatalf("statuses task=%s job=%s", taskStatus, jobStatus)
		}
		var config map[string]json.RawMessage
		if err := json.Unmarshal(configRaw, &config); err != nil {
			t.Fatalf("config: %v", err)
		}
		var pipelineJobID string
		_ = json.Unmarshal(config["pipelineJobId"], &pipelineJobID)
		if pipelineJobID != jobID {
			t.Fatalf("config.pipelineJobId = %q, job = %q", pipelineJobID, jobID)
		}
		var metadata map[string]json.RawMessage
		if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
			t.Fatalf("metadata: %v", err)
		}
		var metadataTaskID string
		_ = json.Unmarshal(metadata["crawlTaskId"], &metadataTaskID)
		if metadataTaskID != taskID {
			t.Fatalf("metadata.crawlTaskId = %q, task = %q", metadataTaskID, taskID)
		}
		var triggeredBy string
		_ = json.Unmarshal(metadata["triggeredById"], &triggeredBy)
		if triggeredBy != "user-int" {
			t.Fatalf("triggeredById = %q", triggeredBy)
		}
		// The raw BullMQ job hash carries the same task/org ids. A source
		// priority is always set, so the producer adds into the prioritized
		// zset (BullMQ 5.63.2), not the wait list.
		jobIDs, err := h.queueSnapshotJobIDs()
		if err != nil {
			t.Fatalf("queue job ids: %v", err)
		}
		if len(jobIDs) != 2 {
			t.Fatalf("queued jobs = %d, want 2", len(jobIDs))
		}
		found := false
		for _, rawJobID := range jobIDs {
			data, err := h.redis.HGet(h.ctx, "bull:"+crawlqueue.QueueNormal+":"+rawJobID, "data").Result()
			if err != nil {
				continue
			}
			var payload struct {
				TaskID string `json:"taskId"`
				OrgID  string `json:"orgId"`
			}
			if json.Unmarshal([]byte(data), &payload) == nil && payload.TaskID == taskID && payload.OrgID == orgID {
				found = true
			}
		}
		if !found {
			t.Fatalf("no BullMQ job hash for task %s", taskID)
		}
		if exists, err := h.redis.Exists(h.ctx, "bull:"+crawlqueue.QueueNormal+":de:crawl-task:"+taskID).Result(); err != nil || exists == 0 {
			t.Fatalf("deduplication key for task %s missing", taskID)
		}
	}
	if count != 2 {
		t.Fatalf("tasks = %d, want 2", count)
	}

	// The shared 25-second window answers the second call without dispatching.
	second, locked, err := h.service.DispatchNow(h.ctx, orgID, "source-int-1", "user-int")
	if err != nil {
		t.Fatalf("second DispatchNow: %v", err)
	}
	if !locked || second.Reason != pipelineDispatchReasonDeduped || second.DedupeUntil == nil {
		t.Fatalf("second outcome = %+v", second)
	}
	window := computeSharedDispatchDedupeKey("source-int-1", h.service.now())
	if h.redis.TTL(h.ctx, window.Key).Val() <= 0 {
		t.Fatal("the dispatch dedupe key must exist with a TTL")
	}

	// The snapshot row and runtime block exist; the Go news-sources read model
	// shows the same queued count.
	var snapshotCount int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM NewsSourceOpsSnapshot WHERE sourceId = 'source-int-1'").Scan(&snapshotCount); err != nil {
		t.Fatalf("snapshot count: %v", err)
	}
	if snapshotCount != 1 {
		t.Fatalf("snapshot rows = %d, want 1", snapshotCount)
	}
	readModel := newssources.NewServiceWithRedis(h.db, h.redis)
	listed, err := readModel.ListDefault(h.ctx, orgID)
	if err != nil {
		t.Fatalf("news sources list: %v", err)
	}
	encoded, _ := json.Marshal(listed)
	var payload struct {
		Sources []struct {
			ID         string `json:"id"`
			OpsSummary struct {
				LatestJob json.RawMessage `json:"latestJob"`
				Runtime   struct {
					CrawlTaskQueuedCount int `json:"crawlTaskQueuedCount"`
				} `json:"runtime"`
			} `json:"opsSummary"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("list payload: %v", err)
	}
	if len(payload.Sources) != 1 {
		t.Fatalf("listed sources = %d, want 1", len(payload.Sources))
	}
	if string(payload.Sources[0].OpsSummary.LatestJob) == "null" {
		t.Fatal("the read model must project the written snapshot")
	}
	if payload.Sources[0].OpsSummary.Runtime.CrawlTaskQueuedCount != 2 {
		t.Fatalf("queued count = %d, want 2", payload.Sources[0].OpsSummary.Runtime.CrawlTaskQueuedCount)
	}
	if h.redis.TTL(h.ctx, listRuntimeKey("source-int-1")).Val() <= 0 {
		t.Fatal("the runtime key must exist with a TTL")
	}
}

func TestNewsSourceSchedulerIntegrationBackpressure(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-2"
	h.insertSource(t, "source-bp-1", orgID, "sitemap", h.seedConfig())
	h.insertSource(t, "source-bp-2", orgID, "sitemap", h.seedConfig())
	settings := integrationSettings()
	settings.BackpressureMaxPendingJobs = 1
	settings.BackpressureDelay = 5 * time.Minute
	h.service.settings = settings

	producer := h.queue
	now := time.Now().UTC().Truncate(time.Millisecond)
	for index := 0; index < 2; index++ {
		taskID := "pending-task-" + string(rune('a'+index))
		if _, err := h.db.Exec(
			"INSERT INTO CrawlTask (id, orgId, createdById, targetUrl, status, concurrency, keywords, runCount, createdAt, updatedAt) "+
				"VALUES (?, ?, 'user-1', 'https://example.com/pending', 'queued', 1, '[]', 0, ?, ?)",
			taskID, orgID, now, now); err != nil {
			t.Fatalf("insert pending task: %v", err)
		}
		if _, err := producer.EnqueueTask(h.ctx, taskID, orgID, crawlqueue.EnqueueOptions{}); err != nil {
			t.Fatalf("enqueue pending task: %v", err)
		}
	}

	subscriber := redis.NewClient(&redis.Options{Addr: h.redis.Options().Addr, DB: 11, Protocol: 2})
	defer subscriber.Close()
	pubsub := subscriber.Subscribe(h.ctx, notificationRelayChannel)
	defer pubsub.Close()
	if _, err := pubsub.Receive(h.ctx); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	h.service.scheduleDueSources(h.ctx, h.service.now())

	// Both due sources were delayed, not dispatched.
	var delayed int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM NewsSource WHERE orgId = ? AND nextRunAt IS NOT NULL", orgID).Scan(&delayed); err != nil {
		t.Fatalf("delayed count: %v", err)
	}
	if delayed != 2 {
		t.Fatalf("delayed sources = %d, want 2", delayed)
	}
	for _, sourceID := range []string{"source-bp-1", "source-bp-2"} {
		raw, err := h.redis.Get(h.ctx, backpressureKey(sourceID)).Result()
		if err != nil {
			t.Fatalf("backpressure marker %s: %v", sourceID, err)
		}
		var marker struct {
			Until       string `json:"until"`
			PendingJobs int    `json:"pendingJobs"`
			Threshold   int    `json:"threshold"`
		}
		if err := json.Unmarshal([]byte(raw), &marker); err != nil {
			t.Fatalf("marker: %v", err)
		}
		if marker.PendingJobs != 2 || marker.Threshold != 1 {
			t.Fatalf("marker = %+v", marker)
		}
		if ttl := h.redis.TTL(h.ctx, backpressureKey(sourceID)).Val(); ttl <= 0 || ttl > 5*time.Minute {
			t.Fatalf("marker ttl = %s", ttl)
		}
		if count, err := h.redis.Get(h.ctx, backpressureCountKey(sourceID)).Int(); err != nil || count != 1 {
			t.Fatalf("backpressure count = %d err=%v", count, err)
		}
		if ttl := h.redis.TTL(h.ctx, backpressureCountKey(sourceID)).Val(); ttl <= 0 {
			t.Fatal("the backpressure counter must expire")
		}
		runtimeRaw, err := h.redis.Get(h.ctx, listRuntimeKey(sourceID)).Result()
		if err != nil {
			t.Fatalf("runtime state %s: %v", sourceID, err)
		}
		var runtime struct {
			BackpressureUntil       *string  `json:"backpressureUntil"`
			BackpressurePendingJobs *int     `json:"backpressurePendingJobs"`
			BackpressureThreshold   *int     `json:"backpressureThreshold"`
			HitTimestamps           []string `json:"backpressureHitTimestamps"`
		}
		if err := json.Unmarshal([]byte(runtimeRaw), &runtime); err != nil {
			t.Fatalf("runtime state: %v", err)
		}
		if runtime.BackpressureUntil == nil || runtime.BackpressurePendingJobs == nil || len(runtime.HitTimestamps) != 1 {
			t.Fatalf("runtime state = %+v", runtime)
		}
	}

	var notificationCount int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM Notification WHERE orgId = ? AND type = 'system'", orgID).Scan(&notificationCount); err != nil {
		t.Fatalf("notification count: %v", err)
	}
	if notificationCount != 1 {
		t.Fatalf("notifications = %d, want 1 (30-minute gate)", notificationCount)
	}
	var dataRaw []byte
	if err := h.db.QueryRow("SELECT data FROM Notification WHERE orgId = ?", orgID).Scan(&dataRaw); err != nil {
		t.Fatalf("notification data: %v", err)
	}
	var data struct {
		Presentation struct {
			Kind   string `json:"kind"`
			Params struct {
				PendingJobs  int `json:"pendingJobs"`
				DelayedCount int `json:"delayedCount"`
			} `json:"params"`
		} `json:"presentation"`
	}
	if err := json.Unmarshal(dataRaw, &data); err != nil {
		t.Fatalf("notification presentation: %v", err)
	}
	if data.Presentation.Kind != presentationKindBackpressure || data.Presentation.Params.DelayedCount != 2 {
		t.Fatalf("presentation = %+v", data.Presentation)
	}
	message, err := pubsub.ReceiveMessage(h.ctx)
	if err != nil {
		t.Fatalf("relay message: %v", err)
	}
	var relay struct {
		Version        int    `json:"version"`
		NotificationID string `json:"notificationId"`
		OrgID          string `json:"orgId"`
	}
	if err := json.Unmarshal([]byte(message.Payload), &relay); err != nil {
		t.Fatalf("relay payload: %v", err)
	}
	if relay.Version != notificationRelayVersion || relay.OrgID != orgID || relay.NotificationID == "" {
		t.Fatalf("relay = %+v", relay)
	}
}

func TestNewsSourceSchedulerIntegrationOperations(t *testing.T) {
	h := newSchedulerHarness(t)
	h.reset(t)
	orgID := "org-scheduler-3"
	h.insertSource(t, "source-ops-1", orgID, "sitemap", h.seedConfig())
	h.discovery.candidates = []crawlmetadata.DiscoveryCandidate{
		discoveryCandidate("https://example.com/ops-a", int64(1789000000000)),
	}
	if _, _, err := h.service.DispatchNow(h.ctx, orgID, "source-ops-1", "user-int"); err != nil {
		t.Fatalf("DispatchNow: %v", err)
	}

	canceled, err := h.service.CancelQueued(h.ctx, orgID, "source-ops-1", "user-int")
	if err != nil {
		t.Fatalf("CancelQueued: %v", err)
	}
	if canceled.RemovedJobs != 1 || len(canceled.CanceledTaskIDs) != 1 {
		t.Fatalf("canceled = %+v", canceled)
	}
	var paused int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM CrawlTask WHERE orgId = ? AND status = 'paused'", orgID).Scan(&paused); err != nil {
		t.Fatalf("paused count: %v", err)
	}
	if paused != 1 {
		t.Fatalf("paused tasks = %d, want 1", paused)
	}

	cleared, err := h.service.ClearInFlight(h.ctx, orgID, "source-ops-1")
	if err != nil {
		t.Fatalf("ClearInFlight: %v", err)
	}
	if cleared.ClearedJobs != 1 {
		t.Fatalf("cleared jobs = %d, want 1", cleared.ClearedJobs)
	}
	var failedJobs int
	if err := h.db.QueryRow("SELECT COUNT(*) FROM PipelineJob WHERE orgId = ? AND status = 'failed' AND error = 'Cleared by admin'", orgID).Scan(&failedJobs); err != nil {
		t.Fatalf("failed jobs: %v", err)
	}
	if failedJobs != 1 {
		t.Fatalf("failed pipeline jobs = %d, want 1", failedJobs)
	}

	// The latest job still carries crawlTaskId, whose task is not failed, so the
	// crawl branch reports retried=false.
	retryOutcome, err := h.service.RetryLatest(h.ctx, authhttp.NewIdentity("user-int", orgID, []string{"crawl.write", "items.write"}), "source-ops-1", nil)
	if err != nil {
		t.Fatalf("RetryLatest: %v", err)
	}
	if retryOutcome.RetryType != "crawl" || retryOutcome.Retried {
		t.Fatalf("retry outcome = %+v", retryOutcome)
	}

	// A pipeline-only latest job (RSS metadata) goes through the item pipeline
	// retry branch: the row returns to queued and the metric is recorded.
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := h.db.Exec(
		"INSERT INTO PipelineJob (id, orgId, sourceId, url, priority, status, queueName, metadata, createdAt, updatedAt) "+
			"VALUES ('job-rss-1', ?, 'source-ops-1', 'https://example.com/rss', 0, 'failed', 'itemPipeline', ?, ?, ?)",
		orgID, []byte(`{"itemMetaId":"meta-1","rawItemId":"raw-1"}`), now, now); err != nil {
		t.Fatalf("insert pipeline job: %v", err)
	}
	pipelineOutcome, err := h.service.RetryLatest(h.ctx, authhttp.NewIdentity("user-int", orgID, []string{"crawl.write"}), "source-ops-1", nil)
	if err != nil {
		t.Fatalf("RetryLatest pipeline: %v", err)
	}
	if pipelineOutcome.RetryType != "pipeline" || !pipelineOutcome.Retried || len(h.pipeline.enqueued) != 1 {
		t.Fatalf("pipeline retry = %+v enqueued=%v", pipelineOutcome, h.pipeline.enqueued)
	}
	var status string
	if err := h.db.QueryRow("SELECT status FROM PipelineJob WHERE id = 'job-rss-1'").Scan(&status); err != nil {
		t.Fatalf("pipeline status: %v", err)
	}
	if status != "queued" {
		t.Fatalf("pipeline status = %q, want queued", status)
	}
	metric, err := h.redis.HGet(h.ctx, "news-source:metric:pipeline-retry:source:source-ops-1:24h", "count").Int()
	if err != nil || metric != 1 {
		t.Fatalf("retry metric = %d err=%v", metric, err)
	}

	// Org isolation: another organization sees 404 for the same source.
	other := authhttp.NewIdentity("user-other", "org-scheduler-other", []string{"crawl.write"})
	if _, err := h.service.RetryLatest(h.ctx, other, "source-ops-1", nil); err == nil {
		t.Fatal("a source from another organization must not be retryable")
	}
}
