//go:build integration

// Integration coverage of the BullMQ worker entry point of
// internal/crawlexecution (CrawlExecutionService.runTask behind
// RunQueuedTask). It runs against the MySQL 8.4, Redis 7.2 and Mongo 7.0
// services of the api-go-user-settings-integration CI job:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// crawl4ai is faked with httptest. The MySQL tables are rebuilt from a reduced
// copy of packages/db/prisma/schema.prisma inside the test (the #114 schema
// isolation pattern), so the narrow column set stays exact.

package crawlexecution

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/classificationrssops"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
)

const (
	queuedIntegrationOrgID    = "org-crawl-execution-queued-it"
	queuedIntegrationSourceID = "news-source-crawl-execution-it"
	queuedIntegrationUserID   = "user-crawl-execution-it"
	queuedIntegrationTarget   = "https://8.8.8.8/article/2026/10/21/circuit-story"

	queuedIntegrationNotificationChannel       = "notification:events:v1"
	queuedIntegrationLegacyNotificationChannel = "news-source:notifications:v1"
)

// TestCrawlExecutionQueuedIntegrationCircuitBreaker is G (B2): two concurrent
// terminal crawl failures of one news source increment consecutiveFailures
// without losing an update, and only the transaction that crosses the threshold
// writes the circuit-open notification. The relay goes to notification:events:v1
// exactly once and never to the legacy news-source channel.
func TestCrawlExecutionQueuedIntegrationCircuitBreaker(t *testing.T) {
	db := openQueuedIntegrationDB(t)
	redisClient := openQueuedIntegrationRedis(t)
	database := openQueuedIntegrationMongo(t)

	now := time.Now().UTC().Truncate(time.Millisecond)
	seedQueuedIntegrationSource(t, db, now)
	for index := 1; index <= 2; index++ {
		seedQueuedIntegrationTask(t, db, now, fmt.Sprintf("crawl-task-queued-%d", index), fmt.Sprintf("pipeline-job-queued-%d", index))
	}

	server := newQueuedIntegrationCrawl4ai(t)
	relay := newQueuedIntegrationRelay(t, redisClient)
	service := New(Options{
		DB:    db,
		Mongo: database,
		Redis: redisClient,
		Config: Config{
			CrawlBaseURL:          server.URL,
			CrawlTimeoutMs:        15_000,
			CrawlHealthCheckTTLMs: 60_000,
			// The first failure already sits one below the threshold, so the two
			// concurrent failures cross it exactly once.
			CircuitBreakerThreshold:   2,
			CircuitBreakerBaseDelayMs: 600_000,
			CircuitBreakerMaxDelayMs:  900_000,
			FailureRecoveryDelayMs:    600_000,
			FailureMaxDelayMs:         900_000,
		},
		Now:       func() time.Time { return now },
		Scheduler: queuedIntegrationScheduler{service: newssourcescheduler.New(newssourcescheduler.Options{DB: db, Redis: redisClient})},
		// The production publisher writes the identifiers-only envelope on
		// notification:events:v1; the two types have the same underlying
		// signature, so the conversion is explicit.
		Relay: NotificationRelayPublisher(classificationrssops.NewRedisNotificationRelayPublisher(redisClient)),
	})

	// The two attempts share a start barrier so the row lock of
	// markSourceFailureState is actually contended.
	start := make(chan struct{})
	errs := make([]error, 2)
	var waitGroup sync.WaitGroup
	for index := 0; index < 2; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			<-start
			_, errs[index] = service.RunQueuedTask(context.Background(),
				queuedIntegrationOrgID, fmt.Sprintf("crawl-task-queued-%d", index+1), "",
				RunOptions{Attempt: 1, MaxAttempts: 1, RequestTimeoutMs: 15_000})
		}(index)
	}
	close(start)
	waitGroup.Wait()

	for index, err := range errs {
		if err == nil {
			t.Fatalf("crawl task %d: RunQueuedTask succeeded, want the crawl4ai failure", index+1)
		}
		if !strings.Contains(err.Error(), "rejected by the upstream policy") {
			t.Fatalf("crawl task %d error = %q, want the crawl4ai message", index+1, err.Error())
		}
	}

	// ---- NewsSource counter ------------------------------------------------
	var (
		consecutiveFailures int
		circuitOpenUntil    sql.NullTime
		isActive            bool
	)
	if err := db.QueryRowContext(context.Background(),
		"SELECT `consecutiveFailures`, `circuitOpenUntil`, `isActive` FROM `NewsSource` WHERE `id` = ?",
		queuedIntegrationSourceID).Scan(&consecutiveFailures, &circuitOpenUntil, &isActive); err != nil {
		t.Fatalf("read the news source row: %v", err)
	}
	if consecutiveFailures != 3 {
		t.Fatalf("consecutiveFailures = %d, want 3 (1 seeded + 2 concurrent failures)", consecutiveFailures)
	}
	if !circuitOpenUntil.Valid {
		t.Fatal("circuitOpenUntil is NULL, want the opened circuit window")
	}
	if !isActive {
		t.Fatal("the source was deactivated, want the circuit to stay open while active")
	}

	// ---- one circuit-open notification -------------------------------------
	var notifications int
	if err := db.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM `Notification` WHERE `orgId` = ?", queuedIntegrationOrgID).Scan(&notifications); err != nil {
		t.Fatalf("count notifications: %v", err)
	}
	if notifications != 1 {
		t.Fatalf("notification rows = %d, want exactly 1 circuit-open row", notifications)
	}
	var (
		notificationID     string
		notificationType   string
		notificationUserID sql.NullString
		notificationTitle  string
		body               sql.NullString
		dataRaw            sql.NullString
	)
	if err := db.QueryRowContext(context.Background(),
		"SELECT `id`, `type`, `userId`, `title`, `body`, `data` FROM `Notification` WHERE `orgId` = ?",
		queuedIntegrationOrgID).Scan(&notificationID, &notificationType, &notificationUserID, &notificationTitle, &body, &dataRaw); err != nil {
		t.Fatalf("read the circuit notification: %v", err)
	}
	if notificationType != "system" {
		t.Fatalf("notification type = %q, want system", notificationType)
	}
	if notificationUserID.Valid {
		t.Fatalf("notification userId = %q, want NULL (org-wide row)", notificationUserID.String)
	}
	if notificationTitle != "News source circuit opened" {
		t.Fatalf("notification title = %q", notificationTitle)
	}
	if !strings.Contains(body.String, `"Integration Source" reached 2 consecutive failures`) {
		t.Fatalf("notification body = %q", body.String)
	}
	var data struct {
		SourceID     string `json:"sourceId"`
		SourceName   string `json:"sourceName"`
		Presentation struct {
			Kind string `json:"kind"`
		} `json:"presentation"`
	}
	if !dataRaw.Valid {
		t.Fatal("the circuit notification has no data payload")
	}
	if err := json.Unmarshal([]byte(dataRaw.String), &data); err != nil {
		t.Fatalf("decode the circuit notification data: %v", err)
	}
	if data.SourceID != queuedIntegrationSourceID || data.Presentation.Kind != "news_source_circuit_opened" {
		t.Fatalf("notification data = %+v, want source %s and kind news_source_circuit_opened",
			data, queuedIntegrationSourceID)
	}

	// ---- relay channel -----------------------------------------------------
	payload := relay.next(t, 15*time.Second)
	relay.expectQuiet(t, 500*time.Millisecond, payload)
	var message struct {
		Version        int    `json:"version"`
		NotificationID string `json:"notificationId"`
		OrgID          string `json:"orgId"`
		UserID         string `json:"userId"`
	}
	if err := json.Unmarshal([]byte(payload), &message); err != nil {
		t.Fatalf("decode the relay payload %q: %v", payload, err)
	}
	if message.Version != 1 || message.NotificationID != notificationID ||
		message.OrgID != queuedIntegrationOrgID || message.UserID != "" {
		t.Fatalf("relay payload = %#v", message)
	}
	if strings.Contains(payload, "presentation") || strings.Contains(payload, "News source circuit opened") {
		t.Fatalf("the relay payload must be identifiers-only, got %q", payload)
	}

	// ---- both tasks and pipeline jobs failed -------------------------------
	for index := 1; index <= 2; index++ {
		var status string
		var lastError sql.NullString
		if err := db.QueryRowContext(context.Background(),
			"SELECT `status`, `lastError` FROM `CrawlTask` WHERE `id` = ?",
			fmt.Sprintf("crawl-task-queued-%d", index)).Scan(&status, &lastError); err != nil {
			t.Fatalf("read crawl task %d: %v", index, err)
		}
		if status != "failed" {
			t.Fatalf("crawl task %d status = %q, want failed", index, status)
		}
		if !lastError.Valid || !strings.Contains(lastError.String, "rejected by the upstream policy") {
			t.Fatalf("crawl task %d lastError = %#v", index, lastError)
		}
		var pipelineStatus string
		if err := db.QueryRowContext(context.Background(),
			"SELECT `status` FROM `PipelineJob` WHERE `id` = ?",
			fmt.Sprintf("pipeline-job-queued-%d", index)).Scan(&pipelineStatus); err != nil {
			t.Fatalf("read pipeline job %d: %v", index, err)
		}
		if pipelineStatus != "failed" {
			t.Fatalf("pipeline job %d status = %q, want failed", index, pipelineStatus)
		}
	}
}

