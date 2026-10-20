//go:build integration

// News-event ingestion integration tests against the real MySQL, Redis and Mongo
// CI services. Environment (injected by .github/workflows/ci.yml):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// The tests rebuild the minimum table set the ingestion touches (same column
// names, unique keys and JSON semantics as the Prisma schema), use a throw-away
// Mongo database and clean up by fixed organization prefixes. The external
// model and vector services are local httptest fixtures: no real model service,
// no real vector service and no production data are involved.
package newseventsingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
	"github.com/wei500L/newwei/apps/api-go/internal/modelaccesssettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const integrationOrgPrefix = "it_news_events_ingest_"

func openIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openIntegrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func openIntegrationMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI not set — integration test requires MongoDB")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	database := client.Database("news_events_ingest_it_" + strconv.FormatInt(time.Now().UnixNano(), 36))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func createNewsEventsIngestTables(t *testing.T, db *sql.DB) {
	t.Helper()
	ddl := []string{
		"DROP TABLE IF EXISTS `NewsEventItem`",
		"DROP TABLE IF EXISTS `NewsEvent`",
		"DROP TABLE IF EXISTS `NewsEventIngestionState`",
		"DROP TABLE IF EXISTS `ProcessedArticle`",
		"DROP TABLE IF EXISTS `Article`",
		"DROP TABLE IF EXISTS `Org`",
		"DROP TABLE IF EXISTS `SystemSetting`",
		"CREATE TABLE `Org` (`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL," +
			" `slug` VARCHAR(191) NOT NULL, `isActive` BOOLEAN NOT NULL DEFAULT true," +
			" `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `Article` (`id` VARCHAR(191) NOT NULL, `crawlAt` DATETIME(3) NOT NULL," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ProcessedArticle` (`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			" `articleId` VARCHAR(191) NOT NULL, `status` VARCHAR(32) NOT NULL, `title` VARCHAR(191) NULL," +
			" `summary` TEXT NULL, `language` VARCHAR(32) NULL, `category` VARCHAR(191) NULL," +
			" `topics` JSON NULL, `entities` JSON NULL, `qualityScore` DOUBLE NULL," +
			" `cleanedMarkdownRef` VARCHAR(191) NULL, `publishedAt` DATETIME(3) NULL," +
			" `processedAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			" `updatedAt` DATETIME(3) NOT NULL," +
			" UNIQUE INDEX `ProcessedArticle_articleId_key`(`articleId`)," +
			" INDEX `ProcessedArticle_orgId_status_processedAt_articleId_idx`(`orgId`, `status`, `processedAt`, `articleId`)," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `NewsEventIngestionState` (`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			" `lastProcessedAt` DATETIME(3) NULL, `lastProcessedArticleId` VARCHAR(191) NULL," +
			" `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			" UNIQUE INDEX `NewsEventIngestionState_orgId_key`(`orgId`)," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `NewsEvent` (`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			" `status` VARCHAR(32) NOT NULL DEFAULT 'active', `language` VARCHAR(32) NULL," +
			" `primaryTopic` VARCHAR(191) NULL, `primaryEntity` VARCHAR(191) NULL, `title` VARCHAR(191) NULL," +
			" `summary` TEXT NULL, `startAt` DATETIME(3) NOT NULL, `lastAt` DATETIME(3) NOT NULL," +
			" `representativeProcessedArticleId` VARCHAR(191) NULL, `representativeProcessedItemId` VARCHAR(191) NULL," +
			" `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			" `updatedAt` DATETIME(3) NOT NULL," +
			" INDEX `NewsEvent_orgId_status_lastAt_idx`(`orgId`, `status`, `lastAt`)," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `NewsEventItem` (`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL," +
			" `eventId` VARCHAR(191) NOT NULL, `processedArticleId` VARCHAR(191) NOT NULL," +
			" `processedItemId` VARCHAR(191) NULL, `similarity` DOUBLE NULL," +
			" `assignedBy` VARCHAR(32) NOT NULL DEFAULT 'overlap'," +
			" `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			" UNIQUE INDEX `NewsEventItem_orgId_processedArticleId_key`(`orgId`, `processedArticleId`)," +
			" INDEX `NewsEventItem_orgId_processedItemId_idx`(`orgId`, `processedItemId`)," +
			" PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `SystemSetting` (`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL," +
			" `isPublic` BOOLEAN NOT NULL DEFAULT false, `description` VARCHAR(191) NULL," +
			" `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			" PRIMARY KEY (`key`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range ddl {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("ddl %q: %v", statement, err)
		}
	}
}

// integrationSettings is the per-organization settings row the ingestion reads.
type integrationSettings struct {
	Enabled                      bool    `json:"enabled"`
	IngestionEnabled             bool    `json:"ingestionEnabled"`
	ClusteringMode               string  `json:"clusteringMode"`
	BertopicMinItemsPerGroup     int     `json:"bertopicMinItemsPerGroup"`
	BertopicMaxItemsPerRequest   int     `json:"bertopicMaxItemsPerRequest"`
	BertopicMinTopicSize         int     `json:"bertopicMinTopicSize"`
	MaxBatchSize                 int     `json:"maxBatchSize"`
	BackfillDays                 int     `json:"backfillDays"`
	LookbackDays                 int     `json:"lookbackDays"`
	VectorMinScore               float64 `json:"vectorMinScore"`
	CrossLanguagePenalty         float64 `json:"crossLanguagePenalty"`
	ClassificationGateEnabled    bool    `json:"classificationGateEnabled"`
	CategoryConflictReject       bool    `json:"categoryConflictReject"`
	CategorySoftPenalty          float64 `json:"categorySoftPenalty"`
	MinCategoryConfidenceForGate float64 `json:"minCategoryConfidenceForGate"`
}

func defaultIntegrationSettings() integrationSettings {
	return integrationSettings{
		Enabled:                      true,
		IngestionEnabled:             true,
		ClusteringMode:               "vector",
		BertopicMinItemsPerGroup:     2,
		BertopicMaxItemsPerRequest:   32,
		BertopicMinTopicSize:         2,
		MaxBatchSize:                 100,
		BackfillDays:                 30,
		LookbackDays:                 30,
		VectorMinScore:               0.82,
		CrossLanguagePenalty:         0.1,
		ClassificationGateEnabled:    true,
		CategoryConflictReject:       true,
		CategorySoftPenalty:          0.15,
		MinCategoryConfidenceForGate: 0.4,
	}
}

func writeIntegrationSettings(t *testing.T, db *sql.DB, orgID string, settings integrationSettings) {
	t.Helper()
	encoded, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal settings: %v", err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO `SystemSetting` (`key`, `value`, `isPublic`, `description`, `createdAt`, `updatedAt`)"+
		" VALUES (?, ?, false, NULL, ?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)",
		"news_event_settings:"+orgID, encoded, now, now); err != nil {
		t.Fatalf("insert settings: %v", err)
	}
}

func insertIntegrationOrg(t *testing.T, db *sql.DB, orgID string, active bool) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO `Org` (`id`, `name`, `slug`, `isActive`, `createdAt`, `updatedAt`)"+
		" VALUES (?, ?, ?, ?, ?, ?)", orgID, orgID, orgID, active, now, now); err != nil {
		t.Fatalf("insert org: %v", err)
	}
}

