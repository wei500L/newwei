//go:build integration

package processeditemoutbox

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

func TestProcessedItemOutboxIntegration(t *testing.T) {
	db := openProcessedItemTestDB(t)
	database := openProcessedItemTestMongo(t)
	ctx := context.Background()
	vectorConfig := fakeVectorConfig{config: vectorclient.Config{Enabled: true, BaseURL: "http://vector.test", Token: "token", TimeoutMs: 1000}}
	vectorWriter := &recordingVector{}
	newTestService := func() *Service {
		return NewService(Options{
			DB:           db,
			Mongo:        database,
			VectorConfig: vectorConfig,
			VectorWriter: vectorWriter,
			BatchSize:    10,
			Concurrency:  4,
			TickBudget:   5 * time.Second,
			Rand:         func() float64 { return 0.5 },
		})
	}

	t.Run("claim is exclusive", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		now := time.Now().UTC().Truncate(time.Millisecond)
		outboxID := "outbox-claim"
		insertOutboxForTest(t, db, outboxID, "org-1", validOutboxPayload("processed-claim", "raw-claim", "meta-claim", "org-1"), "pending", 0, now, now)
		var wg sync.WaitGroup
		results := make(chan *claimedEntry, 2)
		errs := make(chan error, 2)
		for index := 0; index < 2; index++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				store := &mysqlStore{db: db}
				claimed, err := store.claim(ctx, outboxID, now)
				results <- claimed
				errs <- err
			}()
		}
		wg.Wait()
		close(results)
		close(errs)
		for err := range errs {
			if err != nil {
				t.Fatalf("claim: %v", err)
			}
		}
		claimedCount := 0
		for claimed := range results {
			if claimed != nil {
				claimedCount++
				if claimed.Attempts != 1 {
					t.Fatalf("attempts = %d", claimed.Attempts)
				}
			}
		}
		if claimedCount != 1 {
			t.Fatalf("claims = %d, want 1", claimedCount)
		}
	})

	t.Run("delivery writes all stores", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		vectorWriter.reset()
		now := time.Now().UTC().Truncate(time.Millisecond)
		metaID := "meta-deliver"
		insertMetaForTest(t, db, metaID, "org-1", "external-deliver", "https://old.example/item", "pending", now)
		rawID := "507f1f77bcf86cd799439012"
		insertRawForTest(t, database, rawID, metaID, now)
		outboxID := "outbox-deliver"
		payload := validOutboxPayload("507f1f77bcf86cd799439011", rawID, metaID, "org-1")
		insertOutboxForTest(t, db, outboxID, "org-1", payload, "pending", 0, now, now)

		service := newTestService()
		if !service.deliverOne(ctx, outboxID) {
			t.Fatal("delivery was not claimed")
		}
		if countOutboxForTest(t, db, outboxID) != 0 {
			t.Fatal("outbox row was not deleted")
		}
		meta := loadMetaForTest(t, db, metaID)
		if meta.Status != "completed" || meta.Name != "Delivered title" {
			t.Fatalf("item meta = %+v", meta)
		}
		if meta.PublishedAt == nil || meta.PublishedAt.Format(time.RFC3339) != "2026-01-02T03:04:05Z" {
			t.Fatalf("publishedAt = %v", meta.PublishedAt)
		}
		processed := loadProcessedForTest(t, database, "507f1f77bcf86cd799439011")
		if processed.Status != "completed" || processed.ItemMetaID != metaID || processed.SourceID != nil {
			t.Fatalf("processed = %+v", processed)
		}
		if processed.SummaryEmbeddingDimensions == nil || *processed.SummaryEmbeddingDimensions != 2 {
			t.Fatalf("dimensions = %v", processed.SummaryEmbeddingDimensions)
		}
		if !processedHasLocation(processed.Result) {
			t.Fatalf("hasLocation missing: %+v", processed.Result)
		}
		readModel := loadReadModelForTest(t, database, "org-1", metaID)
		if readModel.Status != "completed" || readModel.Title != "Delivered title" || readModel.Processed == nil || readModel.Processed.Status != "completed" {
			t.Fatalf("read model = %+v", readModel)
		}
		if readModel.SourceID == nil || *readModel.SourceID != "source-1" || !readModel.HasVector {
			t.Fatalf("read model source/vector = %v/%v", readModel.SourceID, readModel.HasVector)
		}
		if len(vectorWriter.requestsSnapshot()) != 1 {
			t.Fatalf("vector requests = %d", len(vectorWriter.requestsSnapshot()))
		}
		point := vectorWriter.requestsSnapshot()[0].Points[0]
		if point.ProcessedItemID != "507f1f77bcf86cd799439011" || point.ItemMetaID != metaID || len(point.Vector) != 2 {
			t.Fatalf("vector point = %+v", point)
		}
	})

	t.Run("invalid payload is dead after claim", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		now := time.Now().UTC().Truncate(time.Millisecond)
		outboxID := "outbox-invalid"
		insertOutboxForTest(t, db, outboxID, "org-1", []byte(`{"type":"processed_item","document":{}}`), "pending", 0, now, now)
		service := newTestService()
		if !service.deliverOne(ctx, outboxID) {
			t.Fatal("delivery was not claimed")
		}
		row := loadOutboxForTest(t, db, outboxID)
		if row.Status != "dead" || row.Attempts != 1 || row.LastError != "Invalid outbox payload" {
			t.Fatalf("outbox = %+v", row)
		}
	})

	t.Run("failure applies backoff", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		vectorWriter.reset()
		vectorWriter.fail(errorsNew("vector down"))
		now := time.Now().UTC().Truncate(time.Millisecond)
		metaID := "meta-failure"
		insertMetaForTest(t, db, metaID, "org-1", "external-failure", "Title", "pending", now)
		outboxID := "outbox-failure"
		payload := validOutboxPayload("507f1f77bcf86cd799439021", "507f1f77bcf86cd799439022", metaID, "org-1")
		insertOutboxForTest(t, db, outboxID, "org-1", payload, "pending", 0, now, now)
		service := newTestService()
		if !service.deliverOne(ctx, outboxID) {
			t.Fatal("delivery was not claimed")
		}
		row := loadOutboxForTest(t, db, outboxID)
		if row.Status != "failed" || row.Attempts != 1 || row.LockedAt.Valid || row.LastError == "" {
			t.Fatalf("outbox = %+v", row)
		}
		if row.AvailableAt.Before(time.Now().Add(20 * time.Second)) {
			t.Fatalf("availableAt = %s, want future backoff", row.AvailableAt)
		}
	})

	t.Run("tenth failure compensates dead letter", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		vectorWriter.reset()
		now := time.Now().UTC().Truncate(time.Millisecond)
		metaID := "meta-dead"
		insertMetaForTest(t, db, metaID, "org-1", "external-dead", "Title", "processing", now)
		processedID := "507f1f77bcf86cd799439031"
		insertProcessingProcessedForTest(t, database, processedID, "507f1f77bcf86cd799439032", metaID, "org-1", now)
		insertProcessingReadModelForTest(t, database, metaID, "org-1", now)
		outboxID := "outbox-dead"
		payload := validOutboxPayload(processedID, "not-an-object-id", metaID, "org-1")
		insertOutboxForTest(t, db, outboxID, "org-1", payload, "pending", 9, now, now)
		service := newTestService()
		if !service.deliverOne(ctx, outboxID) {
			t.Fatal("delivery was not claimed")
		}
		row := loadOutboxForTest(t, db, outboxID)
		if row.Status != "dead" || row.Attempts != 10 || row.LastError == "" {
			t.Fatalf("outbox = %+v", row)
		}
		processed := loadProcessedForTest(t, database, processedID)
		if processed.Status != "failed" || processed.Error == nil || processed.Error.Name == nil || *processed.Error.Name != "OutboxDeliveryError" {
			t.Fatalf("processed compensation = %+v", processed)
		}
		readModel := loadReadModelForTest(t, database, "org-1", metaID)
		if readModel.Status != "failed" || readModel.Processed == nil || readModel.Processed.Status != "failed" || readModel.Processed.Error == nil {
			t.Fatalf("read model compensation = %+v", readModel)
		}
	})

	t.Run("tick drains multiple batches within budget", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		vectorWriter.reset()
		now := time.Now().UTC().Truncate(time.Millisecond)
		metaID := "meta-throughput"
		insertMetaForTest(t, db, metaID, "org-1", "external-throughput", "Title", "pending", now)
		for index := 0; index < 25; index++ {
			processedID := fmt.Sprintf("507f1f77bcf86cd79943%04d", index)
			rawID := fmt.Sprintf("507f1f77bcf86cd79944%04d", index)
			insertOutboxForTest(t, db, fmt.Sprintf("outbox-throughput-%02d", index), "org-1", validOutboxPayload(processedID, rawID, metaID, "org-1"), "pending", 0, now, now.Add(time.Duration(index)*time.Millisecond))
		}
		service := newTestService()
		service.RunTick(ctx, 10*time.Second)
		if countAllOutboxForTest(t, db) != 0 {
			t.Fatalf("outbox rows remaining = %d", countAllOutboxForTest(t, db))
		}
		count, err := database.Collection(processedItemsCollection).CountDocuments(ctx, bson.D{{Key: "orgId", Value: "org-1"}})
		if err != nil {
			t.Fatal(err)
		}
		if count != 25 {
			t.Fatalf("processed count = %d, want 25", count)
		}
	})

	t.Run("scan returns due ids in createdAt order", func(t *testing.T) {
		resetProcessedItemState(t, db, database)
		now := time.Now().UTC().Truncate(time.Millisecond)
		insertOutboxForTest(t, db, "outbox-scan-late", "org-1", []byte(`{}`), "pending", 0, now, now.Add(2*time.Second))
		insertOutboxForTest(t, db, "outbox-scan-early", "org-1", []byte(`{}`), "pending", 0, now, now)
		insertOutboxForTest(t, db, "outbox-scan-future", "org-1", []byte(`{}`), "pending", 0, now.Add(time.Hour), now.Add(-time.Second))
		store := &mysqlStore{db: db}
		ids, err := store.listDueIDs(ctx, now, 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != 2 || ids[0] != "outbox-scan-early" || ids[1] != "outbox-scan-late" {
			t.Fatalf("ids = %v", ids)
		}
	})
}

