//go:build integration

// Integration tests for the situation monitor location resolver. They exercise
// the real HTTP handler, MySQL store and Redis-backed geocoding client against
// an httptest Nominatim replacement, so a regression that reintroduces a
// hard-coded URL or a private cache fails here without touching the public
// Nominatim service.
package situationmonitors

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/geocoding"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

const (
	monitorIntegrationJWTSecret   = "0123456789abcdef0123456789abcdef"
	monitorIntegrationJWTIssuer   = "modular-monolith"
	monitorIntegrationJWTAudience = "modular-monolith-clients"
)

func monitorIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set - integration test requires MySQL")
	}
	db, err := usersettings.OpenMySQLFromURL(databaseURL)
	if err != nil {
		t.Fatalf("open mysql: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func monitorIntegrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set - integration test requires Redis")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// setupMonitorIntegrationSchema mirrors the Prisma migrations for the tables
// the monitor service reads and writes. Foreign keys are omitted because the
// disposable CI database has no Org/User fixture rows.
func setupMonitorIntegrationSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	statements := []string{
		"DROP TABLE IF EXISTS `SituationMonitorMonitor`",
		"DROP TABLE IF EXISTS `UserContentSubscription`",
		"DROP TABLE IF EXISTS `ContentSubscriptionCatalog`",
		"CREATE TABLE `SituationMonitorMonitor` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, " +
			"`kind` VARCHAR(32) NOT NULL DEFAULT 'manual', `name` VARCHAR(191) NOT NULL, " +
			"`enabled` BOOLEAN NOT NULL DEFAULT TRUE, `color` VARCHAR(191) NULL, " +
			"`rawKeywords` JSON NOT NULL, `approvedTopics` JSON NOT NULL, `approvedEntities` JSON NOT NULL, " +
			"`approvedSources` JSON NULL, `approvedGeos` JSON NULL, `approvedLexicalTerms` JSON NOT NULL, " +
			"`rejectedSuggestions` JSON NULL, `locationName` VARCHAR(191) NULL, `locationLat` DOUBLE NULL, " +
			"`locationLng` DOUBLE NULL, `locationBounds` JSON NULL, `locationCountryCode` VARCHAR(191) NULL, " +
			"`queryEmbeddingModel` VARCHAR(191) NULL, `queryEmbeddingVector` JSON NULL, " +
			"`lastResolvedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"`updatedAt` DATETIME(3) NOT NULL, PRIMARY KEY (`id`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `UserContentSubscription` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, " +
			"`kind` VARCHAR(32) NOT NULL, `normalizedValue` VARCHAR(191) NOT NULL, `displayValue` VARCHAR(191) NOT NULL, " +
			"`source` VARCHAR(32) NOT NULL DEFAULT 'manual', `metadata` JSON NULL, " +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (`id`), UNIQUE KEY `UserContentSubscription_scope` (`orgId`, `userId`, `kind`, `normalizedValue`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE `ContentSubscriptionCatalog` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `kind` VARCHAR(32) NOT NULL, " +
			"`normalizedValue` VARCHAR(191) NOT NULL, `displayValue` VARCHAR(191) NOT NULL, `count` INT NOT NULL, " +
			"`lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `taxonomyPath` VARCHAR(191) NULL, " +
			"`embeddingVector` JSON NULL, PRIMARY KEY (`id`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `UserSetting` (" +
			"`id` VARCHAR(191) NOT NULL, `orgId` VARCHAR(191) NOT NULL, `userId` VARCHAR(191) NOT NULL, " +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, " +
			"`createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL, " +
			"PRIMARY KEY (`id`), UNIQUE KEY `UserSetting_scope` (`orgId`, `userId`, `key`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
		"CREATE TABLE IF NOT EXISTS `SystemSetting` (" +
			"`key` VARCHAR(191) NOT NULL, `value` JSON NOT NULL, `isPublic` BOOLEAN NOT NULL DEFAULT FALSE, " +
			"`description` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), " +
			"`updatedAt` DATETIME(3) NOT NULL, `updatedById` VARCHAR(191) NULL, PRIMARY KEY (`key`)) " +
			"DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("schema statement failed: %v", err)
		}
	}
}

type recordedNominatimRequest struct {
	path           string
	query          string
	countryCodes   string
	userAgent      string
	acceptLanguage string
	email          string
}

type fakeNominatim struct {
	server *httptest.Server
	mu     sync.Mutex
	calls  map[string]int
	reqs   []recordedNominatimRequest
	// transient maps a query to the number of initial 502 responses it should
	// return before succeeding.
	transient map[string]int
}

func newFakeNominatim(t *testing.T) *fakeNominatim {
	t.Helper()
	fake := &fakeNominatim{calls: map[string]int{}, transient: map[string]int{}}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("q")
		fake.mu.Lock()
		fake.calls[query]++
		fake.reqs = append(fake.reqs, recordedNominatimRequest{
			path:           r.URL.Path,
			query:          query,
			countryCodes:   r.URL.Query().Get("countrycodes"),
			userAgent:      r.Header.Get("User-Agent"),
			acceptLanguage: r.Header.Get("Accept-Language"),
			email:          r.URL.Query().Get("email"),
		})
		remainingTransient := fake.transient[query]
		if remainingTransient > 0 {
			fake.transient[query] = remainingTransient - 1
		}
		fake.mu.Unlock()
		if remainingTransient > 0 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if strings.Contains(query, "Missing") {
			_, _ = w.Write([]byte(`[]`))
			return
		}
		lat, lng := "48.8566", "2.3522"
		minLat, maxLat, minLng, maxLng := "48.12", "48.9", "2.05", "2.61"
		country := "fr"
		if strings.Contains(query, "Berlin") {
			lat, lng = "52.52", "13.405"
			minLat, maxLat, minLng, maxLng = "52.3", "52.7", "13.1", "13.8"
			country = "de"
		}
		_, _ = fmt.Fprintf(w, `[{"lat":"%s","lon":"%s","display_name":"%s","boundingbox":["%s","%s","%s","%s"],"address":{"country_code":"%s"}}]`,
			lat, lng, query, minLat, maxLat, minLng, maxLng, country)
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeNominatim) callCount(query string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[query]
}

func (f *fakeNominatim) lastRequest() recordedNominatimRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reqs) == 0 {
		return recordedNominatimRequest{}
	}
	return f.reqs[len(f.reqs)-1]
}

