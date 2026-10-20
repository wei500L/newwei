//go:build integration

// Full item-pipeline chain integration test against real MySQL and Mongo (the
// services the CI api-go-user-settings-integration job provides).
//
// The job data carries a prefetched article, so no crawl4ai request is made and
// the crawl stage branch under test is the prefetched-body branch. The LLM is a
// deterministic in-process fake; the vector service is disabled. The chain
// under test is:
//
//	New -> Process(normalize -> prefetched fetch -> clean -> dedupe -> persist
//	Article + ProcessedArticle + MongoOutbox) -> #116 immediate delivery
//	(ProcessedItem -> ItemMeta completed -> item read model -> outbox row delete)
//
// Assertions cover the MySQL tables (ItemMeta/PipelineJob/Article/
// ProcessedArticle/MongoOutbox), the Mongo collections (processeditems,
// itemreadmodels, tasklogs) and the immediate delivery result. It does not
// connect a real LLM gateway, crawl4ai or vector service.
package newspipeline_test

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/newspipeline"
	"github.com/wei500L/newwei/apps/api-go/internal/processeditemoutbox"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

const (
	fullchainOrgID      = "org-fullchain"
	fullchainItemMetaID = "itemmeta-fullchain-1"
	fullchainRawItemID  = "c0ffee000000000000000202"
	fullchainPipelineID = "pipeline-fullchain-1"
)

// fullchainMarkdown is long enough to pass the staged pre-flight gate
// (minWordCount 120) and the post-clean gate (minCleanedChars 400).
var fullchainMarkdown = "# Headline\n\n" + strings.Repeat("The company reported revenue growth and new product launches across the region. ", 40)

type fakePipelineModels struct {
	completionCalls int
	embeddingCalls  int
}

func (m *fakePipelineModels) Completion(_ context.Context, req litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	m.completionCalls++
	systemPrompt := ""
	for _, message := range req.Messages {
		if message.Role == "system" {
			systemPrompt += message.Content
		}
	}
	cleanedBody := strings.Repeat("Cleaned article body with facts and figures. ", 20)
	content := `{"title":"Test Title","source":"Test Source","published_at":"2026-01-02T03:04:05.000Z",` +
		`"language":"en","summary":"Test summary","topics":[],"key_points":[],"entities":[],` +
		`"kg_relations":[],"removed_noise_types":[],"cleaned_markdown":` + strconv.Quote("# Headline\n\n"+cleanedBody) + `,` +
		`"content_type":"news_fact","sentiment_label":"neutral","quality_score":0.9}`
	if strings.Contains(systemPrompt, "dedupe") {
		content = `{"similarity":0.1,"is_duplicate":false}`
	}
	return litellmcompat.CompletionResponse{
		Content: content,
		Model:   "test-model",
		Usage:   litellmcompat.Usage{},
	}, nil
}

func (m *fakePipelineModels) Embedding(_ context.Context, req litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
	m.embeddingCalls++
	rows := make([]litellmcompat.EmbeddingRow, 0, len(req.Input))
	for index := range req.Input {
		rows = append(rows, litellmcompat.EmbeddingRow{Index: index, Embedding: []float64{0.1, 0.2, 0.3}})
	}
	return litellmcompat.EmbeddingResponse{Rows: rows, Model: "test-embedding"}, nil
}

func (m *fakePipelineModels) Rerank(context.Context, litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
	return litellmcompat.RerankResponse{}, nil
}

func (m *fakePipelineModels) RuntimeEmbeddingModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{Model: "test-embedding", Configured: true}, nil
}

func (m *fakePipelineModels) RuntimeRerankModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, nil
}

func (m *fakePipelineModels) CompletionTimeoutMS(context.Context) (int, error) { return 60_000, nil }

type disabledVectorConfig struct{}

func (disabledVectorConfig) EffectiveVectorConfig(context.Context) (vectorclient.Config, error) {
	return vectorclient.Config{Enabled: false}, nil
}

type noopVectorWriter struct{}

func (noopVectorWriter) Upsert(context.Context, vectorclient.Config, vectorclient.UpsertRequest) error {
	return nil
}

