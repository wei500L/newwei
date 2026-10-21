//go:build integration

// Integration tests for the migrated Telegram login routes
// (POST .../telegram-auth/start and .../telegram-auth/complete).
//
// They exercise the real MySQL 8.4 row/cache writes and the real Redis
// pending-request cache and rate-limit buckets. Telegram itself is always a
// fake TelegramAuthClientFactory (no MTProto/network); the settings service,
// the Redis store/limiter adapters, the encryption envelope and the audit
// writes are the production implementations.
package situationsettings

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/telegramclient"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	// sitAuthITOrgID / UserID are the request identity of every test. Each test
	// runs in a throwaway MySQL database, so the ids only document the fixture.
	sitAuthITOrgID      = "it-org-telegram-auth"
	sitAuthITUserID     = "it-user-telegram-auth"
	sitAuthITOtherOrgID = "it-org-telegram-auth-other"
	sitAuthITOtherUser  = "it-user-telegram-auth-other"

	// sitAuthITEncryptionKeyHex is a valid 32-byte SYSTEM_SETTINGS_ENCRYPTION_KEY
	// so the Telegram api hash/session take the encrypted envelope path.
	sitAuthITEncryptionKeyHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

	// sitAuthITNestISOLayout is Date.prototype.toISOString (always 3 fractional
	// digits and Z).
	sitAuthITNestISOLayout = "2006-01-02T15:04:05.000Z"
)

var (
	sitAuthITISOTimestamp = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	sitAuthITUUIDv4       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

// sitAuthITTableStatements is the minimal Prisma-compatible schema the settings
// service touches. It is created inside the throwaway database below, so the
// login tests never depend on the tables another integration step left behind.
var sitAuthITTableStatements = []string{
	"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
		"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT FALSE, " +
		"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
		"`updatedAt` DATETIME(3) NOT NULL, `updatedById` VARCHAR(191) NULL, PRIMARY KEY (`key`)) " +
		"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AuditLog` (" +
		"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `actorId` VARCHAR(191) NULL, " +
		"`resource` VARCHAR(191) NOT NULL, `action` VARCHAR(191) NOT NULL, `metadata` JSON NULL, " +
		"`ipAddress` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
		"PRIMARY KEY (`id`), INDEX `AuditLog_orgId_createdAt` (`orgId`, `createdAt`)) " +
		"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	"CREATE TABLE IF NOT EXISTS `AuditLogOutbox` (" +
		"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `payload` JSON NOT NULL, " +
		"`status` VARCHAR(32) NOT NULL DEFAULT 'pending', `attempts` INT NOT NULL DEFAULT 0, " +
		"`lastError` TEXT NULL, `availableAt` DATETIME(3) NOT NULL, `lockedAt` DATETIME(3) NULL, " +
		"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
		"PRIMARY KEY (`id`), INDEX `AuditLogOutbox_status_availableAt` (`status`, `availableAt`)) " +
		"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
}

// ---- real Redis / MySQL fixtures ----

// sitAuthITDatabase creates a throwaway MySQL database with the settings schema.
// The job runs other integration steps against the shared `app` schema, so a
// dedicated database makes the login tests independent of their leftovers and of
// the order the job steps run in.
func sitAuthITDatabase(t *testing.T) *sql.DB {
	t.Helper()
	baseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if baseURL == "" {
		t.Skip("DATABASE_URL not set - integration test requires MySQL")
	}
	base, err := usersettings.OpenMySQLFromURL(baseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	databaseName := "situation_settings_auth_it_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if _, err := base.ExecContext(ctx, "CREATE DATABASE `"+databaseName+"`"); err != nil {
		_ = base.Close()
		t.Fatalf("create integration database: %v", err)
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		_ = base.Close()
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	parsed.Path = "/" + databaseName
	db, err := usersettings.OpenMySQLFromURL(parsed.String())
	if err != nil {
		_ = base.Close()
		t.Fatalf("open integration mysql: %v", err)
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		_ = base.Close()
		t.Fatalf("ping integration mysql: %v", err)
	}
	for _, statement := range sitAuthITTableStatements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			_ = db.Close()
			t.Fatalf("create schema: %v", err)
		}
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_ = db.Close()
		_, _ = base.ExecContext(cleanupCtx, "DROP DATABASE `"+databaseName+"`")
		_ = base.Close()
	})
	return db
}

