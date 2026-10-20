//go:build integration

package situationsettings

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func integrationDB(t *testing.T) *sql.DB {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set - integration test requires MySQL")
	}
	db, err := usersettings.OpenMySQLFromURL(url)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for _, table := range []string{"AuditLogOutbox", "AuditLog", "SystemSetting"} {
		if _, err := db.ExecContext(ctx, "DROP TABLE IF EXISTS `"+table+"`"); err != nil {
			t.Fatalf("drop %s: %v", table, err)
		}
	}
	statements := []string{
		"CREATE TABLE SystemSetting (" +
			"`key` VARCHAR(191) NOT NULL, value JSON NOT NULL, isPublic BOOLEAN NOT NULL DEFAULT FALSE, " +
			"description VARCHAR(191) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"updatedAt DATETIME(3) NOT NULL, updatedById VARCHAR(191) NULL, PRIMARY KEY (`key`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE AuditLog (" +
			"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, actorId VARCHAR(191) NULL, " +
			"resource VARCHAR(191) NOT NULL, action VARCHAR(191) NOT NULL, metadata JSON NULL, " +
			"ipAddress VARCHAR(191) NULL, createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"PRIMARY KEY (id), INDEX AuditLog_orgId_createdAt (orgId, createdAt)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE AuditLogOutbox (" +
			"id VARCHAR(191) NOT NULL, orgId VARCHAR(191) NOT NULL, payload JSON NOT NULL, " +
			"status VARCHAR(32) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0, " +
			"lastError TEXT NULL, availableAt DATETIME(3) NOT NULL, lockedAt DATETIME(3) NULL, " +
			"createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updatedAt DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (id), INDEX AuditLogOutbox_status_availableAt (status, availableAt)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("create table: %v", err)
		}
	}
	return db
}

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set - integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

func integrationEnv() Env {
	env := NewEnvFromLookup(func(string) (string, bool) { return "", false })
	env.EncryptionKeyRaw = testEncryptionKeyHex
	return env
}

func clearIntegrationKeys(t *testing.T, client *redis.Client) {
	t.Helper()
	ctx := context.Background()
	for _, key := range []string{settingsCacheKey, securityCacheKey, telegramStateCacheKey} {
		if err := client.Del(ctx, key).Err(); err != nil {
			t.Fatalf("del %s: %v", key, err)
		}
	}
}

func TestSituationSettingsMySQLIntegration(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	client := integrationRedis(t)
	defer client.Close()
	clearIntegrationKeys(t, client)
	ctx := context.Background()
	service := NewService(Options{DB: db, Redis: client, Env: integrationEnv()})

	defaults, err := service.GetPublicSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if defaults.Source != SettingsSourceEnv || defaults.TranslationMaxConcurrency != 2 {
		t.Fatalf("defaults = %+v", defaults)
	}
	cached := client.Get(ctx, settingsCacheKey).Val()
	if !strings.Contains(cached, `"exists":false`) {
		t.Fatalf("cache envelope = %s", cached)
	}

	body := `{
		"translationMaxConcurrency": 4,
		"translationApiEnabled": false,
		"translationApiBaseUrl": "https://translate.test/api/",
		"translationApiKey": "translation-secret",
		"translationFallbackApiEnabled": true,
		"translationFallbackApiBaseUrl": "https://fallback.test",
		"finnhubApiKey": "finnhub-secret",
		"fredApiKey": "fred-secret",
		"translationApiTimeoutMs": 20000,
		"translationApiMaxRetries": 4,
		"telegramEnabled": true,
		"telegramChannelSet": "tech",
		"telegramMaxFeedItems": 300,
		"telegramMaxTextChars": 900,
		"telegramChannelTimeoutMs": 5000,
		"telegramPollCycleTimeoutMs": 40000,
		"telegramStartupDelayMs": 1000,
		"telegramRateLimitMs": 200,
		"telegramPollIntervalMs": 30000,
		"liveHlsProxyCnnUpstreamUrl": "https://cnn.test/live.m3u8",
		"liveHlsProxyCnnReferer": "https://cnn.test/",
		"liveHlsProxyCnnAllowedHosts": "Example.Test, example.test, cdn.test",
		"liveHlsProxyCnbcUpstreamUrl": "https://cnbc.test/live.m3u8",
		"liveHlsProxyCnbcReferer": "https://cnbc.test/",
		"liveHlsProxyCnbcAllowedHosts": "cnbc.test"
	}`
	input, err := parseUpdateSettings([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	updated, err := service.Update(ctx, "org-1", "user-1", input)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Source != SettingsSourceDB || updated.TranslationMaxConcurrency != 4 ||
		updated.TranslationAPIEnabled || updated.TranslationAPIBaseURL != "https://translate.test/api" ||
		!updated.HasTranslationAPIKey || updated.TranslationAPIKeySource != APIKeySourceStored ||
		!updated.HasFinnhubAPIKey || !updated.HasFredAPIKey || !updated.TelegramEnabled ||
		updated.TelegramChannelSet != "tech" || updated.TelegramPollIntervalMS != 30000 {
		t.Fatalf("updated = %+v", updated)
	}
	if !reflect.DeepEqual(updated.LiveHLSProxyCnnAllowedHosts, []string{"example.test", "cdn.test"}) {
		t.Fatalf("cnn hosts = %v", updated.LiveHLSProxyCnnAllowedHosts)
	}

	var raw []byte
	if err := db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", settingsKey).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	for field, want := range map[string]string{
		"translationMaxConcurrency":  "4",
		"telegramChannelSet":         `"tech"`,
		"liveHlsProxyCnnUpstreamUrl": `"https://cnn.test/live.m3u8"`,
		"telegramApiId":              "null",
		"telegramApiHash":            "null",
		"telegramSession":            "null",
	} {
		if got := strings.TrimSpace(string(stored[field])); got != want {
			t.Fatalf("%s = %s, want %s", field, got, want)
		}
	}
	for _, field := range []string{"translationApiKey", "finnhubApiKey", "fredApiKey"} {
		plain, ok := decryptSettingsSecret(stored[field], testEncryptionKeyHex)
		if !ok {
			t.Fatalf("%s is not a decryptable envelope: %s", field, stored[field])
		}
		if !strings.HasSuffix(plain, "-secret") {
			t.Fatalf("%s plaintext = %q", field, plain)
		}
	}

	var action, resource string
	var metadataRaw []byte
	if err := db.QueryRowContext(ctx,
		"SELECT action, resource, metadata FROM AuditLog WHERE orgId = ? ORDER BY createdAt DESC LIMIT 1", "org-1",
	).Scan(&action, &resource, &metadataRaw); err != nil {
		t.Fatal(err)
	}
	if action != "situation_monitor_update" || resource != "system_settings" {
		t.Fatalf("audit = %s/%s", action, resource)
	}
	var metadata map[string]any
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["translationApiKeyUpdated"] != true || metadata["finnhubApiKeyUpdated"] != true ||
		metadata["fredApiKeyUpdated"] != true || metadata["liveHlsProxyCnnUpdated"] != true {
		t.Fatalf("metadata flags = %v", metadata)
	}
	if metadata["liveHlsProxyCnnAllowedHostsCount"] != float64(2) {
		t.Fatalf("host count = %v", metadata["liveHlsProxyCnnAllowedHostsCount"])
	}
	for _, secret := range []string{"translation-secret", "finnhub-secret", "fred-secret"} {
		if strings.Contains(string(metadataRaw), secret) {
			t.Fatalf("audit metadata leaked %q", secret)
		}
	}

	// The stale `{exists:false}` envelope written by the GET above must be
	// replaced by the written document, exactly like the NestJS
	// invalidate-then-getPublicSettings sequence.
	cachedAfterUpdate := client.Get(ctx, settingsCacheKey).Val()
	if !strings.Contains(cachedAfterUpdate, `"exists":true`) ||
		!strings.Contains(cachedAfterUpdate, `"translationMaxConcurrency":4`) {
		t.Fatalf("cache after update = %s", cachedAfterUpdate)
	}

	// Force the re-read through MySQL (not the envelope just written) to prove
	// that the O3 response equals a post-write database read.
	if err := client.Del(ctx, settingsCacheKey).Err(); err != nil {
		t.Fatal(err)
	}
	reread, err := service.GetPublicSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(updated, reread) {
		t.Fatalf("O3 response differs from re-read:\n%+v\n%+v", updated, reread)
	}

	reset, err := service.Reset(ctx, "org-1", "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if reset.Source != SettingsSourceEnv || reset.HasTranslationAPIKey {
		t.Fatalf("reset = %+v", reset)
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM SystemSetting WHERE `key` = ?", settingsKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("settings row still exists")
	}
	if err := db.QueryRowContext(ctx,
		"SELECT action FROM AuditLog WHERE orgId = ? ORDER BY createdAt DESC LIMIT 1", "org-1",
	).Scan(&action); err != nil {
		t.Fatal(err)
	}
	if action != "situation_monitor_reset" {
		t.Fatalf("reset audit = %s", action)
	}
	if cachedAfterReset := client.Get(ctx, settingsCacheKey).Val(); !strings.Contains(cachedAfterReset, `"exists":false`) {
		t.Fatalf("cache after reset = %s", cachedAfterReset)
	}
}

func TestClearTelegramConfigurationIntegration(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	client := integrationRedis(t)
	defer client.Close()
	clearIntegrationKeys(t, client)
	ctx := context.Background()
	service := NewService(Options{DB: db, Redis: client, Env: integrationEnv()})

	raw := `{
		"translationMaxConcurrency":3,
		"translationApiKey":"keep-me",
		"telegramEnabled":true,
		"telegramApiId":"123",
		"telegramApiHash":"hash",
		"telegramSession":"session",
		"legacyUnknownField":"keep-me-too"
	}`
	if _, err := db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, description, updatedAt) VALUES (?, ?, ?, NOW(3))",
		settingsKey, raw, settingsDescription); err != nil {
		t.Fatal(err)
	}

	updated, err := service.ClearTelegramConfiguration(ctx, "org-1", "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if updated.TelegramEnabled || updated.HasTelegramAPIID || updated.HasTelegramAPIHash || updated.HasTelegramSession {
		t.Fatalf("updated = %+v", updated)
	}
	if !updated.HasTranslationAPIKey {
		t.Fatalf("translation key must survive")
	}

	var storedRaw []byte
	if err := db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", settingsKey).Scan(&storedRaw); err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(storedRaw, &stored); err != nil {
		t.Fatal(err)
	}
	if string(stored["telegramEnabled"]) != "false" || string(stored["telegramApiId"]) != "null" ||
		string(stored["telegramApiHash"]) != "null" || string(stored["telegramSession"]) != "null" {
		t.Fatalf("telegram fields = %s", storedRaw)
	}
	if string(stored["legacyUnknownField"]) != `"keep-me-too"` || string(stored["translationApiKey"]) != `"keep-me"` {
		t.Fatalf("preserved fields = %s", storedRaw)
	}

	var action string
	if err := db.QueryRowContext(ctx,
		"SELECT action FROM AuditLog WHERE orgId = ? ORDER BY createdAt DESC LIMIT 1", "org-1",
	).Scan(&action); err != nil {
		t.Fatal(err)
	}
	if action != "situation_monitor_telegram_clear" {
		t.Fatalf("audit = %s", action)
	}
}

