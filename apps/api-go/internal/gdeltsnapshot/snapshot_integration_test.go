//go:build integration

// MySQL/Redis integration tests for the GDELT snapshot chain. The default
// `go test ./...` run does not need a database or a Redis; this file only
// compiles with the integration tag and runs in the api-go-user-settings-
// integration CI job.
//
// Environment (missing values skip the corresponding part, so a local run
// without services does not fail):
//
//	DATABASE_URL=mysql://root:secret@127.0.0.1:3306/<db>
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379
//
// What it proves beyond the unit tests:
//   - the projected SQL aggregate returns exactly the counters the payload-based
//     reference computes over the same rows, including a row whose payload would
//     not normalize;
//   - the history insert and the seven-day prune target the real schema;
//   - the two cache keys, their TTLs and their raw JSON values match what
//     CacheService would have written;
//   - the database fallback of readSnapshot refills both cache layers;
//   - the shared lease is mutually exclusive and carries the NestJS physical
//     key;
//   - one real rebuild writes the table and both cache layers through the real
//     MySQL and Redis clients.
package gdeltsnapshot

import (
	"context"
	"database/sql"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const createSnapshotTable = "CREATE TABLE IF NOT EXISTS SituationMonitorExternalSnapshot (" +
	"id VARCHAR(191) NOT NULL," +
	"scope ENUM('gdelt_global') NOT NULL," +
	"variantKey VARCHAR(191) NOT NULL," +
	"status ENUM('completed','partial','failed') NOT NULL," +
	"source VARCHAR(191) NOT NULL DEFAULT 'scheduler'," +
	"payload JSON NOT NULL," +
	"warnings JSON NULL," +
	"diagnostics JSON NULL," +
	"generatedAt DATETIME(3) NOT NULL," +
	"expiresAt DATETIME(3) NOT NULL," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"PRIMARY KEY (id)," +
	"INDEX SituationMonitorExternalSnapshot_scope_variant_generated_idx (scope, variantKey, generatedAt)," +
	"INDEX SituationMonitorExternalSnapshot_expires_idx (expiresAt)" +
	") DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// TestGDELTSnapshotIntegration drives the MySQL and Redis halves of the chain
// against the real services.
func TestGDELTSnapshotIntegration(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires a MySQL service")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, createSnapshotTable); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		"DELETE FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ?",
		scope, variantKey); err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(),
			"DELETE FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ?",
			scope, variantKey)
	})

	t.Run("aggregate projection equals the payload reference", func(t *testing.T) {
		testAggregateEquivalence(ctx, t, db)
	})

	t.Run("prune removes only the rows outside the retention window", func(t *testing.T) {
		testPrune(ctx, t, db)
	})

	t.Run("redis cache and lease", func(t *testing.T) {
		address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
		if address == "" {
			t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
		}
		testRedisCacheAndLease(ctx, t, db, address)
	})

	t.Run("real rebuild writes history and caches", func(t *testing.T) {
		address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
		if address == "" {
			t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
		}
		testRealRebuild(ctx, t, db, address)
	})
}