// sitAuthITRedis addresses a dedicated Redis database so the job's other
// integration steps can never collide with the pending/rate-limit keys, and
// cleanly flushes it before and after every test.
func sitAuthITRedis(t *testing.T) *redis.Client {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set - integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: address, DB: 14, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		_ = client.Close()
		t.Fatalf("redis ping: %v", err)
	}
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		_ = client.Close()
		t.Fatalf("flush integration redis database: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = client.FlushDB(cleanupCtx).Err()
		_ = client.Close()
	})
	return client
}

// sitAuthITEnv resolves the settings environment with a valid encryption key.
func sitAuthITEnv() Env {
	return NewEnvFromLookup(func(key string) (string, bool) {
		if key == "SYSTEM_SETTINGS_ENCRYPTION_KEY" {
			return sitAuthITEncryptionKeyHex, true
		}
		return "", false
	})
}

func sitAuthITRedisString(t *testing.T, client *redis.Client, key string) string {
	t.Helper()
	value, err := client.Get(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("get %q: %v", key, err)
	}
	return value
}

func sitAuthITAssertTTL(t *testing.T, client *redis.Client, key string, want, tolerance time.Duration) {
	t.Helper()
	ttl, err := client.TTL(context.Background(), key).Result()
	if err != nil {
		t.Fatalf("ttl %q: %v", key, err)
	}
	if ttl <= 0 || ttl > want || ttl < want-tolerance {
		t.Fatalf("ttl %q = %s, want ~%s", key, ttl, want)
	}
}

// sitAuthITSession builds a valid GramJS 2.26.22 StringSession payload. The
// login fake exports these strings exactly like telegramclient.Client does.
func sitAuthITSession(t *testing.T, dc int, address string, fill byte) string {
	t.Helper()
	key := make([]byte, telegramclient.AuthKeySize)
	for index := range key {
		key[index] = byte((index*7 + int(fill)) % 256)
	}
	encoded, err := telegramclient.EncodeStringSession(telegramclient.Session{
		DC:      dc,
		Address: address,
		Port:    443,
		AuthKey: key,
	})
	if err != nil {
		t.Fatalf("encode session: %v", err)
	}
	return encoded
}

// ---- TelegramAuthClientFactory fake ----

// sitAuthITClient is one temporary-client handle. The start path opens it with
// an empty session string (fresh authorization), the complete path resumes the
// pending session string; ExportStringSession therefore returns the temporary
// session for the former and the final session for the latter, exactly like the
// real flow.
type sitAuthITClient struct {
	factory       *sitAuthITFactory
	sessionString string
}

type sitAuthITFactory struct {
	mu sync.Mutex

	sendCode TelegramSentCode
	sendErr  error

	signInErr   error
	passwordErr error
	exportErr   error

	tempSession  string
	finalSession string

	newCalls  int
	sendCalls int
	apiIDs    []int
	apiHashes []string
	sessions  []string

	sendPhones    []string
	signInCalls   int
	signInPhone   string
	signInHash    string
	signInCode    string
	passwordCalls int
	password      string
	exportCalls   int
	closeCalls    int
}

func (f *sitAuthITFactory) NewTemporary(_ context.Context, apiID int, apiHash, sessionString string) (TelegramAuthClient, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.newCalls++
	f.apiIDs = append(f.apiIDs, apiID)
	f.apiHashes = append(f.apiHashes, apiHash)
	f.sessions = append(f.sessions, sessionString)
	return &sitAuthITClient{factory: f, sessionString: sessionString}, nil
}

func (c *sitAuthITClient) SendCode(_ context.Context, phone string) (TelegramSentCode, error) {
	f := c.factory
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sendCalls++
	f.sendPhones = append(f.sendPhones, phone)
	return f.sendCode, f.sendErr
}

func (c *sitAuthITClient) SignIn(_ context.Context, phone, phoneCodeHash, code string) error {
	f := c.factory
	f.mu.Lock()
	defer f.mu.Unlock()
	f.signInCalls++
	f.signInPhone = phone
	f.signInHash = phoneCodeHash
	f.signInCode = code
	return f.signInErr
}

func (c *sitAuthITClient) SignInWithPassword(_ context.Context, password string) error {
	f := c.factory
	f.mu.Lock()
	defer f.mu.Unlock()
	f.passwordCalls++
	f.password = password
	return f.passwordErr
}

func (c *sitAuthITClient) ExportStringSession() (string, error) {
	f := c.factory
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exportCalls++
	if f.exportErr != nil {
		return "", f.exportErr
	}
	if c.sessionString == "" {
		return f.tempSession, nil
	}
	return f.finalSession, nil
}

