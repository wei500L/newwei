package situationsettings

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/gdeltsnapshot"
)

// fakeTelegramAuthAuthorizer mirrors platformgovernance.Authenticator.Authorize
// for the handler tests: it records the permission and answers 401 when no
// identity is configured.
type fakeTelegramAuthAuthorizer struct {
	identity    *authhttp.Identity
	permissions []string
}

func (f *fakeTelegramAuthAuthorizer) Authorize(w http.ResponseWriter, r *http.Request, permission string) *authhttp.Identity {
	f.permissions = append(f.permissions, permission)
	if f.identity == nil {
		authhttp.WriteUnauthorized(w, r, "")
		return nil
	}
	return f.identity
}

func testTelegramAuthIdentity() *authhttp.Identity {
	return authhttp.NewIdentity("user-1", "org-1", []string{"settings.manage"})
}

func newTestTelegramAuthHandler(settings *fakeTelegramAuthSettings, factory *fakeTelegramAuthFactory, store *fakeTelegramAuthStore, limiter *fakeTelegramAuthLimiter, authorizer telegramAuthAuthorizer, scheduler TelegramScheduler) *TelegramAuthHandler {
	service := newTelegramAuthService(telegramAuthServiceOptions{
		Settings:     settings,
		Telegram:     factory,
		Store:        store,
		Limiter:      limiter,
		Now:          func() time.Time { return testTelegramAuthNow },
		NewRequestID: func() (string, error) { return testTelegramAuthRequestID, nil },
	})
	return &TelegramAuthHandler{
		auth:      authorizer,
		settings:  settings,
		service:   service,
		external:  fakeExternal{summary: gdeltsnapshot.Summary{Status: "idle", Warnings: []gdeltsnapshot.Warning{}}},
		quality:   fakeQuality{},
		scheduler: scheduler,
	}
}

func serveTelegramAuthHandlerRequest(t *testing.T, handler *TelegramAuthHandler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestTelegramAuthHandlerStartSuccess(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	client := &fakeTelegramAuthClient{
		sendCodeResult: TelegramSentCode{PhoneCodeHash: "code-hash", CodeViaApp: true},
		session:        "SESSION-1",
	}
	factory := &fakeTelegramAuthFactory{client: client}
	store := newFakeTelegramAuthStore()
	limiter := &fakeTelegramAuthLimiter{}
	authorizer := &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}
	handler := newTestTelegramAuthHandler(settings, factory, store, limiter, authorizer, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthStartPath, `{"phoneNumber":"+14155552671"}`)
	// NestJS @Post without @HttpCode => 201 Created.
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if got, want := recorder.Header().Get("content-type"), "application/json; charset=utf-8"; got != want {
		t.Fatalf("content-type = %q, want %q", got, want)
	}
	wantBody := `{"requestId":"` + testTelegramAuthRequestID + `","isCodeViaApp":true,"expiresAt":"2026-10-20T20:57:16.123Z"}`
	if got := recorder.Body.String(); got != wantBody {
		t.Fatalf("body = %s, want %s", got, wantBody)
	}
	if len(authorizer.permissions) != 1 || authorizer.permissions[0] != "settings.manage" {
		t.Fatalf("permissions = %v", authorizer.permissions)
	}
	if factory.calls != 1 || client.sendCodeCalls != 1 || client.closeCalls != 1 {
		t.Fatalf("factory/sendCode/close = %d/%d/%d", factory.calls, client.sendCodeCalls, client.closeCalls)
	}
	// The handler resolves the client IP through authlogin.ClientIP: without
	// TRUST_PROXY the socket address wins (httptest uses 192.0.2.1:1234).
	wantIPKey := "situation-monitor:telegram-auth-start:ip:org-1:192.0.2.1"
	if len(limiter.keys) != 3 || limiter.keys[1] != wantIPKey {
		t.Fatalf("rate limit keys = %v, want ip key %q", limiter.keys, wantIPKey)
	}
}

