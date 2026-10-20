//go:build integration

// Archive preparation worker integration tests against real MySQL, Redis and
// Mongo (the services the CI api-go-user-settings-integration job provides).
//
// Coverage: a digest job end-to-end (status processing -> partial -> ready,
// ArchiveArticleClassification writes), the B1 termination case (jobBatchSize+5
// rows whose ProcessedItem result cannot be parsed), a calendar job, and a model
// failure that writes the FAILED status and schedules the BullMQ retry.
package archivepreparationworker

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/archivepreparation"
	"github.com/wei500L/newwei/apps/api-go/internal/dataruntimesettings"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	itOrgID      = "org-archive-worker"
	itFailOrgID  = "org-archive-worker-fail"
	itAnchorDate = "2026-10-20"
	itMonth      = "2026-09"
)

type recordingStatus struct {
	inner  StatusWriter
	mu     sync.Mutex
	states []string
}

func (r *recordingStatus) record(state string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = append(r.states, state)
}

func (r *recordingStatus) MarkProcessing(ctx context.Context, payload archivepreparation.Payload) error {
	r.record("PROCESSING")
	return r.inner.MarkProcessing(ctx, payload)
}
func (r *recordingStatus) MarkPartial(ctx context.Context, payload archivepreparation.Payload) error {
	r.record("PARTIAL")
	return r.inner.MarkPartial(ctx, payload)
}
func (r *recordingStatus) MarkReady(ctx context.Context, payload archivepreparation.Payload) error {
	r.record("READY")
	return r.inner.MarkReady(ctx, payload)
}
func (r *recordingStatus) MarkFailed(ctx context.Context, payload archivepreparation.Payload, message string) error {
	r.record("FAILED")
	return r.inner.MarkFailed(ctx, payload, message)
}
func (r *recordingStatus) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.states...)
}

func (r *recordingStatus) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states = nil
}