func openProcessedItemTestDB(t *testing.T) *sql.DB {
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
	statements := []string{
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
		`CREATE TABLE IF NOT EXISTS MongoOutbox (
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
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func openProcessedItemTestMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI is not set")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	database := client.Database(fmt.Sprintf("processed_item_outbox_it_%d", time.Now().UnixNano()))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func resetProcessedItemState(t *testing.T, db *sql.DB, database *mongo.Database) {
	t.Helper()
	if _, err := db.Exec("DELETE FROM MongoOutbox"); err != nil {
		t.Fatalf("clean outbox: %v", err)
	}
	if _, err := db.Exec("DELETE FROM ItemMeta"); err != nil {
		t.Fatalf("clean item meta: %v", err)
	}
	for _, collection := range []string{rawItemsCollection, processedItemsCollection, itemReadModelsCollection} {
		if _, err := database.Collection(collection).DeleteMany(context.Background(), bson.D{}); err != nil {
			t.Fatalf("clean mongo %s: %v", collection, err)
		}
	}
}

func validOutboxPayload(processedID, rawID, metaID, orgID string) []byte {
	return []byte(fmt.Sprintf(`{
		"type":"processed_item",
		"document":{
			"_id":%q,"rawItemId":%q,"itemMetaId":%q,"orgId":%q,
			"status":"completed","tags":["tag"],
			"result":{"title":"Delivered title","published_at":"2026-01-02T03:04:05Z","location":"Moscow","summary":"summary","cleaned_markdown":"body"},
			"llm":{"model":"test-model"},
			"summaryEmbedding":[0.1,0.2],
			"summaryEmbeddingModel":"embed-v1"
		}
	}`, processedID, rawID, metaID, orgID))
}

func insertMetaForTest(t *testing.T, db *sql.DB, id, orgID, externalID, name, status string, now time.Time) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO ItemMeta (id,orgId,externalId,name,status,mongoRef,version,publishedAt,sortAt,createdAt,updatedAt)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, orgID, externalID, name, status, "", 1, nil, now, now, now)
	if err != nil {
		t.Fatalf("insert item meta: %v", err)
	}
}

func insertRawForTest(t *testing.T, database *mongo.Database, id, metaID string, now time.Time) {
	t.Helper()
	objectID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = database.Collection(rawItemsCollection).InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: objectID},
		{Key: "itemMetaId", Value: metaID},
		{Key: "source", Value: "rss"},
		{Key: "payload", Value: bson.D{
			{Key: "url", Value: "https://example.com/item"},
			{Key: "metadata", Value: bson.D{{Key: "sourceId", Value: "source-1"}}},
		}},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	})
	if err != nil {
		t.Fatalf("insert raw: %v", err)
	}
}

func insertOutboxForTest(t *testing.T, db *sql.DB, id, orgID string, payload []byte, status string, attempts int, availableAt, createdAt time.Time) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO MongoOutbox (id,orgId,type,payload,status,attempts,availableAt,createdAt,updatedAt)
		VALUES (?,?,'processed_item',?,?,?,?,?,?)`, id, orgID, payload, status, attempts, availableAt, createdAt, createdAt)
	if err != nil {
		t.Fatalf("insert outbox: %v", err)
	}
}