func TestTelegramAuthHandlerStartValidationError(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	authorizer := &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}
	factory := &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}
	handler := newTestTelegramAuthHandler(settings, factory, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{}, authorizer, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthStartPath, `{}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if factory.calls != 0 {
		t.Fatalf("factory calls = %d", factory.calls)
	}
	payload := decodeTelegramAuthTestBody(t, recorder)
	if payload["message"] != "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a string" {
		t.Fatalf("message = %v", payload["message"])
	}
	if payload["error"] != "Bad Request" {
		t.Fatalf("error = %v", payload["error"])
	}
	if _, ok := payload["code"]; ok {
		t.Fatalf("ValidationPipe 400 must not carry a code: %v", payload)
	}
}

func TestTelegramAuthHandlerStartRateLimited(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	authorizer := &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}
	factory := &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}
	limiter := &fakeTelegramAuthLimiter{denyKey: "situation-monitor:telegram-auth-start:user:org-1:user-1"}
	handler := newTestTelegramAuthHandler(settings, factory, newFakeTelegramAuthStore(), limiter, authorizer, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthStartPath, `{"phoneNumber":"+14155552671"}`)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body=%s)", recorder.Code, recorder.Body.String())
	}
	payload := decodeTelegramAuthTestBody(t, recorder)
	if payload["message"] != telegramAuthCodeRateLimit || payload["code"] != telegramAuthCodeRateLimit {
		t.Fatalf("body = %v", payload)
	}
	if payload["error"] != "Too Many Requests" {
		t.Fatalf("error = %v", payload["error"])
	}
	if factory.calls != 0 {
		t.Fatalf("factory calls = %d", factory.calls)
	}
}

func TestTelegramAuthHandlerCompleteNewUserFlow(t *testing.T) {
	settings := &fakeTelegramAuthSettings{
		updateResult: PublicSettings{TelegramEnabled: true, TelegramPollIntervalMS: 30_000},
	}
	client := &fakeTelegramAuthClient{session: "FINAL-SESSION"}
	factory := &fakeTelegramAuthFactory{client: client}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	authorizer := &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}
	scheduler := &fakeTelegram{}
	handler := newTestTelegramAuthHandler(settings, factory, store, &fakeTelegramAuthLimiter{}, authorizer, scheduler)

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	// The response is the controller's withExternalSnapshotStatus spread:
	// public settings + externalSnapshotStatus + qualitySummary.
	payload := decodeTelegramAuthTestBody(t, recorder)
	if _, ok := payload["externalSnapshotStatus"]; !ok {
		t.Fatalf("missing externalSnapshotStatus: %v", payload)
	}
	if quality, ok := payload["qualitySummary"]; !ok || quality != nil {
		t.Fatalf("qualitySummary = %v (present=%v)", quality, ok)
	}
	if payload["telegramEnabled"] != true {
		t.Fatalf("telegramEnabled = %v", payload["telegramEnabled"])
	}
	if payload["telegramPollIntervalMs"] != float64(30_000) {
		t.Fatalf("telegramPollIntervalMs = %v", payload["telegramPollIntervalMs"])
	}

	if settings.updateCalls != 1 || settings.updateOrgID != "org-1" || settings.updateActorID != "user-1" {
		t.Fatalf("update call = %d %s/%s", settings.updateCalls, settings.updateOrgID, settings.updateActorID)
	}
	update := settings.updateInput
	// body.enableTelegram was absent: NestJS asBoolean(undefined, current)
	// keeps the stored flag, so the tri-state must stay "missing".
	if update.TelegramEnabled.state != presenceMissing {
		t.Fatalf("TelegramEnabled state = %v, want presenceMissing", update.TelegramEnabled.state)
	}
	if update.TelegramAPIID.state != presenceValue || update.TelegramAPIID.value != "123" {
		t.Fatalf("TelegramAPIID = %+v", update.TelegramAPIID)
	}
	if update.TelegramAPIHash.state != presenceValue || update.TelegramAPIHash.value != "hash" {
		t.Fatalf("TelegramAPIHash = %+v", update.TelegramAPIHash)
	}
	if update.TelegramSession.state != presenceValue || update.TelegramSession.value != "FINAL-SESSION" {
		t.Fatalf("TelegramSession = %+v", update.TelegramSession)
	}
	// syncTelegramScheduleBestEffort(updated.telegramEnabled,
	// updated.telegramPollIntervalMs).
	if scheduler.calls != 1 || !scheduler.enabled || scheduler.every != 30_000 {
		t.Fatalf("scheduler sync = %+v", scheduler)
	}
	if len(store.deletedKeys) != 1 {
		t.Fatalf("pending request must be deleted: %v", store.deletedKeys)
	}
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", client.closeCalls)
	}
}

func TestTelegramAuthHandlerCompletePasswordFlow(t *testing.T) {
	settings := &fakeTelegramAuthSettings{
		updateResult: PublicSettings{TelegramEnabled: true, TelegramPollIntervalMS: 15_000},
	}
	client := &fakeTelegramAuthClient{signInErr: ErrTelegramPasswordNeeded, session: "FINAL-SESSION"}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: client}, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345","password":"  secret  ","enableTelegram":false}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if client.passwordCalls != 1 || client.password != "secret" {
		t.Fatalf("password = %d/%q, want the NestJS-trimmed password", client.passwordCalls, client.password)
	}
	if got := settings.updateInput.TelegramEnabled; got.state != presenceValue || got.value {
		t.Fatalf("TelegramEnabled = %+v, want explicit false", got)
	}
}

func TestTelegramAuthHandlerCompleteSignUpRequired(t *testing.T) {
	settings := &fakeTelegramAuthSettings{}
	client := &fakeTelegramAuthClient{signInErr: ErrTelegramSignUpRequired}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	scheduler := &fakeTelegram{}
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: client}, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, scheduler)

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	payload := decodeTelegramAuthTestBody(t, recorder)
	if payload["code"] != telegramAuthCodeSignUpRequired || payload["message"] != telegramAuthCodeSignUpRequired {
		t.Fatalf("body = %v", payload)
	}
	if settings.updateCalls != 0 || scheduler.calls != 0 {
		t.Fatalf("failed complete must not write settings or sync: %d/%d", settings.updateCalls, scheduler.calls)
	}
}

func TestTelegramAuthHandlerCompleteTenantMismatch(t *testing.T) {
	settings := &fakeTelegramAuthSettings{}
	store := newFakeTelegramAuthStore()
	pending := testTelegramAuthPending()
	pending.OrgID = "org-2"
	testTelegramAuthSeedPending(t, store, pending)
	factory := &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}
	handler := newTestTelegramAuthHandler(settings, factory, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	payload := decodeTelegramAuthTestBody(t, recorder)
	if payload["code"] != telegramAuthCodeRequestMismatch {
		t.Fatalf("body = %v", payload)
	}
	if factory.calls != 0 || settings.updateCalls != 0 {
		t.Fatalf("tenant mismatch must stop before Telegram/settings")
	}
}

func TestTelegramAuthHandlerCompleteNullEnableTelegramKeepsCurrent(t *testing.T) {
	settings := &fakeTelegramAuthSettings{updateResult: PublicSettings{TelegramEnabled: true}}
	client := &fakeTelegramAuthClient{session: "FINAL"}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: client}, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345","enableTelegram":null}`)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d (body=%s)", recorder.Code, recorder.Body.String())
	}
	if got := settings.updateInput.TelegramEnabled; got.state != presenceMissing {
		t.Fatalf("TelegramEnabled = %+v, want presenceMissing for JSON null", got)
	}
}

