//go:build integration

// Timeline rebuild integration tests against the real MySQL, Redis and Mongo CI
// services. Environment (injected by .github/workflows/ci.yml):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/app
//
// The tests create the minimum table set the rebuild touches (same column names,
// unique keys and JSON semantics as the Prisma schema) and clean up by a fixed
// organization prefix.
package newseventstimeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardstats"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/newsevents"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
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

func createTimelineTables(t *testing.T, db *sql.DB) {
	t.Helper()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false," +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`key`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `Article` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `url` VARCHAR(191) NOT NULL," +
			"`sourceId` VARCHAR(191) NOT NULL, `sourceLabel` VARCHAR(191) NULL, `crawlAt` DATETIME(3) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `ProcessedArticle` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `articleId` VARCHAR(191) NOT NULL," +
			"`status` VARCHAR(32) NOT NULL, `title` VARCHAR(191) NULL, `summary` TEXT NULL, `language` VARCHAR(32) NULL," +
			"`category` VARCHAR(191) NULL, `keyPoints` JSON NULL, `source` VARCHAR(191) NULL, `qualityScore` DOUBLE NULL," +
			"`publishedAt` DATETIME(3) NULL, `processedAt` DATETIME(3) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `ProcessedArticle_articleId_key`(`articleId`), PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `NewsEvent` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `status` VARCHAR(32) NOT NULL," +
			"`language` VARCHAR(32) NULL, `primaryTopic` VARCHAR(191) NULL, `primaryEntity` VARCHAR(191) NULL," +
			"`title` VARCHAR(191) NULL, `summary` TEXT NULL, `metadata` JSON NULL," +
			"`representativeProcessedArticleId` VARCHAR(191) NULL, `representativeProcessedItemId` VARCHAR(191) NULL," +
			"`startAt` DATETIME(3) NOT NULL, `lastAt` DATETIME(3) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `NewsEventItem` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `eventId` VARCHAR(191) NOT NULL," +
			"`processedArticleId` VARCHAR(191) NOT NULL, `processedItemId` VARCHAR(191) NULL, `similarity` DOUBLE NULL," +
			"`assignedBy` VARCHAR(32) NOT NULL DEFAULT 'overlap'," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `NewsEventItem_orgId_processedArticleId_key`(`orgId`,`processedArticleId`)," +
			"INDEX `NewsEventItem_orgId_eventId_createdAt_idx`(`orgId`,`eventId`,`createdAt`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `NewsEventTimelineEntry` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `eventId` VARCHAR(191) NOT NULL," +
			"`bucketStart` DATETIME(3) NOT NULL, `title` VARCHAR(191) NULL, `summary` TEXT NULL, `keyPoints` JSON NULL," +
			"`referencedArticleIds` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `NewsEventTimelineEntry_eventId_bucketStart_key`(`eventId`,`bucketStart`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

func cleanupTimelineOrg(t *testing.T, db *sql.DB, orgID string) {
	t.Helper()
	for _, statement := range []string{
		"DELETE FROM `NewsEventTimelineEntry` WHERE `orgId` = ?",
		"DELETE FROM `NewsEventItem` WHERE `orgId` = ?",
		"DELETE FROM `ProcessedArticle` WHERE `orgId` = ?",
		"DELETE FROM `Article` WHERE `orgId` = ?",
		"DELETE FROM `NewsEvent` WHERE `orgId` = ?",
		"DELETE FROM `SystemSetting` WHERE `key` = ?",
		"DELETE FROM `Org` WHERE `id` = ?",
	} {
		argument := orgID
		if strings.Contains(statement, "SystemSetting") {
			argument = "news_event_settings:" + orgID
		}
		if _, err := db.Exec(statement, argument); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
}

func seedTimelineOrg(t *testing.T, db *sql.DB, orgID string) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO `Org` (`id`,`name`,`slug`,`isActive`,`updatedAt`) VALUES (?,?,?,?,NOW(3))",
		orgID, orgID, orgID, true); err != nil {
		t.Fatalf("insert org: %v", err)
	}
	settings := `{"enabled":true,"ingestionEnabled":true,"timelineEnabled":true,"backfillDays":5,"lookbackDays":5}`
	if _, err := db.Exec("INSERT INTO `SystemSetting` (`key`,`value`,`isPublic`,`description`,`createdAt`,`updatedAt`) "+
		"VALUES (?,?,0,?,NOW(3),NOW(3))", "news_event_settings:"+orgID, settings, "test"); err != nil {
		t.Fatalf("insert settings: %v", err)
	}
}