func TestArchivePreparationWorkerIntegration(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	redisAddr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	mongoURI := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if databaseURL == "" || redisAddr == "" || mongoURI == "" {
		t.Skip("DATABASE_URL, API_GO_TEST_REDIS_ADDR and MONGO_URI are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()
	if err := createWorkerSchema(ctx, db); err != nil {
		t.Fatalf("schema: %v", err)
	}
	// Leave the shared CI database without our reduced Article/ProcessedArticle
	// schemas so the later integration steps can create their own tables.
	defer dropWorkerTables(context.Background(), db)
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr, Protocol: 2})
	defer redisClient.Close()
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI).SetServerSelectionTimeout(5 * time.Second))
	if err != nil {
		t.Fatalf("mongo: %v", err)
	}
	defer mongoClient.Disconnect(ctx)
	database := mongoClient.Database(mongoDatabaseName(mongoURI))

	_, _ = database.Collection("processeditems").DeleteMany(ctx, bson.D{{Key: "orgId", Value: bson.D{{Key: "$in", Value: []string{itOrgID, itFailOrgID}}}}})
	modelServer := newModelServer()
	defer modelServer.Close()
	if err := seedSettings(ctx, db, modelServer.URL); err != nil {
		t.Fatalf("settings: %v", err)
	}

	producer := archivepreparation.NewProducer(redisClient)
	settingsService := dataruntimesettings.NewService(db, redisClient, dataruntimesettings.Config{})
	models := litellmcompat.NewClient(db, llmlogs.NewModelRequestWriter(db, database), litellmcompat.Config{
		APIBase: modelServer.URL, Timeout: 5 * time.Second, MaxRetries: 1,
		DefaultModel: "test-model", DefaultTemperature: 0.2, DefaultTopP: 0.9, DefaultMaxOutputTokens: 2048,
		AssistantGuardrailsEnabled: true, AssistantGuardrailsRaw: "openai-moderation-pre",
	})
	processor := NewProcessor(ProcessorDeps{
		DB: db, Redis: redisClient, Mongo: database, Models: models, Settings: settingsService,
	})
	status := &recordingStatus{inner: producer}
	consumer := NewConsumer(processor, status)
	blocking := redis.NewClient(redisClient.Options())
	defer blocking.Close()
	worker, err := NewWorker(redisClient, blocking, WorkerOptions{
		Concurrency:     1,
		Processor:       consumer.Handle,
		OnFailure:       consumer.OnFailure,
		LockDuration:    2 * time.Second,
		LockRenewTime:   time.Second,
		StalledInterval: time.Second,
		DrainDelay:      100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("worker: %v", err)
	}
	if err := worker.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer worker.Close(context.Background())

	// B1: seven rows whose ProcessedItem result cannot be parsed, with a job
	// batch size of two, must still terminate.
	digestIDs, err := seedArticles(ctx, db, database, itOrgID, itAnchorDate, 7)
	if err != nil {
		t.Fatalf("seed digest: %v", err)
	}
	if err := producer.EnsureDigestCoverage(ctx, itOrgID, itAnchorDate); err != nil {
		t.Fatalf("enqueue digest: %v", err)
	}
	if err := waitForState(status, "READY", 30*time.Second); err != nil {
		t.Fatalf("digest ready: %v (%v)", err, status.snapshot())
	}
	states := status.snapshot()
	if len(states) < 3 || states[0] != "PROCESSING" || states[len(states)-1] != "READY" {
		t.Fatalf("states = %v", states)
	}
	partial := false
	for _, state := range states {
		if state == "PARTIAL" {
			partial = true
		}
	}
	if !partial {
		t.Fatalf("no PARTIAL state in %v", states)
	}
	var classified int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ArchiveArticleClassification WHERE orgId = ?", itOrgID).Scan(&classified); err != nil {
		t.Fatalf("count: %v", err)
	}
	if classified != len(digestIDs) {
		t.Fatalf("classified = %d, want %d", classified, len(digestIDs))
	}
	for _, id := range digestIDs {
		var count int
		if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ArchiveArticleClassification WHERE processedArticleId = ?", id).Scan(&count); err != nil || count != 1 {
			t.Fatalf("classification row for %s: %d %v", id, count, err)
		}
	}
	var item struct {
		Result bson.RawValue `bson:"result"`
	}
	if err := database.Collection("processeditems").FindOne(ctx, bson.D{{Key: "orgId", Value: itOrgID}}).Decode(&item); err != nil {
		t.Fatalf("find item: %v", err)
	}
	var stored map[string]any
	_ = bson.Unmarshal(item.Result.Value, &stored)
	if _, ok := stored["category_path"]; ok {
		t.Fatalf("unparseable result must be skipped, got %#v", stored)
	}

	// Calendar scope.
	calendarIDs, err := seedArticles(ctx, db, database, itOrgID, itMonth+"-10", 3)
	if err != nil {
		t.Fatalf("seed calendar: %v", err)
	}
	status.reset()
	if err := producer.EnsureCalendarCoverage(ctx, itOrgID, itMonth); err != nil {
		t.Fatalf("enqueue calendar: %v", err)
	}
	if err := waitForState(status, "READY", 30*time.Second); err != nil {
		t.Fatalf("calendar ready: %v (%v)", err, status.snapshot())
	}
	var calendarClassified int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ArchiveArticleClassification WHERE processedArticleId IN (?, ?, ?)",
		calendarIDs[0], calendarIDs[1], calendarIDs[2]).Scan(&calendarClassified); err != nil {
		t.Fatalf("calendar count: %v", err)
	}
	if calendarClassified != 3 {
		t.Fatalf("calendar classified = %d", calendarClassified)
	}

	// Model failure: the embedding layer fails, the status must become FAILED and
	// BullMQ must record the retry (atm increments) because the producer sets
	// attempts=5.
	failIDs, err := seedArticles(ctx, db, database, itFailOrgID, itAnchorDate, 1)
	if err != nil {
		t.Fatalf("seed fail: %v", err)
	}
	status.reset()
	if err := producer.EnsureDigestCoverage(ctx, itFailOrgID, itAnchorDate); err != nil {
		t.Fatalf("enqueue fail: %v", err)
	}
	if err := waitForState(status, "FAILED", 20*time.Second); err != nil {
		t.Fatalf("failed state: %v (%v)", err, status.snapshot())
	}
	jobKey := "bull:archivePreparation:digest:" + itFailOrgID + ":" + itAnchorDate
	attempts := 0
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		value, err := redisClient.HGet(ctx, jobKey, "atm").Int()
		if err == nil && value == 1 {
			attempts = value
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if attempts != 1 {
		t.Fatalf("attemptsMade = %d, want 1 (retry scheduled)", attempts)
	}
	var failedCount int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ArchiveArticleClassification WHERE processedArticleId = ?", failIDs[0]).Scan(&failedCount); err != nil {
		t.Fatalf("fail count: %v", err)
	}
	if failedCount != 0 {
		t.Fatalf("failed job wrote %d classifications", failedCount)
	}
}