func TestClearTelegramStateBroadcastIntegration(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	clearIntegrationKeys(t, client)
	ctx := context.Background()
	service := NewService(Options{DB: nil, Redis: client, Env: integrationEnv()})

	if err := client.Set(ctx, telegramStateCacheKey, `{"items":[]}`, time.Hour).Err(); err != nil {
		t.Fatal(err)
	}
	pubsub := client.Subscribe(ctx, telegramClearChannel)
	defer pubsub.Close()
	if _, err := pubsub.Receive(ctx); err != nil {
		t.Fatal(err)
	}
	service.ClearTelegramStateEverywhere(ctx)
	message, err := pubsub.ReceiveMessage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if message.Payload != `{"version":1,"clearItems":true}` {
		t.Fatalf("payload = %s", message.Payload)
	}
	if exists, err := client.Exists(ctx, telegramStateCacheKey).Result(); err != nil || exists != 0 {
		t.Fatalf("state cache must be deleted: exists=%d err=%v", exists, err)
	}
}

func TestSecretEncryptionDisabledUsesPlaintextIntegration(t *testing.T) {
	db := integrationDB(t)
	defer db.Close()
	client := integrationRedis(t)
	defer client.Close()
	clearIntegrationKeys(t, client)
	ctx := context.Background()
	service := NewService(Options{DB: db, Redis: client, Env: integrationEnv()})

	if _, err := db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, description, updatedAt) VALUES (?, ?, ?, NOW(3))",
		securitySettingsKey, `{"secretEncryptionEnabled":false}`, "security"); err != nil {
		t.Fatal(err)
	}
	input, err := parseUpdateSettings([]byte(`{"translationMaxConcurrency":3,"translationApiKey":"plain-key"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, "org-1", "user-1", input); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err := db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ?", settingsKey).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatal(err)
	}
	if string(stored["translationApiKey"]) != `"plain-key"` {
		t.Fatalf("plaintext escape hatch = %s", stored["translationApiKey"])
	}
}

// TestEncryptionNodeInterop proves both directions with NestJS's own
// node:crypto implementation: Go ciphertext decrypts in Node, and a fresh Node
// envelope (the exact format storage-settings.crypto.ts writes) decrypts in Go.
func TestEncryptionNodeInteropIntegration(t *testing.T) {
	key := testEncryptionKey(t)
	envelope, err := encryptSettingsSecret("go-to-nest", key)
	if err != nil {
		t.Fatal(err)
	}
	output := runSituationSettingsNodeFixture(t, "decrypt", map[string]string{
		"FIXTURE_KEY_HEX":  testEncryptionKeyHex,
		"FIXTURE_ENVELOPE": string(envelope),
	})
	var decrypted struct {
		Plaintext string `json:"plaintext"`
	}
	if err := json.Unmarshal([]byte(output), &decrypted); err != nil {
		t.Fatalf("node decrypt: %v\n%s", err, output)
	}
	if decrypted.Plaintext != "go-to-nest" {
		t.Fatalf("node decrypted %q", decrypted.Plaintext)
	}

	nodeEnvelope := runSituationSettingsNodeFixture(t, "encrypt", map[string]string{
		"FIXTURE_KEY_HEX":   testEncryptionKeyHex,
		"FIXTURE_PLAINTEXT": "nest-to-go",
	})
	plain, ok := decryptSettingsSecret(json.RawMessage(nodeEnvelope), testEncryptionKeyHex)
	if !ok || plain != "nest-to-go" {
		t.Fatalf("go decrypted %q ok=%v from %s", plain, ok, nodeEnvelope)
	}
}

func situationSettingsRepoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "../../../.."))
}

func runSituationSettingsNodeFixture(t *testing.T, mode string, environment map[string]string) string {
	t.Helper()
	nodePath, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatal("node is required in CI for the system-settings encryption fixture")
		}
		t.Skip("node is not installed")
	}
	root := situationSettingsRepoRoot(t)
	fixture, err := os.ReadFile(filepath.Join(root, "apps/api-go/testdata/situation_scheduler_fixture.mjs"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	command := exec.Command(nodePath, "--input-type=module")
	command.Dir = filepath.Join(root, "apps/api")
	command.Stdin = bytes.NewReader(fixture)
	env := append(os.Environ(), "FIXTURE_MODE="+mode)
	for key, value := range environment {
		env = append(env, key+"="+value)
	}
	command.Env = env
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("node fixture %s: %v\n%s", mode, err, output)
	}
	return strings.TrimSpace(string(output))
}