type allowAllMonitorBlacklist struct{}

func (allowAllMonitorBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

type permissiveMonitorAuthz struct{}

func (permissiveMonitorAuthz) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	return &authz.Authorization{
		UserID:      userID,
		OrgID:       orgID,
		Permissions: map[string]bool{"items.read": true},
	}, nil
}

func monitorToken(t *testing.T, userID, orgID string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":   userID,
		"orgId": orgID,
		"iss":   monitorIntegrationJWTIssuer,
		"aud":   monitorIntegrationJWTAudience,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
	})
	signed, err := token.SignedString([]byte(monitorIntegrationJWTSecret))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func newMonitorIntegrationHandler(db *sql.DB, geocoder LocationGeocoder) *Handler {
	verifier := authn.NewVerifier(monitorIntegrationJWTSecret, monitorIntegrationJWTIssuer, monitorIntegrationJWTAudience)
	chain := authhttp.NewAuthenticator(verifier, allowAllMonitorBlacklist{}, permissiveMonitorAuthz{})
	service := NewService(db, geocoder)
	// Keep the integration fixture deterministic: no model profile rows exist,
	// and a nil gateway proves the request path never reaches a real LLM.
	service.embed = nil
	return NewHandler(chain, service)
}

func monitorRequest(t *testing.T, handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeMonitorResponse(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("decode %s: %v", recorder.Body.String(), err)
	}
}