// seedTimelineEvent inserts one active event plus the given processed articles.
type seedArticle struct {
	articleID   string
	title       string
	category    string
	publishedAt time.Time
	processedAt time.Time
	processedID string
}

func seedTimelineEvent(t *testing.T, db *sql.DB, orgID, eventID string, metadata string, now time.Time, articles []seedArticle) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO `NewsEvent` "+
		"(`id`,`orgId`,`status`,`title`,`summary`,`metadata`,`startAt`,`lastAt`,`updatedAt`) "+
		"VALUES (?,?,'active',?,?,?,?,?,NOW(3))",
		eventID, orgID, "Event title", "Event summary", metadata, now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("insert event: %v", err)
	}
	for _, article := range articles {
		articlePK := "art-" + article.articleID
		if _, err := db.Exec("INSERT INTO `Article` "+
			"(`id`,`orgId`,`url`,`sourceId`,`sourceLabel`,`crawlAt`,`updatedAt`) VALUES (?,?,?,?,?,?,NOW(3))",
			articlePK, orgID, "https://example.test/"+article.articleID, "src-1", "Example", now.Add(-3*time.Hour)); err != nil {
			t.Fatalf("insert article: %v", err)
		}
		if _, err := db.Exec("INSERT INTO `ProcessedArticle` "+
			"(`id`,`orgId`,`articleId`,`status`,`title`,`summary`,`category`,`keyPoints`,`qualityScore`,"+
			"`publishedAt`,`processedAt`,`updatedAt`) VALUES (?,?,?,'completed',?,?,?,?,?,?,?,NOW(3))",
			article.processedID, orgID, article.articleID, article.title, "Summary "+article.title,
			article.category, `["point-a","point-b"]`, 0.5, article.publishedAt, article.processedAt); err != nil {
			t.Fatalf("insert processed article: %v", err)
		}
		if _, err := db.Exec("INSERT INTO `NewsEventItem` "+
			"(`id`,`orgId`,`eventId`,`processedArticleId`,`createdAt`) VALUES (?,?,?,?,?)",
			"nei-"+article.articleID, orgID, eventID, article.processedID, now.Add(-time.Hour)); err != nil {
			t.Fatalf("insert event item: %v", err)
		}
	}
}

func integrationLogger() *log.Logger { return log.New(io.Discard, "", 0) }

type staticSettingsReader struct {
	settings settingscrawl.NewsEventSettingsModel
}

func (r staticSettingsReader) Read(context.Context, string) (settingscrawl.NewsEventSettingsModel, error) {
	return r.settings, nil
}

type staticOrgReader struct{ orgIDs []string }

func (r staticOrgReader) ListActiveOrgIDs(context.Context) ([]string, error) { return r.orgIDs, nil }

type staticConcurrencyReader struct{ value int }

func (r staticConcurrencyReader) ReadNewsEventsTimelineOrgConcurrency(context.Context) (int, error) {
	return r.value, nil
}