// insertSnapshot persists one row through the production store.
func insertSnapshot(ctx context.Context, t *testing.T, store *mysqlStore, payload *Payload, generatedAt time.Time) {
	t.Helper()
	encoded, err := marshalJSON(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	warnings, _ := marshalJSON(payload.Warnings)
	diagnostics, _ := marshalJSON(payload.Diagnostics)
	rowID, err := newRowID()
	if err != nil {
		t.Fatalf("row id: %v", err)
	}
	generated := generatedAt.UTC().Truncate(time.Millisecond)
	if err := store.Insert(ctx, snapshotRow{
		ID:          rowID,
		Scope:       scope,
		VariantKey:  variantKey,
		Status:      payload.Status,
		Source:      sourceName,
		Payload:     encoded,
		Warnings:    warnings,
		Diagnostics: diagnostics,
		GeneratedAt: generated,
		ExpiresAt:   generated.Add(freshTTL),
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
}

// resetRows keeps the subtests independent of each other: every subtest starts
// from an empty global snapshot history.
func resetRows(ctx context.Context, t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.ExecContext(ctx,
		"DELETE FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ?",
		scope, variantKey); err != nil {
		t.Fatalf("reset rows: %v", err)
	}
}

func testAggregateEquivalence(ctx context.Context, t *testing.T, db *sql.DB) {
	resetRows(ctx, t, db)
	store := &mysqlStore{db: db}
	now := time.Now().UTC().Truncate(time.Millisecond)

	completed := samplePayload(isoTime(now.Add(-2*time.Minute)), isoTime(now.Add(-2*time.Minute).Add(freshTTL)))
	rateLimited := samplePayload(isoTime(now.Add(-4*time.Minute)), isoTime(now.Add(-4*time.Minute).Add(freshTTL)))
	rateLimited.Status = StatusPartial
	rateLimited.Partial = true
	rateLimited.Warnings = []Warning{{Code: codeRateLimited, Severity: severityWarning, Message: "m"}}
	insertSnapshot(ctx, t, store, completed, parseTime(t, completed.GeneratedAt))
	insertSnapshot(ctx, t, store, rateLimited, parseTime(t, rateLimited.GeneratedAt))

	// A payload that normalizePayload rejects: it counts as a recent record but
	// contributes to neither the rate-limited nor the availability counter.
	unusable := samplePayload(isoTime(now.Add(-6*time.Minute)), isoTime(now.Add(-6*time.Minute).Add(freshTTL)))
	unusableJSON, err := marshalJSON(unusable)
	if err != nil {
		t.Fatalf("marshal unusable: %v", err)
	}
	stripped := strings.Replace(string(unusableJSON),
		`"generatedAt":"`+unusable.GeneratedAt+`"`, `"generatedAt":""`, 1)
	if _, err := db.ExecContext(ctx, `
INSERT INTO SituationMonitorExternalSnapshot
  (id, scope, variantKey, status, source, payload, warnings, diagnostics, generatedAt, expiresAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"it-unusable", scope, variantKey, string(StatusPartial), sourceName,
		[]byte(stripped), []byte("[]"), []byte("{}"),
		parseTime(t, unusable.GeneratedAt), parseTime(t, unusable.ExpiresAt)); err != nil {
		t.Fatalf("insert unusable row: %v", err)
	}

	rows, err := db.QueryContext(ctx, `
SELECT status, payload, generatedAt FROM SituationMonitorExternalSnapshot
WHERE scope = ? AND variantKey = ? ORDER BY generatedAt DESC, createdAt DESC`, scope, variantKey)
	if err != nil {
		t.Fatalf("select rows: %v", err)
	}
	defer rows.Close()
	reference := make([]referenceRow, 0, 3)
	for rows.Next() {
		var status string
		var rawPayload []byte
		var generatedAt time.Time
		if err := rows.Scan(&status, &rawPayload, &generatedAt); err != nil {
			t.Fatalf("scan: %v", err)
		}
		reference = append(reference, referenceRow{status: Status(status), payload: rawPayload, generatedAt: generatedAt.UTC()})
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	if len(reference) != 3 {
		t.Fatalf("reference rows = %d, want 3", len(reference))
	}

	want := referenceAggregates(reference)
	got, err := store.Aggregates(ctx, now)
	if err != nil {
		t.Fatalf("Aggregates: %v", err)
	}
	if got.RecentCount != want.RecentCount || got.ValidPayloadCount != want.ValidPayloadCount ||
		got.CompletedCount != want.CompletedCount || got.RateLimitedCount != want.RateLimitedCount ||
		got.AvailableCategorySum != want.AvailableCategorySum {
		t.Errorf("projected counters = %+v, reference = %+v", got, want)
	}
	if want.ValidPayloadCount != 2 || want.RateLimitedCount != 1 {
		t.Errorf("reference = %+v, want the unusable row excluded from the payload counters", want)
	}
	assertTimePtr(t, "lastFullSuccessAt", got.LastFullSuccessAt, want.LastFullSuccessAt)
	assertTimePtr(t, "lastNonSuccessAt", got.LastNonSuccessAt, want.LastNonSuccessAt)

	projected := computeStatusMetrics(got, now)
	fromReference := computeStatusMetrics(want, now)
	assertFloatPtrEqual(t, "rolling24hSuccessRate", projected.Rolling24hSuccessRate, fromReference.Rolling24hSuccessRate)
	assertFloatPtrEqual(t, "rolling24hAverageAvailableCategoryCount",
		projected.Rolling24hAverageAvailableCategoryCount, fromReference.Rolling24hAverageAvailableCategoryCount)

	latest, found, err := store.LatestPayload(ctx)
	if err != nil || !found {
		t.Fatalf("LatestPayload: found=%v err=%v", found, err)
	}
	if !strings.Contains(string(latest), `"generatedAt":"`+completed.GeneratedAt+`"`) {
		t.Errorf("latest payload = %.160s, want the newest row", latest)
	}
}

func testPrune(ctx context.Context, t *testing.T, db *sql.DB) {
	resetRows(ctx, t, db)
	store := &mysqlStore{db: db}
	now := time.Now().UTC()
	old := samplePayload(isoTime(now.Add(-8*24*time.Hour)), isoTime(now.Add(-8*24*time.Hour).Add(freshTTL)))
	recent := samplePayload(isoTime(now.Add(-time.Hour)), isoTime(now.Add(-time.Hour).Add(freshTTL)))
	insertSnapshot(ctx, t, store, old, now.Add(-8*24*time.Hour))
	insertSnapshot(ctx, t, store, recent, now.Add(-time.Hour))

	deleted, err := store.Prune(ctx, now.Add(-historyRetentionDays*24*time.Hour))
	if err != nil {
		t.Fatalf("Prune: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted = %d, want 1", deleted)
	}
	var remaining int
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ?",
		scope, variantKey).Scan(&remaining); err != nil {
		t.Fatalf("count: %v", err)
	}
	if remaining != 1 {
		t.Errorf("remaining = %d, want only the recent row", remaining)
	}
}

func testRedisCacheAndLease(ctx context.Context, t *testing.T, db *sql.DB, address string) {
	client := redis.NewClient(&redis.Options{Addr: address})
	defer client.Close()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	cleanupKeys(ctx, t, client)
	service := &Service{
		store: &mysqlStore{db: db},
		cache: redisCache{client: client},
		locks: redisLock{client: client},
		now:   time.Now,
	}

	payload := samplePayload("2026-10-20T12:34:00.000Z", isoTime(time.Now().UTC().Add(freshTTL)))
	if err := service.restoreCaches(ctx, payload); err != nil {
		t.Fatalf("restoreCaches: %v", err)
	}
	want := mustMarshal(t, payload)
	for _, key := range []string{freshCacheKey, staleCacheKey} {
		raw, err := client.Get(ctx, key).Result()
		if err != nil {
			t.Fatalf("get %s: %v", key, err)
		}
		if raw != want {
			t.Errorf("%s = %s, want the marshalled payload", key, raw)
		}
		ttl, err := client.TTL(ctx, key).Result()
		if err != nil {
			t.Fatalf("ttl %s: %v", key, err)
		}
		expected := freshTTL
		if key == staleCacheKey {
			expected = staleTTL
		}
		if ttl > expected || ttl < expected-30*time.Second {
			t.Errorf("%s TTL = %v, want about %v", key, ttl, expected)
		}
	}

	// The lease carries the NestJS physical key and is mutually exclusive.
	held := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = service.locks.WithLock(ctx, refreshLockKey, lockTTL, func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	exists, err := client.Exists(ctx, "lock:"+refreshLockKey).Result()
	if err != nil {
		t.Fatalf("exists lock: %v", err)
	}
	if exists != 1 {
		t.Error("the physical lock key is missing while the lease is held")
	}
	acquired, err := service.locks.WithLock(ctx, refreshLockKey, lockTTL, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("second WithLock: %v", err)
	}
	if acquired {
		t.Error("a second WithLock acquired a held lease")
	}
	close(release)
	<-firstDone
	acquired, err = service.locks.WithLock(ctx, refreshLockKey, lockTTL, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("third WithLock: %v", err)
	}
	if !acquired {
		t.Error("a WithLock after the release did not acquire the lease")
	}

	// The database fallback refills both cache layers. The history holds one
	// unexpired row so the fresh layer is restored as well.
	resetRows(ctx, t, db)
	insertedAt := time.Now().UTC().Truncate(time.Millisecond)
	freshPayload := samplePayload(isoTime(insertedAt), isoTime(insertedAt.Add(freshTTL)))
	insertSnapshot(ctx, t, &mysqlStore{db: db}, freshPayload, insertedAt)
	if _, err := client.Del(ctx, freshCacheKey, staleCacheKey).Result(); err != nil {
		t.Fatalf("del caches: %v", err)
	}
	result, err := service.readSnapshot(ctx)
	if err != nil {
		t.Fatalf("readSnapshot: %v", err)
	}
	if result.payload == nil || result.stale {
		t.Fatalf("result = %+v, want the unexpired history row", result)
	}
	for _, key := range []string{freshCacheKey, staleCacheKey} {
		if exists, _ := client.Exists(ctx, key).Result(); exists != 1 {
			t.Errorf("%s was not refilled from the database", key)
		}
	}
	cleanupKeys(ctx, t, client)
}

func testRealRebuild(ctx context.Context, t *testing.T, db *sql.DB, address string) {
	resetRows(ctx, t, db)
	client := redis.NewClient(&redis.Options{Addr: address})
	defer client.Close()
	cleanupKeys(ctx, t, client)
	now := time.Now().UTC().Truncate(time.Millisecond)
	stub := newGdeltStubServer(t, allCategoriesArticles())
	service := &Service{
		store:   &mysqlStore{db: db},
		cache:   redisCache{client: client},
		locks:   redisLock{client: client},
		enabled: true,
		now:     func() time.Time { return now },
		sleep:   func(context.Context, time.Duration) error { return nil },
	}
	service.fetch = newGDeltFetcher(service.now)
	service.fetch.doc2URL = stub.server.URL

	summary, err := service.ForceRefresh(ctx)
	if err != nil {
		t.Fatalf("ForceRefresh: %v", err)
	}
	if summary.Status != string(StatusCompleted) || summary.Stale || !summary.Enabled {
		t.Errorf("summary = %+v", summary)
	}
	var rowCount int
	if err := db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM SituationMonitorExternalSnapshot WHERE scope = ? AND variantKey = ? AND status = 'completed'",
		scope, variantKey).Scan(&rowCount); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if rowCount != 1 {
		t.Errorf("completed rows = %d, want 1", rowCount)
	}
	for _, key := range []string{freshCacheKey, staleCacheKey} {
		raw, err := client.Get(ctx, key).Result()
		if err != nil {
			t.Fatalf("get %s: %v", key, err)
		}
		if !strings.Contains(raw, `"status":"completed"`) {
			t.Errorf("%s = %.160s", key, raw)
		}
	}
	// A second run reuses nothing and stays completed while the lease is free
	// again.
	if _, err := service.ForceRefresh(ctx); err != nil {
		t.Fatalf("second ForceRefresh: %v", err)
	}
	cleanupKeys(ctx, t, client)
}

func cleanupKeys(ctx context.Context, t *testing.T, client *redis.Client) {
	t.Helper()
	if err := client.Del(ctx, freshCacheKey, staleCacheKey, "lock:"+refreshLockKey).Err(); err != nil {
		t.Fatalf("cleanup redis: %v", err)
	}
}

func parseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed.UTC()
}

func assertTimePtr(t *testing.T, name string, got, want *time.Time) {
	t.Helper()
	switch {
	case got == nil && want == nil:
		return
	case got == nil || want == nil:
		t.Errorf("%s = %v, want %v", name, got, want)
	case !got.Equal(*want):
		t.Errorf("%s = %s, want %s", name, got.UTC(), want.UTC())
	}
}

func assertFloatPtrEqual(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
		return
	case got == nil || want == nil:
		t.Errorf("%s = %v, want %v", name, got, want)
	case math.Abs(*got-*want) > 1e-9:
		t.Errorf("%s = %v, want %v", name, *got, *want)
	}
}
