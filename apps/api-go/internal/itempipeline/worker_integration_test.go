//go:build integration

// Item pipeline worker integration tests against real MySQL, Redis and Mongo
// (the services the CI api-go-user-settings-integration job provides).
//
// Coverage:
//   - a successful job: TaskLog complete, PipelineJob completed, NewsSource
//     success reset, completed event;
//   - a transient failure: the job moves to the delayed set with the queue's
//     exponential backoff, attemptsMade = 1, TaskLog worker with the
//     remainingAttempts decision;
//   - a permanent failure: the job goes straight to the failed set (no delayed
//     attempt), failedReason is stored and itemPipelineDlq receives the
//     dead-letter job with the original data spread;
//   - B1: two concurrent final failures of one source increment the counter
//     twice and send the circuit-open notification once.
package itempipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/newspipeline"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

const (
	itOrgID      = "org-item-pipeline"
	itItemMetaID = "itemmeta-item-pipeline-1"
	itRawItemID  = "c0ffee000000000000000101"
	itPipelineID = "pipeline-job-1"
	itSourceID   = "news-source-1"
)

type integrationPipeline struct {
	mu     sync.Mutex
	calls  int
	err    error
	result newspipeline.ProcessResult
	onCall func()
}

func (f *integrationPipeline) Process(_ context.Context, _ newspipeline.Job, _ newspipeline.RawItem) (newspipeline.ProcessResult, error) {
	f.mu.Lock()
	f.calls++
	hook := f.onCall
	err := f.err
	result := f.result
	f.mu.Unlock()
	if hook != nil {
		hook()
	}
	if err != nil {
		return newspipeline.ProcessResult{}, err
	}
	return result, nil
}

type recordingNotifier struct {
	mu     sync.Mutex
	events []recordedNotification
}

type recordedNotification struct {
	OrgID string
	Title string
	Body  string
	Data  json.RawMessage
}

func (n *recordingNotifier) NotifySystem(_ context.Context, orgID, title, body string, data json.RawMessage) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.events = append(n.events, recordedNotification{OrgID: orgID, Title: title, Body: body, Data: data})
}

func (n *recordingNotifier) count() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.events)
}

type countingSnapshots struct {
	mu    sync.Mutex
	count int
}

func (s *countingSnapshots) Refresh(context.Context, string, string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count++
	return nil
}

func TestItemPipelineWorkerIntegration(t *testing.T) {
	db := openItemPipelineTestDB(t)
	redisClient := openItemPipelineTestRedis(t)
	database := openItemPipelineTestMongo(t)
	resetItemPipelineState(t, db, database)
	seedWorkerRows(t, db, database)

	// Successful job.
	pipeline := &integrationPipeline{result: newspipeline.ProcessResult{
		ProcessedItemID: itRawItemID,
		OutboxID:        "outbox-1",
		Document:        json.RawMessage(`{"_id":"` + itRawItemID + `","status":"completed"}`),
	}}
	notifier := &recordingNotifier{}
	snapshots := &countingSnapshots{}
	processor := newIntegrationProcessor(t, db, database, redisClient, pipeline, notifier, snapshots)
	runtime := startIntegrationWorker(t, redisClient, processor)
	jobID := enqueueIntegrationJob(t, redisClient, database, "trace-success")
	// The producer sets removeOnComplete=true, so a completed job leaves no
	// completed-set entry; the event stream is the observable completion.
	waitForEvent(t, redisClient, "completed", jobID, 15*time.Second)
	stopIntegrationWorker(t, runtime)

	assertItemMetaStatus(t, db, "processing")
	assertPipelineJobCompleted(t, db)
	assertNewsSourceSuccessReset(t, db)
	assertTaskLogStage(t, database, "complete", "completed")
	events := readQueueEvents(t, redisClient)
	if !strings.Contains(events, `"completed"`) {
		t.Fatalf("event stream has no completed event: %s", events)
	}
	if pipeline.calls != 1 {
		t.Fatalf("pipeline calls = %d", pipeline.calls)
	}
}

