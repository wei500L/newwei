//go:build integration

// Knowledge-graph ingestion integration tests against the real MySQL and Redis
// CI services. Environment (injected by .github/workflows/ci.yml):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/app
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// The tests create the minimum table set the ingestion touches (same column
// names, unique keys and JSON semantics as the Prisma schema) and clean up by
// fixed organization prefixes.
package kgingestion

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
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

func createKnowledgeGraphTables(t *testing.T, db *sql.DB) {
	t.Helper()
	ddl := []string{
		"CREATE TABLE IF NOT EXISTS `Org` (" +
			"`id` VARCHAR(191) NOT NULL, `name` VARCHAR(191) NOT NULL, `slug` VARCHAR(191) NOT NULL," +
			"`isActive` BOOLEAN NOT NULL DEFAULT true, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false," +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`key`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `ProcessedArticle` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `articleId` VARCHAR(191) NOT NULL," +
			"`status` VARCHAR(32) NOT NULL, `title` VARCHAR(191) NULL, `summary` TEXT NULL, `language` VARCHAR(32) NULL," +
			"`entities` JSON NULL, `kgRelations` JSON NULL, `llmPromptVersion` VARCHAR(191) NULL," +
			"`processedAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, UNIQUE INDEX `ProcessedArticle_articleId_key`(`articleId`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `KnowledgeEntity` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `type` VARCHAR(32) NOT NULL," +
			"`canonicalName` VARCHAR(191) NOT NULL, `normalizedKey` VARCHAR(191) NOT NULL, `properties` JSON NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `KnowledgeEntity_orgId_type_normalizedKey_key`(`orgId`, `type`, `normalizedKey`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `KnowledgeEntityAlias` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `entityId` VARCHAR(191) NOT NULL," +
			"`alias` VARCHAR(191) NOT NULL, `normalizedAlias` VARCHAR(191) NOT NULL, `source` VARCHAR(16) NOT NULL," +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `KnowledgeEntityAlias_entityId_normalizedAlias_key`(`entityId`, `normalizedAlias`)," +
			"INDEX `KnowledgeEntityAlias_orgId_normalizedAlias_idx`(`orgId`, `normalizedAlias`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `KnowledgeEdge` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `type` VARCHAR(32) NOT NULL," +
			"`fromEntityId` VARCHAR(191) NOT NULL, `toEntityId` VARCHAR(191) NOT NULL, `weight` DOUBLE NOT NULL DEFAULT 1," +
			"`confidence` DOUBLE NOT NULL DEFAULT 0.5, `properties` JSON NULL, `firstSeenAt` DATETIME(3) NOT NULL," +
			"`lastSeenAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL," +
			"UNIQUE INDEX `KnowledgeEdge_orgId_type_fromEntityId_toEntityId_key`(`orgId`, `type`, `fromEntityId`, `toEntityId`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `KnowledgeEdgeEvidence` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `edgeId` VARCHAR(191) NOT NULL," +
			"`articleId` VARCHAR(191) NOT NULL, `extractorVersion` VARCHAR(191) NULL, `confidence` DOUBLE NULL," +
			"`evidence` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `KnowledgeEdgeEvidence_edgeId_articleId_key`(`edgeId`, `articleId`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `ArticleEntityLink` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `articleId` VARCHAR(191) NOT NULL," +
			"`entityId` VARCHAR(191) NOT NULL, `mention` VARCHAR(191) NULL, `confidence` DOUBLE NULL," +
			"`source` VARCHAR(16) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"UNIQUE INDEX `ArticleEntityLink_orgId_articleId_entityId_key`(`orgId`, `articleId`, `entityId`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `KnowledgeGraphIngestionState` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `lastProcessedAt` DATETIME(3) NULL," +
			"`lastProcessedArticleId` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL, UNIQUE INDEX `KnowledgeGraphIngestionState_orgId_key`(`orgId`)," +
			"PRIMARY KEY (`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range ddl {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
}

func cleanupKnowledgeGraphOrg(t *testing.T, db *sql.DB, orgID string) {
	t.Helper()
	statements := []string{
		"DELETE FROM `KnowledgeEdgeEvidence` WHERE `orgId` = ?",
		"DELETE FROM `KnowledgeEdge` WHERE `orgId` = ?",
		"DELETE FROM `KnowledgeEntityAlias` WHERE `orgId` = ?",
		"DELETE FROM `KnowledgeEntity` WHERE `orgId` = ?",
		"DELETE FROM `ArticleEntityLink` WHERE `orgId` = ?",
		"DELETE FROM `KnowledgeGraphIngestionState` WHERE `orgId` = ?",
		"DELETE FROM `ProcessedArticle` WHERE `orgId` = ?",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement, orgID); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
	if _, err := db.Exec("DELETE FROM `SystemSetting` WHERE `key` = ?", "knowledge_graph_settings:"+orgID); err != nil {
		t.Fatalf("cleanup settings: %v", err)
	}
	if _, err := db.Exec("DELETE FROM `Org` WHERE `id` = ?", orgID); err != nil {
		t.Fatalf("cleanup org: %v", err)
	}
}

func insertKnowledgeGraphOrg(t *testing.T, db *sql.DB, orgID string, active bool) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO `Org` (`id`, `name`, `slug`, `isActive`, `updatedAt`) VALUES (?, ?, ?, ?, NOW(3))",
		orgID, orgID, orgID, active); err != nil {
		t.Fatalf("insert org: %v", err)
	}
}

