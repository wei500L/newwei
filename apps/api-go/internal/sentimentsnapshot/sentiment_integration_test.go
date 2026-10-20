//go:build integration

// Sentiment snapshot integration tests against the real MySQL and Mongo CI
// services. Environment (injected by .github/workflows/ci.yml):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
package sentimentsnapshot

import (
	"context"
	"database/sql"
	"io"
	"log"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

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
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func openIntegrationMongo(t *testing.T) *dashboardstats.Connection {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI not set — integration test requires a Mongo service")
	}
	connection, err := dashboardstats.Open(uri)
	if err != nil {
		t.Fatalf("open mongo: %v", err)
	}
	t.Cleanup(func() { _ = connection.Disconnect(context.Background()) })
	return connection
}

func createSentimentTables(t *testing.T, db *sql.DB) {
	t.Helper()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `EntitySentimentSnapshot` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `entityName` VARCHAR(191) NOT NULL," +
			"`entityType` VARCHAR(191) NOT NULL DEFAULT '', `bucketStart` DATETIME(3) NOT NULL," +
			"`totalDocs` INT NOT NULL, `negativeDocs` INT NOT NULL, `positiveDocs` INT NOT NULL," +
			"`neutralDocs` INT NOT NULL, `scoreSum` INT NOT NULL, `avgScore` DOUBLE NOT NULL," +
			"`negativeRatio` DOUBLE NOT NULL, `evidenceProcessedItemIds` JSON NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `EntitySentimentSnapshot_org_entity_type_bucket_uq`(`orgId`,`entityName`,`entityType`,`bucketStart`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `TopicSentimentSnapshot` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `topic` VARCHAR(191) NOT NULL," +
			"`bucketStart` DATETIME(3) NOT NULL, `totalDocs` INT NOT NULL, `negativeDocs` INT NOT NULL," +
			"`positiveDocs` INT NOT NULL, `neutralDocs` INT NOT NULL, `scoreSum` INT NOT NULL," +
			"`avgScore` DOUBLE NOT NULL, `negativeRatio` DOUBLE NOT NULL, `evidenceProcessedItemIds` JSON NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `TopicSentimentSnapshot_orgId_topic_bucketStart_key`(`orgId`,`topic`,`bucketStart`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

func cleanupSentimentOrg(t *testing.T, db *sql.DB, orgID string) {
	t.Helper()
	for _, statement := range []string{
		"DELETE FROM `EntitySentimentSnapshot` WHERE `orgId` = ?",
		"DELETE FROM `TopicSentimentSnapshot` WHERE `orgId` = ?",
		"DELETE FROM `Org` WHERE `id` = ?",
	} {
		if _, err := db.Exec(statement, orgID); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
}

func seedSentimentOrg(t *testing.T, db *sql.DB, orgID string) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO `Org` (`id`,`name`,`slug`,`isActive`,`updatedAt`) VALUES (?,?,?,?,NOW(3))",
		orgID, orgID, orgID, true); err != nil {
		t.Fatalf("insert org: %v", err)
	}
}

// seedProcessedItem inserts one completed ProcessedItem document.
type seedProcessedItem struct {
	createdAt time.Time
	label     string
	entities  []bson.D
	topics    []string
}

func seedProcessedItem(t *testing.T, collection *mongo.Collection, orgID string, document seedProcessedItem) {
	t.Helper()
	entities := bson.A{}
	for _, entity := range document.entities {
		entities = append(entities, entity)
	}
	topics := bson.A{}
	for _, topic := range document.topics {
		topics = append(topics, topic)
	}
	_, err := collection.InsertOne(context.Background(), bson.D{
		{Key: "orgId", Value: orgID},
		{Key: "status", Value: "completed"},
		{Key: "createdAt", Value: document.createdAt},
		{Key: "result", Value: bson.D{
			{Key: "sentiment_label", Value: document.label},
			{Key: "entities", Value: entities},
			{Key: "topics", Value: topics},
		}},
	})
	if err != nil {
		t.Fatalf("insert processed item: %v", err)
	}
}

func entity(name, entityType string, confidence float64) bson.D {
	return bson.D{
		{Key: "name", Value: name},
		{Key: "type", Value: entityType},
		{Key: "confidence", Value: confidence},
	}
}

// staticOrgReader and staticConcurrencyReader are the two scheduler ports the
// rebuild reads before it fans out.
type staticOrgReader struct{ orgIDs []string }

func (r staticOrgReader) ListActiveOrgIDs(context.Context) ([]string, error) { return r.orgIDs, nil }