// queuedIntegrationScheduler is the SchedulerPort of the test: the real
// newssourcescheduler service writes the notification row and publishes the
// generic relay, which is exactly the circuit-open notification path.
type queuedIntegrationScheduler struct {
	service *newssourcescheduler.Service
}

// NotifySystemGeneric implements SchedulerPort.
func (s queuedIntegrationScheduler) NotifySystemGeneric(
	ctx context.Context,
	orgID, title, body string,
	data json.RawMessage,
	relay newssourcescheduler.NotificationRelayFunc,
) {
	s.service.NotifySystemGeneric(ctx, orgID, title, body, data, relay)
}

// queuedIntegrationRelay observes both notification channels.
type queuedIntegrationRelay struct {
	generic chan string
	legacy  chan string
}

// newQueuedIntegrationRelay subscribes both channels before any job runs.
func newQueuedIntegrationRelay(t *testing.T, client *redis.Client) *queuedIntegrationRelay {
	t.Helper()
	relay := &queuedIntegrationRelay{
		generic: make(chan string, 8),
		legacy:  make(chan string, 8),
	}
	ctx := context.Background()
	genericPubSub := client.Subscribe(ctx, queuedIntegrationNotificationChannel)
	if _, err := genericPubSub.Receive(ctx); err != nil {
		t.Fatalf("subscribe %s: %v", queuedIntegrationNotificationChannel, err)
	}
	legacyPubSub := client.Subscribe(ctx, queuedIntegrationLegacyNotificationChannel)
	if _, err := legacyPubSub.Receive(ctx); err != nil {
		t.Fatalf("subscribe %s: %v", queuedIntegrationLegacyNotificationChannel, err)
	}
	go func() {
		for message := range genericPubSub.Channel() {
			relay.generic <- message.Payload
		}
	}()
	go func() {
		for message := range legacyPubSub.Channel() {
			relay.legacy <- message.Payload
		}
	}()
	t.Cleanup(func() {
		_ = genericPubSub.Close()
		_ = legacyPubSub.Close()
	})
	return relay
}

