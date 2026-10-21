package infrastructuresettings

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// The auth fakes mirror the other Go handler tests: a real authhttp chain with
// a test-signed HS256 access token, an always-empty blacklist and a fixed
// permission set. The machine-token path is not exercised here; the route uses
// the ordinary human chain.
const (
	vectorDiagnosticsTestSecret   = "vector-diagnostics-test-secret"
	vectorDiagnosticsTestIssuer   = "modular-monolith"
	vectorDiagnosticsTestAudience = "modular-monolith-clients"
)

// vectorDiagnosticsBlacklist never reports a revoked token.
type vectorDiagnosticsBlacklist struct{}

// Revoked implements authn.Blacklist.
func (vectorDiagnosticsBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

// vectorDiagnosticsAuthz grants exactly the configured permissions.
type vectorDiagnosticsAuthz struct{ permissions []string }

// Authorize implements authz.Repository.
func (a vectorDiagnosticsAuthz) Authorize(context.Context, string, string) (*authz.Authorization, error) {
	permissions := make(map[string]bool, len(a.permissions))
	for _, name := range a.permissions {
		permissions[name] = true
	}
	return &authz.Authorization{UserID: "user-1", OrgID: "org-1", Permissions: permissions}, nil
}

// mintVectorDiagnosticsToken signs an access token the test verifier accepts.
func mintVectorDiagnosticsToken(t *testing.T) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":   "user-1",
		"orgId": "org-1",
		"iss":   vectorDiagnosticsTestIssuer,
		"aud":   vectorDiagnosticsTestAudience,
		"exp":   time.Now().Add(time.Hour).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(vectorDiagnosticsTestSecret))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// vectorDiagnosticsEnv is the environment default block used by the tests.
func vectorDiagnosticsEnv() Config {
	return Config{
		VectorEnabled:         true,
		VectorFallbackToMongo: true,
		VectorBaseURL:         "http://vector.internal",
		VectorToken:           "env-token",
		VectorTimeoutMs:       5000,
		VectorMaxRetries:      2,
	}
}

// newVectorDiagnosticsTestHandler builds the handler over the in-memory
// SystemSetting store.
func newVectorDiagnosticsTestHandler(t *testing.T, settings map[string]string, cfg Config, permissions []string, health *vectorclient.Health) *VectorDiagnosticsHandler {
	t.Helper()
	store := newFakeMySQL(settings)
	service := NewService(store.db(), nil, cfg)
	chain := authhttp.NewAuthenticator(
		authn.NewVerifier(vectorDiagnosticsTestSecret, vectorDiagnosticsTestIssuer, vectorDiagnosticsTestAudience),
		vectorDiagnosticsBlacklist{},
		vectorDiagnosticsAuthz{permissions: permissions},
	)
	return NewVectorDiagnosticsHandler(service, NewAuthenticator(chain, store.db()), health)
}

// serveVectorDiagnostics runs one request through the handler.
func serveVectorDiagnostics(t *testing.T, handler *VectorDiagnosticsHandler, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, nil)
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// orderedJSONKeys lists the top-level members of one JSON object in the order
// they were serialized.
func orderedJSONKeys(t *testing.T, body []byte) []string {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(body))
	opening, err := decoder.Token()
	if err != nil {
		t.Fatalf("decode opening token: %v", err)
	}
	if opening != json.Delim('{') {
		t.Fatalf("response is not a JSON object: %s", body)
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			t.Fatalf("decode member name: %v", err)
		}
		key, ok := token.(string)
		if !ok {
			t.Fatalf("member name is not a string: %v", token)
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			t.Fatalf("decode member %q: %v", key, err)
		}
		keys = append(keys, key)
	}
	if _, err := decoder.Token(); err != nil {
		t.Fatalf("decode closing token: %v", err)
	}
	return keys
}