func assertLocation(t *testing.T, loc *locationDTO, wantLat, wantLng float64, wantCountry string) {
	t.Helper()
	if loc == nil {
		t.Fatal("location is nil")
	}
	if loc.Lat != wantLat || loc.Lng != wantLng {
		t.Fatalf("location lat/lng = %v/%v, want %v/%v", loc.Lat, loc.Lng, wantLat, wantLng)
	}
	if loc.CountryCodeAlpha2 != wantCountry {
		t.Fatalf("location country = %q, want %q", loc.CountryCodeAlpha2, wantCountry)
	}
	if loc.Bounds == nil {
		t.Fatal("location bounds missing")
	}
}

func assertBounds(t *testing.T, loc *locationDTO, wantMinLat, wantMaxLng float64) {
	t.Helper()
	if loc == nil || loc.Bounds == nil {
		t.Fatalf("location bounds missing: %+v", loc)
	}
	if loc.Bounds.MinLat != wantMinLat || loc.Bounds.MaxLng != wantMaxLng {
		t.Fatalf("location bounds = %+v, want minLat=%v maxLng=%v", loc.Bounds, wantMinLat, wantMaxLng)
	}
}

func TestSituationMonitorsGeocodingIntegration(t *testing.T) {
	db := monitorIntegrationDB(t)
	redisClient := monitorIntegrationRedis(t)
	setupMonitorIntegrationSchema(t, db)
	ctx := context.Background()

	if _, err := db.ExecContext(ctx, "DELETE FROM `SystemSetting` WHERE `key` = ?", "geo_nominatim_identity"); err != nil {
		t.Fatalf("clear identity setting: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), "DELETE FROM `SystemSetting` WHERE `key` = ?", "geo_nominatim_identity")
	})
	if _, err := db.ExecContext(ctx,
		"INSERT INTO `SystemSetting` (`key`, `value`, `isPublic`, `createdAt`, `updatedAt`) VALUES (?, ?, 0, NOW(3), NOW(3))",
		"geo_nominatim_identity", `{"userAgent":"Monitor Agent","email":"monitor@example.test"}`); err != nil {
		t.Fatalf("insert identity setting: %v", err)
	}

	fake := newFakeNominatim(t)
	client := geocoding.NewClient(
		geocoding.RedisCache{Client: redisClient},
		redisClient,
		geocoding.SQLSettingsReader{DB: db},
		geocoding.Config{
			BaseURL:        fake.server.URL,
			UserAgent:      "config-default-agent",
			Email:          "config-default@example.test",
			AcceptLanguage: "fr-FR,fr;q=0.9",
			Timeout:        2 * time.Second,
			CacheTTL:       time.Hour,
			NegativeTTL:    time.Hour,
			RatePerSecond:  50,
		},
	)
	// Use a per-test Redis identity cache window so a previous package test
	// cannot leak a stale identity into this client.
	_ = redisClient.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq")

	handler := newMonitorIntegrationHandler(db, client)
	token := monitorToken(t, "user-monitor-it", "org-monitor-it")
	const parisQuery = "Integration Paris"

	previewBody := `{"name":"Integration Paris Monitor","rawKeywords":["protest"],"location":{"name":"Integration Paris","lat":10.5,"lng":20.25}}`
	preview := monitorRequest(t, handler, http.MethodPost, previewPath, token, previewBody)
	if preview.Code != http.StatusCreated {
		t.Fatalf("preview status = %d %s", preview.Code, preview.Body.String())
	}
	var previewPayload previewResponse
	decodeMonitorResponse(t, preview, &previewPayload)
	assertLocation(t, previewPayload.LocationResolution, 10.5, 20.25, "FR")
	if previewPayload.LocationResolution.Bounds.MinLat != 48.12 || previewPayload.LocationResolution.Bounds.MaxLng != 2.61 {
		t.Fatalf("preview bounds = %+v", previewPayload.LocationResolution.Bounds)
	}

	request := fake.lastRequest()
	if request.path != "/search" || request.query != parisQuery || request.countryCodes != "" {
		t.Fatalf("nominatim request = %+v", request)
	}
	if request.userAgent != "Monitor Agent" || request.email != "monitor@example.test" || request.acceptLanguage != "fr-FR,fr;q=0.9" {
		t.Fatalf("nominatim identity/language = %+v", request)
	}
	if _, err := redisClient.Get(ctx, geocoding.CacheKey(parisQuery, "")).Result(); err != nil {
		t.Fatalf("shared positive cache key missing: %v", err)
	}

	createBody := `{"name":"Integration Paris Monitor","rawKeywords":["protest"],"location":{"name":"Integration Paris","lat":10.5,"lng":20.25,"countryCodeAlpha2":"FR"}}`
	created := monitorRequest(t, handler, http.MethodPost, listPath, token, createBody)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d %s", created.Code, created.Body.String())
	}
	var createdPayload storedMonitor
	decodeMonitorResponse(t, created, &createdPayload)
	assertLocation(t, createdPayload.Location, 10.5, 20.25, "FR")
	assertBounds(t, createdPayload.Location, 48.12, 2.61)
	if fake.callCount(parisQuery) != 1 {
		t.Fatalf("create did not reuse preview cache: calls=%d", fake.callCount(parisQuery))
	}

	list := monitorRequest(t, handler, http.MethodGet, listPath, token, "")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d %s", list.Code, list.Body.String())
	}
	var monitors []storedMonitor
	decodeMonitorResponse(t, list, &monitors)
	var stored *storedMonitor
	for index := range monitors {
		if monitors[index].ID == createdPayload.ID {
			stored = &monitors[index]
			break
		}
	}
	if stored == nil {
		t.Fatalf("created monitor missing from list: %+v", monitors)
	}
	assertLocation(t, stored.Location, 10.5, 20.25, "FR")
	assertBounds(t, stored.Location, 48.12, 2.61)

	const berlinQuery = "Integration Berlin, Germany"
	berlinPreviewBody := `{"name":"Integration Berlin Monitor","rawKeywords":["protest"],"location":{"name":"Integration Berlin, Germany"}}`
	berlinPreview := monitorRequest(t, handler, http.MethodPost, previewPath, token, berlinPreviewBody)
	if berlinPreview.Code != http.StatusCreated {
		t.Fatalf("berlin preview status = %d %s", berlinPreview.Code, berlinPreview.Body.String())
	}
	var berlinPayload previewResponse
	decodeMonitorResponse(t, berlinPreview, &berlinPayload)
	assertLocation(t, berlinPayload.LocationResolution, 52.52, 13.405, "DE")
	if berlinRequest := fake.lastRequest(); berlinRequest.query != berlinQuery || berlinRequest.countryCodes != "de" {
		t.Fatalf("nominatim country filter = %+v", berlinRequest)
	}

	updateBody := fmt.Sprintf(`{"location":{"name":%q,"lat":52.52,"lng":13.405,"countryCodeAlpha2":"DE"}}`, berlinQuery)
	updated := monitorRequest(t, handler, http.MethodPatch, listPath+"/"+createdPayload.ID, token, updateBody)
	if updated.Code != http.StatusOK {
		t.Fatalf("update status = %d %s", updated.Code, updated.Body.String())
	}
	var updatedPayload storedMonitor
	decodeMonitorResponse(t, updated, &updatedPayload)
	assertLocation(t, updatedPayload.Location, 52.52, 13.405, "DE")
	if fake.callCount(berlinQuery) != 1 {
		t.Fatalf("update did not reuse preview cache: calls=%d", fake.callCount(berlinQuery))
	}

	// A definitive empty result is negatively cached: the repeat preview must
	// not reach Nominatim again.
	const missingQuery = "Integration Missing Place"
	missingBody := fmt.Sprintf(`{"name":"Integration Missing Monitor","rawKeywords":["protest"],"location":{"name":%q}}`, missingQuery)
	firstMissing := monitorRequest(t, handler, http.MethodPost, previewPath, token, missingBody)
	if firstMissing.Code != http.StatusCreated {
		t.Fatalf("missing preview status = %d %s", firstMissing.Code, firstMissing.Body.String())
	}
	var firstMissingPayload previewResponse
	decodeMonitorResponse(t, firstMissing, &firstMissingPayload)
	if firstMissingPayload.LocationResolution != nil {
		t.Fatalf("missing location resolved: %+v", firstMissingPayload.LocationResolution)
	}
	secondMissing := monitorRequest(t, handler, http.MethodPost, previewPath, token, missingBody)
	if secondMissing.Code != http.StatusCreated {
		t.Fatalf("repeat missing preview status = %d %s", secondMissing.Code, secondMissing.Body.String())
	}
	if fake.callCount(missingQuery) != 1 {
		t.Fatalf("negative cache missed: calls=%d", fake.callCount(missingQuery))
	}
	if _, err := redisClient.Get(ctx, geocoding.CacheKey(missingQuery, "")).Result(); err != nil {
		t.Fatalf("shared negative cache key missing: %v", err)
	}
	createdMissing := monitorRequest(t, handler, http.MethodPost, listPath, token,
		fmt.Sprintf(`{"name":"Integration Missing Monitor","rawKeywords":["protest"],"location":{"name":%q}}`, missingQuery))
	if createdMissing.Code != http.StatusCreated {
		t.Fatalf("missing create status = %d %s", createdMissing.Code, createdMissing.Body.String())
	}
	var missingPayload storedMonitor
	decodeMonitorResponse(t, createdMissing, &missingPayload)
	if missingPayload.Location != nil {
		t.Fatalf("missing monitor stored a location: %+v", missingPayload.Location)
	}

	// A temporary 5xx is not a negative result: the next request must retry the
	// provider instead of reading a poisoned negative entry.
	const flakyQuery = "Integration Flaky Place"
	fake.mu.Lock()
	fake.transient[flakyQuery] = 1
	fake.mu.Unlock()
	flakyBody := fmt.Sprintf(`{"name":"Integration Flaky Monitor","rawKeywords":["protest"],"location":{"name":%q}}`, flakyQuery)
	firstFlaky := monitorRequest(t, handler, http.MethodPost, previewPath, token, flakyBody)
	if firstFlaky.Code != http.StatusCreated {
		t.Fatalf("flaky preview status = %d %s", firstFlaky.Code, firstFlaky.Body.String())
	}
	var firstFlakyPayload previewResponse
	decodeMonitorResponse(t, firstFlaky, &firstFlakyPayload)
	if firstFlakyPayload.LocationResolution != nil {
		t.Fatalf("transient failure resolved: %+v", firstFlakyPayload.LocationResolution)
	}
	secondFlaky := monitorRequest(t, handler, http.MethodPost, previewPath, token, flakyBody)
	if secondFlaky.Code != http.StatusCreated {
		t.Fatalf("flaky retry status = %d %s", secondFlaky.Code, secondFlaky.Body.String())
	}
	var secondFlakyPayload previewResponse
	decodeMonitorResponse(t, secondFlaky, &secondFlakyPayload)
	if secondFlakyPayload.LocationResolution == nil {
		t.Fatal("transient failure poisoned the negative cache")
	}
	if fake.callCount(flakyQuery) != 2 {
		t.Fatalf("transient retry calls=%d, want 2", fake.callCount(flakyQuery))
	}

	// The global limiter is the shared rate:geocode:nominatim key. A second
	// distinct query inside the same one-second window is rejected without a
	// provider call and without a negative entry.
	limiterClient := geocoding.NewClient(
		geocoding.RedisCache{Client: redisClient},
		redisClient,
		geocoding.SQLSettingsReader{DB: db},
		geocoding.Config{BaseURL: fake.server.URL, RatePerSecond: 1},
	)
	limiterHandler := newMonitorIntegrationHandler(db, limiterClient)
	_ = redisClient.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq")
	const limiterFirst = "Integration Limiter One"
	const limiterSecond = "Integration Limiter Two"
	firstLimited := monitorRequest(t, limiterHandler, http.MethodPost, previewPath, token,
		fmt.Sprintf(`{"name":"Integration Limiter Monitor","rawKeywords":["protest"],"location":{"name":%q}}`, limiterFirst))
	if firstLimited.Code != http.StatusCreated {
		t.Fatalf("limiter first status = %d %s", firstLimited.Code, firstLimited.Body.String())
	}
	if exists, err := redisClient.Exists(ctx, "rate:geocode:nominatim").Result(); err != nil || exists != 1 {
		t.Fatalf("shared rate limiter key exists=%d err=%v", exists, err)
	}

	// Seed one active entry in the shared window and call the resolver directly
	// so the assertion does not depend on the test crossing a wall-clock second.
	_ = redisClient.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq")
	seedNow := time.Now().UnixMilli()
	if err := redisClient.ZAdd(ctx, "rate:geocode:nominatim", redis.Z{
		Score:  float64(seedNow),
		Member: fmt.Sprintf("seed-%d", seedNow),
	}).Err(); err != nil {
		t.Fatalf("seed shared limiter: %v", err)
	}
	limiterService := NewService(db, limiterClient)
	if limited := limiterService.resolveLocation(ctx, &locationInput{Name: limiterSecond}); limited != nil {
		t.Fatalf("rate-limited lookup resolved: %+v", limited)
	}
	if fake.callCount(limiterSecond) != 0 {
		t.Fatalf("rate-limited query reached Nominatim: calls=%d", fake.callCount(limiterSecond))
	}
	_ = redisClient.Del(ctx, "rate:geocode:nominatim", "rate:geocode:nominatim:seq")
}