// insertIntegrationArticle writes one Article/ProcessedArticle pair.
func insertIntegrationArticle(t *testing.T, db *sql.DB, orgID, suffix string, processedAt time.Time, topics, entities, category *string, processedItemID *string) (string, string) {
	t.Helper()
	articleID := "ca_" + orgID + "_" + suffix
	processedArticleID := "cpa_" + orgID + "_" + suffix
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO `Article` (`id`, `crawlAt`) VALUES (?, ?)", articleID, processedAt); err != nil {
		t.Fatalf("insert article: %v", err)
	}
	if _, err := db.Exec("INSERT INTO `ProcessedArticle`"+
		" (`id`, `orgId`, `articleId`, `status`, `title`, `summary`, `language`, `category`, `topics`, `entities`,"+
		" `cleanedMarkdownRef`, `publishedAt`, `processedAt`, `createdAt`, `updatedAt`)"+
		" VALUES (?, ?, ?, 'completed', ?, 'Summary', 'en', ?, ?, ?, ?, ?, ?, ?, ?)",
		processedArticleID, orgID, articleID, "Title "+suffix, category, topics, entities,
		processedItemID, processedAt, processedAt, now, now); err != nil {
		t.Fatalf("insert processed article: %v", err)
	}
	return articleID, processedArticleID
}

func insertIntegrationTopicEvent(t *testing.T, db *sql.DB, orgID, eventID, topic string, lastAt time.Time) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO `NewsEvent` (`id`, `orgId`, `status`, `language`, `primaryTopic`, `primaryEntity`,"+
		" `title`, `summary`, `startAt`, `lastAt`, `metadata`, `createdAt`, `updatedAt`)"+
		" VALUES (?, ?, 'active', 'en', ?, NULL, 'Existing event', 'Summary', ?, ?, ?, ?, ?)",
		eventID, orgID, topic, lastAt, lastAt, nil, now, now); err != nil {
		t.Fatalf("insert event: %v", err)
	}
}

// ingestionFixture bundles the wiring one test needs.
type ingestionFixture struct {
	db      *sql.DB
	redis   *redis.Client
	mongo   *mongo.Database
	vectors VectorSearcher
	model   ModelServiceClient
	now     time.Time
}

// newIngestionFixture builds the runner dependencies with local HTTP fixtures.
func newIngestionFixture(t *testing.T, vectorHandler, modelHandler http.HandlerFunc) *ingestionFixture {
	t.Helper()
	db := openIntegrationDB(t)
	redisClient := openIntegrationRedis(t)
	mongoDatabase := openIntegrationMongo(t)
	createNewsEventsIngestTables(t, db)

	fixture := &ingestionFixture{db: db, redis: redisClient, mongo: mongoDatabase, now: time.Now().UTC()}
	vectorOptions := VectorSearcherOptions{
		DB:         db,
		Redis:      redisClient,
		Enabled:    false,
		TimeoutMs:  2000,
		MaxRetries: 0,
	}
	if vectorHandler != nil {
		server := httptest.NewServer(vectorHandler)
		t.Cleanup(server.Close)
		vectorOptions.Enabled = true
		vectorOptions.BaseURL = server.URL
		vectorOptions.Token = "vector-secret"
	}
	fixture.vectors = NewVectorSearcher(vectorOptions)
	if modelHandler != nil {
		server := httptest.NewServer(modelHandler)
		t.Cleanup(server.Close)
		fixture.model = NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
			Enabled:       true,
			BaseURL:       server.URL,
			InternalToken: "model-secret",
			Timeout:       5 * time.Second,
			MaxRetries:    0,
		}})
	}
	return fixture
}

