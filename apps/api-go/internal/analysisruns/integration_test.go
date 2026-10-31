//go:build integration

// End-to-end integration test for ANALYSIS-RUNS-001.
//
// It runs the real Go BullMQ runner against real MySQL, Redis and Mongo, uses
// the real publicportal stream client against a local HTTP SSE fixture, and
// drives the locked Node BullMQ implementation in both directions. The SSE
// fixture proves the stream protocol and the local closed loop; it is not an
// external model verification.
package analysisruns

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

	"github.com/wei500L/newwei/apps/api-go/internal/analysisqueue"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const analysisTestPrefix = analysisqueue.DefaultPrefix

func integrationDatabase(t *testing.T) *sql.DB {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set - integration test requires MySQL")
	}
	db, err := usersettings.OpenMySQLFromURL(url)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS SystemSetting (" +
			"`key` VARCHAR(191) NOT NULL, value JSON NOT NULL, isPublic BOOLEAN NOT NULL DEFAULT FALSE, " +
			"description VARCHAR(191) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"updatedAt DATETIME(3) NOT NULL, updatedById VARCHAR(191) NULL, PRIMARY KEY (`key`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS Notification (" +
			"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, userId VARCHAR(191) NULL, " +
			"type VARCHAR(64) NOT NULL, title VARCHAR(255) NOT NULL, body TEXT NULL, data JSON NULL, " +
			"readAt DATETIME(3) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"updatedAt DATETIME(3) NOT NULL, PRIMARY KEY (id), INDEX Notification_orgId_createdAt (orgId, createdAt)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, table := range []string{"SystemSetting", "Notification"} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`"); err != nil {
			t.Fatalf("drop integration table: %v", err)
		}
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create integration table: %v", err)
		}
	}
	return db
}

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		host := strings.TrimSpace(os.Getenv("REDIS_HOST"))
		port := strings.TrimSpace(os.Getenv("REDIS_PORT"))
		if host == "" {
			t.Skip("API_GO_TEST_REDIS_ADDR/REDIS_HOST not set - integration test requires Redis")
		}
		if port == "" {
			port = "6379"
		}
		addr = net.JoinHostPort(host, port)
	}
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Username: strings.TrimSpace(os.Getenv("REDIS_USERNAME")),
		Password: strings.TrimSpace(os.Getenv("REDIS_PASSWORD")),
		DB:       0,
		Protocol: 2,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	// The CI integration job is a dedicated ephemeral Redis. Flushing keeps the
	// queue assertions deterministic; production code never flushes a database.
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	return client
}

func integrationMongo(t *testing.T) (*mongo.Client, *mongo.Database, func()) {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI not set - integration test requires MongoDB 7.0")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	databaseName := "analysis_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	database := client.Database(databaseName)
	cleanup := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	}
	return client, database, cleanup
}

type sseFixture struct {
	server *httptest.Server
	calls  atomic.Int64
}

func newSSEFixture(handler func(call int64, w http.ResponseWriter, r *http.Request)) *sseFixture {
	fixture := &sseFixture{}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := fixture.calls.Add(1)
		handler(call, w, r)
	}))
	return fixture
}

func (f *sseFixture) close()           { f.server.Close() }
func (f *sseFixture) url() string      { return f.server.URL }
func (f *sseFixture) callCount() int64 { return f.calls.Load() }

func writeChatSuccess(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	encoded, _ := json.Marshal(text)
	fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%s}}]}\n\n", encoded)
	fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
	fmt.Fprint(w, "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12},\"response_cost\":0.001}\n\n")
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func seedProfile(t *testing.T, db *sql.DB, baseURL string, surface string, fallback []string) {
	t.Helper()
	profile := map[string]any{
		"id":             "analysis-test-profile",
		"model":          "primary",
		"apiBase":        baseURL,
		"apiKey":         "test-key",
		"apiSurface":     surface,
		"fallbackModels": fallback,
		"timeoutMs":      5000,
	}
	if surface == "" {
		profile["apiSurface"] = "chat_completions"
	}
	encoded, err := json.Marshal(map[string]any{
		"activeId": "analysis-test-profile",
		"profiles": []any{profile},
	})
	if err != nil {
		t.Fatalf("encode profile: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, updatedAt) VALUES (?, ?, ?) "+
			"ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = VALUES(updatedAt)",
		"llm_gateway_profiles", encoded, time.Now().UTC().Truncate(time.Millisecond))
	if err != nil {
		t.Fatalf("seed profile: %v", err)
	}
}

func newTestHandler(t *testing.T, db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database) *Handler {
	t.Helper()
	streamer := publicportal.NewAnalysisStreamer(publicportal.NewMySQLStore(db), publicportal.GatewayEnv{
		APIBase:         "http://127.0.0.1:1",
		TimeoutMs:       5000,
		MaxRetries:      1,
		TopP:            0.9,
		Temperature:     0.2,
		MaxOutputTokens: 2048,
	})
	handler, err := NewHandler(HandlerOptions{
		Store:         NewStore(mongoDatabase),
		Geo:           NewGeoBuilder(mongoDatabase),
		Streamer:      streamer,
		Prompts:       NewPromptBuilder(PromptOverrides{}),
		Events:        NewEventPublisher(redisClient),
		Notifications: NewNotificationWriter(db, redisClient),
		Logs:          llmlogs.NewAnalysisStreamWriter(db, mongoDatabase),
		FlushChars:    10,
		FlushMs:       50,
		TimeoutMs:     5000,
	})
	if err != nil {
		t.Fatalf("new handler: %v", err)
	}
	return handler
}

func newTestWorker(t *testing.T, db *sql.DB, redisClient *redis.Client, mongoDatabase *mongo.Database, handler *Handler, options WorkerTestOptions) *analysisqueue.Worker {
	t.Helper()
	blocking := redis.NewClient(&redis.Options{
		Addr:     redisClient.Options().Addr,
		Username: redisClient.Options().Username,
		Password: redisClient.Options().Password,
		DB:       redisClient.Options().DB,
		Protocol: 2,
	})
	worker, err := analysisqueue.NewWorker(redisClient, blocking, analysisqueue.WorkerOptions{
		Concurrency:     options.Concurrency,
		Prefix:          analysisTestPrefix,
		LockDuration:    options.LockDuration,
		LockRenewTime:   options.LockRenewTime,
		StalledInterval: options.StalledInterval,
		MaxStalledCount: 1,
		DrainDelay:      options.DrainDelay,
		Processor:       handler.Handle,
		Logger:          t.Logf,
	})
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatalf("start worker: %v", err)
	}
	return worker
}

// closeTestWorker bounds the drain so a deliberately blocked fixture request
// cannot hang the test process. Production main passes its own 30s shutdown
// context.
func closeTestWorker(worker *analysisqueue.Worker) {
	if worker == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = worker.Close(ctx)
}

// WorkerTestOptions keeps test overrides explicit; production uses the fixed
// BullMQ defaults.
type WorkerTestOptions struct {
	Concurrency     int
	LockDuration    time.Duration
	LockRenewTime   time.Duration
	StalledInterval time.Duration
	DrainDelay      time.Duration
}

func defaultWorkerOptions() WorkerTestOptions {
	return WorkerTestOptions{
		Concurrency:     2,
		LockDuration:    analysisqueue.LockDuration,
		LockRenewTime:   analysisqueue.LockRenewTime,
		StalledInterval: analysisqueue.StalledInterval,
		DrainDelay:      300 * time.Millisecond,
	}
}

func seedCorrelation(t *testing.T, store *Store, orgID, userID string) PendingRecord {
	t.Helper()
	record, err := InsertPending(context.Background(), store, orgID, TypeCorrelation, CorrelationInput{
		IndicatorName: "CPI",
		Value:         101.5,
		ChangePercent: -2.25,
		StartDate:     "2026-01-01",
		EndDate:       "2026-01-31",
		NewsSummaries: []string{"first", "second"},
	}, &userID)
	if err != nil {
		t.Fatalf("insert pending: %v", err)
	}
	return record
}

func recordObjectID(t *testing.T, record PendingRecord) bson.ObjectID {
	t.Helper()
	id, err := bson.ObjectIDFromHex(record.ID)
	if err != nil {
		t.Fatalf("parse object id: %v", err)
	}
	return id
}

func waitRecord(t *testing.T, store *Store, id bson.ObjectID, status Status, timeout time.Duration) Record {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last Record
	for time.Now().Before(deadline) {
		record, found, err := store.Load(context.Background(), id)
		if err != nil {
			t.Fatalf("load record: %v", err)
		}
		if found {
			last = record
			if record.Status == status {
				return record
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("record %s did not reach %s (last status %s, error %v)", id.Hex(), status, last.Status, last.Error)
	return Record{}
}

func waitCondition(t *testing.T, label string, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("condition %s not met within %s", label, timeout)
}

func waitJobGone(t *testing.T, client *redis.Client, jobID string, timeout time.Duration) {
	t.Helper()
	key := fmt.Sprintf("%s:analysis:%s", analysisTestPrefix, jobID)
	waitCondition(t, "job key removed "+jobID, timeout, func() bool {
		exists, err := client.Exists(context.Background(), key).Result()
		return err == nil && exists == 0
	})
}

func countNotifications(t *testing.T, db *sql.DB, orgID, notificationType string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM Notification WHERE orgId = ? AND type = ?",
		orgID, notificationType,
	).Scan(&count); err != nil {
		t.Fatalf("count notifications: %v", err)
	}
	return count
}

func countStreamLogs(t *testing.T, database *mongo.Database, orgID string) int64 {
	t.Helper()
	count, err := database.Collection("llmrequestlogs").CountDocuments(context.Background(), bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "requestType", Value: "stream"},
	})
	if err != nil {
		t.Fatalf("count llm logs: %v", err)
	}
	return count
}

type eventCollector struct {
	mu     sync.Mutex
	events []AnalysisEvent
	stop   context.CancelFunc
}

func startEventCollector(t *testing.T, client *redis.Client) *eventCollector {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	pubsub := client.Subscribe(ctx, AnalysisEventsChannel)
	if _, err := pubsub.Receive(ctx); err != nil {
		cancel()
		t.Fatalf("subscribe analysis events: %v", err)
	}
	collector := &eventCollector{stop: func() {
		_ = pubsub.Close()
		cancel()
	}}
	go func() {
		for message := range pubsub.Channel() {
			var event AnalysisEvent
			if err := json.Unmarshal([]byte(message.Payload), &event); err != nil {
				continue
			}
			collector.mu.Lock()
			collector.events = append(collector.events, event)
			collector.mu.Unlock()
		}
	}()
	t.Cleanup(collector.stop)
	return collector
}

func (c *eventCollector) waitFor(t *testing.T, orgID string, status Status, timeout time.Duration) AnalysisEvent {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		for _, event := range c.events {
			if event.OrgID == orgID && event.Result.Status == status {
				c.mu.Unlock()
				return event
			}
		}
		c.mu.Unlock()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("event %s/%s not observed", orgID, status)
	return AnalysisEvent{}
}

func (c *eventCollector) count(t *testing.T, orgID string, status Status) int {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	count := 0
	for _, event := range c.events {
		if event.OrgID == orgID && event.Result.Status == status {
			count++
		}
	}
	return count
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
}

func runNodeFixture(t *testing.T, mode string, environment map[string]string) string {
	t.Helper()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("node is required in CI for the BullMQ interoperability fixture")
		}
		t.Skip("node is not installed")
	}
	root := repoRoot(t)
	fixture, err := os.ReadFile(filepath.Join(root, "apps/api-go/testdata/analysis_queue_fixture.mjs"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	command := exec.Command(nodePath, "--input-type=module")
	command.Dir = filepath.Join(root, "infra/scripts")
	command.Stdin = bytes.NewReader(fixture)
	env := append(os.Environ(), "FIXTURE_MODE="+mode)
	for key, value := range environment {
		env = append(env, key+"="+value)
	}
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("node fixture %s: %v\n%s", mode, err, output)
	}
	return strings.TrimSpace(string(output))
}

func TestAnalysisRunsIntegration(t *testing.T) {
	db := integrationDatabase(t)
	defer db.Close()
	redisClient := integrationRedis(t)
	defer redisClient.Close()
	_, mongoDatabase, closeMongo := integrationMongo(t)
	defer closeMongo()

	ctx := context.Background()
	store := NewStore(mongoDatabase)
	events := startEventCollector(t, redisClient)
	handler := newTestHandler(t, db, redisClient, mongoDatabase)
	worker := newTestWorker(t, db, redisClient, mongoDatabase, handler, defaultWorkerOptions())
	defer func() {
		closeTestWorker(worker)
	}()

	t.Run("NodeBullMQToGoWorkerCompletes", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			writeChatSuccess(w, "node to go")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)

		orgID, userID := "org-node-go", "user-node-go"
		record := seedCorrelation(t, store, orgID, userID)
		jobID := "corr-" + record.ID
		output := runNodeFixture(t, "produce", map[string]string{
			"BULLMQ_REDIS_HOST": redisHost(t, redisClient),
			"BULLMQ_REDIS_PORT": redisPort(t, redisClient),
			"FIXTURE_JOB_ID":    jobID,
			"FIXTURE_ATTEMPTS":  "1",
			"FIXTURE_PAYLOAD":   mustJSON(t, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID, TraceID: "trace-node-go"}),
		})
		if !strings.Contains(output, jobID) {
			t.Fatalf("node producer output = %s", output)
		}
		completed := waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 15*time.Second)
		if completed.Summary == nil || *completed.Summary != "node to go" {
			t.Fatalf("summary = %v", completed.Summary)
		}
		if countNotifications(t, db, orgID, "analysis_completed") != 1 {
			t.Fatal("expected exactly one analysis_completed notification")
		}
		if countStreamLogs(t, mongoDatabase, orgID) != 1 {
			t.Fatal("expected exactly one stream LLM request log")
		}
		var logRow struct {
			RequestType string `bson:"requestType"`
			Model       string `bson:"model"`
			APISurface  string `bson:"apiSurface"`
			Status      string `bson:"status"`
		}
		if err := mongoDatabase.Collection("llmrequestlogs").FindOne(ctx, bson.D{{Key: "orgId", Value: orgID}}).Decode(&logRow); err != nil {
			t.Fatalf("load stream log: %v", err)
		}
		if logRow.RequestType != "stream" || logRow.Model != "primary" ||
			logRow.APISurface != "chat_completions" || logRow.Status != "success" {
			t.Fatalf("stream log row = %+v", logRow)
		}
		event := events.waitFor(t, orgID, StatusCompleted, 5*time.Second)
		if event.Result.Summary == nil || *event.Result.Summary != "node to go" {
			t.Fatalf("completed event = %+v", event)
		}
		if event.Result.CreatedAt == "" || event.Result.Error != nil {
			t.Fatalf("completed event envelope = %+v", event)
		}
		waitJobGone(t, redisClient, jobID, 5*time.Second)
	})

	t.Run("GoProducerToNodeBullMQWorker", func(t *testing.T) {
		closeTestWorker(worker)
		defer func() {
			worker = newTestWorker(t, db, redisClient, mongoDatabase, handler, defaultWorkerOptions())
		}()
		orgID, userID := "org-go-node", "user-go-node"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		jobID, err := producer.Add(ctx, analysisqueue.Payload{
			Type:       analysisqueue.TypeCorrelation,
			AnalysisID: record.ID,
			OrgID:      orgID,
			TraceID:    "trace-go-node",
		})
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		output := runNodeFixture(t, "consume", map[string]string{
			"BULLMQ_REDIS_HOST":  redisHost(t, redisClient),
			"BULLMQ_REDIS_PORT":  redisPort(t, redisClient),
			"FIXTURE_JOB_ID":     jobID,
			"FIXTURE_TIMEOUT_MS": "10000",
		})
		if !strings.Contains(output, jobID) || !strings.Contains(output, `"ok":true`) {
			t.Fatalf("node consumer output = %s", output)
		}
		waitJobGone(t, redisClient, jobID, 5*time.Second)
		pending, found, err := store.Load(ctx, recordObjectID(t, record))
		if err != nil || !found {
			t.Fatalf("load record: found=%v err=%v", found, err)
		}
		if pending.Status != StatusPending {
			t.Fatalf("Node consumer must not write the Go result; status = %s", pending.Status)
		}
	})

	t.Run("ImmediateRetrySucceedsAfterOneFailure", func(t *testing.T) {
		fixture := newSSEFixture(func(call int64, w http.ResponseWriter, _ *http.Request) {
			if call == 1 {
				w.WriteHeader(http.StatusInternalServerError)
				_, _ = w.Write([]byte(`{"error":{"message":"transient"}}`))
				return
			}
			writeChatSuccess(w, "retry works")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-retry", "user-retry"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 3)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		if _, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID}); err != nil {
			t.Fatalf("add job: %v", err)
		}
		completed := waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 20*time.Second)
		if completed.Summary == nil || *completed.Summary != "retry works" {
			t.Fatalf("summary = %v", completed.Summary)
		}
		if fixture.callCount() != 2 {
			t.Fatalf("model calls = %d, want 2", fixture.callCount())
		}
		if countNotifications(t, db, orgID, "analysis_completed") != 1 {
			t.Fatal("expected one completed notification")
		}
		if countNotifications(t, db, orgID, "analysis_failed") != 0 {
			t.Fatal("an intermediate failure must not notify")
		}
	})

	t.Run("FinalFailureNotifiesOnce", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"permanent"}}`))
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-final-failure", "user-final-failure"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		if _, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID}); err != nil {
			t.Fatalf("add job: %v", err)
		}
		failed := waitRecord(t, store, recordObjectID(t, record), StatusFailed, 15*time.Second)
		if failed.Error == nil || !strings.Contains(*failed.Error, "500") {
			t.Fatalf("error = %v", failed.Error)
		}
		if countNotifications(t, db, orgID, "analysis_failed") != 1 {
			t.Fatal("expected exactly one analysis_failed notification")
		}
		if countNotifications(t, db, orgID, "analysis_completed") != 0 {
			t.Fatal("unexpected completed notification")
		}
		events.waitFor(t, orgID, StatusFailed, 5*time.Second)
	})

	t.Run("PausedQueueIsNotClaimed", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			writeChatSuccess(w, "after unpause")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-paused", "user-paused"
		record := seedCorrelation(t, store, orgID, userID)
		if err := redisClient.HSet(ctx, "bull:analysis:meta", "paused", "1").Err(); err != nil {
			t.Fatalf("pause queue: %v", err)
		}
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		jobID, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID})
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		time.Sleep(1200 * time.Millisecond)
		pending, found, err := store.Load(ctx, recordObjectID(t, record))
		if err != nil || !found {
			t.Fatalf("load record: found=%v err=%v", found, err)
		}
		if pending.Status != StatusPending {
			t.Fatalf("paused queue claimed the job: status = %s", pending.Status)
		}
		// BullMQ adds jobs to the paused list while meta.paused is set.
		pausedLen, err := redisClient.LLen(ctx, "bull:analysis:paused").Result()
		if err != nil || pausedLen < 1 {
			t.Fatalf("paused job should stay in the paused list: len=%d err=%v", pausedLen, err)
		}
		activeLen, err := redisClient.LLen(ctx, "bull:analysis:active").Result()
		if err != nil || activeLen != 0 {
			t.Fatalf("paused job must not be active: len=%d err=%v", activeLen, err)
		}
		if err := redisClient.HDel(ctx, "bull:analysis:meta", "paused").Err(); err != nil {
			t.Fatalf("resume queue: %v", err)
		}
		// Queue.resume moves paused jobs back to wait. The test does the same
		// list move explicitly so it exercises the Go consumer's paused check
		// without depending on the Nest/queue pause owner.
		for {
			_, moveErr := redisClient.LMove(ctx, "bull:analysis:paused", "bull:analysis:wait", "RIGHT", "LEFT").Result()
			if moveErr == redis.Nil {
				break
			}
			if moveErr != nil {
				t.Fatalf("resume paused job: %v", moveErr)
			}
		}
		if err := redisClient.ZAdd(ctx, "bull:analysis:marker", redis.Z{Score: 0, Member: "0"}).Err(); err != nil {
			t.Fatalf("wake marker: %v", err)
		}
		completed := waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 15*time.Second)
		if completed.Summary == nil || *completed.Summary != "after unpause" {
			t.Fatalf("summary = %v", completed.Summary)
		}
		waitJobGone(t, redisClient, jobID, 5*time.Second)
	})

	t.Run("CompletedRecordIsNotRecomputed", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			writeChatSuccess(w, "once")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-completed", "user-completed"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		payload := analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID}
		jobID, err := producer.Add(ctx, payload)
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 15*time.Second)
		if fixture.callCount() != 1 {
			t.Fatalf("first run calls = %d", fixture.callCount())
		}
		// removeOnComplete removed the job, so the same job id can be added
		// again. The handler must see completed and acknowledge without a model
		// call.
		if _, err := producer.Add(ctx, payload); err != nil {
			t.Fatalf("re-add job: %v", err)
		}
		waitJobGone(t, redisClient, jobID, 10*time.Second)
		time.Sleep(500 * time.Millisecond)
		if fixture.callCount() != 1 {
			t.Fatalf("completed record was recomputed: calls = %d", fixture.callCount())
		}
	})

	t.Run("OrganizationMismatchCannotTouchTheRecord", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			writeChatSuccess(w, "must not run")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-isolation-a", "user-isolation"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		jobID, err := producer.Add(ctx, analysisqueue.Payload{
			Type:       analysisqueue.TypeCorrelation,
			AnalysisID: record.ID,
			OrgID:      "org-isolation-b",
		})
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		waitCondition(t, "mismatched job finalized", 10*time.Second, func() bool {
			score, err := redisClient.ZScore(ctx, "bull:analysis:failed", jobID).Result()
			return err == nil && score > 0
		})
		pending, found, err := store.Load(ctx, recordObjectID(t, record))
		if err != nil || !found {
			t.Fatalf("load record: found=%v err=%v", found, err)
		}
		if pending.Status != StatusPending {
			t.Fatalf("another organization's job modified the record: status = %s", pending.Status)
		}
		if countNotifications(t, db, orgID, "analysis_completed") != 0 ||
			countNotifications(t, db, orgID, "analysis_failed") != 0 {
			t.Fatal("mismatched organization must not produce a notification")
		}
		if fixture.callCount() != 0 {
			t.Fatal("mismatched organization must not call the model")
		}
		// A payload whose type differs from the persisted record is rejected for
		// the same reason: dispatching the wrong computation could corrupt the
		// result of a legitimate owner.
		typeJobID, err := producer.Add(ctx, analysisqueue.Payload{
			Type:       analysisqueue.TypeAnomaly,
			AnalysisID: record.ID,
			OrgID:      orgID,
		})
		if err != nil {
			t.Fatalf("add mismatched type job: %v", err)
		}
		waitCondition(t, "mismatched type job finalized", 10*time.Second, func() bool {
			score, err := redisClient.ZScore(ctx, "bull:analysis:failed", typeJobID).Result()
			return err == nil && score > 0
		})
		stillPending, found, err := store.Load(ctx, recordObjectID(t, record))
		if err != nil || !found {
			t.Fatalf("load record after type mismatch: found=%v err=%v", found, err)
		}
		if stillPending.Status != StatusPending {
			t.Fatalf("mismatched type modified the record: status = %s", stillPending.Status)
		}
	})

	t.Run("GeoKeepsThirtyPointsPerObject", func(t *testing.T) {
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, _ *http.Request) {
			writeChatSuccess(w, "geo ok")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-geo", "user-geo"
		now := time.Now().UTC().Truncate(time.Second)
		start := now.Add(-200 * time.Second)
		end := now.Add(60 * time.Second)
		seedGeoData(t, mongoDatabase, orgID, now, start)
		record, err := InsertPending(ctx, store, orgID, TypeGeoTransport, GeoTransportInput{
			TransportKinds: []string{"aircraft"},
			StartDate:      start.Format(time.RFC3339),
			EndDate:        end.Format(time.RFC3339),
		}, &userID)
		if err != nil {
			t.Fatalf("insert geo pending: %v", err)
		}
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 1)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		if _, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeGeoTransport, AnalysisID: record.ID, OrgID: orgID}); err != nil {
			t.Fatalf("add geo job: %v", err)
		}
		completed := waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 20*time.Second)
		output, err := decodeInput[GeoTransportOutput](completed.Output)
		if err != nil {
			t.Fatalf("decode geo output: %v", err)
		}
		if output.PromptVersion != GeoPromptVersion {
			t.Fatalf("prompt version = %q", output.PromptVersion)
		}
		if len(output.Context.Objects) != 2 {
			t.Fatalf("objects = %d, want 2", len(output.Context.Objects))
		}
		newest := now.Format("2006-01-02T15:04:05.000Z")
		for _, object := range output.Context.Objects {
			if len(object.TrackPoints) != 30 {
				t.Fatalf("object %s points = %d, want 30", object.ObjectKey, len(object.TrackPoints))
			}
			if object.TrackPoints[0].ObservedAt != newest {
				t.Fatalf("object %s newest point = %s, want %s", object.ObjectKey, object.TrackPoints[0].ObservedAt, newest)
			}
			if object.ObjectKey == "obj-other-org" {
				t.Fatal("another organization's object leaked into the context")
			}
			for _, point := range object.TrackPoints {
				observed, err := time.Parse(time.RFC3339, point.ObservedAt)
				if err != nil {
					t.Fatalf("parse observedAt: %v", err)
				}
				if observed.Before(start) || observed.After(end) {
					t.Fatalf("track point outside the window: %s", point.ObservedAt)
				}
			}
		}
	})

	t.Run("StalledRecoveryResumesRunningRecord", func(t *testing.T) {
		closeTestWorker(worker)
		if err := redisClient.Del(ctx, "bull:analysis:stalled-check").Err(); err != nil {
			t.Fatalf("clear stale stalled-check key: %v", err)
		}
		firstCall := make(chan struct{}, 1)
		release := make(chan struct{})
		fixture := newSSEFixture(func(call int64, w http.ResponseWriter, r *http.Request) {
			if call == 1 {
				firstCall <- struct{}{}
				select {
				case <-release:
				case <-r.Context().Done():
				}
				return
			}
			writeChatSuccess(w, "stalled recovered")
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-stalled", "user-stalled"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 3)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		jobID, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID})
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		fastWorker := newTestWorker(t, db, redisClient, mongoDatabase, handler, WorkerTestOptions{
			Concurrency:     1,
			LockDuration:    500 * time.Millisecond,
			LockRenewTime:   250 * time.Millisecond,
			StalledInterval: 300 * time.Millisecond,
			DrainDelay:      time.Second,
		})
		defer closeTestWorker(fastWorker)
		defer close(release)
		select {
		case <-firstCall:
		case <-time.After(10 * time.Second):
			t.Fatal("first model call did not start")
		}
		// Drop the lock while the first attempt is still running. Renewal then
		// fails, the handler context is canceled and the job becomes stalled.
		if err := redisClient.Del(ctx, fmt.Sprintf("bull:analysis:%s:lock", jobID)).Err(); err != nil {
			t.Fatalf("delete lock: %v", err)
		}
		completed := waitRecord(t, store, recordObjectID(t, record), StatusCompleted, 25*time.Second)
		if completed.Summary == nil || *completed.Summary != "stalled recovered" {
			t.Fatalf("summary = %v", completed.Summary)
		}
		if fixture.callCount() != 2 {
			t.Fatalf("model calls = %d, want 2", fixture.callCount())
		}
		if countNotifications(t, db, orgID, "analysis_failed") != 0 {
			t.Fatal("a recovered stall must not notify a failure")
		}
	})

	t.Run("StalledExhaustionFinalizesFailed", func(t *testing.T) {
		if err := redisClient.Del(ctx, "bull:analysis:stalled-check").Err(); err != nil {
			t.Fatalf("clear stale stalled-check key: %v", err)
		}
		callSignal := make(chan struct{}, 4)
		release := make(chan struct{})
		fixture := newSSEFixture(func(_ int64, w http.ResponseWriter, r *http.Request) {
			callSignal <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
			}
		})
		defer fixture.close()
		seedProfile(t, db, fixture.url(), "chat_completions", nil)
		orgID, userID := "org-stalled-exhausted", "user-stalled-exhausted"
		record := seedCorrelation(t, store, orgID, userID)
		producer, err := analysisqueue.NewProducer(redisClient, analysisTestPrefix, 3)
		if err != nil {
			t.Fatalf("producer: %v", err)
		}
		jobID, err := producer.Add(ctx, analysisqueue.Payload{Type: analysisqueue.TypeCorrelation, AnalysisID: record.ID, OrgID: orgID})
		if err != nil {
			t.Fatalf("add job: %v", err)
		}
		fastWorker := newTestWorker(t, db, redisClient, mongoDatabase, handler, WorkerTestOptions{
			Concurrency:     1,
			LockDuration:    500 * time.Millisecond,
			LockRenewTime:   250 * time.Millisecond,
			StalledInterval: 300 * time.Millisecond,
			DrainDelay:      time.Second,
		})
		defer closeTestWorker(fastWorker)
		defer close(release)
		lockKey := fmt.Sprintf("bull:analysis:%s:lock", jobID)
		// Two attempts are stalled by dropping their lock. maxStalledCount=1
		// means the second stall marks the job deferred-failed; the next fetch
		// must finalize failed without another model call.
		for attempt := 0; attempt < 2; attempt++ {
			select {
			case <-callSignal:
			case <-time.After(10 * time.Second):
				t.Fatalf("model call %d did not start", attempt+1)
			}
			if err := redisClient.Del(ctx, lockKey).Err(); err != nil {
				t.Fatalf("delete lock for attempt %d: %v", attempt+1, err)
			}
		}
		failed := waitRecord(t, store, recordObjectID(t, record), StatusFailed, 25*time.Second)
		if failed.Error == nil || !strings.Contains(*failed.Error, "stalled") {
			t.Fatalf("failed error = %v, want the BullMQ stalled reason", failed.Error)
		}
		if fixture.callCount() != 2 {
			t.Fatalf("model calls = %d, want 2 (the deferred fetch must not call the model)", fixture.callCount())
		}
		if countNotifications(t, db, orgID, "analysis_failed") != 1 {
			t.Fatal("stalled exhaustion must send exactly one analysis_failed notification")
		}
		if countNotifications(t, db, orgID, "analysis_completed") != 0 {
			t.Fatal("stalled exhaustion must not send a completed notification")
		}
		events.waitFor(t, orgID, StatusFailed, 5*time.Second)
		waitCondition(t, "stalled job finalized in the failed set", 10*time.Second, func() bool {
			score, err := redisClient.ZScore(ctx, "bull:analysis:failed", jobID).Result()
			return err == nil && score > 0
		})
	})
}