func TestSituationMonitorsTenantIsolationIntegration(t *testing.T) {
	db := monitorIntegrationDB(t)
	redisClient := monitorIntegrationRedis(t)
	setupMonitorIntegrationSchema(t, db)

	fake := newFakeNominatim(t)
	client := geocoding.NewClient(
		geocoding.RedisCache{Client: redisClient},
		redisClient,
		geocoding.SQLSettingsReader{DB: db},
		geocoding.Config{BaseURL: fake.server.URL, RatePerSecond: 50},
	)
	handler := newMonitorIntegrationHandler(db, client)

	orgA := fmt.Sprintf("org-monitor-a-%d", time.Now().UnixNano())
	orgB := fmt.Sprintf("org-monitor-b-%d", time.Now().UnixNano())
	tokenA := monitorToken(t, "user-monitor-a", orgA)
	tokenOtherUser := monitorToken(t, "user-monitor-other", orgA)
	tokenOtherOrg := monitorToken(t, "user-monitor-a", orgB)

	created := monitorRequest(t, handler, http.MethodPost, listPath, tokenA,
		`{"name":"Tenant Monitor","rawKeywords":["protest"],"location":{"name":"Integration Paris, France"}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d %s", created.Code, created.Body.String())
	}
	var createdPayload storedMonitor
	decodeMonitorResponse(t, created, &createdPayload)

	for name, token := range map[string]string{
		"other-user-same-org": tokenOtherUser,
		"other-org-same-user": tokenOtherOrg,
	} {
		list := monitorRequest(t, handler, http.MethodGet, listPath, token, "")
		if list.Code != http.StatusOK {
			t.Fatalf("%s list status = %d %s", name, list.Code, list.Body.String())
		}
		var monitors []storedMonitor
		decodeMonitorResponse(t, list, &monitors)
		for _, monitor := range monitors {
			if monitor.ID == createdPayload.ID {
				t.Fatalf("%s can read monitor %s", name, createdPayload.ID)
			}
		}
		update := monitorRequest(t, handler, http.MethodPatch, listPath+"/"+createdPayload.ID, token,
			`{"color":"#123456"}`)
		if update.Code != http.StatusNotFound {
			t.Fatalf("%s patch status = %d %s", name, update.Code, update.Body.String())
		}
	}

	// The owner still sees the monitor after the rejected cross-tenant writes.
	ownerList := monitorRequest(t, handler, http.MethodGet, listPath, tokenA, "")
	if ownerList.Code != http.StatusOK {
		t.Fatalf("owner list status = %d %s", ownerList.Code, ownerList.Body.String())
	}
	var ownerMonitors []storedMonitor
	decodeMonitorResponse(t, ownerList, &ownerMonitors)
	found := false
	for _, monitor := range ownerMonitors {
		if monitor.ID == createdPayload.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("owner monitor disappeared after cross-tenant attempts")
	}
}