// next waits for the generic relay message.
func (r *queuedIntegrationRelay) next(t *testing.T, timeout time.Duration) string {
	t.Helper()
	select {
	case payload := <-r.generic:
		return payload
	case <-time.After(timeout):
		t.Fatalf("no message on %s within %s", queuedIntegrationNotificationChannel, timeout)
		return ""
	}
}

// expectQuiet asserts that neither a second generic message nor any legacy
// channel message arrives.
func (r *queuedIntegrationRelay) expectQuiet(t *testing.T, window time.Duration, first string) {
	t.Helper()
	select {
	case payload := <-r.generic:
		t.Fatalf("duplicate generic relay message on %s: %s", queuedIntegrationNotificationChannel, payload)
	case payload := <-r.legacy:
		t.Fatalf("unexpected legacy relay message on %s: %s (double delivery)",
			queuedIntegrationLegacyNotificationChannel, payload)
	case <-time.After(window):
	}
	if first == "" {
		t.Fatal("the generic relay message is empty")
	}
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// openQueuedIntegrationDB opens MySQL and rebuilds the reduced schema.
func openQueuedIntegrationDB(t *testing.T) *sql.DB {
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
	for _, statement := range queuedIntegrationSchema() {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("rebuild the crawl execution schema: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, table := range []string{"CrawlResult", "CrawlTask", "Notification", "NewsSource", "PipelineJob", "SystemSetting"} {
			_, _ = db.Exec("DROP TABLE IF EXISTS `" + table + "`")
		}
		_ = db.Close()
	})
	return db
}