// vectorDiagnosticsKeyOrder is the NestJS object-literal order.
func vectorDiagnosticsKeyOrder() []string {
	return []string{
		"snapshotAt",
		"source",
		"enabled",
		"configured",
		"fallbackToMongo",
		"baseUrl",
		"timeoutMs",
		"maxRetries",
		"hasToken",
		"tokenSource",
		"temporarilyUnavailable",
		"unavailableUntil",
		"consecutiveFailures",
		"lastOperation",
		"lastFailureAt",
		"lastErrorName",
		"lastErrorMessage",
	}
}

// parseVectorDiagnosticsTime enforces the NestJS toISOString shape (UTC,
// millisecond precision, trailing Z).
func parseVectorDiagnosticsTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil {
		t.Fatalf("timestamp %q is not ISO milliseconds with Z: %v", value, err)
	}
	return parsed
}

// TestVectorDiagnosticsResponseFieldOrderAndNulls pins the 17-field order and
// every null rule for a process that never saw a vector failure and has no
// vector configuration.
func TestVectorDiagnosticsResponseFieldOrderAndNulls(t *testing.T) {
	cfg := vectorDiagnosticsEnv()
	cfg.VectorEnabled = false
	cfg.VectorFallbackToMongo = false
	cfg.VectorBaseURL = ""
	cfg.VectorToken = ""
	handler := newVectorDiagnosticsTestHandler(t, nil, cfg, []string{"settings.manage"}, nil)

	recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}

	gotKeys := orderedJSONKeys(t, recorder.Body.Bytes())
	wantKeys := vectorDiagnosticsKeyOrder()
	if len(gotKeys) != len(wantKeys) {
		t.Fatalf("keys = %v, want %v", gotKeys, wantKeys)
	}
	for index, want := range wantKeys {
		if gotKeys[index] != want {
			t.Fatalf("key %d = %q, want %q (full order: %v)", index, gotKeys[index], want, gotKeys)
		}
	}

	var body vectorServiceRuntimeDiagnostics
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	parseVectorDiagnosticsTime(t, body.SnapshotAt)
	if body.Source != "env" {
		t.Errorf("source = %q, want env", body.Source)
	}
	if body.Enabled || body.FallbackToMongo {
		t.Errorf("enabled/fallbackToMongo = %t/%t, want false/false", body.Enabled, body.FallbackToMongo)
	}
	if body.Configured || body.HasToken {
		t.Errorf("configured/hasToken = %t/%t, want false/false", body.Configured, body.HasToken)
	}
	if body.BaseURL != nil {
		t.Errorf("baseUrl = %v, want null", *body.BaseURL)
	}
	if body.TimeoutMs != 5000 || body.MaxRetries != 2 {
		t.Errorf("timeoutMs/maxRetries = %d/%d", body.TimeoutMs, body.MaxRetries)
	}
	if body.TokenSource != "none" {
		t.Errorf("tokenSource = %q, want none", body.TokenSource)
	}
	if body.TemporarilyUnavailable {
		t.Error("temporarilyUnavailable must be false")
	}
	if body.UnavailableUntil != nil {
		t.Errorf("unavailableUntil = %v, want null", *body.UnavailableUntil)
	}
	if body.ConsecutiveFailures != 0 {
		t.Errorf("consecutiveFailures = %d", body.ConsecutiveFailures)
	}
	if body.LastOperation != nil || body.LastFailureAt != nil || body.LastErrorName != nil || body.LastErrorMessage != nil {
		t.Errorf("last-* fields must be null: %+v", body)
	}

	// A nil Health (unwired) must render the same empty state, not panic.
	nilHealthHandler := newVectorDiagnosticsTestHandler(t, nil, cfg, []string{"settings.manage"}, nil)
	nilHealthHandler.health = nil
	nilRecorder := serveVectorDiagnostics(t, nilHealthHandler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
	if nilRecorder.Code != http.StatusOK {
		t.Fatalf("nil health status = %d, body = %s", nilRecorder.Code, nilRecorder.Body.String())
	}
}