func insertProcessingProcessedForTest(t *testing.T, database *mongo.Database, id, rawID, metaID, orgID string, now time.Time) {
	t.Helper()
	processedID, _ := bson.ObjectIDFromHex(id)
	rawObjectID, _ := bson.ObjectIDFromHex(rawID)
	_, err := database.Collection(processedItemsCollection).InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: processedID},
		{Key: "rawItemId", Value: rawObjectID},
		{Key: "itemMetaId", Value: metaID},
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "processing"},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	})
	if err != nil {
		t.Fatalf("insert processed: %v", err)
	}
}

func insertProcessingReadModelForTest(t *testing.T, database *mongo.Database, metaID, orgID string, now time.Time) {
	t.Helper()
	_, err := database.Collection(itemReadModelsCollection).InsertOne(context.Background(), bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "itemMetaId", Value: metaID},
		{Key: "status", Value: "processing"},
		{Key: "processed", Value: bson.D{{Key: "status", Value: "processing"}}},
		{Key: "updatedAt", Value: now},
	})
	if err != nil {
		t.Fatalf("insert read model: %v", err)
	}
}

func countOutboxForTest(t *testing.T, db *sql.DB, id string) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM MongoOutbox WHERE id = ?", id).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func countAllOutboxForTest(t *testing.T, db *sql.DB) int {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM MongoOutbox").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

