package situationsignals

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

const (
	testJWTSecret = "0123456789abcdef0123456789abcdef"
	testIssuer    = "modular-monolith"
	testAudience  = "modular-monolith-clients"
)

// allowAllBlacklist reports every token as not revoked.
type allowAllBlacklist struct{}

func (allowAllBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

// fixedAuthz returns a fixed authorization, mirroring the MySQL re-derivation
// result without a database.
type fixedAuthz struct {
	authorization *authz.Authorization
	err           error
}

func (f fixedAuthz) Authorize(context.Context, string, string) (*authz.Authorization, error) {
	return f.authorization, f.err
}

// signToken mints an access token accepted by authn.Verifier.
func signToken(t *testing.T, permissions []string) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":   "user-1",
		"orgId": "org-1",
		"iss":   testIssuer,
		"aud":   testAudience,
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
		"role":  "admin",
	}
	if permissions != nil {
		claims["permissions"] = permissions
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(testJWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

// newTestHandler builds a handler whose authentication chain is real (signature
// verification, revocation list, authorization repository) but has no database
// or Redis behind it.
func newTestHandler(t *testing.T, permissions []string) *Handler {
	t.Helper()
	verifier := authn.NewVerifier(testJWTSecret, testIssuer, testAudience)
	chain := authhttp.NewAuthenticator(verifier, allowAllBlacklist{}, fixedAuthz{
		authorization: &authz.Authorization{
			UserID:      "user-1",
			OrgID:       "org-1",
			Permissions: permissionSet(permissions),
		},
	})
	_, ops := newMemoryCache()
	settings := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}
	service := &Service{
		cache:    ops,
		settings: settings,
		loadMonitors: func(context.Context, string, string) ([]monitorRecord, error) {
			return []monitorRecord{}, nil
		},
	}
	return NewHandler(NewAuthenticator(chain, nil), service)
}

func permissionSet(names []string) map[string]bool {
	out := map[string]bool{}
	for _, name := range names {
		out[name] = true
	}
	return out
}

func doRequest(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
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

func TestHandlerFailureOrder(t *testing.T) {
	readToken := signToken(t, nil)
	writeToken := signToken(t, []string{"items.write"})
	handler := newTestHandler(t, nil)

	// 401: no token.
	recorder := doRequest(handler, http.MethodGet, catalogPath, "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d %s", recorder.Code, recorder.Body.String())
	}

	// 403: authenticated but missing items.write on the write route.
	handler = newTestHandler(t, []string{"items.read"})
	recorder = doRequest(handler, http.MethodPost, feedbackPath, readToken, `{"signalType":"narrative","signalId":"s","label":"false_positive"}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("read-only feedback = %d %s", recorder.Code, recorder.Body.String())
	}
	var forbidden map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &forbidden); err != nil {
		t.Fatal(err)
	}
	if string(forbidden["code"]) != `"INSUFFICIENT_PERMISSIONS"` {
		t.Fatalf("forbidden body = %s", recorder.Body.String())
	}

	// 400: the permission check runs before the DTO validation.
	handler = newTestHandler(t, []string{"items.read", "items.write"})
	recorder = doRequest(handler, http.MethodPost, feedbackPath, writeToken, `{}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid body = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "signalType must be one of the following values") {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	// The S1 case: a blank signalId reaches the service (the DTO accepts it) and
	// the service answers 400 before any write.
	recorder = doRequest(handler, http.MethodPost, feedbackPath, writeToken, `{"signalType":"narrative","signalId":" ","label":"false_positive"}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "signalId is required") {
		t.Fatalf("blank signalId = %d %s", recorder.Code, recorder.Body.String())
	}

	// 404: the refresh-run record does not exist.
	recorder = doRequest(handler, http.MethodGet, refreshRunsPrefix+"missing", writeToken, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing refresh run = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "Situation Monitor refresh run not found.") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestHandlerMachineTokenWithoutDatabase(t *testing.T) {
	// The unit test has no MachineAccessToken table behind the authenticator, so
	// the lookup cannot run. Production wiring always has the pool (config
	// requires DATABASE_URL for go mode) and an unknown token answers 401
	// "Invalid machine token"; without the pool the missing dependency is
	// reported as 503 instead of a generic 500.
	handler := newTestHandler(t, []string{"items.read"})
	recorder := doRequest(handler, http.MethodGet, catalogPath, "mtk_abc", "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("machine token with no db = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "Internal server error") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestHandlerRouteDispatch(t *testing.T) {
	handler := newTestHandler(t, []string{"items.read"})
	token := signToken(t, nil)

	// A path the gateway never routes here answers 404 instead of panicking.
	recorder := doRequest(handler, http.MethodGet, "/api/situation-monitor/insights", token, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("insights = %d", recorder.Code)
	}
	// A longer refresh-run path never reaches the service.
	recorder = doRequest(handler, http.MethodGet, refreshRunsPrefix+"a/b", token, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("long refresh run = %d", recorder.Code)
	}
	// The wrong method on a taken-over path is a 404 as well.
	recorder = doRequest(handler, http.MethodPut, catalogPath, token, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("PUT catalog = %d", recorder.Code)
	}
}

func TestHandlerLiveHLSProxyConfigBranches(t *testing.T) {
	handler := newTestHandler(t, []string{"items.read"})
	token := signToken(t, nil)

	recorder := doRequest(handler, http.MethodGet, liveHLSProxyPath, token, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("no channel = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"channel":"","configured":false`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	recorder = doRequest(handler, http.MethodGet, liveHLSProxyPath+"?channel=fox", token, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"channel":"fox","configured":false`) {
		t.Fatalf("illegal channel = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"upstreamUrl":null`) || !strings.Contains(recorder.Body.String(), `"allowedHosts":[]`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	// A legal channel with no stored configuration answers the same shape.
	recorder = doRequest(handler, http.MethodGet, liveHLSProxyPath+"?channel=CNN", token, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"channel":"cnn","configured":false`) {
		t.Fatalf("cnn = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestLiveHLSProxyChannelConfig(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{
		"exists":true,
		"value":{
			"liveHlsProxyCnnUpstreamUrl":"https://cdn.example.test/live/index.m3u8",
			"liveHlsProxyCnnReferer":"https://www.example.test/watch",
			"liveHlsProxyCnnAllowedHosts":["cdn.example.test","Edge.Example.Test","bad host"],
			"liveHlsProxyCnbcUpstreamUrl":"http://insecure.example.test/live.m3u8"
		}
	}`)
	reader := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}

	cnn, err := reader.liveHLSProxyChannelConfig(t.Context(), "cnn")
	if err != nil {
		t.Fatal(err)
	}
	if !cnn.Configured || cnn.UpstreamURL == nil || *cnn.UpstreamURL != "https://cdn.example.test/live/index.m3u8" {
		t.Fatalf("cnn = %+v", cnn)
	}
	if cnn.Referer == nil || *cnn.Referer != "https://www.example.test/watch" {
		t.Fatalf("referer = %v", cnn.Referer)
	}
	if len(cnn.AllowedHosts) != 2 || cnn.AllowedHosts[0] != "cdn.example.test" || cnn.AllowedHosts[1] != "edge.example.test" {
		t.Fatalf("allowedHosts = %v", cnn.AllowedHosts)
	}

	// The CNBC upstream is http, which normalizeHttpsUrl rejects.
	cnbc, err := reader.liveHLSProxyChannelConfig(t.Context(), "cnbc")
	if err != nil {
		t.Fatal(err)
	}
	if cnbc.Configured || cnbc.UpstreamURL != nil || cnbc.Referer != nil || len(cnbc.AllowedHosts) != 0 {
		t.Fatalf("cnbc = %+v", cnbc)
	}
}

func TestHandlerOrefAndTelegramRoutes(t *testing.T) {
	store, ops := newMemoryCache()
	store.values[settingsCacheKey] = []byte(`{"exists":true,"value":{"telegramChannelSet":"full"}}`)
	store.values[telegramStateKey] = []byte(`{"channelSet":"full","cursorByHandle":{},"items":[],"lastPollAt":1767323045000,"lastError":null}`)
	store.values[orefAlertsKey] = []byte(`{"scope":"global","alerts":[],"historyCount24h":0,"totalHistoryCount":0,"timestamp":"2026-01-02T03:04:05.000Z"}`)
	store.values[orefHistoryKey] = []byte(`{"scope":"global","history":[],"historyCount24h":4,"totalHistoryCount":9,"timestamp":"2026-01-02T03:04:05.000Z"}`)

	verifier := authn.NewVerifier(testJWTSecret, testIssuer, testAudience)
	chain := authhttp.NewAuthenticator(verifier, allowAllBlacklist{}, fixedAuthz{
		authorization: &authz.Authorization{
			UserID: "user-1", OrgID: "org-1", Permissions: permissionSet([]string{"items.read"}),
		},
	})
	settings := &settingsReader{cache: ops, lookup: envLookup(map[string]string{})}
	service := &Service{
		cache:    ops,
		settings: settings,
		loadMonitors: func(context.Context, string, string) ([]monitorRecord, error) {
			return []monitorRecord{}, nil
		},
	}
	handler := NewHandler(NewAuthenticator(chain, nil), service)
	token := signToken(t, nil)

	recorder := doRequest(handler, http.MethodGet, orefAlertsPath, token, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("oref alerts = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"timestamp":"2026-01-02T03:04:05.000Z"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"historyCount24h":4`) {
		t.Fatalf("counters must come from the history cache: %s", recorder.Body.String())
	}

	recorder = doRequest(handler, http.MethodGet, orefHistoryPath, token, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"history":[]`) {
		t.Fatalf("oref history = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = doRequest(handler, http.MethodGet, telegramFeedPath, token, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("telegram feed = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"updatedAt":"2026-01-02T03:04:05.000Z"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	recorder = doRequest(handler, http.MethodGet, catalogPath, token, "")
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"narratives"`) {
		t.Fatalf("catalog = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestReadJSONBodyClassification(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, feedbackPath, bytes.NewBufferString(`{"a":1}`))
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	body, kind := readJSONBody(request)
	if kind != bodyOK || string(body) != `{"a":1}` {
		t.Fatalf("kind = %v body = %s", kind, body)
	}

	request = httptest.NewRequest(http.MethodPost, feedbackPath, bytes.NewBufferString(""))
	request.Header.Set("Content-Type", "application/json")
	if _, kind := readJSONBody(request); kind != bodyAbsent {
		t.Fatalf("empty body kind = %v", kind)
	}

	request = httptest.NewRequest(http.MethodPost, feedbackPath, bytes.NewBufferString(`{oops`))
	request.Header.Set("Content-Type", "application/json")
	body, kind := readJSONBody(request)
	if kind != bodyInvalidJSON {
		t.Fatalf("invalid body kind = %v", kind)
	}
	if !strings.Contains(invalidJSONMessage(body), "is not valid JSON") {
		t.Fatalf("message = %s", invalidJSONMessage(body))
	}

	request = httptest.NewRequest(http.MethodPost, feedbackPath, bytes.NewBufferString(`{"a":1}`))
	request.Header.Set("Content-Type", "text/plain")
	if _, kind := readJSONBody(request); kind != bodyAbsent {
		t.Fatalf("non-json content type kind = %v", kind)
	}
}