func TestItemPipelineWorkerRetriesTransientFailure(t *testing.T) {
	db := openItemPipelineTestDB(t)
	redisClient := openItemPipelineTestRedis(t)
	database := openItemPipelineTestMongo(t)
	resetItemPipelineState(t, db, database)
	seedWorkerRows(t, db, database)

	pipeline := &integrationPipeline{err: &TransientError{Message: "temporary"}}
	processor := newIntegrationProcessor(t, db, database, redisClient, pipeline, &recordingNotifier{}, &countingSnapshots{})
	runtime := startIntegrationWorker(t, redisClient, processor)
	jobID := enqueueIntegrationJob(t, redisClient, database, "trace-retry")
	waitForSetCard(t, redisClient, "bull:itemPipeline:delayed", 1, 15*time.Second)
	stopIntegrationWorker(t, runtime)

	// The queue default backoff is exponential with delay 2000ms, so the first
	// failure waits 2000ms and the job carries attemptsMade=1.
	state := readJobState(t, redisClient, jobID)
	if state["atm"] != "1" {
		t.Fatalf("attemptsMade = %s, want 1", state["atm"])
	}
	if !strings.Contains(state["failedReason"], "temporary") {
		t.Fatalf("failedReason = %q", state["failedReason"])
	}
	assertTaskLogStage(t, database, "worker", "failed")
	// No terminal failure: nothing in the failed set or the DLQ.
	if got := zcard(t, redisClient, "bull:itemPipeline:failed"); got != 0 {
		t.Fatalf("failed set = %d, want 0", got)
	}
	if got := zcard(t, redisClient, "bull:itemPipelineDlq:failed"); got != 0 {
		t.Fatalf("dlq failed set = %d, want 0", got)
	}
}

func TestItemPipelineWorkerPermanentFailureGoesToDLQ(t *testing.T) {
	db := openItemPipelineTestDB(t)
	redisClient := openItemPipelineTestRedis(t)
	database := openItemPipelineTestMongo(t)
	resetItemPipelineState(t, db, database)
	seedWorkerRows(t, db, database)

	pipeline := &integrationPipeline{err: NewPermanentError("permanent boom")}
	processor := newIntegrationProcessor(t, db, database, redisClient, pipeline, &recordingNotifier{}, &countingSnapshots{})
	runtime := startIntegrationWorker(t, redisClient, processor)
	jobID := enqueueIntegrationJob(t, redisClient, database, "trace-permanent")
	waitForSetCard(t, redisClient, "bull:itemPipeline:failed", 1, 15*time.Second)
	// No DLQ consumer runs in this test: the dead letter stays in the wait
	// list, so wait for its hash to appear instead of a completed entry.
	dlqJobID := "dlq-itemPipeline-" + jobID + "-1"
	waitForHash(t, redisClient, "bull:itemPipelineDlq:"+dlqJobID, 15*time.Second)
	stopIntegrationWorker(t, runtime)

	if got := zcard(t, redisClient, "bull:itemPipeline:delayed"); got != 0 {
		t.Fatalf("delayed set = %d, want 0 (permanent errors never retry)", got)
	}
	state := readJobState(t, redisClient, jobID)
	if !strings.Contains(state["failedReason"], "permanent boom") {
		t.Fatalf("failedReason = %q", state["failedReason"])
	}
	// The dead-letter job id is stable and the payload spreads the original
	// job data plus the failure context.
	dlq := readDLQJob(t, redisClient, dlqJobID)
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(dlq["data"]), &payload); err != nil {
		t.Fatalf("decode dlq data: %v", err)
	}
	for _, key := range []string{"rawItemId", "itemMetaId", "orgId", "originalQueue", "originalJobId", "failedAt", "attempts", "attemptsMade", "errorKind", "error"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("dlq payload missing %q: %s", key, dlq["data"])
		}
	}
	if string(payload["originalQueue"]) != `"itemPipeline"` || string(payload["originalJobId"]) != `"`+integrationJobID+`"` {
		t.Fatalf("dlq identity = %s / %s", payload["originalQueue"], payload["originalJobId"])
	}
	if string(payload["errorKind"]) != `"permanent"` {
		t.Fatalf("dlq errorKind = %s", payload["errorKind"])
	}
	// Final failure: ItemMeta failed, read model failed, TaskLog worker.
	assertItemMetaStatus(t, db, "failed")
	assertTaskLogStage(t, database, "worker", "failed")
}