func TestFullPipelineChainIntegration(t *testing.T) {
	db := openFullChainMySQL(t)
	database := openFullChainMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	resetFullChainState(t, db, database)

	now := time.Now().UTC().Truncate(time.Millisecond)
	insertFullChainRows(t, db, database, now)
	seedDedupeSettings(t, db)

	models := &fakePipelineModels{}
	outboxService := processeditemoutbox.NewService(processeditemoutbox.Options{
		DB:           db,
		Mongo:        database,
		VectorConfig: disabledVectorConfig{},
		VectorWriter: noopVectorWriter{},
	})
	config := newspipeline.LoadConfig(func(string) string { return "" }, ".")
	service := newspipeline.New(newspipeline.Options{
		DB:     db,
		Mongo:  database,
		Config: config,
		Models: models,
		Outbox: newOutboxAdapter(outboxService),
		Now:    time.Now,
	})

	rawPayload := json.RawMessage(`{"url":"https://example.com/fullchain","metadata":{},"prefetchedArticle":{"markdown":"` +
		strings.ReplaceAll(fullchainMarkdown, "\n", "\\n") + `"}}`)
	pipelineJobID := fullchainPipelineID
	result, err := service.Process(ctx, newspipeline.Job{
		Queue:           "itemPipeline",
		JobID:           "job-fullchain",
		ItemMetaID:      fullchainItemMetaID,
		RawItemID:       fullchainRawItemID,
		OrgID:           fullchainOrgID,
		ProcessedItemID: fullchainRawItemID,
		PipelineJobID:   &pipelineJobID,
	}, newspipeline.RawItem{
		ID:         fullchainRawItemID,
		ItemMetaID: fullchainItemMetaID,
		Payload:    rawPayload,
	})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.ProcessedItemID != fullchainRawItemID || result.OutboxID == "" {
		t.Fatalf("result = %+v", result)
	}
	if models.completionCalls == 0 {
		t.Fatal("clean stage must call the completion model")
	}

	// Persist side: Article + ProcessedArticle + MongoOutbox were written.
	contentHash := sha256.Sum256([]byte(strings.TrimSpace(fullchainMarkdown)))
	expectedHash := hex.EncodeToString(contentHash[:])
	var articleID string
	if err := db.QueryRow("SELECT id FROM Article WHERE orgId = ? AND contentHash = ?", fullchainOrgID, expectedHash).Scan(&articleID); err != nil {
		t.Fatalf("Article row: %v", err)
	}
	var processedStatus string
	if err := db.QueryRow("SELECT status FROM ProcessedArticle WHERE articleId = ? AND orgId = ?", articleID, fullchainOrgID).Scan(&processedStatus); err != nil {
		t.Fatalf("ProcessedArticle row: %v", err)
	}
	if processedStatus != "completed" {
		t.Fatalf("ProcessedArticle.status = %q", processedStatus)
	}

	// Immediate delivery (#116): the outbox row is claimed, ProcessedItem is
	// completed, ItemMeta completes and the read model is hydrated.
	waitForProcessedItem(t, database)
	waitForOutboxDrain(t, db)
	assertFullChainItemMetaCompleted(t, db)
	assertFullChainReadModel(t, database)
	assertFullChainTaskLog(t, database)
	if models.embeddingCalls > 0 {
		t.Fatalf("embedding calls = %d, want 0 (dedupe settings disable embeddings)", models.embeddingCalls)
	}
}

// outboxAdapter exposes the #116 service through the pipeline's narrow port.
type outboxAdapter struct {
	service *processeditemoutbox.Service
}

func newOutboxAdapter(service *processeditemoutbox.Service) outboxAdapter {
	return outboxAdapter{service: service}
}

func (a outboxAdapter) DeliverNow(ctx context.Context, outboxID string) bool {
	return a.service.DeliverNow(ctx, outboxID)
}

// snapshotAdapter is a no-op ops snapshot refresher; the snapshot service is
// unit/integration tested in internal/newssourcescheduler.
type snapshotAdapter struct{}

func (snapshotAdapter) RefreshNewsSourceSnapshot(context.Context, string, string) error { return nil }