// runner wires the ingest runner with the shared settings reader.
func (f *ingestionFixture) runner() *ingestRunner {
	return &ingestRunner{
		store:    &store{db: f.db, mongo: f.mongo},
		settings: ReadModelSettingsReader{Reader: settingscrawl.NewNewsEventsIngestSettingsReader(f.db)},
		model:    f.model,
		vectors:  f.vectors,
		settle:   defaultSettleWindow,
		now:      func() time.Time { return f.now },
	}
}

// assigner wires the assignment path with an explicit clock and no prefetch.
func (f *ingestionFixture) assigner(leaves map[string]processedItemLeaf) *assigner {
	if leaves == nil {
		leaves = map[string]processedItemLeaf{}
	}
	return &assigner{
		store:   &store{db: f.db, mongo: f.mongo},
		model:   f.model,
		vectors: f.vectors,
		leaves:  leaves,
		now:     func() time.Time { return f.now },
	}
}

// state reads the ingestion cursor.
func (f *ingestionFixture) state(t *testing.T, orgID string) (sql.NullTime, sql.NullString) {
	t.Helper()
	var lastProcessedAt sql.NullTime
	var lastProcessedArticleID sql.NullString
	if err := f.db.QueryRow("SELECT `lastProcessedAt`, `lastProcessedArticleId` FROM `NewsEventIngestionState` WHERE `orgId` = ?",
		orgID).Scan(&lastProcessedAt, &lastProcessedArticleID); err != nil {
		t.Fatalf("read state: %v", err)
	}
	return lastProcessedAt, lastProcessedArticleID
}

