//go:build integration

package pipelinerecovery

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsingest"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

type writeFixture struct {
	db     *sql.DB
	mongo  *mongo.Database
	redis  *redis.Client
	svc    *Service
	ctx    context.Context
	orgID  string
	itemID string
}

func openFixture(t *testing.T) *writeFixture {
	t.Helper()
	ctx := context.Background()

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
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		t.Fatalf("ping mysql: %v", err)
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS ItemMeta (
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
		updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
		UNIQUE KEY ItemMeta_org_externalId (orgId, externalId)
	) ENGINE=InnoDB`); err != nil {
		t.Fatalf("create ItemMeta: %v", err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM ItemMeta WHERE orgId = ?", "org-1"); err != nil {
		t.Fatalf("clear ItemMeta: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	mongoURI := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if mongoURI == "" {
		t.Skip("MONGO_URI is not set")
	}
	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	if err := mongoClient.Ping(pingCtx, nil); err != nil {
		t.Fatalf("ping mongo: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = mongoClient.Disconnect(cleanupCtx)
	})
	databaseName := "app"
	if parsedMongo, err := url.Parse(mongoURI); err == nil {
		if name := strings.TrimPrefix(parsedMongo.Path, "/"); name != "" {
			databaseName = name
		}
	}
	database := mongoClient.Database(databaseName)
	for _, collection := range []string{rawItemsCollection, processedItemsCollection} {
		if err := database.Collection(collection).Drop(ctx); err != nil {
			var commandError mongo.CommandError
			if !errors.As(err, &commandError) || commandError.Code != 26 {
				t.Fatalf("drop %s: %v", collection, err)
			}
		}
	}

	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	redisClient := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	if err := redisClient.Ping(pingCtx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	if err := redisClient.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	t.Cleanup(func() { _ = redisClient.Close() })

	producer := pipelineenqueue.New(pipelineenqueue.Options{Redis: redisClient, Mongo: database})
	return &writeFixture{
		db:     db,
		mongo:  database,
		redis:  redisClient,
		svc:    NewServiceWithProducer(db, database, producer),
		ctx:    ctx,
		orgID:  "org-1",
		itemID: "item-1",
	}
}

func (f *writeFixture) insertItemMeta(t *testing.T, id, orgID, status, mongoRef string) {
	t.Helper()
	if _, err := f.db.ExecContext(f.ctx,
		"INSERT INTO ItemMeta (id, orgId, externalId, name, status, mongoRef) VALUES (?, ?, ?, ?, ?, ?)",
		id, orgID, id+"-external", id, status, mongoRef); err != nil {
		t.Fatalf("insert ItemMeta %s: %v", id, err)
	}
}

func (f *writeFixture) insertRawItem(t *testing.T, id bson.ObjectID, itemMetaID, rawURL string) {
	t.Helper()
	payload := bson.D{
		{Key: "url", Value: rawURL},
		{Key: "keywords", Value: bson.A{}},
		{Key: "tags", Value: bson.A{}},
		{Key: "summaryHints", Value: bson.A{}},
		{Key: "metadata", Value: bson.D{}},
		{Key: "forceRefresh", Value: false},
	}
	full, fullHash, base, ok := itemsingest.ComparableURLVariants(rawURL)
	var fullValue, hashValue, baseValue any
	if ok {
		fullValue, hashValue, baseValue = full, fullHash, base
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := f.mongo.Collection(rawItemsCollection).InsertOne(f.ctx, bson.D{
		{Key: "_id", Value: id},
		{Key: "itemMetaId", Value: itemMetaID},
		{Key: "payload", Value: payload},
		{Key: "source", Value: "manual"},
		{Key: "urlComparableFull", Value: fullValue},
		{Key: "urlComparableFullHash", Value: hashValue},
		{Key: "urlComparableBase", Value: baseValue},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
	}); err != nil {
		t.Fatalf("insert raw item: %v", err)
	}
}

func (f *writeFixture) itemMeta(t *testing.T, id string) (status, mongoRef string) {
	t.Helper()
	if err := f.db.QueryRowContext(f.ctx,
		"SELECT status, mongoRef FROM ItemMeta WHERE id = ?", id).Scan(&status, &mongoRef); err != nil {
		t.Fatalf("read ItemMeta %s: %v", id, err)
	}
	return status, mongoRef
}

func (f *writeFixture) waitContains(t *testing.T, jobID string) {
	t.Helper()
	waitFor(t, "itemPipeline wait entry", func() bool {
		values, err := f.redis.LRange(f.ctx, pipelineenqueue.QueuePrefixKey+"wait", 0, -1).Result()
		if err != nil {
			return false
		}
		for _, value := range values {
			if value == jobID {
				return true
			}
		}
		return false
	})
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func expectStatus(t *testing.T, err error, status int, message string) {
	t.Helper()
	gotStatus, gotMessage, ok := statusOf(err)
	if !ok || gotStatus != status || gotMessage != message {
		t.Fatalf("error = %v (%d %q), want %d %q", err, gotStatus, gotMessage, status, message)
	}
}

// TestPipelineRecoveryWritesIntegration covers the replay/rollback error order,
// the Mongo clone/upsert, the MySQL ItemMeta update, the BullMQ enqueue and the
// org-scoped isolation against real MySQL, Mongo and Redis.
func TestPipelineRecoveryWritesIntegration(t *testing.T) {
	fixture := openFixture(t)

	sourceRaw := bson.NewObjectID()
	fixture.insertItemMeta(t, fixture.itemID, fixture.orgID, "completed", sourceRaw.Hex())
	fixture.insertRawItem(t, sourceRaw, fixture.itemID, "https://example.com/a?x=1#frag")

	// 404: another organization cannot see the item.
	_, err := fixture.svc.Replay(fixture.ctx, "org-2", fixture.itemID, "")
	expectStatus(t, err, 404, "Item not found")

	// 400: duplicate items are rejected before any lookup.
	duplicateRaw := bson.NewObjectID()
	fixture.insertItemMeta(t, "item-dup", fixture.orgID, "duplicate", duplicateRaw.Hex())
	_, err = fixture.svc.Replay(fixture.ctx, fixture.orgID, "item-dup", "")
	expectStatus(t, err, 400, "Cannot replay duplicate item")
	_, err = fixture.svc.Rollback(fixture.ctx, fixture.orgID, "item-dup", "")
	expectStatus(t, err, 400, "Cannot rollback duplicate item")

	// 400: an invalid ObjectId string.
	_, err = fixture.svc.Replay(fixture.ctx, fixture.orgID, fixture.itemID, "not-an-object-id")
	expectStatus(t, err, 400, "Invalid rawItemId")

	// 404: a valid ObjectId without a RawItem.
	missingRaw := bson.NewObjectID()
	fixture.insertItemMeta(t, "item-missing", fixture.orgID, "completed", missingRaw.Hex())
	_, err = fixture.svc.Replay(fixture.ctx, fixture.orgID, "item-missing", "")
	expectStatus(t, err, 404, "Raw item not found")

	// 400: a RawItem that belongs to another item.
	foreignRaw := bson.NewObjectID()
	fixture.insertRawItem(t, foreignRaw, "item-other", "https://example.com/foreign")
	_, err = fixture.svc.Replay(fixture.ctx, fixture.orgID, fixture.itemID, foreignRaw.Hex())
	expectStatus(t, err, 400, "rawItemId does not belong to item")

	// Success: clone, ItemMeta update, enqueue and response.
	replay, err := fixture.svc.Replay(fixture.ctx, fixture.orgID, fixture.itemID, "")
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if replay.ItemMetaID != fixture.itemID || len(replay.RawItemID) != 24 {
		t.Fatalf("replay result = %+v", replay)
	}
	if replay.RawItemID == sourceRaw.Hex() {
		t.Fatal("replay must clone, not reuse, the source RawItem")
	}
	if want := fixture.itemID + "-" + replay.RawItemID; replay.QueueJobID != want {
		t.Fatalf("queueJobId = %q, want %q", replay.QueueJobID, want)
	}
	status, mongoRef := fixture.itemMeta(t, fixture.itemID)
	if status != "pending" || mongoRef != replay.RawItemID {
		t.Fatalf("ItemMeta after replay = %q/%q", status, mongoRef)
	}
	var cloned struct {
		ItemMetaID string        `bson:"itemMetaId"`
		Source     string        `bson:"source"`
		Payload    bson.RawValue `bson:"payload"`
		URLFull    string        `bson:"urlComparableFull"`
		URLBase    string        `bson:"urlComparableBase"`
		URLHash    string        `bson:"urlComparableFullHash"`
	}
	clonedOID, err := bson.ObjectIDFromHex(replay.RawItemID)
	if err != nil {
		t.Fatalf("clone id: %v", err)
	}
	if err := fixture.mongo.Collection(rawItemsCollection).FindOne(fixture.ctx,
		bson.D{{Key: "_id", Value: clonedOID}}).Decode(&cloned); err != nil {
		t.Fatalf("read clone: %v", err)
	}
	if cloned.ItemMetaID != fixture.itemID || cloned.Source != "replay" {
		t.Fatalf("cloned raw = %+v", cloned)
	}
	payload, ok := cloned.Payload.DocumentOK()
	if !ok {
		t.Fatal("cloned payload is not a document")
	}
	if got, _ := payload.Lookup("url").StringValueOK(); got != "https://example.com/a?x=1#frag" {
		t.Fatalf("cloned payload.url = %q", got)
	}
	if cloned.URLFull == "" || cloned.URLHash == "" || cloned.URLBase == "" {
		t.Fatalf("cloned URL comparables are empty: %+v", cloned)
	}
	fixture.waitContains(t, replay.QueueJobID)

	// Rollback: ItemMeta status only, a new ProcessedItem and an enqueue that
	// carries its id.
	rollbackItem := "item-rollback"
	rollbackRaw := bson.NewObjectID()
	rollbackURL := "https://example.com/b"
	fixture.insertItemMeta(t, rollbackItem, fixture.orgID, "completed", rollbackRaw.Hex())
	fixture.insertRawItem(t, rollbackRaw, rollbackItem, rollbackURL)

	rollback, err := fixture.svc.Rollback(fixture.ctx, fixture.orgID, rollbackItem, "")
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if rollback.RawItemID != rollbackRaw.Hex() || len(rollback.ProcessedItemID) != 24 {
		t.Fatalf("rollback result = %+v", rollback)
	}
	status, mongoRef = fixture.itemMeta(t, rollbackItem)
	if status != "pending" || mongoRef != rollbackRaw.Hex() {
		t.Fatalf("ItemMeta after rollback = %q/%q", status, mongoRef)
	}
	processedOID, err := bson.ObjectIDFromHex(rollback.ProcessedItemID)
	if err != nil {
		t.Fatalf("processed id: %v", err)
	}
	var processed struct {
		RawItemID  bson.ObjectID `bson:"rawItemId"`
		ItemMetaID string        `bson:"itemMetaId"`
		OrgID      string        `bson:"orgId"`
		Status     string        `bson:"status"`
		Tags       []string      `bson:"tags"`
		CreatedAt  time.Time     `bson:"createdAt"`
	}
	if err := fixture.mongo.Collection(processedItemsCollection).FindOne(fixture.ctx,
		bson.D{{Key: "_id", Value: processedOID}}).Decode(&processed); err != nil {
		t.Fatalf("read processed item: %v", err)
	}
	if processed.RawItemID != rollbackRaw || processed.ItemMetaID != rollbackItem ||
		processed.OrgID != fixture.orgID || processed.Status != "pending" ||
		len(processed.Tags) != 0 || processed.CreatedAt.IsZero() {
		t.Fatalf("processed item = %+v", processed)
	}
	if want := rollbackItem + "-" + rollbackRaw.Hex(); rollback.QueueJobID != want {
		t.Fatalf("rollback queueJobId = %q, want %q", rollback.QueueJobID, want)
	}
	fixture.waitContains(t, rollback.QueueJobID)

	// The enqueued job carries the new processed item id.
	hash, err := fixture.redis.HGetAll(fixture.ctx,
		pipelineenqueue.QueuePrefixKey+rollback.QueueJobID).Result()
	if err != nil {
		t.Fatalf("read rollback job: %v", err)
	}
	var jobData struct {
		RawItemID       string `json:"rawItemId"`
		ProcessedItemID string `json:"processedItemId"`
		OrgID           string `json:"orgId"`
	}
	if err := json.Unmarshal([]byte(hash["data"]), &jobData); err != nil {
		t.Fatalf("rollback job data: %v", err)
	}
	if jobData.RawItemID != rollbackRaw.Hex() || jobData.ProcessedItemID != rollback.ProcessedItemID ||
		jobData.OrgID != fixture.orgID {
		t.Fatalf("rollback job data = %+v", jobData)
	}
}
