//go:build integration

// MySQL/Redis/Mongo integration tests for the NewsNow hottest unit. The default
// `go test ./...` run needs none of them; this file compiles with the
// integration tag and runs in the api-go-user-settings-integration CI job.
//
// Environment:
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//	MONGO_URI=mongodb://127.0.0.1:27017/<db>
//
// It proves the H1 organization scoping and the O1 batched matcher against real
// storage, the O4 multi-row opinion upsert against the real schema, and the
// signal-state pipeline plus lock/time-slice keys against the real Redis.
package newsnowhottest

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationMySQL(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func integrationMongo(t *testing.T) *mongo.Database {
	t.Helper()
	uri := strings.TrimSpace(os.Getenv("MONGO_URI"))
	if uri == "" {
		t.Skip("MONGO_URI not set — integration test requires MongoDB")
	}
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		t.Fatalf("connect mongo: %v", err)
	}
	database := client.Database("newsnow_hottest_it_" + strconv.FormatInt(time.Now().UnixNano(), 36))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = database.Drop(ctx)
		_ = client.Disconnect(ctx)
	})
	return database
}

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: strings.TrimSpace(os.Getenv("REDIS_PASSWORD")),
		Protocol: 2,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("ping redis: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// The DDL matches the tables the other integration suites create, so the test
// also works when a previous suite already created them.
const createItemMetaTable = "CREATE TABLE IF NOT EXISTS ItemMeta (" +
	"id varchar(40) NOT NULL PRIMARY KEY," +
	"orgId varchar(40) NOT NULL," +
	"externalId varchar(255) NOT NULL," +
	"name varchar(255) NOT NULL," +
	"status varchar(32) NOT NULL DEFAULT 'draft'," +
	"mongoRef varchar(40) NOT NULL DEFAULT ''," +
	"version int NOT NULL DEFAULT 1," +
	"publishedAt datetime(3) NULL," +
	"sortAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"createdAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"updatedAt datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"UNIQUE KEY ItemMeta_org_externalId (orgId, externalId)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

const createNewsEventItemTable = "CREATE TABLE IF NOT EXISTS NewsEventItem (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"eventId VARCHAR(191) NOT NULL," +
	"processedArticleId VARCHAR(191) NOT NULL," +
	"processedItemId VARCHAR(191) NULL," +
	"similarity DOUBLE NULL," +
	"assignedBy ENUM('vector','overlap','manual') NOT NULL DEFAULT 'overlap'," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"UNIQUE INDEX NewsEventItem_orgId_processedArticleId_key (orgId, processedArticleId)," +
	"PRIMARY KEY (id)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

func TestNewsnowHottestIntegrationOrgMatching(t *testing.T) {
	db := integrationMySQL(t)
	database := integrationMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	for _, statement := range []string{createItemMetaTable, createNewsEventItemTable} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	orgA := "org-a-" + suffix
	orgB := "org-b-" + suffix
	metaA := "meta-a-" + suffix
	metaB := "meta-b-" + suffix
	metaOld := "meta-old-" + suffix
	cleanupSQL := []string{
		"DELETE FROM NewsEventItem WHERE orgId IN (?, ?)",
		"DELETE FROM ItemMeta WHERE id IN (?, ?, ?)",
	}
	t.Cleanup(func() {
		_, _ = db.Exec(cleanupSQL[0], orgA, orgB)
		_, _ = db.Exec(cleanupSQL[1], metaA, metaB, metaOld)
	})
	for _, row := range []struct{ id, org string }{{metaA, orgA}, {metaB, orgB}, {metaOld, orgA}} {
		if _, err := db.ExecContext(ctx,
			"INSERT INTO ItemMeta (id, orgId, externalId, name) VALUES (?, ?, ?, ?)",
			row.id, row.org, row.id, row.id); err != nil {
			t.Fatalf("insert itemmeta: %v", err)
		}
	}

	variants, ok := comparableURLVariants("https://integration.example/a")
	if !ok {
		t.Fatal("comparable variants")
	}
	now := time.Now().UTC()
	rawRows := []RawItemRow{
		{ItemMetaID: metaB, PayloadURL: variants.Full, FullHash: variants.FullHash, Full: variants.Full, Base: variants.Base, CreatedAt: now.Add(-time.Minute)},
		{ItemMetaID: metaA, PayloadURL: variants.Full, FullHash: variants.FullHash, Full: variants.Full, Base: variants.Base, CreatedAt: now.Add(-2 * time.Minute)},
	}
	rawItems := database.Collection(rawItemsCollection)
	for _, row := range rawRows {
		if _, err := rawItems.InsertOne(ctx, bson.D{
			{Key: "itemMetaId", Value: row.ItemMetaID},
			{Key: "payload", Value: bson.D{{Key: "url", Value: row.PayloadURL}}},
			{Key: "urlComparableFullHash", Value: row.FullHash},
			{Key: "urlComparableFull", Value: row.Full},
			{Key: "urlComparableBase", Value: row.Base},
			{Key: "createdAt", Value: row.CreatedAt},
		}); err != nil {
			t.Fatalf("insert raw item: %v", err)
		}
	}
	processedID := bson.NewObjectID()
	if _, err := database.Collection(processedItemsCollection).InsertOne(ctx, bson.D{
		{Key: "_id", Value: processedID},
		{Key: "orgId", Value: orgA},
		{Key: "itemMetaId", Value: metaA},
		{Key: "status", Value: "completed"},
		{Key: "createdAt", Value: now},
	}); err != nil {
		t.Fatalf("insert processed item: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		"INSERT INTO NewsEventItem (id, orgId, eventId, processedArticleId, processedItemId, createdAt) VALUES (?,?,?,?,?,?)",
		"event-row-"+suffix, orgA, "event-a-"+suffix, "article-"+suffix, processedID.Hex(), now); err != nil {
		t.Fatalf("insert event: %v", err)
	}

	matcher := NewOrgMatcher(NewMatchStore(database, db))
	resolved, err := matcher.ResolveOrgMatches(ctx, orgA, []string{"https://integration.example/a"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	match, matched := resolved["https://integration.example/a"]
	if !matched || match.ItemID != metaA {
		t.Fatalf("H1 scoping failed: %+v", resolved)
	}
	if match.EventID != "event-a-"+suffix {
		t.Fatalf("event = %q", match.EventID)
	}

	// The reference implementation must agree for the same fixture.
	store := &fakeMatchStore{
		rows:      rawRows,
		orgs:      map[string]string{metaA: orgA, metaB: orgB, metaOld: orgA},
		processed: map[string][]string{metaA: {processedID.Hex()}},
		events:    []EventRow{{ProcessedItemID: processedID.Hex(), EventID: "event-a-" + suffix, CreatedAt: now}},
	}
	want, matched := referenceResolve(store, orgA, "https://integration.example/a")
	if !matched || want.ItemID != metaA || want.EventID != match.EventID {
		t.Fatalf("reference mismatch: want %+v got %+v", want, match)
	}
}

func TestNewsnowHottestIntegrationOpinionBatch(t *testing.T) {
	db := integrationMySQL(t)
	database := integrationMongo(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	statements := []string{
		"CREATE TABLE IF NOT EXISTS NewsnowCandidateSnapshot (" +
			"id VARCHAR(191) NOT NULL PRIMARY KEY, orgId VARCHAR(191) NOT NULL," +
			"bucketStart DATETIME(3) NOT NULL, candidateHash VARCHAR(191) NOT NULL," +
			"label VARCHAR(191) NOT NULL, summary TEXT NULL, themes JSON NULL," +
			"keywords JSON NULL, entities JSON NULL, sourceIds JSON NULL," +
			"sourceCount INT NOT NULL, itemCount INT NOT NULL," +
			"heatScore DOUBLE NOT NULL, freshnessScore DOUBLE NOT NULL," +
			"candidateScore DOUBLE NOT NULL, authorityScore DOUBLE NOT NULL," +
			"domesticSourceCount INT NOT NULL DEFAULT 0, domesticItemCount INT NOT NULL DEFAULT 0," +
			"domesticRatio DOUBLE NOT NULL DEFAULT 0, isDomestic TINYINT(1) NOT NULL DEFAULT 0," +
			"sentimentPressure DOUBLE NOT NULL DEFAULT 0," +
			"createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL," +
			"UNIQUE KEY candidate_unique (orgId, bucketStart, candidateHash)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS NewsnowDomesticOpinionIndexSnapshot (" +
			"id VARCHAR(191) NOT NULL PRIMARY KEY, orgId VARCHAR(191) NOT NULL," +
			"bucketStart DATETIME(3) NOT NULL, indexValue DOUBLE NOT NULL," +
			"attentionScore DOUBLE NOT NULL, breadthScore DOUBLE NOT NULL," +
			"freshnessScore DOUBLE NOT NULL, sentimentPressure DOUBLE NOT NULL," +
			"candidateCount INT NOT NULL DEFAULT 0, keywordSummary JSON NULL," +
			"createdAt DATETIME(3) NOT NULL, updatedAt DATETIME(3) NOT NULL," +
			"UNIQUE KEY index_unique (orgId, bucketStart)" +
			") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	orgID := "org-opinion-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	t.Cleanup(func() {
		_, _ = db.Exec("DELETE FROM NewsnowCandidateSnapshot WHERE orgId = ?", orgID)
		_, _ = db.Exec("DELETE FROM NewsnowDomesticOpinionIndexSnapshot WHERE orgId = ?", orgID)
	})

	generatedAt := time.Date(2026, 10, 20, 12, 30, 0, 0, time.UTC)
	store := NewOpinionStore(db, database)
	summary := "摘要"
	candidates := []CandidatePersistenceInput{
		{
			CandidateHash: "hash-1", Label: "候选一", Summary: &summary, RepresentativeTitle: "标题一",
			Themes: []string{"主题"}, Topics: []string{"话题"}, Entities: []string{"实体"},
			SourceIDs: []string{"s1", "s2"}, DomesticSourceIDs: []string{"s1"}, SourceCount: 2, ItemCount: 3,
			HeatScore: 0.6, FreshnessScore: 0.8, CandidateScore: 0.7, AuthorityScore: 0.5,
			DomesticSourceCount: 1, DomesticItemCount: 2, MatchedItemIDs: []string{},
		},
		{
			CandidateHash: "hash-2", Label: "候选二", RepresentativeTitle: "标题二",
			Themes: []string{}, Topics: []string{}, Entities: []string{}, SourceIDs: []string{"s3"},
			DomesticSourceIDs: []string{}, SourceCount: 1, ItemCount: 1,
			HeatScore: 0.2, FreshnessScore: 0.3, CandidateScore: 0.4, AuthorityScore: 0.5,
			MatchedItemIDs: []string{},
		},
	}
	if err := store.PersistSnapshots(ctx, OpinionSnapshotInput{
		OrgID: orgID, GeneratedAt: generatedAt, TotalDomesticSourceCount: 3, Candidates: candidates,
	}); err != nil {
		t.Fatalf("persist batch: %v", err)
	}

	// Reference: the same rows written one by one into the next hour bucket.
	referenceBucket := generatedAt.UTC().Add(time.Hour).Truncate(time.Hour)
	for _, candidate := range candidates {
		persisted := buildPersistedCandidate(candidate, map[string]string{})
		_, err := db.ExecContext(ctx,
			"INSERT INTO NewsnowCandidateSnapshot (id, orgId, bucketStart, candidateHash, label, summary, themes,"+
				" keywords, entities, sourceIds, sourceCount, itemCount, heatScore, freshnessScore, candidateScore,"+
				" authorityScore, domesticSourceCount, domesticItemCount, domesticRatio, isDomestic, sentimentPressure,"+
				" createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
			"ref-"+persisted.CandidateHash, orgID, referenceBucket, persisted.CandidateHash, persisted.Label,
			persisted.Summary, mustJSON(persisted.Themes), mustJSON(persisted.Keywords), mustJSON(persisted.Entities),
			mustJSON(persisted.SourceIDs), persisted.SourceCount, persisted.ItemCount, persisted.HeatScore,
			persisted.FreshnessScore, persisted.CandidateScore, persisted.AuthorityScore, persisted.DomesticSourceCount,
			persisted.DomesticItemCount, persisted.DomesticRatio, persisted.IsDomestic, persisted.SentimentPressure,
			time.Now().UTC().Truncate(time.Millisecond), time.Now().UTC().Truncate(time.Millisecond))
		if err != nil {
			t.Fatalf("reference insert: %v", err)
		}
	}
	bucket := toUTCHourStart(generatedAt)
	batchRows, err := readCandidateProjection(ctx, db, orgID, bucket)
	if err != nil {
		t.Fatalf("read batch rows: %v", err)
	}
	referenceRows, err := readCandidateProjection(ctx, db, orgID, referenceBucket)
	if err != nil {
		t.Fatalf("read reference rows: %v", err)
	}
	if !equalCandidateProjections(batchRows, referenceRows) {
		t.Fatalf("batch rows differ from per-row upsert:\nbatch=%+v\nref=%+v", batchRows, referenceRows)
	}

	// A second refresh with one candidate removed must delete the stale row.
	if err := store.PersistSnapshots(ctx, OpinionSnapshotInput{
		OrgID: orgID, GeneratedAt: generatedAt, TotalDomesticSourceCount: 3, Candidates: candidates[:1],
	}); err != nil {
		t.Fatalf("persist second batch: %v", err)
	}
	afterRows, err := readCandidateProjection(ctx, db, orgID, bucket)
	if err != nil {
		t.Fatalf("read after rows: %v", err)
	}
	if len(afterRows) != 1 || afterRows[0].Hash != "hash-1" {
		t.Fatalf("deleteMany did not remove the stale candidate: %+v", afterRows)
	}
}

type candidateProjection struct {
	Hash              string
	Label             string
	Themes            string
	Keywords          string
	SourceCount       int
	CandidateScore    float64
	DomesticRatio     float64
	IsDomestic        bool
	SentimentPressure float64
}

func readCandidateProjection(ctx context.Context, db *sql.DB, orgID string, bucket time.Time) ([]candidateProjection, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT candidateHash, label, themes, keywords, sourceCount, candidateScore, domesticRatio, isDomestic, sentimentPressure"+
			" FROM NewsnowCandidateSnapshot WHERE orgId = ? AND bucketStart = ? ORDER BY candidateHash", orgID, bucket)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]candidateProjection, 0, 4)
	for rows.Next() {
		var row candidateProjection
		var themes, keywords []byte
		if err := rows.Scan(&row.Hash, &row.Label, &themes, &keywords, &row.SourceCount,
			&row.CandidateScore, &row.DomesticRatio, &row.IsDomestic, &row.SentimentPressure); err != nil {
			return nil, err
		}
		row.Themes = string(themes)
		row.Keywords = string(keywords)
		out = append(out, row)
	}
	return out, rows.Err()
}

func equalCandidateProjections(left, right []candidateProjection) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func TestNewsnowHottestIntegrationLocksAndStatePipeline(t *testing.T) {
	client := integrationRedis(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	store := NewRedisStore(client)

	lockTarget := "newsnow:hottest:analysis:v1:org-it:refresh"
	t.Cleanup(func() {
		client.Del(context.Background(), "lock:"+lockTarget)
	})
	lease, err := acquireLock(ctx, store, lockTarget, analysisLockTTLMillis)
	if err != nil || lease == nil {
		t.Fatalf("acquire: %v %v", lease, err)
	}
	ttl, err := client.PTTL(ctx, "lock:"+lockTarget).Result()
	if err != nil || ttl <= 0 || ttl > 45*time.Second {
		t.Fatalf("lock ttl = %v (%v)", ttl, err)
	}
	if second, err := acquireLock(ctx, store, lockTarget, analysisLockTTLMillis); err != nil || second != nil {
		t.Fatalf("second acquire = %v %v", second, err)
	}
	lease.release()
	if again, err := acquireLock(ctx, store, lockTarget, analysisLockTTLMillis); err != nil || again == nil {
		t.Fatalf("reacquire = %v %v", again, err)
	} else {
		again.release()
	}

	scheduler := &Scheduler{store: store, now: func() time.Time {
		return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	}}
	t.Cleanup(func() { client.Del(context.Background(), hottestTickGateKey) })
	claimed, err := scheduler.claimTick(ctx)
	if err != nil || !claimed {
		t.Fatalf("claim tick = %v %v", claimed, err)
	}
	raw, err := client.Get(ctx, hottestTickGateKey).Result()
	if err != nil {
		t.Fatalf("read tick gate: %v", err)
	}
	var payload struct {
		ClaimedAt string `json:"claimedAt"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || payload.ClaimedAt != "2026-10-20T12:00:00.000Z" {
		t.Fatalf("tick payload = %s (%v)", raw, err)
	}
	if ttl := client.PTTL(ctx, hottestTickGateKey).Val(); ttl <= 0 || ttl > hottestTickGateTTL {
		t.Fatalf("tick ttl = %v", ttl)
	}

	orgID := "org-state-it"
	signalKeys := []string{"signal-a", "signal-b"}
	t.Cleanup(func() {
		client.Del(context.Background(), buildStateKey(orgID, "signal-a"), buildStateKey(orgID, "signal-b"))
	})
	service := NewService(Options{Store: store})
	signals := []Signal{
		{SignalSeed: SignalSeed{SignalKey: "signal-a", Rank: 2}, CapturedAt: "2026-10-20T12:00:00.000Z"},
		{SignalSeed: SignalSeed{SignalKey: "signal-b", Rank: 1}, CapturedAt: "2026-10-20T12:00:00.000Z",
			State: &SignalState{FirstSeenAt: "2026-10-20T10:00:00.000Z", LastRank: intOrNull(4)}},
	}
	service.persistSignalStates(ctx, orgID, signals)
	states := service.safeGetStates(ctx, []string{buildStateKey(orgID, signalKeys[0]), buildStateKey(orgID, signalKeys[1])})
	if len(states) != 2 || states[0] == nil || states[1] == nil {
		t.Fatalf("states = %+v", states)
	}
	if states[1].FirstSeenAt != "2026-10-20T10:00:00.000Z" || !states[1].LastRank.Valid || states[1].LastRank.Value != 1 {
		t.Fatalf("second state = %+v", states[1])
	}
	if ttl := client.TTL(ctx, buildStateKey(orgID, "signal-a")).Val(); ttl <= 35*time.Hour || ttl > 36*time.Hour {
		t.Fatalf("state ttl = %v", ttl)
	}

	warmLease, err := acquireLock(ctx, store, warmLockKey, warmLockTTLMillis)
	if err != nil || warmLease == nil {
		t.Fatalf("warm lock = %v %v", warmLease, err)
	}
	t.Cleanup(func() { client.Del(context.Background(), "lock:"+warmLockKey) })
	if ttl := client.PTTL(ctx, "lock:"+warmLockKey).Val(); ttl <= 0 || ttl > 55*time.Second {
		t.Fatalf("warm lock ttl = %v", ttl)
	}
	warmLease.release()
}