// itemsOf returns the assignment rows of one organization.
func (f *ingestionFixture) itemsOf(t *testing.T, orgID string) []struct {
	EventID            string
	ProcessedArticleID string
	Similarity         sql.NullFloat64
	AssignedBy         string
} {
	t.Helper()
	rows, err := f.db.Query("SELECT `eventId`, `processedArticleId`, `similarity`, `assignedBy`"+
		" FROM `NewsEventItem` WHERE `orgId` = ? ORDER BY `processedArticleId`", orgID)
	if err != nil {
		t.Fatalf("query items: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var items []struct {
		EventID            string
		ProcessedArticleID string
		Similarity         sql.NullFloat64
		AssignedBy         string
	}
	for rows.Next() {
		var item struct {
			EventID            string
			ProcessedArticleID string
			Similarity         sql.NullFloat64
			AssignedBy         string
		}
		if err := rows.Scan(&item.EventID, &item.ProcessedArticleID, &item.Similarity, &item.AssignedBy); err != nil {
			t.Fatalf("scan item: %v", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("items: %v", err)
	}
	return items
}

// eventMetadata reads one event metadata column.
func (f *ingestionFixture) eventMetadata(t *testing.T, eventID string) []byte {
	t.Helper()
	var metadata []byte
	if err := f.db.QueryRow("SELECT `metadata` FROM `NewsEvent` WHERE `id` = ?", eventID).Scan(&metadata); err != nil {
		t.Fatalf("read metadata: %v", err)
	}
	return metadata
}

// countTaskLogs counts tasklogs documents of one stage for an organization.
func (f *ingestionFixture) countTaskLogs(t *testing.T, orgID, stage string) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	count, err := f.mongo.Collection(taskLogsCollection).CountDocuments(ctx,
		bson.D{{Key: "orgId", Value: orgID}, {Key: "stage", Value: stage}})
	if err != nil {
		t.Fatalf("count task logs: %v", err)
	}
	return count
}

// countFailureGroups counts newseventclusteringfailures documents.
func (f *ingestionFixture) countFailureGroups(t *testing.T, orgID string) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	count, err := f.mongo.Collection(clusteringFailuresCollection).CountDocuments(ctx,
		bson.D{{Key: "orgId", Value: orgID}})
	if err != nil {
		t.Fatalf("count failures: %v", err)
	}
	return count
}

// TestIngestionDefaultModeAssignsThroughAllPaths covers the vector path, the
// overlap path and the new-event path in one batch, plus the per-article cursor.
func TestIngestionDefaultModeAssignsThroughAllPaths(t *testing.T) {
	fixture := newIngestionFixture(t, vectorServiceFixture(t), nil)
	orgID := integrationOrgPrefix + "default_mode"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	base := fixture.now.Add(-10 * time.Minute)
	// A pre-existing event with a topic the overlap article shares. The casing is
	// identical because the in-memory re-check is case-sensitive while the SQL
	// comparison is not.
	existingEventID := "cne_" + orgID + "_topic"
	insertIntegrationTopicEvent(t, fixture.db, orgID, existingEventID, "AI", base)

	// 1. The vector article: its processed item has an embedding and the vector
	//    service returns a membership for the same pre-existing event.
	withinSettle := fixture.now.Add(-5 * time.Minute)
	_, _ = insertIntegrationArticle(t, fixture.db, orgID, "vector",
		withinSettle.Add(-2*time.Minute), stringPtr(`["tech"]`), stringPtr(`[]`), nil, stringPtr("675f1f2e9d3c4b5a6e7f8a91"))
	// 2. The overlap article: same primaryTopic as the existing event, no vector.
	overlapAt := withinSettle.Add(-time.Minute)
	_, overlapArticleID := insertIntegrationArticle(t, fixture.db, orgID, "overlap",
		overlapAt, stringPtr(`["AI"]`), stringPtr(`[]`), nil, nil)
	// 3. The new event article: no vector, no overlap, but a classification from
	//    the ProcessedArticle.category fallback.
	newAt := withinSettle
	_, newArticleID := insertIntegrationArticle(t, fixture.db, orgID, "fresh",
		newAt, stringPtr(`["sports"]`), stringPtr(`[]`), stringPtr("tech"), nil)

	// ProcessedItem leaves with the embedding of the vector article.
	vectorEmbedding := []float64{0.11, 0.22, 0.33}
	seedProcessedItem(t, fixture.mongo, "675f1f2e9d3c4b5a6e7f8a91", json.RawMessage(`{
		"category": "tech",
		"category_path": "tech/ai",
		"category_confidence": 0.95,
		"sentiment_label": "positive"
	}`), vectorEmbedding, "text-embedding-3-small")

	// Seed the membership the vector service points at.
	insertIntegrationItem(t, fixture.db, orgID, existingEventID, "cpa_"+orgID+"_seed", "675f1f2e9d3c4b5a6e7f8a99")

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}

	items := fixture.itemsOf(t, orgID)
	byArticle := make(map[string]struct {
		EventID    string
		Similarity sql.NullFloat64
		AssignedBy string
	}, len(items))
	for _, item := range items {
		byArticle[item.ProcessedArticleID] = struct {
			EventID    string
			Similarity sql.NullFloat64
			AssignedBy string
		}{EventID: item.EventID, Similarity: item.Similarity, AssignedBy: item.AssignedBy}
	}

	vectorItem, ok := byArticle["cpa_"+orgID+"_vector"]
	if !ok {
		t.Fatalf("vector article not assigned: %#v", byArticle)
	}
	if vectorItem.EventID != existingEventID || vectorItem.AssignedBy != "vector" {
		t.Fatalf("vector assignment = %+v", vectorItem)
	}
	if !vectorItem.Similarity.Valid || vectorItem.Similarity.Float64 != 0.93 {
		t.Fatalf("vector similarity = %+v, want 0.93", vectorItem.Similarity)
	}

	overlapItem, ok := byArticle[overlapArticleID]
	if !ok {
		t.Fatalf("overlap article not assigned")
	}
	if overlapItem.EventID != existingEventID || overlapItem.AssignedBy != "overlap" {
		t.Fatalf("overlap assignment = %+v", overlapItem)
	}
	if !overlapItem.Similarity.Valid || overlapItem.Similarity.Float64 != 0.5 {
		t.Fatalf("overlap similarity = %+v, want 0.5", overlapItem.Similarity)
	}

	freshItem, ok := byArticle[newArticleID]
	if !ok {
		t.Fatalf("new article not assigned")
	}
	if freshItem.EventID == existingEventID || freshItem.AssignedBy != "overlap" {
		t.Fatalf("new assignment = %+v", freshItem)
	}
	if freshItem.Similarity.Valid {
		t.Fatalf("new assignment similarity = %+v, want NULL", freshItem.Similarity)
	}

	// The cursor advanced one article at a time to the last processed article.
	lastProcessedAt, lastArticleID := fixture.state(t, orgID)
	if !lastProcessedAt.Valid || !lastProcessedAt.Time.Equal(newAt.Truncate(time.Millisecond)) {
		t.Fatalf("cursor processedAt = %+v, want %v", lastProcessedAt, newAt)
	}
	if !lastArticleID.Valid || lastArticleID.String != "ca_"+orgID+"_fresh" {
		t.Fatalf("cursor articleId = %+v", lastArticleID)
	}

	// The new event carries metadata.classification from the article category.
	metadata := fixture.eventMetadata(t, freshItem.EventID)
	if !strings.Contains(string(metadata), `"classification"`) || !strings.Contains(string(metadata), `"legacyCategory":"tech"`) {
		t.Fatalf("new event metadata = %s", metadata)
	}

	// One category_gate TaskLog per decision, and at least one decision log.
	if got := fixture.countTaskLogs(t, orgID, categoryGateStage); got == 0 {
		t.Fatal("no category gate task logs were written")
	}
}