func insertKnowledgeGraphSettings(t *testing.T, db *sql.DB, orgID string, document string) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO `SystemSetting` (`key`, `value`, `isPublic`, `description`, `createdAt`, `updatedAt`) VALUES (?, ?, 0, ?, NOW(3), NOW(3))",
		"knowledge_graph_settings:"+orgID, document, "test",
	); err != nil {
		t.Fatalf("insert settings: %v", err)
	}
}

func insertProcessedArticle(t *testing.T, db *sql.DB, orgID, articleID string, processedAt time.Time, relations string) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO `ProcessedArticle` (`id`, `orgId`, `articleId`, `status`, `processedAt`, `kgRelations`, `updatedAt`) "+
			"VALUES (?, ?, ?, 'completed', ?, ?, NOW(3))",
		articleID, orgID, articleID, processedAt, relations,
	); err != nil {
		t.Fatalf("insert processed article: %v", err)
	}
}

func integrationLogger() *log.Logger {
	return log.New(io.Discard, "", 0)
}

func integrationService(
	db *sql.DB,
	completer *fakeCompleter,
	counter FailureCounter,
	now func() time.Time,
) *Service {
	logger := integrationLogger()
	store := NewStore(db, now)
	return NewService(ServiceOptions{
		Store:    store,
		Settings: NewSettingsProvider(db, nil, logger),
		Failures: counter,
		Quality:  NewQuality(completer, nil, now, logger),
		Graph:    NewGraphWriter(db, now),
		Linker:   NewLinker(db, completer, nil, now, logger),
		Logger:   logger,
	})
}