type outboxRowForTest struct {
	Status      string
	Attempts    int
	LastError   string
	AvailableAt time.Time
	LockedAt    sql.NullTime
}

func loadOutboxForTest(t *testing.T, db *sql.DB, id string) outboxRowForTest {
	t.Helper()
	var row outboxRowForTest
	var lastError sql.NullString
	if err := db.QueryRow("SELECT status,attempts,lastError,availableAt,lockedAt FROM MongoOutbox WHERE id = ?", id).
		Scan(&row.Status, &row.Attempts, &lastError, &row.AvailableAt, &row.LockedAt); err != nil {
		t.Fatal(err)
	}
	row.LastError = lastError.String
	return row
}

func loadMetaForTest(t *testing.T, db *sql.DB, id string) itemsreadingMetaForTest {
	t.Helper()
	var row itemsreadingMetaForTest
	var publishedAt sql.NullTime
	if err := db.QueryRow("SELECT status,name,publishedAt,sortAt FROM ItemMeta WHERE id = ?", id).
		Scan(&row.Status, &row.Name, &publishedAt, &row.SortAt); err != nil {
		t.Fatal(err)
	}
	if publishedAt.Valid {
		row.PublishedAt = &publishedAt.Time
	}
	return row
}

type itemsreadingMetaForTest struct {
	Status      string
	Name        string
	PublishedAt *time.Time
	SortAt      time.Time
}

func loadProcessedForTest(t *testing.T, database *mongo.Database, id string) processedDocForTest {
	t.Helper()
	objectID, err := bson.ObjectIDFromHex(id)
	if err != nil {
		t.Fatal(err)
	}
	var row processedDocForTest
	if err := database.Collection(processedItemsCollection).FindOne(context.Background(), bson.D{{Key: "_id", Value: objectID}}).Decode(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

type processedDocForTest struct {
	ItemMetaID                 string                 `bson:"itemMetaId"`
	Status                     string                 `bson:"status"`
	SourceID                   *string                `bson:"sourceId"`
	SummaryEmbeddingDimensions *int                   `bson:"summaryEmbeddingDimensions"`
	Result                     processedResultForTest `bson:"result"`
	Error                      *processedErrorForTest `bson:"error"`
}

type processedResultForTest struct {
	Location *string `bson:"location"`
}

type processedErrorForTest struct {
	Message string  `bson:"message"`
	Name    *string `bson:"name"`
}

func processedHasLocation(result processedResultForTest) bool {
	return result.Location != nil && strings.TrimSpace(*result.Location) != ""
}

func loadReadModelForTest(t *testing.T, database *mongo.Database, orgID, metaID string) readModelForTest {
	t.Helper()
	var row readModelForTest
	if err := database.Collection(itemReadModelsCollection).FindOne(context.Background(), bson.D{{Key: "orgId", Value: orgID}, {Key: "itemMetaId", Value: metaID}}).Decode(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

type readModelForTest struct {
	Status    string                  `bson:"status"`
	Title     string                  `bson:"title"`
	SourceID  *string                 `bson:"sourceId"`
	HasVector bool                    `bson:"hasVector"`
	Processed *readModelProcessedTest `bson:"processed"`
}

type readModelProcessedTest struct {
	Status string                 `bson:"status"`
	Error  *processedErrorForTest `bson:"error"`
}

type fakeVectorConfig struct {
	config vectorclient.Config
}

func (f fakeVectorConfig) EffectiveVectorConfig(context.Context) (vectorclient.Config, error) {
	return f.config, nil
}

type recordingVector struct {
	mu       sync.Mutex
	requests []vectorclient.UpsertRequest
	err      error
}

func (r *recordingVector) Upsert(_ context.Context, _ vectorclient.Config, request vectorclient.UpsertRequest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.requests = append(r.requests, request)
	return nil
}

func (r *recordingVector) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.requests = nil
	r.err = nil
}

func (r *recordingVector) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.err = err
}

func (r *recordingVector) requestsSnapshot() []vectorclient.UpsertRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]vectorclient.UpsertRequest, len(r.requests))
	copy(out, r.requests)
	return out
}

func errorsNew(message string) error {
	return fmt.Errorf("%s", message)
}