// TestIngestionIsIdempotentForExistingItems locks the pre-check.
func TestIngestionIsIdempotentForExistingItems(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "idempotent"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	processedAt := fixture.now.Add(-5 * time.Minute)
	articleID, processedArticleID := insertIntegrationArticle(t, fixture.db, orgID, "existing",
		processedAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	eventID := "cne_" + orgID + "_existing"
	insertIntegrationTopicEvent(t, fixture.db, orgID, eventID, "ai", fixture.now.Add(-time.Hour))
	insertIntegrationItem(t, fixture.db, orgID, eventID, processedArticleID, "")

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	// Running again must not create a second item or a new event.
	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("second ingest: %v", err)
	}
	items := fixture.itemsOf(t, orgID)
	if len(items) != 1 || items[0].EventID != eventID {
		t.Fatalf("items = %#v", items)
	}
	var eventCount int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM `NewsEvent` WHERE `orgId` = ?", orgID).Scan(&eventCount); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if eventCount != 1 {
		t.Fatalf("events = %d, want 1", eventCount)
	}
	_ = articleID
}

// TestIngestionSettleWindowSkipsLateCommitsIfUnbounded is the B1 regression: an
// article processed inside the settle window is not read this round, and is read
// by the next round once it leaves the window.
func TestIngestionSettleWindowSkipsLateCommits(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "settle"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	// processedAt only 10 s before now: the default 120 s window excludes it.
	articleAt := fixture.now.Add(-10 * time.Second)
	_, processedArticleID := insertIntegrationArticle(t, fixture.db, orgID, "late",
		articleAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if items := fixture.itemsOf(t, orgID); len(items) != 0 {
		t.Fatalf("article inside the settle window was processed: %#v", items)
	}

	// The next round, two and a half minutes later, sees it.
	fixture.now = fixture.now.Add(150 * time.Second)
	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("second ingest: %v", err)
	}
	items := fixture.itemsOf(t, orgID)
	if len(items) != 1 || items[0].ProcessedArticleID != processedArticleID {
		t.Fatalf("items = %#v", items)
	}
}

// TestIngestionSettleWindowPreventsTheLateCommitRace is the B1 regression. Two
// pipeline transactions produce processedAt P1 < P2; the later one commits
// first. Without the settle window the tick would read P2, advance the cursor
// past P1 and never see P1 again. With the window neither row is eligible yet,
// so the cursor stays put and the next round reads both in order.
func TestIngestionSettleWindowPreventsTheLateCommitRace(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "late_race"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	// Both processedAt values are inside the 120 s window at this tick.
	earlierAt := fixture.now.Add(-40 * time.Second)
	laterAt := fixture.now.Add(-30 * time.Second)
	// Only the later transaction has committed when the tick runs.
	_, laterArticleID := insertIntegrationArticle(t, fixture.db, orgID, "later",
		laterAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if items := fixture.itemsOf(t, orgID); len(items) != 0 {
		t.Fatalf("a row inside the settle window was processed: %#v", items)
	}
	var stateCount int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM `NewsEventIngestionState` WHERE `orgId` = ? AND `lastProcessedAt` IS NULL", orgID).Scan(&stateCount); err != nil {
		t.Fatalf("read state: %v", err)
	}
	if stateCount != 1 {
		t.Fatalf("the cursor moved during the guarded round")
	}

	// The earlier transaction commits late, then the window passes.
	_, earlierArticleID := insertIntegrationArticle(t, fixture.db, orgID, "earlier",
		earlierAt, stringPtr(`["economy"]`), stringPtr(`[]`), nil, nil)
	fixture.now = fixture.now.Add(150 * time.Second)
	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("second ingest: %v", err)
	}

	items := fixture.itemsOf(t, orgID)
	if len(items) != 2 {
		t.Fatalf("items = %#v, want both articles", items)
	}
	// The earlier article was processed in processedAt order, before the later
	// one, and the cursor ended on the later article.
	if items[0].ProcessedArticleID != earlierArticleID || items[1].ProcessedArticleID != laterArticleID {
		t.Fatalf("assignment order = %q,%q", items[0].ProcessedArticleID, items[1].ProcessedArticleID)
	}
	lastProcessedAt, lastArticleID := fixture.state(t, orgID)
	if !lastProcessedAt.Valid || !lastProcessedAt.Time.Equal(laterAt.Truncate(time.Millisecond)) {
		t.Fatalf("cursor processedAt = %+v, want %v", lastProcessedAt, laterAt)
	}
	if !lastArticleID.Valid || lastArticleID.String != "ca_"+orgID+"_later" {
		t.Fatalf("cursor article = %+v", lastArticleID)
	}
}