func TestMarkSourceFailureStateConcurrentFinalFailures(t *testing.T) {
	db := openItemPipelineTestDB(t)
	database := openItemPipelineTestMongo(t)
	ctx := context.Background()

	resetItemPipelineState(t, db, database)
	seedNewsSource(t, db, 0, true)

	notifier := &recordingNotifier{}
	processor := newIntegrationProcessor(t, db, database, nil, &integrationPipeline{}, notifier, &countingSnapshots{})
	processor.sourceFailure = SourceFailureConfig{
		CircuitBreakerThreshold: 1,
		FailureRecoveryDelayMs:  600_000,
		FailureMaxDelayMs:       21_600_000,
	}

	var wg sync.WaitGroup
	for index := 0; index < 2; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			processor.markSourceFailureState(ctx, itSourceID, time.Now())
		}()
	}
	wg.Wait()

	assertSourceFailures(t, db, 2, false)
	if got := notifier.count(); got != 1 {
		t.Fatalf("circuit-open notifications = %d, want exactly 1", got)
	}
	notification := notifier.events[0]
	if notification.Title != "News source circuit opened" ||
		!strings.Contains(notification.Body, `"Test Source" reached 1 consecutive failures`) {
		t.Fatalf("notification = %+v", notification)
	}
}

// ---- helpers ----

func openItemPipelineTestDB(t *testing.T) *sql.DB {
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	// The reduced schemas are owned exclusively by this test; the CI step runs
	// after the other integration steps, so dropping them keeps this schema
	// exact without touching tables another step still needs.
	statements := []string{
		"DROP TABLE IF EXISTS ItemMeta",
		"DROP TABLE IF EXISTS PipelineJob",
		"DROP TABLE IF EXISTS NewsSource",
		"DROP TABLE IF EXISTS Notification",
		`CREATE TABLE IF NOT EXISTS ItemMeta (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			externalId varchar(255) NOT NULL,
			name varchar(255) NOT NULL,
			status varchar(32) NOT NULL DEFAULT 'draft',
			mongoRef varchar(40) NOT NULL DEFAULT '',
			version int NOT NULL DEFAULT 1,
			publishedAt datetime(3) NULL,
			sortAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS PipelineJob (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			sourceId varchar(40) NULL,
			url text NOT NULL,
			urlFingerprint varchar(64) NULL,
			priority int NOT NULL DEFAULT 0,
			status varchar(20) NOT NULL DEFAULT 'pending',
			queueName varchar(64) NOT NULL DEFAULT 'crawl-queue',
			scheduledFor datetime(3) NULL,
			startedAt datetime(3) NULL,
			completedAt datetime(3) NULL,
			attempts int NOT NULL DEFAULT 0,
			error text NULL,
			crawlRunId varchar(40) NULL,
			articleId varchar(40) NULL,
			metadata json NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS NewsSource (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			name varchar(255) NOT NULL,
			isActive tinyint(1) NOT NULL DEFAULT 1,
			lastRunAt datetime(3) NULL,
			lastSuccessAt datetime(3) NULL,
			lastFailureAt datetime(3) NULL,
			lastResultAt datetime(3) NULL,
			nextRunAt datetime(3) NULL,
			consecutiveFailures int NOT NULL DEFAULT 0,
			circuitOpenUntil datetime(3) NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE IF NOT EXISTS Notification (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			userId varchar(40) NULL,
			type varchar(32) NOT NULL DEFAULT 'system',
			title varchar(255) NOT NULL,
			body text NULL,
			data json NULL,
			readAt datetime(3) NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, table := range []string{"Notification", "NewsSource", "PipelineJob", "ItemMeta"} {
			_, _ = db.Exec("DROP TABLE IF EXISTS `" + table + "`")
		}
		_ = db.Close()
	})
	return db
}

func openItemPipelineTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func openItemPipelineTestMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI is not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	parsed, err := url.Parse(uri)
	if err != nil {
		t.Fatalf("parse MONGO_URI: %v", err)
	}
	name := strings.TrimPrefix(parsed.Path, "/")
	if name == "" {
		name = "app"
	}
	database := client.Database(name + "_itempipeline_it")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func resetItemPipelineState(t *testing.T, db *sql.DB, database *mongo.Database) {
	t.Helper()
	for _, table := range []string{"Notification", "NewsSource", "PipelineJob", "ItemMeta"} {
		if _, err := db.Exec("DELETE FROM `" + table + "`"); err != nil {
			t.Fatalf("clean %s: %v", table, err)
		}
	}
	for _, collection := range []string{taskLogsCollection, rawItemsCollection, processedItemsCollection, itemReadModelsCollection} {
		_, _ = database.Collection(collection).DeleteMany(context.Background(), bson.D{})
	}
}

func seedWorkerRows(t *testing.T, db *sql.DB, database *mongo.Database) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(`INSERT INTO ItemMeta (id,orgId,externalId,name,status,mongoRef,version,sortAt,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, itItemMetaID, itOrgID, "external-1", "Item", "pending", itRawItemID, 1, now, now, now); err != nil {
		t.Fatalf("insert item meta: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO PipelineJob (id,orgId,url,status,queueName,attempts,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?)`, itPipelineID, itOrgID, "https://example.com/a", "pending", "itemPipeline", 0, now, now); err != nil {
		t.Fatalf("insert pipeline job: %v", err)
	}
	seedNewsSource(t, db, 0, true)
	rawID, err := bson.ObjectIDFromHex(itRawItemID)
	if err != nil {
		t.Fatalf("raw id: %v", err)
	}
	_, err = database.Collection(rawItemsCollection).InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: rawID},
		{Key: "itemMetaId", Value: itItemMetaID},
		{Key: "payload", Value: bson.D{
			{Key: "url", Value: "https://example.com/a"},
			{Key: "prefetchedArticle", Value: bson.D{{Key: "markdown", Value: "body"}}},
		}},
		{Key: "source", Value: "manual"},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	})
	if err != nil {
		t.Fatalf("insert raw item: %v", err)
	}
}