func (c *sitAuthITClient) Close() {
	f := c.factory
	f.mu.Lock()
	f.closeCalls++
	f.mu.Unlock()
}

// sitAuthITAuthorizer mirrors platformgovernance.Authenticator.Authorize for the
// handler tests: it records the permission and returns the configured identity.
type sitAuthITAuthorizer struct {
	identity    *authhttp.Identity
	permissions []string
}

func (a *sitAuthITAuthorizer) Authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	a.permissions = append(a.permissions, permission)
	if a.identity == nil {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	return a.identity
}

// ---- handler harness ----

type sitAuthITHarness struct {
	db         *sql.DB
	redis      *redis.Client
	service    *Service
	handler    *TelegramAuthHandler
	factory    *sitAuthITFactory
	scheduler  *fakeTelegram
	authorizer *sitAuthITAuthorizer
	orgID      string
	userID     string
}

func newSitAuthITHarness(t *testing.T, orgID, userID string) *sitAuthITHarness {
	t.Helper()
	db := sitAuthITDatabase(t)
	client := sitAuthITRedis(t)

	service := NewService(Options{DB: db, Redis: client, Env: sitAuthITEnv()})
	factory := &sitAuthITFactory{
		sendCode:     TelegramSentCode{PhoneCodeHash: "code-hash-1", CodeViaApp: true},
		tempSession:  sitAuthITSession(t, 2, "149.154.167.51", 1),
		finalSession: sitAuthITSession(t, 4, "149.154.167.51", 2),
	}
	scheduler := &fakeTelegram{}
	authorizer := &sitAuthITAuthorizer{identity: authhttp.NewIdentity(userID, orgID, []string{requiredPermission})}
	handler := &TelegramAuthHandler{
		auth:     authorizer,
		settings: service,
		service: newTelegramAuthService(telegramAuthServiceOptions{
			Settings: service,
			Telegram: factory,
			Store:    newRedisTelegramAuthStore(client),
			Limiter:  newRedisTelegramAuthRateLimiter(client, false),
		}),
		external:  fakeExternal{},
		quality:   fakeQuality{},
		scheduler: scheduler,
	}
	return &sitAuthITHarness{
		db:         db,
		redis:      client,
		service:    service,
		handler:    handler,
		factory:    factory,
		scheduler:  scheduler,
		authorizer: authorizer,
		orgID:      orgID,
		userID:     userID,
	}
}

func (h *sitAuthITHarness) post(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	h.handler.ServeHTTP(recorder, request)
	return recorder
}

func (h *sitAuthITHarness) start(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return h.post(t, telegramAuthStartPath, body)
}

func (h *sitAuthITHarness) complete(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return h.post(t, telegramAuthCompletePath, body)
}

func sitAuthITDecode(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response body %s: %v", recorder.Body.String(), err)
	}
}

// pendingRequest returns a complete pending document for the fixture identity.
func (h *sitAuthITHarness) pendingRequest(requestID string) telegramAuthPending {
	return telegramAuthPending{
		RequestID:       requestID,
		OrgID:           h.orgID,
		ActorID:         h.userID,
		TelegramAPIID:   "123456",
		TelegramAPIHash: "hash-abc",
		PhoneNumber:     "+14155552671",
		PhoneCodeHash:   "code-hash-1",
		Session:         h.factory.tempSession,
		CreatedAt:       "2026-10-20T20:47:16.123Z",
	}
}

// seedPending writes the pending document through the production Redis store
// adapter (the same bytes startAuth writes).
func (h *sitAuthITHarness) seedPending(t *testing.T, pending telegramAuthPending) {
	t.Helper()
	payload, err := marshalTelegramAuthPending(pending)
	if err != nil {
		t.Fatalf("marshal pending document: %v", err)
	}
	if err := newRedisTelegramAuthStore(h.redis).Save(context.Background(), telegramAuthCacheKey(pending.RequestID), payload, telegramAuthRequestTTLSeconds*time.Second); err != nil {
		t.Fatalf("seed pending document: %v", err)
	}
}

func (h *sitAuthITHarness) pendingExists(t *testing.T, requestID string) bool {
	t.Helper()
	exists, err := h.redis.Exists(context.Background(), telegramAuthCacheKey(requestID)).Result()
	if err != nil {
		t.Fatalf("exists pending document: %v", err)
	}
	return exists == 1
}

func (h *sitAuthITHarness) settingsRow(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var raw []byte
	err := h.db.QueryRowContext(context.Background(),
		"SELECT `value` FROM `SystemSetting` WHERE `key` = ?", settingsKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		t.Fatalf("read settings row: %v", err)
	}
	var value map[string]json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode settings row %s: %v", raw, err)
	}
	return value
}