// TestIngestionBertopicSuccessAssignsRepresentativeAndMembers covers
// bertopic_primary: the representative creates the event and the members are
// assigned to it with the manual method, then the cursor advances once.
func TestIngestionBertopicSuccessAssignsRepresentativeAndMembers(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "bertopic_ok"
	settings := defaultIntegrationSettings()
	settings.ClusteringMode = "bertopic_primary"
	settings.VectorMinScore = 0.5
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, settings)

	processedAt := fixture.now.Add(-5 * time.Minute)
	_, alphaID := insertIntegrationArticle(t, fixture.db, orgID, "alpha",
		processedAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	_, betaID := insertIntegrationArticle(t, fixture.db, orgID, "beta",
		processedAt.Add(time.Second), stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)

	// The cluster response names the real processedArticleId values.
	clusterHandler := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		_, _ = fmt.Fprintf(writer, `{
			"clusters": [{"topicId": 0, "itemIds": [%q, %q], "representativeId": %q, "keywords": ["ai"]}],
			"outlierIds": [],
			"diagnostics": {"document_count": 2, "cluster_count": 1, "outlier_count": 0}
		}`, alphaID, betaID, alphaID)
	}
	server := httptest.NewServer(http.HandlerFunc(clusterHandler))
	defer server.Close()
	fixture.model = NewModelClient(staticModelConfig{config: modelaccesssettings.AssistantModelServiceConfig{
		Enabled:       true,
		BaseURL:       server.URL,
		InternalToken: "model-secret",
		Timeout:       5 * time.Second,
		MaxRetries:    0,
	}})

	seedProcessedItem(t, fixture.mongo, "675f1f2e9d3c4b5a6e7f8b01", nil, []float64{1, 0}, "text-embedding-3-small")
	seedProcessedItem(t, fixture.mongo, "675f1f2e9d3c4b5a6e7f8b02", nil, []float64{1, 0}, "text-embedding-3-small")
	linkProcessedItem(t, fixture.db, alphaID, "675f1f2e9d3c4b5a6e7f8b01")
	linkProcessedItem(t, fixture.db, betaID, "675f1f2e9d3c4b5a6e7f8b02")

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}

	items := fixture.itemsOf(t, orgID)
	if len(items) != 2 {
		t.Fatalf("items = %#v", items)
	}
	byArticle := make(map[string]struct {
		EventID    string
		AssignedBy string
	}, len(items))
	for _, item := range items {
		byArticle[item.ProcessedArticleID] = struct {
			EventID    string
			AssignedBy string
		}{EventID: item.EventID, AssignedBy: item.AssignedBy}
	}
	representative, ok := byArticle[alphaID]
	if !ok || representative.EventID == "" {
		t.Fatalf("representative not assigned: %#v", byArticle)
	}
	member, ok := byArticle[betaID]
	if !ok || member.EventID != representative.EventID {
		t.Fatalf("member not assigned to the representative's event: %#v", byArticle)
	}
	// The representative goes through the full picker, so a brand-new event
	// records the overlap method; the member goes through the requested-event
	// path with the manual method and its cosine similarity.
	if representative.AssignedBy != "overlap" {
		t.Fatalf("representative assignedBy = %q, want overlap", representative.AssignedBy)
	}
	if member.AssignedBy != "manual" {
		t.Fatalf("member assignedBy = %q, want manual", member.AssignedBy)
	}
	if got := fixture.countTaskLogs(t, orgID, bertopicClusterStage); got != 1 {
		t.Fatalf("bertopic cluster task logs = %d, want 1", got)
	}
	lastProcessedAt, _ := fixture.state(t, orgID)
	if !lastProcessedAt.Valid || !lastProcessedAt.Time.Equal(processedAt.Add(time.Second).Truncate(time.Millisecond)) {
		t.Fatalf("cursor = %+v, want the last batch entry", lastProcessedAt)
	}
}

// TestIngestionBertopicFailureRecordsGroupAndAdvancesCursor covers the failure
// path: the failure group and its TaskLog are written and the cursor still
// advances to the last batch entry.
func TestIngestionBertopicFailureRecordsGroupAndAdvancesCursor(t *testing.T) {
	fixture := newIngestionFixture(t, nil, func(writer http.ResponseWriter, request *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`{"detail":"BERTopic clustering failed: boom"}`))
	})
	orgID := integrationOrgPrefix + "bertopic_fail"
	settings := defaultIntegrationSettings()
	settings.ClusteringMode = "bertopic_primary"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, settings)

	processedAt := fixture.now.Add(-5 * time.Minute)
	_, alphaID := insertIntegrationArticle(t, fixture.db, orgID, "alpha",
		processedAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	_, betaID := insertIntegrationArticle(t, fixture.db, orgID, "beta",
		processedAt.Add(time.Second), stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	seedProcessedItem(t, fixture.mongo, "675f1f2e9d3c4b5a6e7f8c01", nil, []float64{1, 0}, "text-embedding-3-small")
	seedProcessedItem(t, fixture.mongo, "675f1f2e9d3c4b5a6e7f8c02", nil, []float64{1, 0}, "text-embedding-3-small")
	linkProcessedItem(t, fixture.db, alphaID, "675f1f2e9d3c4b5a6e7f8c01")
	linkProcessedItem(t, fixture.db, betaID, "675f1f2e9d3c4b5a6e7f8c02")

	if err := fixture.runner().ingestOrg(context.Background(), orgID); err != nil {
		t.Fatalf("ingest: %v", err)
	}

	if items := fixture.itemsOf(t, orgID); len(items) != 0 {
		t.Fatalf("failed chunk still assigned articles: %#v", items)
	}
	if got := fixture.countFailureGroups(t, orgID); got != 1 {
		t.Fatalf("failure groups = %d, want 1", got)
	}
	if got := fixture.countTaskLogs(t, orgID, bertopicFailureQueueStage); got != 1 {
		t.Fatalf("failure task logs = %d, want 1", got)
	}
	// The failure record carries the pending status and the item count.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var stored struct {
		Status         string `bson:"status"`
		ClusteringMode string `bson:"clusteringMode"`
		FailureReason  string `bson:"failureReason"`
		ItemCount      int64  `bson:"itemCount"`
		AttemptCount   int64  `bson:"attemptCount"`
		Items          []struct {
			ProcessedArticleID string `bson:"processedArticleId"`
		} `bson:"items"`
	}
	if err := fixture.mongo.Collection(clusteringFailuresCollection).
		FindOne(ctx, bson.D{{Key: "orgId", Value: orgID}}).Decode(&stored); err != nil {
		t.Fatalf("read failure group: %v", err)
	}
	if stored.Status != "pending" || stored.ClusteringMode != "bertopic_primary" {
		t.Fatalf("failure group = %+v", stored)
	}
	if stored.FailureReason != "bertopic_request_failed" || stored.ItemCount != 2 || len(stored.Items) != 2 {
		t.Fatalf("failure group = %+v", stored)
	}
	if stored.AttemptCount != 0 {
		t.Fatalf("attemptCount = %d, want 0 from $setOnInsert", stored.AttemptCount)
	}

	lastProcessedAt, _ := fixture.state(t, orgID)
	if !lastProcessedAt.Valid || !lastProcessedAt.Time.Equal(processedAt.Add(time.Second).Truncate(time.Millisecond)) {
		t.Fatalf("cursor = %+v, want the last batch entry even after a failure", lastProcessedAt)
	}
}