func TestKnowledgeGraphIngestionBatchAndK2MySQLIntegration(t *testing.T) {
	db := openIntegrationDB(t)
	createKnowledgeGraphTables(t, db)

	const orgID = "org-kg-batch"
	cleanupKnowledgeGraphOrg(t, db, orgID)
	insertKnowledgeGraphOrg(t, db, orgID, true)
	t.Cleanup(func() { cleanupKnowledgeGraphOrg(t, db, orgID) })

	insertKnowledgeGraphSettings(t, db, orgID, `{
		"enabled": true, "ingestionEnabled": true, "maxBatchSize": 2,
		"maxRelationsPerArticle": 20, "minEdgeConfidence": 0.5,
		"dynamicEdgeConfidenceEnabled": false, "multiModelValidationEnabled": false,
		"entityDisambiguationEnabled": false
	}`)

	base := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	relation := func(object string, confidence float64, predicate, quote string) string {
		return `[{"subject":{"name":"Acme","type":"company"},"predicate":"` + predicate +
			`","object":{"name":"` + object + `","type":"company"},"confidence":` +
			formatFloat(confidence) + `,"evidence":"` + quote + `"}]`
	}
	insertProcessedArticle(t, db, orgID, "a1", base, relation("Beta", 0.6, "supplies", "quote a1"))
	insertProcessedArticle(t, db, orgID, "a2", base, relation("Beta", 0.8, "supplies", "quote a2"))
	insertProcessedArticle(t, db, orgID, "a3", base.Add(time.Minute), relation("Gamma", 0.7, "supplies", "quote a3"))
	insertProcessedArticle(t, db, orgID, "a4", base.Add(2*time.Minute), relation("Delta", 0.9, "mystery", "quote a4"))
	// Older than the thirty-day backfill window must never be read.
	insertProcessedArticle(t, db, orgID, "old", base.Add(-40*24*time.Hour), relation("Old", 0.9, "supplies", "old"))

	now := func() time.Time { return base.Add(3 * time.Minute) }
	service := integrationService(db, &fakeCompleter{}, &fakeFailureCounter{counts: map[string]int{}}, now)

	// First tick: maxBatchSize 2 -> a1, a2 (same processedAt, ordered by id).
	if _, err := service.IngestOrg(context.Background(), orgID); err != nil {
		t.Fatal(err)
	}
	assertIngestionCursor(t, db, orgID, base, "a2")
	assertEdge(t, db, orgID, "Acme", "Beta", 2, 0.7)
	assertEdgeEvidenceCount(t, db, orgID, "Acme", "Beta", 2)

	// Second tick continues at the same processedAt boundary: a3 then a4.
	if _, err := service.IngestOrg(context.Background(), orgID); err != nil {
		t.Fatal(err)
	}
	assertIngestionCursor(t, db, orgID, base.Add(2*time.Minute), "a4")
	assertEdge(t, db, orgID, "Acme", "Gamma", 1, 0.7)
	// The unknown predicate is skipped but the article still advances the cursor.
	if count := countEdge(t, db, orgID, "Acme", "Delta"); count != 0 {
		t.Fatalf("unknown relation created %d edges", count)
	}
	if count := countEdge(t, db, orgID, "Acme", "Old"); count != 0 {
		t.Fatalf("old article was ingested")
	}

	// K2: reprocessing a1 updates its evidence but must not count the weight again.
	reprocessed := ProcessedArticle{
		ArticleID:   "a1",
		ProcessedAt: base,
		KGRelations: json.RawMessage(relation("Beta", 0.9, "supplies", "updated quote")),
	}
	settings := Settings{
		Enabled:                           true,
		IngestionEnabled:                  true,
		MaxBatchSize:                      2,
		MaxRelationsPerArticle:            20,
		MinEdgeConfidence:                 0.5,
		DynamicEdgeConfidenceEnabled:      false,
		EntityDisambiguationMaxCandidates: 5,
	}
	if _, err := service.ProcessArticle(context.Background(), orgID, reprocessed, settings); err != nil {
		t.Fatal(err)
	}
	assertEdge(t, db, orgID, "Acme", "Beta", 2, 0.7)
	assertEdgeEvidenceCount(t, db, orgID, "Acme", "Beta", 2)
	if quote := evidenceQuote(t, db, orgID, "Acme", "Beta", "a1"); quote != "updated quote" {
		t.Fatalf("evidence quote = %q", quote)
	}
	if quote := evidenceQuote(t, db, orgID, "Acme", "Beta", "a2"); quote != "quote a2" {
		t.Fatalf("a2 evidence quote = %q", quote)
	}
}