func (h *sitAuthITHarness) latestAuditMetadata(t *testing.T) map[string]any {
	t.Helper()
	var action string
	var raw []byte
	err := h.db.QueryRowContext(context.Background(),
		"SELECT `action`, `metadata` FROM `AuditLog` WHERE `orgId` = ? ORDER BY `createdAt` DESC LIMIT 1", h.orgID,
	).Scan(&action, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		t.Fatalf("read audit row: %v", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatalf("decode audit metadata %s: %v", raw, err)
	}
	if action != "situation_monitor_update" {
		t.Fatalf("audit action = %q, want situation_monitor_update", action)
	}
	return metadata
}

// assertStartResponse checks the startAuth response and the Redis pending
// document it caches (field order included).
func (h *sitAuthITHarness) assertStartResponse(t *testing.T, recorder *httptest.ResponseRecorder, requestBody string) telegramAuthStartResult {
	t.Helper()
	if recorder.Code != http.StatusCreated {
		t.Fatalf("start status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	var started telegramAuthStartResult
	sitAuthITDecode(t, recorder, &started)
	if !sitAuthITUUIDv4.MatchString(started.RequestID) {
		t.Fatalf("requestId = %q, want a lowercase RFC 4122 v4 UUID", started.RequestID)
	}
	if !started.IsCodeViaApp {
		t.Fatalf("isCodeViaApp = false, want the fake's true")
	}
	if !sitAuthITISOTimestamp.MatchString(started.ExpiresAt) {
		t.Fatalf("expiresAt = %q, want ISO milliseconds Z", started.ExpiresAt)
	}
	if !strings.Contains(requestBody, "123456") || !strings.Contains(requestBody, "hash-abc") {
		t.Fatalf("test bug: start body must carry the credentials: %s", requestBody)
	}

	// The cached pending document is JSON.stringify-compatible: exact field
	// order requestId, orgId, actorId, telegramApiId, telegramApiHash,
	// phoneNumber, phoneCodeHash, session, createdAt.
	key := telegramAuthCacheKey(started.RequestID)
	raw := sitAuthITRedisString(t, h.redis, key)
	pendingPattern := regexp.MustCompile(
		`^\{"requestId":"` + started.RequestID +
			`","orgId":"` + h.orgID +
			`","actorId":"` + h.userID +
			`","telegramApiId":"123456","telegramApiHash":"hash-abc","phoneNumber":"\+14155552671"` +
			`,"phoneCodeHash":"code-hash-1","session":"` + regexp.QuoteMeta(h.factory.tempSession) +
			`","createdAt":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)"\}$`)
	match := pendingPattern.FindStringSubmatch(raw)
	if match == nil {
		t.Fatalf("pending document bytes = %s, want the NestJS JSON.stringify shape", raw)
	}
	createdAt, err := time.Parse(sitAuthITNestISOLayout, match[1])
	if err != nil {
		t.Fatalf("parse createdAt %q: %v", match[1], err)
	}
	expiresAt, err := time.Parse(sitAuthITNestISOLayout, started.ExpiresAt)
	if err != nil {
		t.Fatalf("parse expiresAt %q: %v", started.ExpiresAt, err)
	}
	if expiresAt.Sub(createdAt) != 10*time.Minute {
		t.Fatalf("expiresAt - createdAt = %s, want 10m", expiresAt.Sub(createdAt))
	}
	sitAuthITAssertTTL(t, h.redis, key, 10*time.Minute, time.Minute)
	return started
}

// assertStartRateLimitKeys checks the three sliding-window buckets the start
// route consumes and their :seq counters on the real Redis.
func (h *sitAuthITHarness) assertStartRateLimitKeys(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	phoneHash := sha256.Sum256([]byte("+14155552671"))
	keys := []string{
		"rate:" + telegramAuthStartRateLimitKeyUserPrefix + h.orgID + ":" + h.userID,
		"rate:" + telegramAuthStartRateLimitKeyIPPrefix + h.orgID + ":" + "192.0.2.1",
		"rate:" + telegramAuthStartRateLimitKeyPhonePrefix + h.orgID + ":" + hex.EncodeToString(phoneHash[:]),
	}
	for _, key := range keys {
		if count, err := h.redis.ZCard(ctx, key).Result(); err != nil || count != 1 {
			t.Fatalf("rate bucket %q zcard = %d (err=%v), want 1", key, count, err)
		}
		if sequence, err := h.redis.Get(ctx, key+":seq").Result(); err != nil || sequence != "1" {
			t.Fatalf("rate bucket %q seq = %q (err=%v), want 1", key, sequence, err)
		}
		sitAuthITAssertTTL(t, h.redis, key, 20*time.Minute, 2*time.Minute)
		sitAuthITAssertTTL(t, h.redis, key+":seq", 20*time.Minute, 2*time.Minute)
	}
}

// TestTelegramAuthStartIntegration covers startAuth end to end: DTO validation
// passes, the fake temporary client sends the code and exports a GramJS
// session, the 201 response and the 600s pending cache document are exact, the
// three rate-limit buckets are consumed, and a fourth request is quota-limited
// before reaching Telegram.
func TestTelegramAuthStartIntegration(t *testing.T) {
	h := newSitAuthITHarness(t, sitAuthITOrgID, sitAuthITUserID)
	const startBody = `{"telegramApiId":" 123456 ","telegramApiHash":" hash-abc ","phoneNumber":"+14155552671"}`

	h.assertStartResponse(t, h.start(t, startBody), startBody)
	if h.factory.sendCalls != 1 || h.factory.closeCalls != 1 || h.factory.newCalls != 1 {
		t.Fatalf("factory calls send/close/new = %d/%d/%d, want 1/1/1", h.factory.sendCalls, h.factory.closeCalls, h.factory.newCalls)
	}
	if len(h.factory.sendPhones) != 1 || h.factory.sendPhones[0] != "+14155552671" {
		t.Fatalf("SendCode phones = %v", h.factory.sendPhones)
	}
	if len(h.factory.apiIDs) != 1 || h.factory.apiIDs[0] != 123456 ||
		len(h.factory.apiHashes) != 1 || h.factory.apiHashes[0] != "hash-abc" {
		t.Fatalf("temporary client credentials = %v/%v", h.factory.apiIDs, h.factory.apiHashes)
	}
	if h.factory.sessions[0] != "" {
		t.Fatalf("startAuth must open the temporary client with an empty session, got %q", h.factory.sessions[0])
	}
	if len(h.authorizer.permissions) != 1 || h.authorizer.permissions[0] != requiredPermission {
		t.Fatalf("authorizer permissions = %v, want %s", h.authorizer.permissions, requiredPermission)
	}
	h.assertStartRateLimitKeys(t)

	// The phone bucket allows three requests in the 10 minute window; the fourth
	// is a 429 TELEGRAM_AUTH_RATE_LIMIT and never reaches the Telegram factory.
	for attempt := 0; attempt < 2; attempt++ {
		if recorder := h.start(t, startBody); recorder.Code != http.StatusCreated {
			t.Fatalf("extra start #%d status = %d (body=%s)", attempt+1, recorder.Code, recorder.Body.String())
		}
	}
	limited := h.start(t, startBody)
	if limited.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited start status = %d, want 429 (body=%s)", limited.Code, limited.Body.String())
	}
	var errorBody telegramAuthErrorBody
	sitAuthITDecode(t, limited, &errorBody)
	if errorBody.StatusCode != http.StatusTooManyRequests || errorBody.Code != telegramAuthCodeRateLimit ||
		errorBody.Message != telegramAuthCodeRateLimit || errorBody.Error != "Too Many Requests" {
		t.Fatalf("rate-limit body = %+v", errorBody)
	}
	if errorBody.Path != telegramAuthStartPath || !sitAuthITISOTimestamp.MatchString(errorBody.Timestamp) {
		t.Fatalf("rate-limit body path/timestamp = %q/%q", errorBody.Path, errorBody.Timestamp)
	}
	if h.factory.sendCalls != 3 {
		t.Fatalf("SendCode calls after the quota = %d, want 3 (rate limit runs before Telegram)", h.factory.sendCalls)
	}
}

// TestTelegramAuthCompleteIntegration covers the whole start -> complete flow
// against real Redis/MySQL: the pending session is resumed, the final GramJS
// session is exported, the four settings members are written (hash/session as
// encrypted envelopes that the service decrypts back), the pending document is
// deleted, an audit row is written and the controller's settings response with
// externalSnapshotStatus/qualitySummary is returned.
func TestTelegramAuthCompleteIntegration(t *testing.T) {
	h := newSitAuthITHarness(t, sitAuthITOrgID, sitAuthITUserID)
	const startBody = `{"telegramApiId":"123456","telegramApiHash":"hash-abc","phoneNumber":"+14155552671"}`
	started := h.assertStartResponse(t, h.start(t, startBody), startBody)

	recorder := h.complete(t, `{"requestId":"`+started.RequestID+`","phoneCode":" 12345 ","enableTelegram":true}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("complete status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	var response settingsResponse
	sitAuthITDecode(t, recorder, &response)
	if !response.TelegramEnabled || !response.HasTelegramAPIID || !response.HasTelegramAPIHash || !response.HasTelegramSession {
		t.Fatalf("complete response = %+v", response.PublicSettings)
	}
	if response.TelegramAPIID == nil || *response.TelegramAPIID != "123456" {
		t.Fatalf("telegramApiId = %v", response.TelegramAPIID)
	}
	if response.TelegramAPIIDSource != APIKeySourceStored ||
		response.TelegramAPIHashSource != APIKeySourceStored ||
		response.TelegramSessionSource != APIKeySourceStored {
		t.Fatalf("sources = %s/%s/%s", response.TelegramAPIIDSource, response.TelegramAPIHashSource, response.TelegramSessionSource)
	}
	if response.TelegramPollIntervalMS != 60000 {
		t.Fatalf("telegramPollIntervalMs = %d, want the env default 60000", response.TelegramPollIntervalMS)
	}
	if len(response.ExternalSnapshotStatus) == 0 || string(response.ExternalSnapshotStatus) == "null" {
		t.Fatalf("externalSnapshotStatus = %s", response.ExternalSnapshotStatus)
	}
	if string(response.QualitySummary) != "null" {
		t.Fatalf("qualitySummary = %s, want null", response.QualitySummary)
	}

	// The pending request is gone and the final session was resumed from it.
	if h.pendingExists(t, started.RequestID) {
		t.Fatal("pending request must be deleted after a successful complete")
	}
	if h.factory.newCalls != 2 {
		t.Fatalf("factory calls = %d, want 2 (start + complete)", h.factory.newCalls)
	}
	if h.factory.sessions[1] != h.factory.tempSession {
		t.Fatalf("complete session = %q, want the pending temporary session", h.factory.sessions[1])
	}
	if h.factory.signInCalls != 1 || h.factory.signInCode != "12345" || h.factory.signInPhone != "+14155552671" || h.factory.signInHash != "code-hash-1" {
		t.Fatalf("sign-in call = %d phone=%q hash=%q code=%q", h.factory.signInCalls, h.factory.signInPhone, h.factory.signInHash, h.factory.signInCode)
	}
	if h.factory.exportCalls != 2 || h.factory.closeCalls != 2 {
		t.Fatalf("export/close calls = %d/%d, want 2/2", h.factory.exportCalls, h.factory.closeCalls)
	}

	// The settings row carries the four members; the api hash and the session
	// are system-settings:v1 envelopes the service decrypts back.
	row := h.settingsRow(t)
	if row == nil {
		t.Fatal("settings row was not written")
	}
	if string(row["telegramEnabled"]) != "true" {
		t.Fatalf("telegramEnabled = %s", row["telegramEnabled"])
	}
	if string(row["telegramApiId"]) != `"123456"` {
		t.Fatalf("telegramApiId = %s", row["telegramApiId"])
	}
	for _, field := range []string{"telegramApiHash", "telegramSession"} {
		if !isEncryptedSettingsValue(row[field]) {
			t.Fatalf("%s is not an encrypted envelope: %s", field, row[field])
		}
	}
	if plain, ok := decryptSettingsSecret(row["telegramApiHash"], sitAuthITEncryptionKeyHex); !ok || plain != "hash-abc" {
		t.Fatalf("decrypted telegramApiHash = %q ok=%v", plain, ok)
	}
	if plain, ok := decryptSettingsSecret(row["telegramSession"], sitAuthITEncryptionKeyHex); !ok || plain != h.factory.finalSession {
		t.Fatalf("decrypted telegramSession = %q ok=%v", plain, ok)
	}

	// EffectiveSettings (the worker's read path) decrypts the same row.
	if err := h.redis.Del(context.Background(), settingsCacheKey).Err(); err != nil {
		t.Fatalf("delete settings cache: %v", err)
	}
	effective, err := h.service.EffectiveSettings(context.Background())
	if err != nil {
		t.Fatalf("EffectiveSettings: %v", err)
	}
	if !effective.TelegramEnabled || effective.TelegramAPIID != "123456" ||
		effective.TelegramAPIHash != "hash-abc" || effective.TelegramSession != h.factory.finalSession {
		t.Fatalf("effective telegram settings = %+v", effective)
	}

	// The audit row mirrors the settings PUT metadata flags.
	metadata := h.latestAuditMetadata(t)
	if metadata == nil {
		t.Fatal("audit row missing")
	}
	for _, flag := range []string{"telegramApiIdUpdated", "telegramApiHashUpdated", "telegramSessionUpdated"} {
		if metadata[flag] != true {
			t.Fatalf("audit metadata %s = %v", flag, metadata[flag])
		}
	}
	if strings.Contains(string(mustJSON(t, metadata)), h.factory.finalSession) {
		t.Fatal("audit metadata leaked the Telegram session")
	}

	// The controller hot-syncs the poll schedule with the written settings.
	if h.scheduler.calls != 1 || !h.scheduler.enabled || h.scheduler.every != response.TelegramPollIntervalMS {
		t.Fatalf("scheduler sync = calls:%d enabled:%t every:%d", h.scheduler.calls, h.scheduler.enabled, h.scheduler.every)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

// TestTelegramAuthCompletePasswordIntegration covers the 2FA branch: SignIn
// reports ErrTelegramPasswordNeeded, a request without password is a 400
// TELEGRAM_AUTH_PASSWORD_REQUIRED that keeps the pending document, and a
// request with password calls SignInWithPassword and completes the login.
func TestTelegramAuthCompletePasswordIntegration(t *testing.T) {
	h := newSitAuthITHarness(t, sitAuthITOrgID, sitAuthITUserID)
	const requestID = "22222222-3333-4444-8555-666666666666"
	h.seedPending(t, h.pendingRequest(requestID))
	h.factory.signInErr = ErrTelegramPasswordNeeded

	recorder := h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("missing-password status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	var errorBody telegramAuthErrorBody
	sitAuthITDecode(t, recorder, &errorBody)
	if errorBody.Code != telegramAuthCodePasswordRequired || errorBody.Message != telegramAuthCodePasswordRequired || errorBody.Error != "Bad Request" {
		t.Fatalf("missing-password body = %+v", errorBody)
	}
	if !h.pendingExists(t, requestID) {
		t.Fatal("the pending request must survive a password-required error")
	}
	if h.settingsRow(t) != nil {
		t.Fatal("no settings row may be written before the password step succeeds")
	}
	if h.factory.passwordCalls != 0 || h.factory.newCalls != 1 {
		t.Fatalf("password/new calls = %d/%d, want 0/1", h.factory.passwordCalls, h.factory.newCalls)
	}

	// The retry with the trimmed password succeeds through SignInWithPassword.
	recorder = h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345","password":"  secret  "}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("password status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if h.factory.passwordCalls != 1 || h.factory.password != "secret" {
		t.Fatalf("SignInWithPassword = calls:%d password:%q", h.factory.passwordCalls, h.factory.password)
	}
	if h.pendingExists(t, requestID) {
		t.Fatal("pending request must be deleted after the password login")
	}
	row := h.settingsRow(t)
	if row == nil {
		t.Fatal("settings row was not written after the password login")
	}
	if plain, ok := decryptSettingsSecret(row["telegramSession"], sitAuthITEncryptionKeyHex); !ok || plain != h.factory.finalSession {
		t.Fatalf("stored session = %q ok=%v", plain, ok)
	}
}

// TestTelegramAuthCompleteSignUpIntegration covers the sign-up-required branch:
// Telegram reports that the phone has no account, the handler answers 400
// TELEGRAM_AUTH_SIGNUP_REQUIRED and neither the settings row nor the pending
// document is touched.
func TestTelegramAuthCompleteSignUpIntegration(t *testing.T) {
	h := newSitAuthITHarness(t, sitAuthITOrgID, sitAuthITUserID)
	const requestID = "33333333-4444-4555-8666-777777777777"
	h.seedPending(t, h.pendingRequest(requestID))
	h.factory.signInErr = ErrTelegramSignUpRequired

	recorder := h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("sign-up status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	var errorBody telegramAuthErrorBody
	sitAuthITDecode(t, recorder, &errorBody)
	if errorBody.Code != telegramAuthCodeSignUpRequired || errorBody.Message != telegramAuthCodeSignUpRequired {
		t.Fatalf("sign-up body = %+v", errorBody)
	}
	if !h.pendingExists(t, requestID) {
		t.Fatal("pending request must survive a sign-up-required error")
	}
	if h.settingsRow(t) != nil {
		t.Fatal("no settings row may be written when sign up is required")
	}
	if h.factory.newCalls != 1 || h.factory.signInCalls != 1 {
		t.Fatalf("factory/sign-in calls = %d/%d", h.factory.newCalls, h.factory.signInCalls)
	}
}

// TestTelegramAuthRequestOwnershipIntegration covers the ownership and expiry
// branches: a pending request owned by another org or actor is rejected with
// TELEGRAM_AUTH_REQUEST_MISMATCH before any Telegram client is created, and a
// missing/expired pending document is TELEGRAM_AUTH_REQUEST_EXPIRED.
func TestTelegramAuthRequestOwnershipIntegration(t *testing.T) {
	h := newSitAuthITHarness(t, sitAuthITOrgID, sitAuthITUserID)
	const requestID = "44444444-5555-4666-8777-888888888888"

	foreignOrg := h.pendingRequest(requestID)
	foreignOrg.OrgID = sitAuthITOtherOrgID
	foreignOrg.ActorID = sitAuthITOtherUser
	h.seedPending(t, foreignOrg)
	recorder := h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("foreign-org status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	var errorBody telegramAuthErrorBody
	sitAuthITDecode(t, recorder, &errorBody)
	if errorBody.Code != telegramAuthCodeRequestMismatch || errorBody.Message != telegramAuthCodeRequestMismatch {
		t.Fatalf("foreign-org body = %+v", errorBody)
	}
	if h.factory.newCalls != 0 {
		t.Fatalf("factory calls = %d, want 0 before the ownership check", h.factory.newCalls)
	}
	if !h.pendingExists(t, requestID) {
		t.Fatal("the mismatched pending request must not be deleted")
	}

	// Same org, different actor: also a mismatch.
	foreignActor := h.pendingRequest(requestID)
	foreignActor.ActorID = sitAuthITOtherUser
	h.seedPending(t, foreignActor)
	recorder = h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("foreign-actor status = %d, want 400", recorder.Code)
	}
	sitAuthITDecode(t, recorder, &errorBody)
	if errorBody.Code != telegramAuthCodeRequestMismatch {
		t.Fatalf("foreign-actor body = %+v", errorBody)
	}

	// Deleting the cache entry makes the request expire.
	if err := h.redis.Del(context.Background(), telegramAuthCacheKey(requestID)).Err(); err != nil {
		t.Fatalf("delete pending document: %v", err)
	}
	recorder = h.complete(t, `{"requestId":"`+requestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expired status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	sitAuthITDecode(t, recorder, &errorBody)
	if errorBody.Code != telegramAuthCodeRequestExpired || errorBody.Message != telegramAuthCodeRequestExpired {
		t.Fatalf("expired body = %+v", errorBody)
	}
	if h.factory.newCalls != 0 {
		t.Fatalf("factory calls = %d, want 0 for expired/mismatched requests", h.factory.newCalls)
	}
	if h.settingsRow(t) != nil {
		t.Fatal("no settings row may be written for rejected requests")
	}
}

// TestTelegramClientSessionCrossPackageRoundTripIntegration is A1 from the
// settings package's point of view: the GramJS session string the login flow
// exports is encoded/decoded by internal/telegramclient and re-encodes to the
// exact same bytes.
func TestTelegramClientSessionCrossPackageRoundTripIntegration(t *testing.T) {
	key := make([]byte, telegramclient.AuthKeySize)
	for index := range key {
		key[index] = byte((index * 11) % 256)
	}
	session := telegramclient.Session{
		DC:      2,
		Address: "149.154.167.51",
		Port:    443,
		AuthKey: key,
	}
	encoded, err := telegramclient.EncodeStringSession(session)
	if err != nil {
		t.Fatalf("encode session: %v", err)
	}
	if !strings.HasPrefix(encoded, "1") {
		t.Fatalf("session string %q does not carry the GramJS version prefix", encoded)
	}
	decoded, err := telegramclient.DecodeStringSession(encoded)
	if err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if decoded.DC != session.DC || decoded.Address != session.Address || decoded.Port != session.Port {
		t.Fatalf("decoded session = %+v, want %+v", decoded, session)
	}
	if !bytes.Equal(decoded.AuthKey, session.AuthKey) {
		t.Fatalf("auth key round trip changed the bytes")
	}
	reencoded, err := telegramclient.EncodeStringSession(decoded)
	if err != nil {
		t.Fatalf("re-encode session: %v", err)
	}
	if reencoded != encoded {
		t.Fatalf("re-encoded session = %q, want %q", reencoded, encoded)
	}
}