func redisHost(t *testing.T, client *redis.Client) string {
	t.Helper()
	host, _, err := net.SplitHostPort(client.Options().Addr)
	if err != nil {
		t.Fatalf("split redis addr: %v", err)
	}
	return host
}

func redisPort(t *testing.T, client *redis.Client) string {
	t.Helper()
	_, port, err := net.SplitHostPort(client.Options().Addr)
	if err != nil {
		t.Fatalf("split redis addr: %v", err)
	}
	return port
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(encoded)
}

func seedGeoData(t *testing.T, database *mongo.Database, orgID string, now, start time.Time) {
	t.Helper()
	states := database.Collection(mapTransportStateCollection)
	points := database.Collection(mapTransportTrackPointCollection)
	stateDocs := []any{
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "entityKind", Value: "aircraft"},
			{Key: "sourceType", Value: "opensky"},
			{Key: "sourceScope", Value: "all"},
			{Key: "objectKey", Value: "obj-a"},
			{Key: "observedAt", Value: now},
			{Key: "lat", Value: 10.0},
			{Key: "lng", Value: 20.0},
			{Key: "geoCell", Value: "cell-a"},
			{Key: "callsign", Value: "AAA"},
		},
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "entityKind", Value: "aircraft"},
			{Key: "sourceType", Value: "opensky"},
			{Key: "sourceScope", Value: "all"},
			{Key: "objectKey", Value: "obj-b"},
			{Key: "observedAt", Value: now},
			{Key: "lat", Value: 11.0},
			{Key: "lng", Value: 21.0},
			{Key: "geoCell", Value: "cell-b"},
			{Key: "callsign", Value: "BBB"},
		},
	}
	if _, err := states.InsertMany(context.Background(), stateDocs); err != nil {
		t.Fatalf("insert geo states: %v", err)
	}
	pointDocs := make([]any, 0, 220)
	for index := 0; index < 100; index++ {
		pointDocs = append(pointDocs, geoTestPoint(orgID, "obj-a", now.Add(-time.Duration(index)*time.Second), "cell-a"))
		pointDocs = append(pointDocs, geoTestPoint(orgID, "obj-b", now.Add(-time.Duration(index)*time.Second), "cell-b"))
	}
	for index := 0; index < 10; index++ {
		pointDocs = append(pointDocs, geoTestPoint(orgID, "obj-a", start.Add(-time.Duration(index+1)*time.Hour), "cell-old"))
	}
	for index := 0; index < 20; index++ {
		pointDocs = append(pointDocs, geoTestPoint("org-other", "obj-other-org", now.Add(-time.Duration(index)*time.Second), "cell-other"))
	}
	if _, err := points.InsertMany(context.Background(), pointDocs); err != nil {
		t.Fatalf("insert geo points: %v", err)
	}
}

func geoTestPoint(orgID, objectKey string, observedAt time.Time, geoCell string) bson.D {
	return bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "entityKind", Value: "aircraft"},
		{Key: "sourceType", Value: "opensky"},
		{Key: "sourceScope", Value: "all"},
		{Key: "objectKey", Value: objectKey},
		{Key: "observedAt", Value: observedAt},
		{Key: "lat", Value: 10.0},
		{Key: "lng", Value: 20.0},
		{Key: "geoCell", Value: geoCell},
	}
}