func TestKnowledgeGraphIngestionLinkMySQLIntegration(t *testing.T) {
	db := openIntegrationDB(t)
	createKnowledgeGraphTables(t, db)

	const orgID = "org-kg-link"
	cleanupKnowledgeGraphOrg(t, db, orgID)
	insertKnowledgeGraphOrg(t, db, orgID, true)
	t.Cleanup(func() { cleanupKnowledgeGraphOrg(t, db, orgID) })

	// Two company entities share the alias "acme"; disambiguation must be able
	// to pick the second one.
	insertEntityWithAlias(t, db, orgID, "e1", "Acme", "company", "acme", "llm")
	insertEntityWithAlias(t, db, orgID, "e2", "Acme Holdings", "company", "acme", "llm")

	completer := &fakeCompleter{completeFn: func(req publicportal.KGCompletionRequest) (publicportal.KGCompletionResult, error) {
		if req.Metadata.Task != disambiguationTask || req.Metadata.OrgID != orgID {
			t.Errorf("disambiguation metadata = %+v", req.Metadata)
		}
		if req.MaxTokens != 160 || req.MaxRetries != 1 || req.TimeoutMS != 45_000 {
			t.Errorf("disambiguation request = %+v", req)
		}
		return publicportal.KGCompletionResult{Content: `{"entityId":"e2","confidence":0.9}`, Model: "m1"}, nil
	}}
	fixed := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	linker := NewLinker(db, completer, nil, func() time.Time { return fixed }, integrationLogger())

	entities := json.RawMessage(`[
		{"name":"acme","type":"company","confidence":0.9},
		{"name":"Brand New","type":"company","confidence":0.9},
		{"name":"Low","type":"company","confidence":0.3}
	]`)
	settings := Settings{EntityDisambiguationEnabled: true, EntityDisambiguationMaxCandidates: 5}
	written, err := linker.Link(context.Background(), orgID, "article-1", entities, settings, "Acme is discussed")
	if err != nil {
		t.Fatal(err)
	}
	if written != 2 {
		t.Fatalf("written = %d, want 2", written)
	}

	// Disambiguation changed the first candidate to e2.
	if entityID := linkEntityID(t, db, orgID, "article-1", "acme"); entityID != "e2" {
		t.Fatalf("linked entity = %q, want e2", entityID)
	}
	// The missing entity was created with llm aliases.
	if count := countEntity(t, db, orgID, "Brand New", "company"); count != 1 {
		t.Fatalf("created entity count = %d", count)
	}
	if count := countEntity(t, db, orgID, "Low", "company"); count != 0 {
		t.Fatalf("low-confidence entity was created")
	}

	requests := completer.captured()
	if len(requests) != 1 {
		t.Fatalf("disambiguation requests = %d", len(requests))
	}
	if !strings.Contains(requests[0].User, "- e1: Acme (company)") || !strings.Contains(requests[0].User, "- e2: Acme Holdings (company)") {
		t.Fatalf("disambiguation prompt = %s", requests[0].User)
	}

	// Re-linking the same article is idempotent.
	written, err = linker.Link(context.Background(), orgID, "article-1", entities, settings, "Acme is discussed")
	if err != nil {
		t.Fatal(err)
	}
	if written != 0 {
		t.Fatalf("second written = %d, want 0", written)
	}
	if count := countArticleLinks(t, db, orgID, "article-1"); count != 2 {
		t.Fatalf("link rows = %d, want 2", count)
	}
}