func openFullChainMySQL(t *testing.T) *sql.DB {
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
	statements := []string{
		"DROP TABLE IF EXISTS ItemMeta",
		"DROP TABLE IF EXISTS PipelineJob",
		"DROP TABLE IF EXISTS Article",
		"DROP TABLE IF EXISTS ProcessedArticle",
		"DROP TABLE IF EXISTS ProcessedArticleTermHourly",
		"DROP TABLE IF EXISTS MongoOutbox",
		"DROP TABLE IF EXISTS SystemSetting",
		`CREATE TABLE ItemMeta (
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
		`CREATE TABLE PipelineJob (
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
		`CREATE TABLE Article (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			sourceId varchar(40) NULL,
			url varchar(512) NOT NULL,
			urlFingerprint varchar(64) NULL,
			sourceLabel varchar(255) NULL,
			language varchar(32) NULL,
			titleGuess varchar(512) NULL,
			crawlAt datetime(3) NOT NULL,
			contentHash varchar(64) NOT NULL,
			markdownRef varchar(191) NULL,
			version int NOT NULL DEFAULT 1,
			metadata json NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY Article_org_url (orgId, url),
			UNIQUE KEY Article_org_contentHash (orgId, contentHash)
		) ENGINE=InnoDB`,
		`CREATE TABLE ProcessedArticle (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			articleId varchar(40) NOT NULL,
			status varchar(20) NOT NULL DEFAULT 'completed',
			title varchar(512) NULL,
			subtitle varchar(512) NULL,
			author varchar(255) NULL,
			source varchar(255) NULL,
			publishedAt datetime(3) NULL,
			category varchar(120) NULL,
			topics json NULL,
			summary text NULL,
			keyPoints json NULL,
			entities json NULL,
			kgRelations json NULL,
			cleanedMarkdownRef varchar(191) NULL,
			removedNoiseTypes json NULL,
			qualityScore double NULL,
			llmModel varchar(191) NULL,
			llmPromptVersion varchar(191) NULL,
			language varchar(32) NULL,
			location varchar(255) NULL,
			promptTokens int NULL,
			completionTokens int NULL,
			totalTokens int NULL,
			costUsd double NULL,
			latencyMs int NULL,
			eventAt datetime(3) NULL,
			hasLocation tinyint(1) NOT NULL DEFAULT 0,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			processedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			UNIQUE KEY ProcessedArticle_articleId (articleId)
		) ENGINE=InnoDB`,
		`CREATE TABLE ProcessedArticleTermHourly (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			processedArticleId varchar(40) NOT NULL,
			bucketStart datetime(3) NOT NULL,
			term varchar(191) NOT NULL,
			source varchar(32) NOT NULL,
			articleCount int NOT NULL DEFAULT 1,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE MongoOutbox (
			id varchar(40) NOT NULL PRIMARY KEY,
			orgId varchar(40) NOT NULL,
			type varchar(32) NOT NULL DEFAULT 'processed_item',
			payload json NOT NULL,
			status varchar(20) NOT NULL DEFAULT 'pending',
			attempts int NOT NULL DEFAULT 0,
			lastError text NULL,
			availableAt datetime(3) NOT NULL,
			lockedAt datetime(3) NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
		) ENGINE=InnoDB`,
		`CREATE TABLE SystemSetting (
			` + "`key`" + ` varchar(191) NOT NULL PRIMARY KEY,
			value json NOT NULL,
			isPublic tinyint(1) NOT NULL DEFAULT 0,
			description text NULL,
			createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
			updatedById varchar(40) NULL
		) ENGINE=InnoDB`,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("schema statement failed: %v", err)
		}
	}
	t.Cleanup(func() {
		for _, table := range []string{"MongoOutbox", "ProcessedArticleTermHourly", "ProcessedArticle", "Article", "PipelineJob", "ItemMeta", "SystemSetting"} {
			_, _ = db.Exec("DROP TABLE IF EXISTS `" + table + "`")
		}
		_ = db.Close()
	})
	return db
}