func timelineSettings() settingscrawl.NewsEventSettingsModel {
	return settingscrawl.NewsEventSettingsModel{
		Enabled:                              true,
		IngestionEnabled:                     true,
		TimelineEnabled:                      true,
		BackfillDays:                         5,
		LookbackDays:                         5,
		TimelineMaxEventsPerRun:              50,
		TimelineLowConfidenceThreshold:       0.5,
		TimelineHighConfidenceThreshold:      0.8,
		TimelineDriftKlThreshold:             0.35,
		TimelineMinBucketItemsForDrift:       3,
		TimelineCrossCategoryWarningShare:    0.3,
		TimelineMaxCategoryDistributionItems: 16,
		TimelineMaxPhaseSummaries:            8,
		MinCategoryConfidenceForGate:         0.4,
	}
}

// TestTimelineRebuildIntegration performs the end-to-end rebuild and reads the
// result back through the real GraphQL read root.
func TestTimelineRebuildIntegration(t *testing.T) {
	db := openIntegrationDB(t)
	redisClient := openIntegrationRedis(t)
	mongoConnection := openIntegrationMongo(t)
	mongoDB := mongoConnection.Database()
	createTimelineTables(t, db)

	orgID := "org-timeline-integration"
	eventID := "event-timeline-integration"
	cleanupTimelineOrg(t, db, orgID)
	t.Cleanup(func() { cleanupTimelineOrg(t, db, orgID) })
	seedTimelineOrg(t, db, orgID)

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	yesterdayStart := todayStart.Add(-24 * time.Hour)

	// Mongo classification context: the processed item overrides the
	// ProcessedArticle.category and contributes the category path and confidence.
	processedItemID := bson.NewObjectID()
	if _, err := mongoDB.Collection(processedItemsCollection).InsertOne(context.Background(), bson.D{
		{Key: "_id", Value: processedItemID},
		{Key: "result", Value: bson.D{
			{Key: "category", Value: "tech"},
			{Key: "category_path", Value: "Tech/AI"},
			{Key: "category_confidence", Value: 0.9},
		}},
	}); err != nil {
		t.Fatalf("insert processed item: %v", err)
	}
	t.Cleanup(func() {
		_, _ = mongoDB.Collection(processedItemsCollection).DeleteOne(context.Background(),
			bson.D{{Key: "_id", Value: processedItemID}})
	})

	seedTimelineEvent(t, db, orgID, eventID, `{"briefV1":{"tldr":"kept"}}`, now, []seedArticle{
		{
			articleID:   "a-yesterday",
			title:       "Yesterday title",
			category:    "finance",
			publishedAt: yesterdayStart.Add(12 * time.Hour),
			processedAt: now.Add(-time.Hour),
			processedID: "pa-yesterday",
		},
		{
			articleID:   "a-today",
			title:       "Today title",
			category:    "finance",
			publishedAt: todayStart.Add(12 * time.Hour),
			processedAt: now.Add(-time.Hour),
			processedID: "pa-today",
		},
	})
	// Attach the Mongo classification to the today item only, so the two buckets
	// differ in category path and confidence.
	if _, err := db.Exec("UPDATE `NewsEventItem` SET `processedItemId` = ? WHERE `orgId` = ? AND `id` = ?",
		processedItemID.Hex(), orgID, "nei-a-today"); err != nil {
		t.Fatalf("attach processed item: %v", err)
	}

	timelineStore := newStore(storeOptions{DB: db, Mongo: mongoDB, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       timelineStore,
		Settings:    staticSettingsReader{settings: timelineSettings()},
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 2},
		Redis:       redisClient,
		Logger:      log.New(io.Discard, "", 0),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.rebuildOrg(context.Background(), orgID); err != nil {
		t.Fatalf("rebuildOrg: %v", err)
	}

	// The rows exist with the expected bucket, summary and references.
	rows, err := db.Query("SELECT `bucketStart`,`title`,`summary`,`referencedArticleIds` "+
		"FROM `NewsEventTimelineEntry` WHERE `orgId` = ? ORDER BY `bucketStart` ASC", orgID)
	if err != nil {
		t.Fatalf("select entries: %v", err)
	}
	defer rows.Close()
	type entryRow struct {
		bucket     time.Time
		title      string
		summary    string
		references []byte
	}
	stored := make([]entryRow, 0, 2)
	for rows.Next() {
		var row entryRow
		var references []byte
		if err := rows.Scan(&row.bucket, &row.title, &row.summary, &references); err != nil {
			t.Fatalf("scan entry: %v", err)
		}
		row.references = references
		stored = append(stored, row)
	}
	if len(stored) != 2 {
		t.Fatalf("stored entries = %d, want 2", len(stored))
	}
	if !stored[0].bucket.Equal(yesterdayStart) || !stored[1].bucket.Equal(todayStart) {
		t.Fatalf("bucket starts = %v/%v, want %v/%v", stored[0].bucket, stored[1].bucket,
			yesterdayStart, todayStart)
	}
	if string(stored[0].references) != `["a-yesterday"]` {
		t.Errorf("yesterday references = %s", stored[0].references)
	}

	// The read root sees the buckets and the whole metadata.timeline payload.
	registry := contract.NewRegistry()
	newsevents.Register(registry, db, mongoDB, redisClient, newsevents.Options{})
	root, ok := registry.Query("newsEvent")
	if !ok {
		t.Fatal("newsEvent root is not registered")
	}
	result, err := root.Resolve(contract.Context{
		Ctx:      context.Background(),
		Identity: contract.Identity{UserID: "user-1", OrgID: orgID, Permissions: map[string]bool{"items.read": true}},
		Args:     map[string]any{"id": eventID},
	})
	if err != nil {
		t.Fatalf("newsEvent resolve: %v", err)
	}
	model, ok := result.(newsevents.NewsEventModel)
	if !ok {
		t.Fatalf("newsEvent result is %T", result)
	}
	if model.Timeline == nil || len(*model.Timeline) != 2 {
		t.Fatalf("read-back timeline = %v, want 2 entries", model.Timeline)
	}
	readBack := (*model.Timeline)[1]
	if readBack.CategoryPath == nil || *readBack.CategoryPath != "tech/ai" {
		t.Errorf("read-back categoryPath = %v, want tech/ai from the Mongo classification", readBack.CategoryPath)
	}
	if readBack.CategoryConfidence == nil || *readBack.CategoryConfidence != 0.9 {
		t.Errorf("read-back categoryConfidence = %v, want 0.9", readBack.CategoryConfidence)
	}
	if readBack.Tentative == nil || *readBack.Tentative || readBack.Anchor == nil || *readBack.Anchor {
		t.Errorf("read-back tentative/anchor = %v/%v, want false/false", readBack.Tentative, readBack.Anchor)
	}
	if references, ok := readBack.ReferencedArticleIDs.([]byte); !ok || string(references) != `["a-today"]` {
		t.Errorf("read-back references = %v", readBack.ReferencedArticleIDs)
	}
	if model.TopicDriftWarning == nil || *model.TopicDriftWarning {
		t.Errorf("read-back topicDriftWarning = %v, want false", model.TopicDriftWarning)
	}
	distribution, ok := model.CategoryDistribution.([]byte)
	if !ok || !strings.Contains(string(distribution), `"categoryPath":"tech/ai"`) {
		t.Errorf("read-back categoryDistribution = %v", model.CategoryDistribution)
	}
	phases, ok := model.TimelinePhases.([]byte)
	if !ok || !strings.Contains(string(phases), `"Technology release stage"`) {
		t.Errorf("read-back timelinePhases = %v", model.TimelinePhases)
	}
	subEvents, ok := model.SubEvents.([]byte)
	if !ok || !strings.Contains(string(subEvents), `"parentEventId":"`+eventID+`"`) {
		t.Errorf("read-back subEvents = %v", model.SubEvents)
	}

	// B1: the briefV1 leaf written before the run is still there.
	var metadata []byte
	if err := db.QueryRow("SELECT `metadata` FROM `NewsEvent` WHERE `id` = ? AND `orgId` = ?",
		eventID, orgID).Scan(&metadata); err != nil {
		t.Fatalf("select metadata: %v", err)
	}
	var document struct {
		Brief  json.RawMessage   `json:"briefV1"`
		Timing *timelineMetadata `json:"timeline"`
	}
	if err := json.Unmarshal(metadata, &document); err != nil {
		t.Fatalf("decode metadata: %v", err)
	}
	if !strings.Contains(string(document.Brief), `"tldr":"kept"`) {
		t.Errorf("briefV1 = %s, want the pre-existing leaf", document.Brief)
	}
	if document.Timing == nil || len(document.Timing.Entries) != 2 {
		t.Errorf("metadata.timeline entries = %v, want 2", document.Timing)
	}
}

// TestTimelineWritePreservesConcurrentBrief pins B1 at the write boundary: a
// briefV1 leaf written after the rebuild read the metadata must survive.
func TestTimelineWritePreservesConcurrentBrief(t *testing.T) {
	db := openIntegrationDB(t)
	createTimelineTables(t, db)
	orgID := "org-timeline-brief-race"
	eventID := "event-timeline-brief-race"
	cleanupTimelineOrg(t, db, orgID)
	t.Cleanup(func() { cleanupTimelineOrg(t, db, orgID) })
	seedTimelineOrg(t, db, orgID)

	now := time.Now().UTC()
	seedTimelineEvent(t, db, orgID, eventID, `{"briefV1":{"tldr":"stale"}}`, now, nil)
	store := newStore(storeOptions{DB: db, Now: func() time.Time { return now }})

	// The rebuild reads the event first.
	events, err := store.selectEvents(context.Background(), orgID, now.Add(-5*24*time.Hour), 10)
	if err != nil || len(events) != 1 {
		t.Fatalf("selectEvents = %d events, err %v", len(events), err)
	}
	// A concurrent brief writer replaces the leaf after that read.
	if _, err := db.Exec("UPDATE `NewsEvent` SET `metadata` = JSON_SET(`metadata`, '$.briefV1', CAST(? AS JSON)) "+
		"WHERE `id` = ? AND `orgId` = ?", `{"tldr":"fresh"}`, eventID, orgID); err != nil {
		t.Fatalf("concurrent brief write: %v", err)
	}
	timeline := timelineMetadata{
		Entries:              map[string]timelineEntryClassification{"2026-10-19T00:00:00.000Z": {ItemCount: 1}},
		CategoryDistribution: []categoryDistributionEntry{},
		DriftWarnings:        []topicDriftWarning{},
		PhaseSummaries:       []timelinePhaseSummary{},
		SubEvents:            []timelineSubEvent{},
		UpdatedAt:            formatISOMillis(now),
	}
	if err := store.writeEventTimeline(context.Background(), orgID, eventID, timeline, now); err != nil {
		t.Fatalf("writeEventTimeline: %v", err)
	}

	var metadata []byte
	if err := db.QueryRow("SELECT `metadata` FROM `NewsEvent` WHERE `id` = ? AND `orgId` = ?",
		eventID, orgID).Scan(&metadata); err != nil {
		t.Fatalf("select metadata: %v", err)
	}
	if !strings.Contains(string(metadata), `"tldr":"fresh"`) {
		t.Fatalf("metadata = %s, want the concurrent briefV1 to survive", metadata)
	}
	if !strings.Contains(string(metadata), `"timeline"`) {
		t.Fatalf("metadata = %s, want the timeline leaf", metadata)
	}
}

// TestTimelineWriteReplacesNonObjectMetadata pins the array/scalar result: the
// NestJS merge treats a non-object metadata column as an empty object, so the
// result is exactly {timeline}.
func TestTimelineWriteReplacesNonObjectMetadata(t *testing.T) {
	db := openIntegrationDB(t)
	createTimelineTables(t, db)
	orgID := "org-timeline-nonobject"
	eventID := "event-timeline-nonobject"
	cleanupTimelineOrg(t, db, orgID)
	t.Cleanup(func() { cleanupTimelineOrg(t, db, orgID) })
	seedTimelineOrg(t, db, orgID)

	now := time.Now().UTC()
	seedTimelineEvent(t, db, orgID, eventID, `[1,2,3]`, now, nil)
	store := newStore(storeOptions{DB: db, Now: func() time.Time { return now }})
	timeline := timelineMetadata{
		Entries:              map[string]timelineEntryClassification{},
		CategoryDistribution: []categoryDistributionEntry{},
		DriftWarnings:        []topicDriftWarning{},
		PhaseSummaries:       []timelinePhaseSummary{},
		SubEvents:            []timelineSubEvent{},
		UpdatedAt:            formatISOMillis(now),
	}
	if err := store.writeEventTimeline(context.Background(), orgID, eventID, timeline, now); err != nil {
		t.Fatalf("writeEventTimeline: %v", err)
	}
	var metadata []byte
	if err := db.QueryRow("SELECT `metadata` FROM `NewsEvent` WHERE `id` = ? AND `orgId` = ?",
		eventID, orgID).Scan(&metadata); err != nil {
		t.Fatalf("select metadata: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &document); err != nil {
		t.Fatalf("decode metadata: %v", err)
	}
	if len(document) != 1 {
		t.Fatalf("metadata keys = %v, want only timeline", document)
	}
	if _, ok := document["timeline"]; !ok {
		t.Fatalf("metadata = %s, want a timeline leaf", metadata)
	}
}

// TestTimelineRetentionPrunesOldBuckets pins the pruning of buckets that fell out
// of the retention window.
func TestTimelineRetentionPrunesOldBuckets(t *testing.T) {
	db := openIntegrationDB(t)
	createTimelineTables(t, db)
	orgID := "org-timeline-retention"
	eventID := "event-timeline-retention"
	cleanupTimelineOrg(t, db, orgID)
	t.Cleanup(func() { cleanupTimelineOrg(t, db, orgID) })
	seedTimelineOrg(t, db, orgID)

	now := time.Now().UTC()
	todayStart := toUTCDayStart(now)
	oldBucket := todayStart.Add(-30 * 24 * time.Hour)
	recentBucket := todayStart.Add(-24 * time.Hour)
	metadata := `{"timeline":{"entries":{"` + formatISOMillis(oldBucket) + `":{"categoryPath":"tech/ai","categoryConfidence":0.5,"tentative":false,"anchor":false,"importanceScore":0.5,"itemCount":1},"` +
		formatISOMillis(recentBucket) + `":{"categoryPath":"tech/ai","categoryConfidence":0.5,"tentative":false,"anchor":false,"importanceScore":0.5,"itemCount":1},"not-a-date":{"itemCount":7}}}}`
	seedTimelineEvent(t, db, orgID, eventID, metadata, now, []seedArticle{{
		articleID:   "a-retention",
		title:       "Retention title",
		category:    "tech",
		publishedAt: todayStart.Add(6 * time.Hour),
		processedAt: now.Add(-time.Hour),
		processedID: "pa-retention",
	}})

	store := newStore(storeOptions{DB: db, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       store,
		Settings:    staticSettingsReader{settings: timelineSettings()},
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Logger:      integrationLogger(),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.rebuildOrg(context.Background(), orgID); err != nil {
		t.Fatalf("rebuildOrg: %v", err)
	}

	var storedMetadata []byte
	if err := db.QueryRow("SELECT `metadata` FROM `NewsEvent` WHERE `id` = ? AND `orgId` = ?",
		eventID, orgID).Scan(&storedMetadata); err != nil {
		t.Fatalf("select metadata: %v", err)
	}
	var document struct {
		Timing *timelineMetadata `json:"timeline"`
	}
	if err := json.Unmarshal(storedMetadata, &document); err != nil {
		t.Fatalf("decode metadata: %v", err)
	}
	if document.Timing == nil {
		t.Fatalf("metadata = %s, want a timeline leaf", storedMetadata)
	}
	if _, kept := document.Timing.Entries[formatISOMillis(oldBucket)]; kept {
		t.Error("a bucket outside the retention window must be pruned")
	}
	if _, kept := document.Timing.Entries[formatISOMillis(recentBucket)]; !kept {
		t.Error("a bucket inside the retention window must be kept")
	}
	if _, kept := document.Timing.Entries["not-a-date"]; !kept {
		t.Error("an unparseable bucket key must be kept")
	}
	if _, kept := document.Timing.Entries[formatISOMillis(todayStart)]; !kept {
		t.Error("this run's bucket must be present")
	}
}

// TestTimelineSchedulerKeys pins the shared tick gate and organization lease
// names and the mutual exclusion they provide.
func TestTimelineSchedulerKeys(t *testing.T) {
	db := openIntegrationDB(t)
	redisClient := openIntegrationRedis(t)
	createTimelineTables(t, db)
	orgID := "org-timeline-scheduler"
	eventID := "event-timeline-scheduler"
	cleanupTimelineOrg(t, db, orgID)
	t.Cleanup(func() { cleanupTimelineOrg(t, db, orgID) })
	seedTimelineOrg(t, db, orgID)

	now := time.Now().UTC()
	seedTimelineEvent(t, db, orgID, eventID, `{}`, now, nil)
	ctx := context.Background()
	_ = redisClient.Del(ctx, tickGateKey, "lock:"+orgLockKeyPrefix+orgID).Err()
	t.Cleanup(func() { _ = redisClient.Del(ctx, tickGateKey, "lock:"+orgLockKeyPrefix+orgID).Err() })

	var leaseSeen int
	settings := &observingSettingsReader{
		settings: timelineSettings(),
		onRead: func() {
			exists, err := redisClient.Exists(ctx, "lock:"+orgLockKeyPrefix+orgID).Result()
			if err == nil && exists == 1 {
				leaseSeen = 1
			}
		},
	}
	store := newStore(storeOptions{DB: db, Now: func() time.Time { return now }})
	scheduler := newScheduler(schedulerOptions{
		Store:       store,
		Settings:    settings,
		Orgs:        staticOrgReader{orgIDs: []string{orgID}},
		Concurrency: staticConcurrencyReader{value: 1},
		Redis:       redisClient,
		Logger:      integrationLogger(),
		Now:         func() time.Time { return now },
	})
	if err := scheduler.runOnce(ctx); err != nil {
		t.Fatalf("runOnce: %v", err)
	}
	if leaseSeen != 1 {
		t.Error("the organization lease was not held while the rebuild ran")
	}
	payload, err := redisClient.Get(ctx, tickGateKey).Result()
	if err != nil {
		t.Fatalf("tick gate missing: %v", err)
	}
	if !strings.Contains(payload, `"claimedAt":"`) {
		t.Errorf("tick gate payload = %s, want {claimedAt}", payload)
	}
	ttl, err := redisClient.TTL(ctx, tickGateKey).Result()
	if err != nil {
		t.Fatalf("tick gate TTL: %v", err)
	}
	if ttl > rebuildTickGateTTL || ttl <= rebuildTickGateTTL-time.Minute {
		t.Errorf("tick gate TTL = %v, want about %v", ttl, rebuildTickGateTTL)
	}
	// A second tick in the same interval is claimed by the gate and skipped.
	if err := scheduler.runOnce(ctx); err != nil {
		t.Fatalf("second runOnce: %v", err)
	}
	if settings.reads != 1 {
		t.Errorf("second tick ran the rebuild: reads = %d, want 1", settings.reads)
	}
}

type observingSettingsReader struct {
	settings settingscrawl.NewsEventSettingsModel
	onRead   func()
	reads    int
}

func (r *observingSettingsReader) Read(context.Context, string) (settingscrawl.NewsEventSettingsModel, error) {
	r.reads++
	if r.onRead != nil {
		r.onRead()
	}
	return r.settings, nil
}