func TestKnowledgeGraphIngestionSettingsCacheMySQLIntegration(t *testing.T) {
	db := openIntegrationDB(t)
	redisClient := openIntegrationRedis(t)
	createKnowledgeGraphTables(t, db)

	const orgID = "org-kg-settings"
	cleanupKnowledgeGraphOrg(t, db, orgID)
	insertKnowledgeGraphOrg(t, db, orgID, true)
	t.Cleanup(func() { cleanupKnowledgeGraphOrg(t, db, orgID) })
	cacheKey := settingsCacheKeyPrefix + orgID
	t.Cleanup(func() { _ = redisClient.Del(context.Background(), cacheKey).Err() })
	_ = redisClient.Del(context.Background(), cacheKey).Err()

	provider := NewSettingsProvider(db, redisClient, integrationLogger())
	first := provider.Read(context.Background(), orgID)
	if !first.Enabled || !first.IngestionEnabled {
		t.Fatalf("bootstrap settings = %+v", first)
	}
	var stored int
	if err := db.QueryRow("SELECT COUNT(*) FROM `SystemSetting` WHERE `key` = ?", "knowledge_graph_settings:"+orgID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 1 {
		t.Fatalf("bootstrap rows = %d", stored)
	}
	if ttl := redisClient.TTL(context.Background(), cacheKey).Val(); ttl <= 0 || ttl > settingsCacheTTLSeconds*time.Second {
		t.Fatalf("settings cache ttl = %v", ttl)
	}

	// A cached document wins over the database until it expires or is dropped.
	if _, err := db.Exec("UPDATE `SystemSetting` SET `value` = ? WHERE `key` = ?",
		`{"enabled": false, "ingestionEnabled": false}`, "knowledge_graph_settings:"+orgID); err != nil {
		t.Fatal(err)
	}
	if cached := provider.Read(context.Background(), orgID); !cached.Enabled {
		t.Fatalf("cache was not used: %+v", cached)
	}
	if err := redisClient.Del(context.Background(), cacheKey).Err(); err != nil {
		t.Fatal(err)
	}
	if refreshed := provider.Read(context.Background(), orgID); refreshed.Enabled {
		t.Fatalf("database value was not read after cache drop: %+v", refreshed)
	}
}

func TestKnowledgeGraphIngestionRedisIntegration(t *testing.T) {
	redisClient := openIntegrationRedis(t)
	ctx := context.Background()
	lockKey := orgLockKeyPrefix + "org-kg-redis"
	t.Cleanup(func() {
		_ = redisClient.Del(ctx, tickGateKey, lockKey).Err()
	})
	_ = redisClient.Del(ctx, tickGateKey, lockKey).Err()

	fixed := time.Date(2026, 10, 19, 12, 5, 0, 0, time.UTC)
	scheduler := NewScheduler(SchedulerOptions{Store: NewRedisStore(redisClient), Now: func() time.Time { return fixed }})
	claimed, err := scheduler.claimTick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !claimed {
		t.Fatal("first claim = false")
	}
	value, err := redisClient.Get(ctx, tickGateKey).Result()
	if err != nil {
		t.Fatal(err)
	}
	if value != `{"claimedAt":"2026-10-19T12:05:00.000Z"}` {
		t.Fatalf("tick gate value = %s", value)
	}
	if ttl := redisClient.PTTL(ctx, tickGateKey).Val(); ttl <= 280*time.Second || ttl > 285*time.Second {
		t.Fatalf("tick gate pttl = %v", ttl)
	}
	second, err := scheduler.claimTick(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if second {
		t.Fatal("second claim = true, want mutual exclusion")
	}

	store := NewRedisStore(redisClient)
	if acquired, err := store.SetIfAbsent(ctx, lockKey, "token-a", 5*time.Second); err != nil || !acquired {
		t.Fatalf("acquire lock = %v, %v", acquired, err)
	}
	// A foreign token must not release the lock.
	if err := store.ReleaseLock(ctx, lockKey, "token-b"); err != nil {
		t.Fatal(err)
	}
	if exists, err := redisClient.Exists(ctx, lockKey).Result(); err != nil || exists != 1 {
		t.Fatalf("lock exists after foreign release = %d, %v", exists, err)
	}
	// Renewal extends the TTL with the owner token.
	if err := store.RenewLock(ctx, lockKey, "token-a", orgLockTTL); err != nil {
		t.Fatal(err)
	}
	if ttl := redisClient.PTTL(ctx, lockKey).Val(); ttl <= 50*time.Second || ttl > 60*time.Second {
		t.Fatalf("renewed pttl = %v", ttl)
	}
	if err := store.ReleaseLock(ctx, lockKey, "token-a"); err != nil {
		t.Fatal(err)
	}
	if exists, err := redisClient.Exists(ctx, lockKey).Result(); err != nil || exists != 0 {
		t.Fatalf("lock exists after release = %d, %v", exists, err)
	}

	// Two schedulers sharing Redis: the second organization run must be skipped
	// while the first holds the organization lease.
	blockedKey := orgLockKeyPrefix + "org-kg-lock"
	t.Cleanup(func() { _ = redisClient.Del(ctx, blockedKey).Err() })
	_ = redisClient.Del(ctx, blockedKey).Err()
	blocking := &blockingOrgProcessor{started: make(chan struct{}), release: make(chan struct{})}
	first := NewScheduler(SchedulerOptions{Store: NewRedisStore(redisClient), Processor: blocking})
	second := NewScheduler(SchedulerOptions{Store: NewRedisStore(redisClient), Processor: blocking})
	done := make(chan orgRunResult, 1)
	go func() {
		done <- first.runOrgWithLock(ctx, "org-kg-lock")
	}()
	<-blocking.started
	if exists, err := redisClient.Exists(ctx, blockedKey).Result(); err != nil || exists != 1 {
		t.Fatalf("organization lease missing during run = %d, %v", exists, err)
	}
	if result := second.runOrgWithLock(ctx, "org-kg-lock"); result.outcome != orgRunSkipped {
		t.Fatalf("second run outcome = %v, want skipped", result.outcome)
	}
	close(blocking.release)
	if result := <-done; result.outcome != orgRunCompleted {
		t.Fatalf("first run outcome = %v err = %v", result.outcome, result.err)
	}
	if exists, err := redisClient.Exists(ctx, blockedKey).Result(); err != nil || exists != 0 {
		t.Fatalf("organization lease after run = %d, %v", exists, err)
	}
}

// blockingOrgProcessor holds the organization lease until release is closed.
type blockingOrgProcessor struct {
	started chan struct{}
	release chan struct{}
}

func (p *blockingOrgProcessor) IngestOrg(context.Context, string) (BatchSummary, error) {
	close(p.started)
	<-p.release
	return BatchSummary{}, nil
}

func assertIngestionCursor(t *testing.T, db *sql.DB, orgID string, processedAt time.Time, articleID string) {
	t.Helper()
	var (
		gotAt sql.NullTime
		gotID sql.NullString
	)
	if err := db.QueryRow("SELECT `lastProcessedAt`, `lastProcessedArticleId` FROM `KnowledgeGraphIngestionState` WHERE `orgId` = ?", orgID).
		Scan(&gotAt, &gotID); err != nil {
		t.Fatalf("read cursor: %v", err)
	}
	if !gotAt.Valid || !gotAt.Time.UTC().Equal(processedAt.UTC()) || gotID.String != articleID {
		t.Fatalf("cursor = %v/%q, want %v/%q", gotAt.Time, gotID.String, processedAt, articleID)
	}
}

func countEdge(t *testing.T, db *sql.DB, orgID, from, to string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM `KnowledgeEdge` e "+
			"INNER JOIN `KnowledgeEntity` f ON f.`id` = e.`fromEntityId` "+
			"INNER JOIN `KnowledgeEntity` t ON t.`id` = e.`toEntityId` "+
			"WHERE e.`orgId` = ? AND f.`canonicalName` = ? AND t.`canonicalName` = ?",
		orgID, from, to,
	).Scan(&count); err != nil {
		t.Fatalf("count edge: %v", err)
	}
	return count
}

func assertEdge(t *testing.T, db *sql.DB, orgID, from, to string, weight float64, confidence float64) {
	t.Helper()
	var (
		gotWeight     float64
		gotConfidence float64
	)
	if err := db.QueryRow(
		"SELECT e.`weight`, e.`confidence` FROM `KnowledgeEdge` e "+
			"INNER JOIN `KnowledgeEntity` f ON f.`id` = e.`fromEntityId` "+
			"INNER JOIN `KnowledgeEntity` t ON t.`id` = e.`toEntityId` "+
			"WHERE e.`orgId` = ? AND f.`canonicalName` = ? AND t.`canonicalName` = ?",
		orgID, from, to,
	).Scan(&gotWeight, &gotConfidence); err != nil {
		t.Fatalf("read edge: %v", err)
	}
	if gotWeight != weight || math.Abs(gotConfidence-confidence) > 1e-9 {
		t.Fatalf("edge = weight %v confidence %v, want %v/%v", gotWeight, gotConfidence, weight, confidence)
	}
}

func assertEdgeEvidenceCount(t *testing.T, db *sql.DB, orgID, from, to string, want int) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM `KnowledgeEdgeEvidence` ev "+
			"INNER JOIN `KnowledgeEdge` e ON e.`id` = ev.`edgeId` "+
			"INNER JOIN `KnowledgeEntity` f ON f.`id` = e.`fromEntityId` "+
			"INNER JOIN `KnowledgeEntity` t ON t.`id` = e.`toEntityId` "+
			"WHERE e.`orgId` = ? AND f.`canonicalName` = ? AND t.`canonicalName` = ?",
		orgID, from, to,
	).Scan(&count); err != nil {
		t.Fatalf("count evidence: %v", err)
	}
	if count != want {
		t.Fatalf("evidence count = %d, want %d", count, want)
	}
}