// TestAssignmentPreCheckReturnsExistingEvent locks the idempotency pre-check of
// both assignment entry points. The P2002 branch behind it is exercised by
// TestIngestionConcurrentAssignOnlyOneWins.
func TestAssignmentPreCheckReturnsExistingEvent(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "conflict"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	processedAt := fixture.now.Add(-5 * time.Minute)
	_, processedArticleID := insertIntegrationArticle(t, fixture.db, orgID, "conflict",
		processedAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	winnerEventID := "cne_" + orgID + "_winner"
	insertIntegrationTopicEvent(t, fixture.db, orgID, winnerEventID, "other", fixture.now.Add(-time.Hour))
	insertIntegrationItem(t, fixture.db, orgID, winnerEventID, processedArticleID, "")

	signal := NewsSignal{
		ArticleID:          "ca_" + orgID + "_conflict",
		ProcessedArticleID: processedArticleID,
		Timestamp:          processedAt,
		Topics:             []string{"ai"},
	}
	result, err := fixture.assigner(nil).AssignNewsSignalToEvent(context.Background(), orgID, signal, baseSettings())
	if err != nil {
		t.Fatalf("assign: %v", err)
	}
	if result.Created || result.EventID != winnerEventID {
		t.Fatalf("result = %+v, want the winner %q", result, winnerEventID)
	}

	// The specific-event path returns the REQUESTED event id on a conflict.
	specific, err := fixture.assigner(nil).AssignNewsSignalToSpecificEvent(context.Background(), orgID, winnerEventID, signal, nil, assignmentMethodManual)
	if err != nil {
		t.Fatalf("specific assign: %v", err)
	}
	if specific.Created || specific.EventID != winnerEventID {
		t.Fatalf("specific result = %+v", specific)
	}
}

// TestSchedulerClaimsSharedTickGateAndOrgLock locks the key names and the
// mutual exclusion of the two shared gates.
func TestSchedulerClaimsSharedTickGateAndOrgLock(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "scheduler"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := fixture.redis.Del(ctx, tickGateKey, activeOrgCacheKey).Err(); err != nil {
		t.Fatalf("clear keys: %v", err)
	}

	scheduler := NewScheduler(SchedulerOptions{
		DB:          fixture.db,
		RedisClient: fixture.redis,
		Mongo:       fixture.mongo,
		Settings:    ReadModelSettingsReader{Reader: settingscrawl.NewNewsEventsIngestSettingsReader(fixture.db)},
		Concurrency: fixedConcurrency(1),
		Model:       fixture.model,
		Vectors:     fixture.vectors,
		Settle:      defaultSettleWindow,
		Now:         func() time.Time { return fixture.now },
	})

	claimed, err := scheduler.claimTick(ctx)
	if err != nil || !claimed {
		t.Fatalf("first claim = %v/%v", claimed, err)
	}
	second, err := scheduler.claimTick(ctx)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if second {
		t.Fatal("the tick gate was claimed twice")
	}
	payload, err := fixture.redis.Get(ctx, tickGateKey).Result()
	if err != nil {
		t.Fatalf("read tick gate: %v", err)
	}
	if !strings.Contains(payload, "claimedAt") {
		t.Fatalf("tick gate payload = %q", payload)
	}
	ttl, err := fixture.redis.TTL(ctx, tickGateKey).Result()
	if err != nil {
		t.Fatalf("tick gate ttl: %v", err)
	}
	if ttl <= 0 || ttl > tickGateTTL+time.Second {
		t.Fatalf("tick gate ttl = %v", ttl)
	}

	// The organization lock is exclusive while held and released afterwards.
	lockKey := orgLockKeyPrefix + orgID
	first := scheduler.runOrgWithLock(ctx, orgID)
	if first.outcome != orgRunCompleted {
		t.Fatalf("first org run = %+v", first)
	}
	if exists, err := fixture.redis.Exists(ctx, lockKey).Result(); err != nil || exists != 0 {
		t.Fatalf("org lock still present: %d/%v", exists, err)
	}

	// Holding the lock makes the next run skip.
	if err := fixture.redis.SetNX(ctx, lockKey, "other-owner", time.Minute).Err(); err != nil {
		t.Fatalf("hold lock: %v", err)
	}
	skipped := scheduler.runOrgWithLock(ctx, orgID)
	if skipped.outcome != orgRunSkipped {
		t.Fatalf("second org run = %+v, want skipped", skipped)
	}
	if err := fixture.redis.Del(ctx, lockKey).Err(); err != nil {
		t.Fatalf("release lock: %v", err)
	}
}

// fixedConcurrency is the OrgConcurrencyReader the scheduler test uses.
type fixedConcurrency int

// ReadNewsEventsIngestionOrgConcurrency implements OrgConcurrencyReader.
func (c fixedConcurrency) ReadNewsEventsIngestionOrgConcurrency(ctx context.Context) (int, error) {
	_ = ctx
	return int(c), nil
}

// vectorServiceFixture returns a vector service that maps every search to one
// pre-existing membership.
func vectorServiceFixture(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"collection":"processeditems","matches":[
			{"processedItemId":"675f1f2e9d3c4b5a6e7f8a99","itemMetaId":"m1","score":0.93,"createdAtMs":1700000000000}
		]}`))
	}
}

// seedProcessedItem inserts one processeditems document.
func seedProcessedItem(t *testing.T, database *mongo.Database, id string, result json.RawMessage, embedding []float64, modelName string) {
	t.Helper()
	objectID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		t.Fatalf("object id: %v", err)
	}
	document := bson.D{
		{Key: "_id", Value: objectID},
		{Key: "summaryEmbedding", Value: embedding},
		{Key: "summaryEmbeddingModel", Value: modelName},
	}
	if len(result) > 0 {
		var decoded bson.D
		if err := bson.UnmarshalExtJSON(result, false, &decoded); err != nil {
			t.Fatalf("decode result: %v", err)
		}
		document = append(document, bson.E{Key: "result", Value: decoded})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := database.Collection(processedItemsCollection).InsertOne(ctx, document); err != nil {
		t.Fatalf("insert processed item: %v", err)
	}
}

// linkProcessedItem points one ProcessedArticle at a ProcessedItem.
func linkProcessedItem(t *testing.T, db *sql.DB, processedArticleID, processedItemID string) {
	t.Helper()
	if _, err := db.Exec("UPDATE `ProcessedArticle` SET `cleanedMarkdownRef` = ? WHERE `id` = ?",
		processedItemID, processedArticleID); err != nil {
		t.Fatalf("link processed item: %v", err)
	}
}

// insertIntegrationItem inserts one NewsEventItem row directly.
func insertIntegrationItem(t *testing.T, db *sql.DB, orgID, eventID, processedArticleID, processedItemID string) {
	t.Helper()
	id := "cni_" + orgID + "_" + processedArticleID
	if len(id) > 180 {
		id = id[:180]
	}
	var itemID any
	if processedItemID == "" {
		itemID = nil
	} else {
		itemID = processedItemID
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := db.Exec("INSERT INTO `NewsEventItem` (`id`, `orgId`, `eventId`, `processedArticleId`, `processedItemId`, `similarity`, `assignedBy`, `createdAt`)"+
		" VALUES (?, ?, ?, ?, ?, NULL, 'overlap', ?)", id, orgID, eventID, processedArticleID, itemID, now); err != nil {
		t.Fatalf("insert item: %v", err)
	}
}

// TestIngestionConcurrentAssignOnlyOneWins locks the (orgId, processedArticleId)
// unique key under real concurrency: one call creates, the other reports the
// winner.
func TestIngestionConcurrentAssignOnlyOneWins(t *testing.T) {
	fixture := newIngestionFixture(t, nil, nil)
	orgID := integrationOrgPrefix + "race"
	insertIntegrationOrg(t, fixture.db, orgID, true)
	writeIntegrationSettings(t, fixture.db, orgID, defaultIntegrationSettings())

	processedAt := fixture.now.Add(-5 * time.Minute)
	_, processedArticleID := insertIntegrationArticle(t, fixture.db, orgID, "race",
		processedAt, stringPtr(`["ai"]`), stringPtr(`[]`), nil, nil)
	signal := NewsSignal{
		ArticleID:          "ca_" + orgID + "_race",
		ProcessedArticleID: processedArticleID,
		Timestamp:          processedAt,
		Topics:             []string{"ai"},
	}

	var waitGroup sync.WaitGroup
	results := make([]AssignResult, 4)
	errors := make([]error, 4)
	for index := 0; index < 4; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			results[index], errors[index] = fixture.assigner(nil).AssignNewsSignalToEvent(context.Background(), orgID, signal, baseSettings())
		}(index)
	}
	waitGroup.Wait()

	created := 0
	eventIDs := make(map[string]struct{}, len(results))
	for index, result := range results {
		if errors[index] != nil {
			t.Fatalf("assign %d: %v", index, errors[index])
		}
		if result.Created {
			created++
		}
		eventIDs[result.EventID] = struct{}{}
	}
	if created != 1 {
		t.Fatalf("created = %d, want exactly 1", created)
	}
	if len(eventIDs) != 1 {
		t.Fatalf("event ids = %#v, want one winner", eventIDs)
	}
	items := fixture.itemsOf(t, orgID)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
}