// TestVectorDiagnosticsReadsStoredSettings pins source/tokenSource and the
// database overrides of the public/effective configuration.
func TestVectorDiagnosticsReadsStoredSettings(t *testing.T) {
	settings := map[string]string{
		settingKeyVectorService: `{"enabled":true,"fallbackToMongo":false,"baseUrl":"http://db.vector","token":"db-token","timeoutMs":1500,"maxRetries":3}`,
	}
	handler := newVectorDiagnosticsTestHandler(t, settings, vectorDiagnosticsEnv(), []string{"settings.manage"}, &vectorclient.Health{})
	recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body vectorServiceRuntimeDiagnostics
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Source != "db" || body.TokenSource != "stored" {
		t.Fatalf("source/tokenSource = %q/%q", body.Source, body.TokenSource)
	}
	if !body.Enabled || body.FallbackToMongo {
		t.Fatalf("enabled/fallbackToMongo = %t/%t", body.Enabled, body.FallbackToMongo)
	}
	if !body.Configured || !body.HasToken {
		t.Fatalf("configured/hasToken = %t/%t", body.Configured, body.HasToken)
	}
	if body.BaseURL == nil || *body.BaseURL != "http://db.vector" {
		t.Fatalf("baseUrl = %v", body.BaseURL)
	}
	if body.TimeoutMs != 1500 || body.MaxRetries != 3 {
		t.Fatalf("timeoutMs/maxRetries = %d/%d", body.TimeoutMs, body.MaxRetries)
	}
}

// TestVectorDiagnosticsReportsWindow pins the unhealthy branch: availability,
// window end, failure streak and the last-* fields come from the shared
// vectorclient.Health.
func TestVectorDiagnosticsReportsWindow(t *testing.T) {
	health := &vectorclient.Health{}
	now := time.Now()
	health.MarkUnavailable(
		&vectorclient.Error{Kind: "VectorUnauthorizedError", Message: "Vector service authentication failed"},
		vectorclient.OperationSearch,
		now,
	)
	handler := newVectorDiagnosticsTestHandler(t, nil, vectorDiagnosticsEnv(), []string{"settings.manage"}, health)
	recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body vectorServiceRuntimeDiagnostics
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.Enabled || !body.Configured || !body.HasToken {
		t.Fatalf("enabled/configured/hasToken = %t/%t/%t", body.Enabled, body.Configured, body.HasToken)
	}
	if body.BaseURL == nil || *body.BaseURL != "http://vector.internal" {
		t.Fatalf("baseUrl = %v", body.BaseURL)
	}
	if body.TokenSource != "env" {
		t.Fatalf("tokenSource = %q", body.TokenSource)
	}
	if !body.TemporarilyUnavailable {
		t.Fatal("temporarilyUnavailable must be true")
	}
	if body.UnavailableUntil == nil {
		t.Fatal("unavailableUntil must be a timestamp inside the window")
	}
	unavailableUntil := parseVectorDiagnosticsTime(t, *body.UnavailableUntil)
	if !unavailableUntil.After(now) {
		t.Fatalf("unavailableUntil = %s, want after %s", unavailableUntil, now)
	}
	if body.ConsecutiveFailures != 1 {
		t.Fatalf("consecutiveFailures = %d", body.ConsecutiveFailures)
	}
	if body.LastOperation == nil || *body.LastOperation != "search" {
		t.Fatalf("lastOperation = %v", body.LastOperation)
	}
	if body.LastFailureAt == nil {
		t.Fatal("lastFailureAt must be a timestamp")
	}
	parseVectorDiagnosticsTime(t, *body.LastFailureAt)
	if body.LastErrorName == nil || *body.LastErrorName != "VectorUnauthorizedError" {
		t.Fatalf("lastErrorName = %v", body.LastErrorName)
	}
	if body.LastErrorMessage == nil || *body.LastErrorMessage != "Vector service authentication failed" {
		t.Fatalf("lastErrorMessage = %v", body.LastErrorMessage)
	}
}

