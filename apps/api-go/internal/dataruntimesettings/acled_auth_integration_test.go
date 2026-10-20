//go:build integration

// ACLED OAuth state integration tests against the real MySQL and Redis CI
// services. The token endpoint is an in-process httptest server, so no real ACLED
// request is made.
//
// The ACLED API policy is disabled in production code (Open myACLED has no API
// access). These tests call the resolver internals directly so the lock, the
// cooldown and the stored state machine stay covered for the day the policy is
// enabled.
package dataruntimesettings

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const acledIntegrationKey = "realtime_signals_acled_auth_state"

func openAcledIntegration(t *testing.T) (*Service, *sql.DB, *redis.Client) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set — integration test requires MySQL")
	}
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires Redis")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	rdb := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = rdb.Close() })

	statements := []string{
		"DROP TABLE IF EXISTS `SystemSetting`",
		"CREATE TABLE `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT false," +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)," +
			"`updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedById` VARCHAR(191) NULL," +
			"PRIMARY KEY (`key`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	_ = rdb.Del(context.Background(), cacheKeyAcledAuthState, cacheKeyRealtime).Err()
	service := NewService(db, rdb, Config{NodeEnv: "test"})
	return service, db, rdb
}

func TestAcledAuthStateIntegration(t *testing.T) {
	service, db, rdb := openAcledIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	now := time.Now().UTC().Truncate(time.Millisecond)
	expiresAt := now.Add(time.Hour)
	state := &parsedAcledAuthState{
		accessToken:   "acled-access-token",
		expiresAt:     nestTimestamp(expiresAt),
		refreshedAt:   nestTimestamp(now),
		lastAttemptAt: nestTimestamp(now),
	}
	if err := service.persistAcledAuthState(ctx, state); err != nil {
		t.Fatalf("persist: %v", err)
	}

	var raw []byte
	var description sql.NullString
	if err := db.QueryRowContext(ctx, "SELECT value, description FROM SystemSetting WHERE `key` = ?", acledIntegrationKey).
		Scan(&raw, &description); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if description.String != descriptionAcledAuthState {
		t.Fatalf("description = %q", description.String)
	}
	var stored writtenAcledAuthState
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("decode row: %v", err)
	}
	if stored.Version != 1 || stored.ExpiresAt == nil || stored.RefreshedAt == nil {
		t.Fatalf("stored state = %+v", stored)
	}
	var accessToken string
	if err := json.Unmarshal(stored.AccessToken, &accessToken); err != nil || accessToken != "acled-access-token" {
		t.Fatalf("stored access token = %s/%v", stored.AccessToken, err)
	}

	loaded, err := service.loadAcledAuthState(ctx)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded == nil || loaded.accessToken != "acled-access-token" || loaded.expiresAt == "" {
		t.Fatalf("loaded = %+v", loaded)
	}

	// The cache envelope is written with exists=true and is invalidated by the
	// next write.
	if _, found, err := cacheEnvelope(t, ctx, rdb); err != nil || !found {
		t.Fatalf("cache envelope found=%t err=%v", found, err)
	}
	if err := service.clearAcledAuthState(ctx); err != nil {
		t.Fatalf("clear: %v", err)
	}
	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM SystemSetting WHERE `key` = ?", acledIntegrationKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("row count after clear = %d", count)
	}
	if _, found, err := cacheEnvelope(t, ctx, rdb); err != nil || found {
		t.Fatalf("cache envelope after clear found=%t err=%v", found, err)
	}
}

func cacheEnvelope(t *testing.T, ctx context.Context, rdb *redis.Client) (cachedAcledAuthState, bool, error) {
	t.Helper()
	raw, err := rdb.Get(ctx, cacheKeyAcledAuthState).Bytes()
	if err != nil {
		if err == redis.Nil {
			return cachedAcledAuthState{}, false, nil
		}
		return cachedAcledAuthState{}, false, err
	}
	var envelope cachedAcledAuthState
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return cachedAcledAuthState{}, false, err
	}
	return envelope, true, nil
}

func TestAcledRefreshLockIntegration(t *testing.T) {
	service, db, _ := openAcledIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()

	var requests int
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests++
		mu.Unlock()
		if err := r.ParseForm(); err != nil ||
			r.Form.Get("grant_type") != "password" ||
			r.Form.Get("username") != "acled-user" ||
			r.Form.Get("client_id") != "acled" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"acled-token","expires_in":3600}`))
	}))
	defer server.Close()

	previousURL := acledOAuthURL
	acledOAuthURL = server.URL
	defer func() { acledOAuthURL = previousURL }()

	effective := &effectiveRealtimeSettings{
		AcledOauthUsername: "acled-user",
		AcledOauthPassword: "acled-password",
		AcledOauthClientID: "acled",
		RequestTimeoutMs:   2000,
		MaxRetries:         0,
	}

	var waitGroup sync.WaitGroup
	results := make([]*parsedAcledAuthState, 2)
	errorsByIndex := make([]error, 2)
	for index := 0; index < 2; index++ {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			state, err := service.refreshAcledAccessToken(ctx, effective, nil, false)
			results[index] = state
			errorsByIndex[index] = err
		}(index)
	}
	waitGroup.Wait()

	for index := range results {
		if errorsByIndex[index] != nil {
			t.Fatalf("refresh %d: %v", index, errorsByIndex[index])
		}
		if results[index] == nil || results[index].accessToken != "acled-token" {
			t.Fatalf("refresh %d state = %+v", index, results[index])
		}
	}
	mu.Lock()
	tokenRequests := requests
	mu.Unlock()
	if tokenRequests != 1 {
		t.Fatalf("token requests = %d, want 1 (the shared lock serializes refreshes)", tokenRequests)
	}

	var count int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM SystemSetting WHERE `key` = ?", acledIntegrationKey).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("persisted rows = %d", count)
	}
	// The winner invalidates the cache and a waiting refresher may repopulate it
	// from MySQL; either way the shared state must hold the new token.
	loaded, err := service.loadAcledAuthState(ctx)
	if err != nil || loaded == nil || loaded.accessToken != "acled-token" {
		t.Fatalf("loaded state = %+v/%v", loaded, err)
	}
}