func waitForState(status *recordingStatus, target string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		states := status.snapshot()
		for _, state := range states {
			if state == target {
				return nil
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s", target)
}

func mongoDatabaseName(uri string) string {
	trimmed := strings.TrimPrefix(uri, "mongodb://")
	if index := strings.Index(trimmed, "/"); index >= 0 {
		rest := trimmed[index+1:]
		if end := strings.Index(rest, "?"); end >= 0 {
			rest = rest[:end]
		}
		if rest != "" {
			return rest
		}
	}
	return "app"
}

func dropWorkerTables(ctx context.Context, db *sql.DB) {
	for _, table := range []string{
		"ArchiveArticleClassification", "ArchiveVerticalAnchorEmbedding",
		"NewsEventItem", "ProcessedArticle", "Article",
	} {
		_, _ = db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`")
	}
}

func createWorkerSchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		"DROP TABLE IF EXISTS `ArchiveArticleClassification`",
		"DROP TABLE IF EXISTS `ArchiveVerticalAnchorEmbedding`",
		"DROP TABLE IF EXISTS `NewsEventItem`",
		"DROP TABLE IF EXISTS `ProcessedArticle`",
		"DROP TABLE IF EXISTS `Article`",
		"CREATE TABLE `Article` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `url` VARCHAR(191) NOT NULL, `sourceLabel` VARCHAR(191) NULL, `crawlAt` DATETIME(3) NOT NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ProcessedArticle` (`id` VARCHAR(191) PRIMARY KEY, `articleId` VARCHAR(191) NOT NULL, `title` VARCHAR(191) NULL, `summary` TEXT NULL, `source` VARCHAR(191) NULL, `publishedAt` DATETIME(3) NULL, `topics` JSON NULL, `entities` JSON NULL, `qualityScore` DOUBLE NULL, `location` VARCHAR(191) NULL, `processedAt` DATETIME(3) NOT NULL, `cleanedMarkdownRef` VARCHAR(191) NULL, `status` VARCHAR(191) NOT NULL, KEY `ProcessedArticle_processedAt_id_idx` (`processedAt`, `id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `NewsEventItem` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `processedArticleId` VARCHAR(191) NOT NULL, `eventId` VARCHAR(191) NOT NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ArchiveArticleClassification` (`id` VARCHAR(191) PRIMARY KEY, `orgId` VARCHAR(191) NOT NULL, `articleId` VARCHAR(191) NOT NULL, `processedArticleId` VARCHAR(191) NOT NULL, `region` VARCHAR(191) NOT NULL, `vertical` VARCHAR(191) NOT NULL, `ruleScores` JSON NOT NULL, `embeddingScores` JSON NOT NULL, `rerankScores` JSON NOT NULL, `fusedScores` JSON NOT NULL, `classificationTextHash` VARCHAR(191) NOT NULL, `classificationTextVersion` VARCHAR(191) NOT NULL, `taxonomyVersion` VARCHAR(191) NOT NULL, `pipelineVersion` VARCHAR(191) NOT NULL, `embeddingModel` VARCHAR(191) NOT NULL, `rerankModel` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, UNIQUE KEY `ArchiveArticleClassification_processedArticleId_key` (`processedArticleId`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ArchiveVerticalAnchorEmbedding` (`id` VARCHAR(191) PRIMARY KEY, `vertical` VARCHAR(191) NOT NULL, `taxonomyVersion` VARCHAR(191) NOT NULL, `anchorText` TEXT NOT NULL, `anchorTextHash` VARCHAR(191) NOT NULL, `embeddingModel` VARCHAR(191) NOT NULL, `embeddingVector` JSON NOT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, UNIQUE KEY `ArchiveVerticalAnchorEmbedding_vertical_taxVer_embModel_hash_uq` (`vertical`, `taxonomyVersion`, `embeddingModel`, `anchorTextHash`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (`key` VARCHAR(191) PRIMARY KEY, `value` JSON NOT NULL, `isPublic` TINYINT(1) NOT NULL DEFAULT 0, `description` TEXT NULL, `createdAt` DATETIME(3) NOT NULL, `updatedAt` DATETIME(3) NOT NULL, `updatedById` VARCHAR(191) NULL) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("%s: %w", statement, err)
		}
	}
	return nil
}

func seedSettings(ctx context.Context, db *sql.DB, modelBase string) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	upsert := func(key, value string) error {
		_, err := db.ExecContext(ctx,
			"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt) VALUES (?, ?, 0, '', ?, ?)",
			key, value, now, now)
		return err
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM SystemSetting WHERE `key` IN ('archive_preparation_settings', 'llm_gateway_profiles') OR `key` LIKE 'news_classification_settings:%'"); err != nil {
		return err
	}
	if err := upsert("archive_preparation_settings", `{"jobBatchSize":2,"embeddingBatchSize":2,"embeddingMaxConcurrency":1,"rerankMaxConcurrency":1}`); err != nil {
		return err
	}
	profiles := map[string]any{
		"activeId": "profile-test", "embeddingActiveId": "profile-test", "rerankActiveId": "profile-test",
		"profiles": []any{map[string]any{
			"id": "profile-test", "name": "test", "apiBase": modelBase, "model": "test-model",
			"embeddingModel": "test-embed", "rerankModel": "test-rerank", "enabled": true,
			"maxRetries": 1, "timeoutMs": 5000, "sendMetadata": true,
			"responseFormatMode": "json_schema", "apiSurface": "chat_completions",
		}},
	}
	encoded, _ := json.Marshal(profiles)
	if err := upsert("llm_gateway_profiles", string(encoded)); err != nil {
		return err
	}
	classification := map[string]any{
		"enabled": true, "strictFail": true, "enableLlm": true, "enableEmbedding": true, "enableRerank": true,
		"minConfidence": 0.35, "embeddingTopK": 12, "rerankTopN": 6, "taxonomyVersion": "test-taxonomy",
		"taxonomy": []any{
			map[string]any{"path": "tech/ai/model-release", "displayName": "AI", "description": "d", "legacyCategory": "ai", "keywords": []string{"ai"}, "synonyms": []string{}},
			map[string]any{"path": "finance/macro/monetary-policy", "displayName": "Macro", "description": "d", "legacyCategory": "finance", "keywords": []string{"fed"}, "synonyms": []string{}},
		},
	}
	encodedClassification, _ := json.Marshal(classification)
	return upsert("news_classification_settings:"+itOrgID, string(encodedClassification))
}

func seedArticles(ctx context.Context, db *sql.DB, database *mongo.Database, orgID, anchor string, count int) ([]string, error) {
	base, err := time.Parse("2006-01-02", anchor)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, count)
	prefix := strings.ReplaceAll(anchor, "-", "")
	for index := 0; index < count; index++ {
		articleID := fmt.Sprintf("%s-a-%s-%02d", orgID, prefix, index)
		processedID := fmt.Sprintf("%s-p-%s-%02d", orgID, prefix, index)
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", orgID, anchor, index)))
		ref := hex.EncodeToString(sum[:12])
		processedAt := base.Add(12*time.Hour - time.Duration(index)*time.Minute)
		if _, err := db.ExecContext(ctx,
			"INSERT INTO Article (id, orgId, url, sourceLabel, crawlAt) VALUES (?, ?, ?, ?, ?)",
			articleID, orgID, "https://example.com/"+articleID, "Example", processedAt.Add(-time.Hour)); err != nil {
			return nil, err
		}
		if _, err := db.ExecContext(ctx,
			"INSERT INTO ProcessedArticle (id, articleId, title, summary, source, publishedAt, topics, entities, qualityScore, location, processedAt, cleanedMarkdownRef, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed')",
			processedID, articleID, "title "+processedID, "summary", nil, processedAt, `["ai"]`, `[{"name":"Acme"}]`, 0.5, nil, processedAt, ref); err != nil {
			return nil, err
		}
		id, _ := bson.ObjectIDFromHex(ref)
		if _, err := database.Collection("processeditems").InsertOne(ctx, bson.D{
			{Key: "_id", Value: id},
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: "completed"},
			// No cleaned_markdown: parseStoredCleanedNews must skip this result, so
			// the row always needs display backfill and reproduces B1.
			{Key: "result", Value: bson.D{{Key: "title", Value: "unparseable"}}},
		}); err != nil {
			return nil, err
		}
		ids = append(ids, processedID)
	}
	return ids, nil
}

func newModelServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		metadata, _ := body["metadata"].(map[string]any)
		if metadata != nil && metadata["orgId"] == itFailOrgID {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"embedding failed"}}`))
			return
		}
		switch r.URL.Path {
		case "/v1/embeddings":
			input, _ := body["input"].([]any)
			data := make([]any, 0, len(input))
			for index := range input {
				data = append(data, map[string]any{
					"index":     index,
					"embedding": []float64{1, float64(index % 2), 0, 1},
				})
			}
			encoded, _ := json.Marshal(map[string]any{"model": "test-embed", "data": data})
			_, _ = w.Write(encoded)
		case "/v1/rerank":
			documents, _ := body["documents"].([]any)
			results := make([]any, 0, len(documents))
			for index := range documents {
				results = append(results, map[string]any{"index": index, "relevance_score": float64(len(documents)-index) / float64(len(documents))})
			}
			encoded, _ := json.Marshal(map[string]any{"model": "test-rerank", "results": results})
			_, _ = w.Write(encoded)
		case "/v1/chat/completions":
			_, _ = w.Write([]byte(`{"model":"test-model","choices":[{"message":{"role":"assistant","content":"{\"candidates\":[{\"path\":\"tech/ai/model-release\",\"score\":0.9}]}"}}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}