// TestVectorDiagnosticsConfiguredRequiresBoth pins Boolean(baseUrl && token):
// either half alone is not "configured", while hasToken follows the token only.
func TestVectorDiagnosticsConfiguredRequiresBoth(t *testing.T) {
	cases := []struct {
		name       string
		baseURL    string
		token      string
		configured bool
		hasToken   bool
	}{
		{name: "both", baseURL: "http://vector.internal", token: "env-token", configured: true, hasToken: true},
		{name: "url only", baseURL: "http://vector.internal", token: "", configured: false, hasToken: false},
		{name: "token only", baseURL: "", token: "env-token", configured: false, hasToken: true},
		{name: "neither", baseURL: "", token: "", configured: false, hasToken: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			cfg := vectorDiagnosticsEnv()
			cfg.VectorBaseURL = testCase.baseURL
			cfg.VectorToken = testCase.token
			handler := newVectorDiagnosticsTestHandler(t, nil, cfg, []string{"settings.manage"}, &vectorclient.Health{})
			recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d", recorder.Code)
			}
			var body vectorServiceRuntimeDiagnostics
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if body.Configured != testCase.configured || body.HasToken != testCase.hasToken {
				t.Fatalf("configured/hasToken = %t/%t, want %t/%t", body.Configured, body.HasToken, testCase.configured, testCase.hasToken)
			}
			if testCase.baseURL == "" {
				if body.BaseURL != nil {
					t.Fatalf("baseUrl = %v, want null", *body.BaseURL)
				}
			}
		})
	}
}

// TestVectorDiagnosticsAuth pins the shared evaluation order: 401 without a
// token, 403 without settings.manage (no platform-admin second gate needed),
// 200 with settings.manage.
func TestVectorDiagnosticsAuth(t *testing.T) {
	handler := newVectorDiagnosticsTestHandler(t, nil, vectorDiagnosticsEnv(), []string{"settings.manage"}, &vectorclient.Health{})

	if recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("without token: %d %s", recorder.Code, recorder.Body.String())
	}

	noPermission := newVectorDiagnosticsTestHandler(t, nil, vectorDiagnosticsEnv(), []string{"settings.read"}, &vectorclient.Health{})
	recorder := serveVectorDiagnostics(t, noPermission, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("without settings.manage: %d %s", recorder.Code, recorder.Body.String())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"code":"INSUFFICIENT_PERMISSIONS"`)) {
		t.Fatalf("403 body = %s", recorder.Body.String())
	}

	if recorder := serveVectorDiagnostics(t, handler, http.MethodGet, pathVectorServiceDiagnostics, mintVectorDiagnosticsToken(t)); recorder.Code != http.StatusOK {
		t.Fatalf("with settings.manage: %d %s", recorder.Code, recorder.Body.String())
	}
}

// TestVectorDiagnosticsExactGETOnly pins the 404 for every non-GET method and
// for path variants; the 404 precedes authentication like an unmatched NestJS
// route.
func TestVectorDiagnosticsExactGETOnly(t *testing.T) {
	handler := newVectorDiagnosticsTestHandler(t, nil, vectorDiagnosticsEnv(), []string{"settings.manage"}, &vectorclient.Health{})
	token := mintVectorDiagnosticsToken(t)
	for _, testCase := range []struct {
		method string
		path   string
		token  string
	}{
		{http.MethodPost, pathVectorServiceDiagnostics, token},
		{http.MethodPut, pathVectorServiceDiagnostics, token},
		{http.MethodDelete, pathVectorServiceDiagnostics, token},
		{http.MethodPatch, pathVectorServiceDiagnostics, token},
		{http.MethodOptions, pathVectorServiceDiagnostics, ""},
		{http.MethodHead, pathVectorServiceDiagnostics, token},
		{http.MethodPost, pathVectorServiceDiagnostics, ""},
		{http.MethodGet, pathVectorServiceDiagnostics + "/", token},
		{http.MethodGet, pathVectorServiceDiagnostics + "/extra", token},
		{http.MethodGet, "/api/system-settings/vector-service", token},
		{http.MethodGet, "/api/system-settings/vector-service/diagnostics-extra", token},
	} {
		recorder := serveVectorDiagnostics(t, handler, testCase.method, testCase.path, testCase.token)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s = %d, want 404", testCase.method, testCase.path, recorder.Code)
		}
	}
}