func openFullChainMongo(t *testing.T) *mongo.Database {
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
	database := client.Database(name + "_fullchain_it")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func resetFullChainState(t *testing.T, db *sql.DB, database *mongo.Database) {
	t.Helper()
	for _, table := range []string{"MongoOutbox", "ProcessedArticleTermHourly", "ProcessedArticle", "Article", "PipelineJob", "ItemMeta", "SystemSetting"} {
		if _, err := db.Exec("DELETE FROM `" + table + "`"); err != nil {
			t.Fatalf("clean %s: %v", table, err)
		}
	}
	for _, collection := range []string{"tasklogs", "processeditems", "itemreadmodels", "rawitems"} {
		_, _ = database.Collection(collection).DeleteMany(context.Background(), bson.D{})
	}
}

func insertFullChainRows(t *testing.T, db *sql.DB, database *mongo.Database, now time.Time) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO ItemMeta (id,orgId,externalId,name,status,mongoRef,version,sortAt,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?)`, fullchainItemMetaID, fullchainOrgID, "external-fullchain", "Item", "pending", fullchainRawItemID, 1, now, now, now); err != nil {
		t.Fatalf("insert item meta: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO PipelineJob (id,orgId,url,status,queueName,attempts,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?)`, fullchainPipelineID, fullchainOrgID, "https://example.com/fullchain", "pending", "itemPipeline", 0, now, now); err != nil {
		t.Fatalf("insert pipeline job: %v", err)
	}
	rawID, err := bson.ObjectIDFromHex(fullchainRawItemID)
	if err != nil {
		t.Fatalf("raw id: %v", err)
	}
	_, err = database.Collection("rawitems").InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: rawID},
		{Key: "itemMetaId", Value: fullchainItemMetaID},
		{Key: "payload", Value: bson.D{
			{Key: "url", Value: "https://example.com/fullchain"},
			{Key: "publishedAt", Value: "2026-01-02T03:04:05.000Z"},
		}},
		{Key: "source", Value: "manual"},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	})
	if err != nil {
		t.Fatalf("insert raw item: %v", err)
	}
}

func seedDedupeSettings(t *testing.T, db *sql.DB) {
	t.Helper()
	value := `{"useEmbeddings":false,"defaultThreshold":0.9,"scopedThresholds":[]}`
	if _, err := db.Exec("INSERT INTO SystemSetting (`key`,value) VALUES (?,?)",
		"news_dedupe_settings:"+fullchainOrgID, value); err != nil {
		t.Fatalf("seed dedupe settings: %v", err)
	}
}

func waitForProcessedItem(t *testing.T, database *mongo.Database) {
	t.Helper()
	rawID, err := bson.ObjectIDFromHex(fullchainRawItemID)
	if err != nil {
		t.Fatalf("raw id: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		var document struct {
			Status string `bson:"status"`
			Result struct {
				Title string `bson:"title"`
			} `bson:"result"`
		}
		err := database.Collection("processeditems").FindOne(ctx, bson.D{{Key: "_id", Value: rawID}}).Decode(&document)
		cancel()
		if err == nil {
			if document.Status != "completed" {
				t.Fatalf("ProcessedItem.status = %q, want completed", document.Status)
			}
			if document.Result.Title != "Test Title" {
				t.Fatalf("ProcessedItem.result.title = %q", document.Result.Title)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("ProcessedItem was not delivered")
}

func waitForOutboxDrain(t *testing.T, db *sql.DB) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM MongoOutbox").Scan(&count); err != nil {
			t.Fatalf("count outbox: %v", err)
		}
		if count == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("MongoOutbox row was not delivered and deleted")
}

func assertFullChainItemMetaCompleted(t *testing.T, db *sql.DB) {
	t.Helper()
	var status string
	var name string
	var publishedAt sql.NullTime
	if err := db.QueryRow("SELECT status, name, publishedAt FROM ItemMeta WHERE id = ?", fullchainItemMetaID).
		Scan(&status, &name, &publishedAt); err != nil {
		t.Fatalf("read item meta: %v", err)
	}
	if status != "completed" {
		t.Fatalf("ItemMeta.status = %q, want completed", status)
	}
	if name == "" {
		t.Fatal("ItemMeta.name must be completed by delivery")
	}
	if !publishedAt.Valid {
		t.Fatal("ItemMeta.publishedAt must be set from the cleaned result")
	}
}

func assertFullChainReadModel(t *testing.T, database *mongo.Database) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var document struct {
		Status string `bson:"status"`
	}
	err := database.Collection("itemreadmodels").FindOne(ctx, bson.D{
		{Key: "orgId", Value: fullchainOrgID},
		{Key: "itemMetaId", Value: fullchainItemMetaID},
	}).Decode(&document)
	if err != nil {
		t.Fatalf("read model: %v", err)
	}
	if document.Status != "completed" {
		t.Fatalf("read model status = %q", document.Status)
	}
}

func assertFullChainTaskLog(t *testing.T, database *mongo.Database) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	count, err := database.Collection("tasklogs").CountDocuments(ctx, bson.D{
		{Key: "orgId", Value: fullchainOrgID},
	})
	if err != nil {
		t.Fatalf("count task logs: %v", err)
	}
	if count == 0 {
		t.Fatal("pipeline must write at least one TaskLog row")
	}
}