func seedNewsSource(t *testing.T, db *sql.DB, failures int, active bool) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec(`INSERT INTO NewsSource (id,orgId,name,isActive,consecutiveFailures,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?)`, itSourceID, itOrgID, "Test Source", active, failures, now, now); err != nil {
		t.Fatalf("insert news source: %v", err)
	}
}

func newIntegrationProcessor(
	t *testing.T,
	db *sql.DB,
	database *mongo.Database,
	redisClient *redis.Client,
	pipeline Pipeline,
	notifier Notifier,
	snapshots SnapshotRefresher,
) *Processor {
	t.Helper()
	processor, err := NewProcessor(ProcessorOptions{
		DB:             db,
		Mongo:          database,
		Redis:          redisClient,
		Pipeline:       pipeline,
		Notifier:       notifier,
		Snapshots:      snapshots,
		SnapshotWindow: time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewProcessor: %v", err)
	}
	return processor
}

func startIntegrationWorker(t *testing.T, redisClient *redis.Client, processor *Processor) *Worker {
	t.Helper()
	blocking := redis.NewClient(redisClient.Options())
	worker, err := NewWorker(redisClient, blocking, WorkerOptions{
		Concurrency: 2,
		Processor:   processor.Handle,
		OnFailure:   processor.HandleFailure,
	})
	if err != nil {
		t.Fatalf("NewWorker: %v", err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = worker.Close(ctx)
		_ = blocking.Close()
	})
	return worker
}

func stopIntegrationWorker(t *testing.T, worker *Worker) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := worker.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

const integrationJobID = itItemMetaID + "-" + itRawItemID

func enqueueIntegrationJob(t *testing.T, redisClient *redis.Client, database *mongo.Database, traceID string) string {
	t.Helper()
	producer := pipelineenqueue.New(pipelineenqueue.Options{Redis: redisClient, Mongo: database})
	pipelineJobID := itPipelineID
	sourceID := itSourceID
	enqueued, err := producer.EnqueueItem(context.Background(), itOrgID, itItemMetaID, itRawItemID, pipelineenqueue.EnqueueOptions{
		TraceID:         traceID,
		PipelineJobID:   &pipelineJobID,
		SourceID:        &sourceID,
		ProcessedItemID: itRawItemID,
	})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if enqueued != integrationJobID {
		t.Fatalf("producer job id = %q, want %q", enqueued, integrationJobID)
	}
	return enqueued
}

func waitForEvent(t *testing.T, redisClient *redis.Client, eventName, jobID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		entries, err := redisClient.XRange(context.Background(), "bull:itemPipeline:events", "-", "+").Result()
		if err != nil {
			t.Fatalf("read events: %v", err)
		}
		for _, entry := range entries {
			if fmt.Sprint(entry.Values["event"]) == eventName && fmt.Sprint(entry.Values["jobId"]) == jobID {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("event %s for job %s did not appear", eventName, jobID)
}

func waitForHash(t *testing.T, redisClient *redis.Client, key string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		exists, err := redisClient.Exists(context.Background(), key).Result()
		if err != nil {
			t.Fatalf("exists %s: %v", key, err)
		}
		if exists == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("hash %s did not appear", key)
}

func waitForSetCard(t *testing.T, redisClient *redis.Client, key string, want int64, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if got := zcard(t, redisClient, key); got == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s did not reach %d (got %d)", key, want, zcard(t, redisClient, key))
}

func zcard(t *testing.T, redisClient *redis.Client, key string) int64 {
	t.Helper()
	value, err := redisClient.ZCard(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("zcard %s: %v", key, err)
	}
	return value
}

func readJobState(t *testing.T, redisClient *redis.Client, jobID string) map[string]string {
	t.Helper()
	values, err := redisClient.HGetAll(context.Background(), "bull:itemPipeline:"+jobID).Result()
	if err != nil {
		t.Fatalf("read job state: %v", err)
	}
	return values
}

func readDLQJob(t *testing.T, redisClient *redis.Client, jobID string) map[string]string {
	t.Helper()
	values, err := redisClient.HGetAll(context.Background(), "bull:itemPipelineDlq:"+jobID).Result()
	if err != nil {
		t.Fatalf("read dlq job: %v", err)
	}
	if len(values) == 0 {
		t.Fatalf("dlq job %s not found", jobID)
	}
	return values
}

func readQueueEvents(t *testing.T, redisClient *redis.Client) string {
	t.Helper()
	entries, err := redisClient.XRange(context.Background(), "bull:itemPipeline:events", "-", "+").Result()
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	builder := strings.Builder{}
	for _, entry := range entries {
		builder.WriteString(fmt.Sprint(entry.Values["event"]))
		builder.WriteString(" ")
	}
	return builder.String()
}

func assertItemMetaStatus(t *testing.T, db *sql.DB, want string) {
	t.Helper()
	var status string
	if err := db.QueryRow("SELECT status FROM ItemMeta WHERE id = ?", itItemMetaID).Scan(&status); err != nil {
		t.Fatalf("read item meta: %v", err)
	}
	if status != want {
		t.Fatalf("ItemMeta.status = %q, want %q", status, want)
	}
}

func assertPipelineJobCompleted(t *testing.T, db *sql.DB) {
	t.Helper()
	var status string
	var completedAt sql.NullTime
	if err := db.QueryRow("SELECT status, completedAt FROM PipelineJob WHERE id = ?", itPipelineID).Scan(&status, &completedAt); err != nil {
		t.Fatalf("read pipeline job: %v", err)
	}
	if status != "completed" || !completedAt.Valid {
		t.Fatalf("PipelineJob = %s / %v", status, completedAt)
	}
}

func assertNewsSourceSuccessReset(t *testing.T, db *sql.DB) {
	t.Helper()
	var lastSuccessAt sql.NullTime
	var failures int
	var circuit sql.NullTime
	if err := db.QueryRow("SELECT lastSuccessAt, consecutiveFailures, circuitOpenUntil FROM NewsSource WHERE id = ?", itSourceID).
		Scan(&lastSuccessAt, &failures, &circuit); err != nil {
		t.Fatalf("read news source: %v", err)
	}
	if !lastSuccessAt.Valid || failures != 0 || circuit.Valid {
		t.Fatalf("NewsSource success = %v / %d / %v", lastSuccessAt, failures, circuit)
	}
}

func assertSourceFailures(t *testing.T, db *sql.DB, want int, wantDisabled bool) {
	t.Helper()
	var failures int
	var active bool
	var circuit sql.NullTime
	if err := db.QueryRow("SELECT consecutiveFailures, isActive, circuitOpenUntil FROM NewsSource WHERE id = ?", itSourceID).
		Scan(&failures, &active, &circuit); err != nil {
		t.Fatalf("read news source: %v", err)
	}
	if failures != want {
		t.Fatalf("consecutiveFailures = %d, want %d", failures, want)
	}
	if wantDisabled == active {
		t.Fatalf("isActive = %v", active)
	}
}

func assertTaskLogStage(t *testing.T, database *mongo.Database, stage, status string) {
	t.Helper()
	filter := bson.D{{Key: "queue", Value: QueueName}, {Key: "stage", Value: stage}, {Key: "status", Value: status}}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		count, err := database.Collection(taskLogsCollection).CountDocuments(ctx, filter)
		cancel()
		if err != nil {
			t.Fatalf("count task logs: %v", err)
		}
		if count > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("no TaskLog queue=%s stage=%s status=%s", QueueName, stage, status)
}