func TestTelegramAuthHandlerUnauthorized(t *testing.T) {
	settings := &fakeTelegramAuthSettings{}
	store := newFakeTelegramAuthStore()
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{}, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthStartPath, `{"phoneNumber":"+14155552671"}`)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if len(store.savedKeys) != 0 {
		t.Fatalf("unauthenticated request must not touch the cache")
	}
}

func TestTelegramAuthHandlerRejectsOtherRoutes(t *testing.T) {
	settings := &fakeTelegramAuthSettings{}
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}},
		newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, &fakeTelegram{})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, telegramAuthStartPath},
		{http.MethodPut, telegramAuthCompletePath},
		{http.MethodPost, settingsPath},
		{http.MethodPost, telegramAuthPath + "/unknown"},
	}
	for _, testCase := range cases {
		recorder := serveTelegramAuthHandlerRequest(t, handler, testCase.method, testCase.path, `{}`)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s status = %d, want 404", testCase.method, testCase.path, recorder.Code)
		}
		wantMessage := "Cannot " + testCase.method + " " + testCase.path
		payload := decodeTelegramAuthTestBody(t, recorder)
		if payload["message"] != wantMessage {
			t.Fatalf("%s %s message = %v, want %q", testCase.method, testCase.path, payload["message"], wantMessage)
		}
	}
}

func TestTelegramAuthHandlerMissingDependenciesIs503(t *testing.T) {
	recorder := httptest.NewRecorder()
	handler := &TelegramAuthHandler{}
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, telegramAuthStartPath, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

func TestTelegramAuthHandlerCompleteSettingsFailure(t *testing.T) {
	settings := &fakeTelegramAuthSettings{updateErr: errors.New("mysql down")}
	client := &fakeTelegramAuthClient{session: "FINAL"}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	handler := newTestTelegramAuthHandler(settings, &fakeTelegramAuthFactory{client: client}, store,
		&fakeTelegramAuthLimiter{}, &fakeTelegramAuthAuthorizer{identity: testTelegramAuthIdentity()}, &fakeTelegram{})

	recorder := serveTelegramAuthHandlerRequest(t, handler, http.MethodPost, telegramAuthCompletePath,
		`{"requestId":"`+testTelegramAuthRequestID+`","phoneCode":"12345"}`)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	payload := decodeTelegramAuthTestBody(t, recorder)
	if payload["message"] != "Internal server error" {
		t.Fatalf("body = %v", payload)
	}
}

func TestTelegramAuthHandlerClientIP(t *testing.T) {
	handler := &TelegramAuthHandler{}

	request := httptest.NewRequest(http.MethodPost, telegramAuthStartPath, nil)
	request.RemoteAddr = "203.0.113.7:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.9")
	if got, want := handler.clientIP(request), "203.0.113.7"; got != want {
		t.Fatalf("clientIP without TRUST_PROXY = %q, want socket address %q", got, want)
	}

	handler.trustProxy = "1"
	if got, want := handler.clientIP(request), "198.51.100.9"; got != want {
		t.Fatalf("clientIP with TRUST_PROXY=1 = %q, want %q", got, want)
	}

	request.RemoteAddr = "[::ffff:192.0.2.5]:1234"
	handler.trustProxy = ""
	if got, want := handler.clientIP(request), "192.0.2.5"; got != want {
		t.Fatalf("clientIP strips IPv4-mapped prefix: %q, want %q", got, want)
	}
}

func decodeTelegramAuthTestBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("response is not JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}