type staticConcurrencyReader struct{ value int }

func (r staticConcurrencyReader) ReadSentimentSnapshotOrgConcurrency(context.Context) (int, error) {
	return r.value, nil
}

// TestSentimentSnapshotRebuildIntegration rebuilds both days and asserts the
// rewritten rows.
func TestSentimentSnapshotRebuildIntegration(t *testing.T) {
	db := openIntegrationDB(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDB := mongoConnection.Database()
	createSentimentTables(t, db)

	orgID := "org-sentiment-integration"
	cleanupSentimentOrg(t, db, orgID)
	t.Cleanup(func() { cleanupSentimentOrg(t, db, orgID) })
	seedSentimentOrg(t, db, orgID)
	collection := mongoDB.Collection(processedItemsName)
	t.Cleanup(func() {
		_, _ = collection.DeleteMany(context.Background(), bson.D{{Key: "orgId", Value: orgID}})
	})

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	yesterdayStart := todayStart.Add(-24 * time.Hour)
	for _, document := range []seedProcessedItem{
		{
			createdAt: todayStart.Add(time.Hour),
			label:     "Positive",
			entities:  []bson.D{entity("Apple", "Company", 0.9), entity("LowConfidence", "Company", 0.2)},
			topics:    []string{"markets"},
		},
		{
			createdAt: todayStart.Add(2 * time.Hour),
			label:     "negative",
			entities:  []bson.D{entity("Apple", "Company", 0.8)},
			topics:    []string{"markets"},
		},
		{
			createdAt: yesterdayStart.Add(time.Hour),
			label:     "neutral",
			entities:  []bson.D{entity("Oracle", "Company", 0.7)},
			topics:    []string{"cloud"},
		},
	} {
		seedProcessedItem(t, collection, orgID, document)
	}

	timelineStore := newStore(storeOptions{DB: db, Mongo: mongoDB, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       timelineStore,
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Logger:      log.New(io.Discard, "", 0),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.rebuildOrg(context.Background(), orgID); err != nil {
		t.Fatalf("rebuildOrg: %v", err)
	}

	entities := readEntitySnapshots(t, db, orgID, todayStart)
	if len(entities) != 1 {
		t.Fatalf("today entity rows = %d, want 1 (the low-confidence mention is filtered)", len(entities))
	}
	// totalDocs 2, both positive.
	apple := entities[0]
	if apple.name != "Apple" || apple.entityType != "company" {
		t.Fatalf("first entity = %q/%q, want Apple/company", apple.name, apple.entityType)
	}
	if apple.totalDocs != 2 || apple.positiveDocs != 2 || apple.negativeDocs != 0 || apple.scoreSum != 2 {
		t.Errorf("Apple counters = %+v", apple)
	}
	if math.Abs(apple.avgScore-1) > 1e-12 || apple.negativeRatio != 0 {
		t.Errorf("Apple averages = %v/%v, want 1/0", apple.avgScore, apple.negativeRatio)
	}

	topics := readTopicSnapshots(t, db, orgID, todayStart)
	if len(topics) != 1 || topics[0].topic != "markets" || topics[0].totalDocs != 2 {
		t.Fatalf("today topic rows = %+v", topics)
	}

	yesterdayEntities := readEntitySnapshots(t, db, orgID, yesterdayStart)
	if len(yesterdayEntities) != 1 || yesterdayEntities[0].name != "Oracle" {
		t.Fatalf("yesterday entity rows = %+v", yesterdayEntities)
	}

	// A second run rewrites the day instead of accumulating.
	if err := scheduler.rebuildOrg(context.Background(), orgID); err != nil {
		t.Fatalf("second rebuildOrg: %v", err)
	}
	if again := readEntitySnapshots(t, db, orgID, todayStart); len(again) != 1 || again[0].totalDocs != 2 {
		t.Fatalf("after the second run: %+v", again)
	}
}

// TestSentimentSnapshotCollationMerge pins B2: names that are distinct in Mongo
// but equal under utf8mb4_unicode_ci merge into one row with accumulated
// counters and a DOUBLE division.
func TestSentimentSnapshotCollationMerge(t *testing.T) {
	db := openIntegrationDB(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDB := mongoConnection.Database()
	createSentimentTables(t, db)

	orgID := "org-sentiment-collation"
	cleanupSentimentOrg(t, db, orgID)
	t.Cleanup(func() { cleanupSentimentOrg(t, db, orgID) })
	seedSentimentOrg(t, db, orgID)
	collection := mongoDB.Collection(processedItemsName)
	t.Cleanup(func() {
		_, _ = collection.DeleteMany(context.Background(), bson.D{{Key: "orgId", Value: orgID}})
	})

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	base := todayStart.Add(time.Hour)
	// "Apple" (2 positive), "apple" (1 negative) and "Apple " (1 neutral) collapse
	// into one unique-index row: totalDocs 4, scoreSum 1.
	documents := []seedProcessedItem{
		{createdAt: base, label: "positive", entities: []bson.D{entity("Apple", "Company", 0.9)}, topics: []string{"AI"}},
		{createdAt: base.Add(time.Minute), label: "positive", entities: []bson.D{entity("Apple", "Company", 0.9)}, topics: []string{"AI"}},
		{createdAt: base.Add(2 * time.Minute), label: "negative", entities: []bson.D{entity("apple", "company", 0.9)}, topics: []string{"ai"}},
		{createdAt: base.Add(3 * time.Minute), label: "neutral", entities: []bson.D{entity("Apple ", "Company", 0.9)}, topics: []string{"AI "}},
		// "Gamma" (2 positive) and "gamma" (1 neutral) merge to totalDocs 3 and
		// scoreSum 2, so avgScore is 2/3 and a DECIMAL division would truncate it.
		{createdAt: base.Add(4 * time.Minute), label: "positive", entities: []bson.D{entity("Gamma", "Org", 0.9)}, topics: []string{"finance"}},
		{createdAt: base.Add(5 * time.Minute), label: "positive", entities: []bson.D{entity("Gamma", "Org", 0.9)}, topics: []string{"finance"}},
		{createdAt: base.Add(6 * time.Minute), label: "neutral", entities: []bson.D{entity("gamma", "org", 0.9)}, topics: []string{"finance"}},
	}
	for _, document := range documents {
		seedProcessedItem(t, collection, orgID, document)
	}

	timelineStore := newStore(storeOptions{DB: db, Mongo: mongoDB, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       timelineStore,
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Logger:      log.New(io.Discard, "", 0),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.rebuildOrg(context.Background(), orgID); err != nil {
		t.Fatalf("rebuildOrg: %v", err)
	}

	entities := readEntitySnapshots(t, db, orgID, todayStart)
	if len(entities) != 2 {
		t.Fatalf("entity rows = %d, want 2 merged rows: %+v", len(entities), entities)
	}
	var apple, gamma entitySnapshot
	for _, row := range entities {
		switch row.name {
		case "Apple":
			apple = row
		case "Gamma":
			gamma = row
		default:
			t.Fatalf("unexpected retained name %q; the first written (highest document count) spelling must win", row.name)
		}
	}
	if apple.totalDocs != 4 || apple.positiveDocs != 2 || apple.negativeDocs != 1 || apple.neutralDocs != 1 || apple.scoreSum != 1 {
		t.Fatalf("Apple merged counters = %+v", apple)
	}
	if math.Abs(apple.avgScore-0.25) > 1e-12 {
		t.Errorf("Apple avgScore = %v, want 0.25", apple.avgScore)
	}
	if math.Abs(apple.negativeRatio-0.25) > 1e-12 {
		t.Errorf("Apple negativeRatio = %v, want 0.25", apple.negativeRatio)
	}

	if gamma.totalDocs != 3 || gamma.scoreSum != 2 {
		t.Fatalf("Gamma merged counters = %+v", gamma)
	}
	wantAverage := 2.0 / 3.0
	if math.Abs(gamma.avgScore-wantAverage) > 1e-12 {
		t.Errorf("Gamma avgScore = %v, want %v (a DECIMAL division would give 0.6667)", gamma.avgScore, wantAverage)
	}

	topics := readTopicSnapshots(t, db, orgID, todayStart)
	if len(topics) != 2 {
		t.Fatalf("topic rows = %d, want 2 merged rows: %+v", len(topics), topics)
	}
	for _, row := range topics {
		if row.topic == "AI" {
			if row.totalDocs != 3 || row.positiveDocs != 2 || row.negativeDocs != 1 {
				t.Errorf("AI merged counters = %+v", row)
			}
			if math.Abs(row.avgScore-1.0/3.0) > 1e-12 {
				t.Errorf("AI avgScore = %v, want %v", row.avgScore, 1.0/3.0)
			}
		}
	}
}

// TestSentimentSnapshotTransactionRollback pins the "old data survives a failed
// rebuild" property.
func TestSentimentSnapshotTransactionRollback(t *testing.T) {
	db := openIntegrationDB(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDB := mongoConnection.Database()
	createSentimentTables(t, db)

	orgID := "org-sentiment-rollback"
	cleanupSentimentOrg(t, db, orgID)
	t.Cleanup(func() { cleanupSentimentOrg(t, db, orgID) })
	seedSentimentOrg(t, db, orgID)
	collection := mongoDB.Collection(processedItemsName)
	t.Cleanup(func() {
		_, _ = collection.DeleteMany(context.Background(), bson.D{{Key: "orgId", Value: orgID}})
	})

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	if _, err := db.Exec("INSERT INTO `EntitySentimentSnapshot` "+
		"(`id`,`orgId`,`entityName`,`entityType`,`bucketStart`,`totalDocs`,`negativeDocs`,`positiveDocs`,"+
		"`neutralDocs`,`scoreSum`,`avgScore`,`negativeRatio`,`updatedAt`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))",
		"old-row", orgID, "Legacy", "company", todayStart, 9, 0, 9, 0, 9, 1, 0); err != nil {
		t.Fatalf("seed old snapshot: %v", err)
	}
	seedProcessedItem(t, collection, orgID, seedProcessedItem{
		createdAt: todayStart.Add(time.Hour),
		label:     "positive",
		entities:  []bson.D{entity("Fresh", "Company", 0.9)},
		topics:    []string{"markets"},
	})

	// Drop one of the two tables so the delete inside the transaction fails after
	// the first delete already ran.
	if _, err := db.Exec("DROP TABLE `TopicSentimentSnapshot`"); err != nil {
		t.Fatalf("drop topic table: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec("CREATE TABLE IF NOT EXISTS `TopicSentimentSnapshot` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `topic` VARCHAR(191) NOT NULL," +
			"`bucketStart` DATETIME(3) NOT NULL, `totalDocs` INT NOT NULL, `negativeDocs` INT NOT NULL," +
			"`positiveDocs` INT NOT NULL, `neutralDocs` INT NOT NULL, `scoreSum` INT NOT NULL," +
			"`avgScore` DOUBLE NOT NULL, `negativeRatio` DOUBLE NOT NULL, `evidenceProcessedItemIds` JSON NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `TopicSentimentSnapshot_orgId_topic_bucketStart_key`(`orgId`,`topic`,`bucketStart`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	})

	timelineStore := newStore(storeOptions{DB: db, Mongo: mongoDB, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       timelineStore,
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Logger:      log.New(io.Discard, "", 0),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.rebuildOrg(context.Background(), orgID); err == nil {
		t.Fatal("rebuildOrg succeeded with a missing table, want a transaction failure")
	}
	rows := readEntitySnapshots(t, db, orgID, todayStart)
	if len(rows) != 1 || rows[0].name != "Legacy" || rows[0].totalDocs != 9 {
		t.Fatalf("after the failed run: %+v, want the pre-existing row untouched", rows)
	}
}

// TestSentimentSchedulerKeys pins the shared tick gate and organization lease
// names.
//
// The lease name is proven by pre-seeding the physical "lock:" key: while another
// owner holds it the rebuild must not run, and once it is released the same tick
// writes the rows.
func TestSentimentSchedulerKeys(t *testing.T) {
	db := openIntegrationDB(t)
	redisClient := openIntegrationRedis(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDB := mongoConnection.Database()
	createSentimentTables(t, db)

	orgID := "org-sentiment-scheduler"
	cleanupSentimentOrg(t, db, orgID)
	t.Cleanup(func() { cleanupSentimentOrg(t, db, orgID) })
	seedSentimentOrg(t, db, orgID)
	collection := mongoDB.Collection(processedItemsName)
	t.Cleanup(func() {
		_, _ = collection.DeleteMany(context.Background(), bson.D{{Key: "orgId", Value: orgID}})
	})

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	seedProcessedItem(t, collection, orgID, seedProcessedItem{
		createdAt: todayStart.Add(time.Hour),
		label:     "positive",
		entities:  []bson.D{entity("Scheduler", "Company", 0.9)},
		topics:    []string{"markets"},
	})

	ctx := context.Background()
	lockKey := "lock:" + snapshotOrgLockFmt + orgID
	_ = redisClient.Del(ctx, snapshotTickGateKey, lockKey).Err()
	t.Cleanup(func() { _ = redisClient.Del(ctx, snapshotTickGateKey, lockKey).Err() })

	store := newStore(storeOptions{DB: db, Mongo: mongoDB, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       store,
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Redis:       redisClient,
		Logger:      log.New(io.Discard, "", 0),
		Now:         func() time.Time { return now },
	})

	// Another owner holds the lease: the tick still claims the gate but must not
	// rebuild.
	if err := redisClient.Set(ctx, lockKey, "other-owner", time.Minute).Err(); err != nil {
		t.Fatalf("seed lease: %v", err)
	}
	if err := scheduler.runOnce(ctx); err != nil {
		t.Fatalf("runOnce under a held lease: %v", err)
	}
	if rows := readEntitySnapshots(t, db, orgID, todayStart); len(rows) != 0 {
		t.Fatalf("rows written while another owner held the lease: %+v", rows)
	}
	payload, err := redisClient.Get(ctx, snapshotTickGateKey).Result()
	if err != nil {
		t.Fatalf("tick gate missing: %v", err)
	}
	if !strings.Contains(payload, `"claimedAt":"`) {
		t.Errorf("tick gate payload = %s, want {claimedAt}", payload)
	}
	ttl, err := redisClient.TTL(ctx, snapshotTickGateKey).Result()
	if err != nil {
		t.Fatalf("tick gate TTL: %v", err)
	}
	if ttl > tickGateTTL || ttl <= tickGateTTL-time.Minute {
		t.Errorf("tick gate TTL = %v, want about %v", ttl, tickGateTTL)
	}

	// Release the lease and the gate: the same code path now writes the day.
	if err := redisClient.Del(ctx, lockKey, snapshotTickGateKey).Err(); err != nil {
		t.Fatalf("release keys: %v", err)
	}
	if err := scheduler.runOnce(ctx); err != nil {
		t.Fatalf("runOnce after the release: %v", err)
	}
	if rows := readEntitySnapshots(t, db, orgID, todayStart); len(rows) != 1 {
		t.Fatalf("rows after the release = %+v, want 1", rows)
	}
}

type entitySnapshot struct {
	name          string
	entityType    string
	totalDocs     int
	negativeDocs  int
	positiveDocs  int
	neutralDocs   int
	scoreSum      int
	avgScore      float64
	negativeRatio float64
}

func readEntitySnapshots(t *testing.T, db *sql.DB, orgID string, bucketStart time.Time) []entitySnapshot {
	t.Helper()
	rows, err := db.Query("SELECT `entityName`,`entityType`,`totalDocs`,`negativeDocs`,`positiveDocs`,"+
		"`neutralDocs`,`scoreSum`,`avgScore`,`negativeRatio` FROM `EntitySentimentSnapshot` "+
		"WHERE `orgId` = ? AND `bucketStart` = ? ORDER BY `totalDocs` DESC, `entityName` ASC", orgID, bucketStart)
	if err != nil {
		t.Fatalf("select entity snapshots: %v", err)
	}
	defer rows.Close()
	out := make([]entitySnapshot, 0, 4)
	for rows.Next() {
		var row entitySnapshot
		if err := rows.Scan(&row.name, &row.entityType, &row.totalDocs, &row.negativeDocs,
			&row.positiveDocs, &row.neutralDocs, &row.scoreSum, &row.avgScore, &row.negativeRatio); err != nil {
			t.Fatalf("scan entity snapshot: %v", err)
		}
		out = append(out, row)
	}
	return out
}

type topicSnapshot struct {
	topic         string
	totalDocs     int
	negativeDocs  int
	positiveDocs  int
	neutralDocs   int
	scoreSum      int
	avgScore      float64
	negativeRatio float64
}

func readTopicSnapshots(t *testing.T, db *sql.DB, orgID string, bucketStart time.Time) []topicSnapshot {
	t.Helper()
	rows, err := db.Query("SELECT `topic`,`totalDocs`,`negativeDocs`,`positiveDocs`,`neutralDocs`,"+
		"`scoreSum`,`avgScore`,`negativeRatio` FROM `TopicSentimentSnapshot` "+
		"WHERE `orgId` = ? AND `bucketStart` = ? ORDER BY `totalDocs` DESC, `topic` ASC", orgID, bucketStart)
	if err != nil {
		t.Fatalf("select topic snapshots: %v", err)
	}
	defer rows.Close()
	out := make([]topicSnapshot, 0, 4)
	for rows.Next() {
		var row topicSnapshot
		if err := rows.Scan(&row.topic, &row.totalDocs, &row.negativeDocs, &row.positiveDocs,
			&row.neutralDocs, &row.scoreSum, &row.avgScore, &row.negativeRatio); err != nil {
			t.Fatalf("scan topic snapshot: %v", err)
		}
		out = append(out, row)
	}
	return out
}
