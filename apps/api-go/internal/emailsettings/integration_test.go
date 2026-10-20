//go:build integration

package emailsettings

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationDB(t *testing.T) *DB {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	pool, err := usersettings.OpenMySQLFromURL(url)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = pool.Close() })
	return NewDB(pool)
}

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

const createSettingsTable = "CREATE TABLE IF NOT EXISTS SystemSetting (" +
	"`key` VARCHAR(191) NOT NULL," +
	"value JSON NOT NULL," +
	"isPublic TINYINT(1) NOT NULL DEFAULT 0," +
	"description VARCHAR(191) NULL," +
	"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
	"updatedAt DATETIME(3) NOT NULL," +
	"updatedById VARCHAR(191) NULL," +
	"PRIMARY KEY (`key`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

const createAuditTable = "CREATE TABLE IF NOT EXISTS AuditLog (" +
	"id VARCHAR(191) NOT NULL," +
	"orgId VARCHAR(191) NOT NULL," +
	"actorId VARCHAR(191) NULL," +
	"resource VARCHAR(191) NOT NULL," +
	"action VARCHAR(191) NOT NULL," +
	"metadata JSON NULL," +
	"ipAddress VARCHAR(191) NULL," +
	"createdAt DATETIME(3) NOT NULL," +
	"PRIMARY KEY (id)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"

// TestAuthCodeSettingsIntegration proves T2 against real MySQL and Redis: the row
// upsert, the description-on-insert-only rule, the audit row and the shared
// 60 second cache envelope.
func TestAuthCodeSettingsIntegration(t *testing.T) {
	db := integrationDB(t)
	rdb := integrationRedis(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := db.Exec(ctx, createSettingsTable); err != nil {
		t.Fatalf("create SystemSetting: %v", err)
	}
	if err := db.Exec(ctx, createAuditTable); err != nil {
		t.Fatalf("create AuditLog: %v", err)
	}
	if err := db.Exec(ctx, "DELETE FROM SystemSetting WHERE `key` = ?", authCodeSettingsRowKey); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(ctx, "DELETE FROM AuditLog WHERE resource = ? AND action = ?", emailAuditResource, emailAuditAction); err != nil {
		t.Fatal(err)
	}
	_ = rdb.Del(ctx, authCodeSettingsCacheKey).Err()

	service := NewService(db, rdb, baseConfig())
	first, err := service.updateSettings(ctx, "org-it", "user-it", AuthCodeSettings{TTLSeconds: 120, CooldownSeconds: 20, MaxAttempts: 2})
	if err != nil {
		t.Fatal(err)
	}
	if first.TTLSeconds != 120 || first.CooldownSeconds != 20 || first.MaxAttempts != 2 {
		t.Fatalf("first = %+v", first)
	}

	var raw []byte
	var description *string
	var updatedBy *string
	if err := db.pool.QueryRowContext(ctx,
		"SELECT value, description, updatedById FROM SystemSetting WHERE `key` = ?", authCodeSettingsRowKey).
		Scan(&raw, &description, &updatedBy); err != nil {
		t.Fatal(err)
	}
	var stored AuthCodeSettings
	if err := json.Unmarshal(raw, &stored); err != nil || stored != first {
		t.Fatalf("stored = %s err=%v", raw, err)
	}
	if description == nil || *description != authCodeDescription {
		t.Fatalf("description = %v", description)
	}
	if updatedBy == nil || *updatedBy != "user-it" {
		t.Fatalf("updatedById = %v", updatedBy)
	}

	cached, err := rdb.Get(ctx, authCodeSettingsCacheKey).Bytes()
	if err != nil {
		t.Fatalf("cache read: %v", err)
	}
	var cachedSettings AuthCodeSettings
	if err := json.Unmarshal(cached, &cachedSettings); err != nil || cachedSettings != first {
		t.Fatalf("cache = %s err=%v", cached, err)
	}
	ttl := rdb.TTL(ctx, authCodeSettingsCacheKey).Val()
	if ttl <= 0 || ttl > 60*time.Second {
		t.Fatalf("cache ttl = %v", ttl)
	}

	// A second write updates the value but must not overwrite the description.
	if _, err := service.updateSettings(ctx, "org-it", "user-it-2", AuthCodeSettings{TTLSeconds: 600, CooldownSeconds: 30, MaxAttempts: 4}); err != nil {
		t.Fatal(err)
	}
	if err := db.pool.QueryRowContext(ctx,
		"SELECT description, updatedById FROM SystemSetting WHERE `key` = ?", authCodeSettingsRowKey).
		Scan(&description, &updatedBy); err != nil {
		t.Fatal(err)
	}
	if description == nil || *description != authCodeDescription || updatedBy == nil || *updatedBy != "user-it-2" {
		t.Fatalf("after update description=%v updatedBy=%v", description, updatedBy)
	}

	var auditCount int
	if err := db.pool.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM AuditLog WHERE resource = ? AND action = ?",
		emailAuditResource, emailAuditAction).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 2 {
		t.Fatalf("audit rows = %d, want 2", auditCount)
	}

	// The read path returns the cached document and falls back to MySQL after an
	// eviction.
	fromCache, err := service.settings(ctx)
	if err != nil || fromCache.TTLSeconds != 600 {
		t.Fatalf("cached settings = %+v err=%v", fromCache, err)
	}
	_ = rdb.Del(ctx, authCodeSettingsCacheKey).Err()
	fromDB, err := service.settings(ctx)
	if err != nil || fromDB.TTLSeconds != 600 || fromDB.CooldownSeconds != 30 || fromDB.MaxAttempts != 4 {
		t.Fatalf("db settings = %+v err=%v", fromDB, err)
	}
}