func evidenceQuote(t *testing.T, db *sql.DB, orgID, from, to, articleID string) string {
	t.Helper()
	var raw []byte
	if err := db.QueryRow(
		"SELECT ev.`evidence` FROM `KnowledgeEdgeEvidence` ev "+
			"INNER JOIN `KnowledgeEdge` e ON e.`id` = ev.`edgeId` "+
			"INNER JOIN `KnowledgeEntity` f ON f.`id` = e.`fromEntityId` "+
			"INNER JOIN `KnowledgeEntity` t ON t.`id` = e.`toEntityId` "+
			"WHERE e.`orgId` = ? AND f.`canonicalName` = ? AND t.`canonicalName` = ? AND ev.`articleId` = ?",
		orgID, from, to, articleID,
	).Scan(&raw); err != nil {
		t.Fatalf("read evidence: %v", err)
	}
	var document struct {
		Quote string `json:"quote"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode evidence: %v", err)
	}
	return document.Quote
}

func insertEntityWithAlias(t *testing.T, db *sql.DB, orgID, id, canonicalName, entityType, alias, source string) {
	t.Helper()
	if _, err := db.Exec(
		"INSERT INTO `KnowledgeEntity` (`id`, `orgId`, `type`, `canonicalName`, `normalizedKey`, `updatedAt`) "+
			"VALUES (?, ?, ?, ?, ?, NOW(3))",
		id, orgID, entityType, canonicalName, strings.ToLower(canonicalName),
	); err != nil {
		t.Fatalf("insert entity: %v", err)
	}
	if _, err := db.Exec(
		"INSERT INTO `KnowledgeEntityAlias` (`id`, `orgId`, `entityId`, `alias`, `normalizedAlias`, `source`) "+
			"VALUES (?, ?, ?, ?, ?, ?)",
		id+"-alias", orgID, id, alias, strings.ToLower(alias), source,
	); err != nil {
		t.Fatalf("insert alias: %v", err)
	}
}

func linkEntityID(t *testing.T, db *sql.DB, orgID, articleID, mention string) string {
	t.Helper()
	var entityID string
	if err := db.QueryRow(
		"SELECT `entityId` FROM `ArticleEntityLink` WHERE `orgId` = ? AND `articleId` = ? AND `mention` = ? LIMIT 1",
		orgID, articleID, mention,
	).Scan(&entityID); err != nil {
		t.Fatalf("read link: %v", err)
	}
	return entityID
}

func countEntity(t *testing.T, db *sql.DB, orgID, canonicalName, entityType string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM `KnowledgeEntity` WHERE `orgId` = ? AND `canonicalName` = ? AND `type` = ?",
		orgID, canonicalName, entityType,
	).Scan(&count); err != nil {
		t.Fatalf("count entity: %v", err)
	}
	return count
}

func countArticleLinks(t *testing.T, db *sql.DB, orgID, articleID string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(
		"SELECT COUNT(*) FROM `ArticleEntityLink` WHERE `orgId` = ? AND `articleId` = ?",
		orgID, articleID,
	).Scan(&count); err != nil {
		t.Fatalf("count links: %v", err)
	}
	return count
}

func formatFloat(value float64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