// queuedIntegrationSchema is the reduced Prisma schema the runTask error path
// touches: the task row, the validation-state query, the pipeline job update and
// the notification writer.
func queuedIntegrationSchema() []string {
	return []string{
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
			UNIQUE KEY ` + "`CrawlResult_taskId_contentHash_key`" + ` (` + "`taskId`" + `, ` + "`contentHash`" + `)
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
}

// openQueuedIntegrationRedis opens Redis and clears the crawl worker keys.
func openQueuedIntegrationRedis(t *testing.T) *redis.Client {
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
	keys, err := client.Keys(ctx, "bull:crawl4ai*").Result()
	if err != nil {
		t.Fatalf("list crawl queue keys: %v", err)
	}
	keys = append(keys, crawlqueue.ActivityHashKey, crawlqueue.CrawlSettingsCacheKey)
	if err := client.Del(ctx, keys...).Err(); err != nil {
		t.Fatalf("delete crawl worker keys: %v", err)
	}
	// The crawl4ai client must not issue the conditional HEAD request against
	// the target URL: the preflight is disabled exactly like an operator would.
	if err := client.Set(ctx, crawlqueue.CrawlSettingsCacheKey,
		`{"conditionalRequestEnabled":false,"maxConcurrency":1,"requestTimeoutNormalMs":15000}`, 0).Err(); err != nil {
		t.Fatalf("seed the crawl client settings: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// openQueuedIntegrationMongo connects Mongo and isolates one database per run.
func openQueuedIntegrationMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI is not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	name := "app"
	if parsed, parseErr := url.Parse(uri); parseErr == nil {
		if trimmed := strings.TrimPrefix(parsed.Path, "/"); trimmed != "" {
			name = trimmed
		}
	}
	database := client.Database(name + "_crawlexecution_queued_it")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.Ping(ctx, nil); err != nil {
		t.Fatalf("ping mongo: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		_ = database.Drop(cleanupCtx)
		_ = client.Disconnect(cleanupCtx)
	})
	return database
}

// seedQueuedIntegrationSource seeds the news source one failure below the
// circuit threshold.
func seedQueuedIntegrationSource(t *testing.T, db *sql.DB, now time.Time) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(),
		"INSERT INTO `NewsSource` (`id`, `orgId`, `name`, `url`, `isActive`, `consecutiveFailures`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, 'Integration Source', ?, 1, 1, ?, ?)",
		queuedIntegrationSourceID, queuedIntegrationOrgID, "https://8.8.8.8/source", now, now); err != nil {
		t.Fatalf("insert the news source: %v", err)
	}
}

// seedQueuedIntegrationTask seeds one CrawlTask plus its PipelineJob. The config
// carries both ids the circuit breaker path reads.
func seedQueuedIntegrationTask(t *testing.T, db *sql.DB, now time.Time, taskID, pipelineJobID string) {
	t.Helper()
	config := fmt.Sprintf(`{"ingestToItems":false,"pipelineJobId":%q,"sourceId":%q}`, pipelineJobID, queuedIntegrationSourceID)
	if _, err := db.ExecContext(context.Background(),
		"INSERT INTO `CrawlTask` (`id`, `orgId`, `createdById`, `newsSourceId`, `targetUrl`, `status`, `config`, `keywords`, `runCount`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, 'queued', ?, '[]', 0, ?, ?)",
		taskID, queuedIntegrationOrgID, queuedIntegrationUserID, queuedIntegrationSourceID,
		queuedIntegrationTarget, config, now, now); err != nil {
		t.Fatalf("insert crawl task %s: %v", taskID, err)
	}
	if _, err := db.ExecContext(context.Background(),
		"INSERT INTO `PipelineJob` (`id`, `orgId`, `sourceId`, `url`, `status`, `queueName`, `attempts`, `createdAt`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, 'pending', 'crawl4ai', 0, ?, ?)",
		pipelineJobID, queuedIntegrationOrgID, queuedIntegrationSourceID, queuedIntegrationTarget, now, now); err != nil {
		t.Fatalf("insert pipeline job %s: %v", pipelineJobID, err)
	}
}

// newQueuedIntegrationCrawl4ai starts a fake crawl4ai that always answers 400
// with a non-retryable message.
func newQueuedIntegrationCrawl4ai(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if strings.HasSuffix(request.URL.Path, "/health") {
			_, _ = writer.Write([]byte("{}"))
			return
		}
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = writer.Write([]byte(`{"message":"target rejected by the upstream policy"}`))
	}))
	t.Cleanup(server.Close)
	return server
}
