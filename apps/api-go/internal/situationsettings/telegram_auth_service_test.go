package situationsettings

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"
)

// ---- fakes ----

type fakeTelegramAuthSettings struct {
	effective      EffectiveSettings
	effectiveErr   error
	effectiveCalls int

	updateResult  PublicSettings
	updateErr     error
	updateCalls   int
	updateOrgID   string
	updateActorID string
	updateInput   UpdateInput
}

func (f *fakeTelegramAuthSettings) EffectiveSettings(context.Context) (EffectiveSettings, error) {
	f.effectiveCalls++
	return f.effective, f.effectiveErr
}

func (f *fakeTelegramAuthSettings) Update(_ context.Context, orgID, actorID string, input UpdateInput) (PublicSettings, error) {
	f.updateCalls++
	f.updateOrgID = orgID
	f.updateActorID = actorID
	f.updateInput = input
	return f.updateResult, f.updateErr
}

type fakeTelegramAuthClient struct {
	sendCodeResult TelegramSentCode
	sendCodeErr    error
	sendCodeCalls  int
	sendCodePhone  string

	signInErr   error
	signInCalls int
	signInPhone string
	signInHash  string
	signInCode  string

	passwordErr   error
	passwordCalls int
	password      string

	session     string
	exportErr   error
	exportCalls int

	closeCalls int
}

func (c *fakeTelegramAuthClient) SendCode(_ context.Context, phone string) (TelegramSentCode, error) {
	c.sendCodeCalls++
	c.sendCodePhone = phone
	return c.sendCodeResult, c.sendCodeErr
}

func (c *fakeTelegramAuthClient) SignIn(_ context.Context, phone, phoneCodeHash, code string) error {
	c.signInCalls++
	c.signInPhone = phone
	c.signInHash = phoneCodeHash
	c.signInCode = code
	return c.signInErr
}

func (c *fakeTelegramAuthClient) SignInWithPassword(_ context.Context, password string) error {
	c.passwordCalls++
	c.password = password
	return c.passwordErr
}

func (c *fakeTelegramAuthClient) ExportStringSession() (string, error) {
	c.exportCalls++
	return c.session, c.exportErr
}

func (c *fakeTelegramAuthClient) Close() { c.closeCalls++ }

type fakeTelegramAuthFactory struct {
	client  *fakeTelegramAuthClient
	err     error
	calls   int
	apiID   int
	apiHash string
	session string
}

func (f *fakeTelegramAuthFactory) NewTemporary(_ context.Context, apiID int, apiHash, sessionString string) (TelegramAuthClient, error) {
	f.calls++
	f.apiID = apiID
	f.apiHash = apiHash
	f.session = sessionString
	if f.err != nil {
		return nil, f.err
	}
	return f.client, nil
}

type fakeTelegramAuthStore struct {
	values      map[string][]byte
	loadErr     error
	saveErr     error
	deleteErr   error
	loadKeys    []string
	savedKeys   []string
	savedData   [][]byte
	savedTTLs   []time.Duration
	deletedKeys []string
}

func newFakeTelegramAuthStore() *fakeTelegramAuthStore {
	return &fakeTelegramAuthStore{values: map[string][]byte{}}
}

func (s *fakeTelegramAuthStore) Load(_ context.Context, key string) ([]byte, bool, error) {
	s.loadKeys = append(s.loadKeys, key)
	if s.loadErr != nil {
		return nil, false, s.loadErr
	}
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *fakeTelegramAuthStore) Save(_ context.Context, key string, payload []byte, ttl time.Duration) error {
	s.savedKeys = append(s.savedKeys, key)
	s.savedData = append(s.savedData, append([]byte(nil), payload...))
	s.savedTTLs = append(s.savedTTLs, ttl)
	if s.saveErr != nil {
		return s.saveErr
	}
	if s.values == nil {
		s.values = map[string][]byte{}
	}
	s.values[key] = append([]byte(nil), payload...)
	return nil
}

func (s *fakeTelegramAuthStore) Delete(_ context.Context, key string) error {
	s.deletedKeys = append(s.deletedKeys, key)
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.values, key)
	return nil
}

type fakeTelegramAuthLimiter struct {
	denyKey      string
	denyContains bool
	err          error
	keys         []string
	limits       []int
	windows      []int
}

func (l *fakeTelegramAuthLimiter) Consume(_ context.Context, key string, limit, windowSeconds int) (bool, error) {
	l.keys = append(l.keys, key)
	l.limits = append(l.limits, limit)
	l.windows = append(l.windows, windowSeconds)
	if l.err != nil {
		return false, l.err
	}
	if l.denyKey != "" {
		if l.denyContains && strings.Contains(key, l.denyKey) {
			return false, nil
		}
		if !l.denyContains && key == l.denyKey {
			return false, nil
		}
	}
	return true, nil
}

// ---- helpers ----

const testTelegramAuthRequestID = "11111111-2222-4333-8444-555555555555"

var testTelegramAuthNow = time.Date(2026, 10, 20, 20, 47, 16, 123_000_000, time.UTC)

func newTestTelegramAuthService(settings *fakeTelegramAuthSettings, factory *fakeTelegramAuthFactory, store *fakeTelegramAuthStore, limiter *fakeTelegramAuthLimiter) *telegramAuthService {
	if settings == nil {
		settings = &fakeTelegramAuthSettings{}
	}
	if store == nil {
		store = newFakeTelegramAuthStore()
	}
	if limiter == nil {
		limiter = &fakeTelegramAuthLimiter{}
	}
	return newTelegramAuthService(telegramAuthServiceOptions{
		Settings:     settings,
		Telegram:     factory,
		Store:        store,
		Limiter:      limiter,
		Now:          func() time.Time { return testTelegramAuthNow },
		NewRequestID: func() (string, error) { return testTelegramAuthRequestID, nil },
	})
}

func requireTelegramAuthCoded(t *testing.T, err error, status int, code string) *telegramAuthCodedError {
	t.Helper()
	var coded *telegramAuthCodedError
	if !errors.As(err, &coded) {
		t.Fatalf("error = %v (%T), want coded %s", err, err, code)
	}
	if coded.statusCode != status || coded.code != code {
		t.Fatalf("coded = %d/%s, want %d/%s", coded.statusCode, coded.code, status, code)
	}
	return coded
}

func testTelegramAuthSeedPending(t *testing.T, store *fakeTelegramAuthStore, pending telegramAuthPending) []byte {
	t.Helper()
	payload, err := marshalTelegramAuthPending(pending)
	if err != nil {
		t.Fatalf("marshal pending: %v", err)
	}
	if store.values == nil {
		store.values = map[string][]byte{}
	}
	store.values[telegramAuthCacheKey(pending.RequestID)] = payload
	return payload
}

func testTelegramAuthCompleteInput() CompleteTelegramAuthInput {
	return CompleteTelegramAuthInput{
		RequestID:      testTelegramAuthRequestID,
		PhoneCode:      "12345",
		Password:       optionalString{state: presenceMissing},
		EnableTelegram: optionalBool{state: presenceMissing},
	}
}

func TestMarshalTelegramAuthPendingDocumentBytes(t *testing.T) {
	pending := telegramAuthPending{
		RequestID:       "req-1",
		OrgID:           "org-1",
		ActorID:         "user-1",
		TelegramAPIID:   "123",
		TelegramAPIHash: "hash",
		PhoneNumber:     "+14155552671",
		PhoneCodeHash:   "code-hash",
		Session:         "SESSION",
		CreatedAt:       "2026-10-20T20:47:16.123Z",
	}
	payload, err := marshalTelegramAuthPending(pending)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"requestId":"req-1","orgId":"org-1","actorId":"user-1","telegramApiId":"123","telegramApiHash":"hash","phoneNumber":"+14155552671","phoneCodeHash":"code-hash","session":"SESSION","createdAt":"2026-10-20T20:47:16.123Z"}`
	if string(payload) != want {
		t.Fatalf("pending document = %s, want %s", payload, want)
	}

	decoded, found, err := decodeTelegramAuthPending(payload)
	if err != nil || !found {
		t.Fatalf("decode = %+v found=%v err=%v", decoded, found, err)
	}
	if decoded != pending {
		t.Fatalf("round trip = %+v, want %+v", decoded, pending)
	}
}

func TestMarshalTelegramAuthPendingDoesNotHTMLEscape(t *testing.T) {
	// JSON.stringify leaves <, > and & untouched; the Go encoder must do the
	// same or the shared Redis document would differ byte-for-byte.
	pending := telegramAuthPending{
		RequestID:       "req-1",
		OrgID:           "org-1",
		ActorID:         "user-1",
		TelegramAPIID:   "123",
		TelegramAPIHash: "a&b<c>d",
		PhoneNumber:     "+14155552671",
		PhoneCodeHash:   "code-hash",
		Session:         "SESSION+/=",
		CreatedAt:       "2026-10-20T20:47:16.123Z",
	}
	payload, err := marshalTelegramAuthPending(pending)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"requestId":"req-1","orgId":"org-1","actorId":"user-1","telegramApiId":"123","telegramApiHash":"a&b<c>d","phoneNumber":"+14155552671","phoneCodeHash":"code-hash","session":"SESSION+/=","createdAt":"2026-10-20T20:47:16.123Z"}`
	if string(payload) != want {
		t.Fatalf("pending document = %s, want %s", payload, want)
	}
	if strings.Contains(string(payload), `\u`) {
		t.Fatalf("pending document must not HTML-escape: %s", payload)
	}
	if bytes.HasSuffix(payload, []byte("\n")) {
		t.Fatalf("pending document must not have the encoder newline: %q", payload)
	}
}

func TestTelegramAuthCacheKeyAndTTL(t *testing.T) {
	if got, want := telegramAuthCacheKey("req-1"), "situation-monitor:telegram-auth:req-1"; got != want {
		t.Fatalf("cache key = %q, want %q", got, want)
	}
	if got, want := time.Duration(telegramAuthRequestTTLSeconds)*time.Second, 10*time.Minute; got != want {
		t.Fatalf("TTL = %s, want %s", got, want)
	}
	if telegramAuthStartRateLimitWindowSeconds != 600 {
		t.Fatalf("rate limit window = %ds, want 600", telegramAuthStartRateLimitWindowSeconds)
	}
}

func TestStartAuthSuccessCachesPending(t *testing.T) {
	settings := &fakeTelegramAuthSettings{
		effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"},
	}
	client := &fakeTelegramAuthClient{
		sendCodeResult: TelegramSentCode{PhoneCodeHash: "code-hash", CodeViaApp: true},
		session:        "SESSION-1",
	}
	factory := &fakeTelegramAuthFactory{client: client}
	store := newFakeTelegramAuthStore()
	limiter := &fakeTelegramAuthLimiter{}
	service := newTestTelegramAuthService(settings, factory, store, limiter)

	result, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		TelegramAPIID:   optionalString{state: presenceMissing},
		TelegramAPIHash: optionalString{state: presenceMissing},
		PhoneNumber:     "+14155552671",
	}, "203.0.113.5")
	if err != nil {
		t.Fatalf("startAuth error = %v", err)
	}

	wantRequestID := testTelegramAuthRequestID
	if result.RequestID != wantRequestID || !result.IsCodeViaApp {
		t.Fatalf("result = %+v", result)
	}
	if got, want := result.ExpiresAt, "2026-10-20T20:57:16.123Z"; got != want {
		t.Fatalf("expiresAt = %q, want %q", got, want)
	}

	if factory.calls != 1 || factory.apiID != 123 || factory.apiHash != "hash" || factory.session != "" {
		t.Fatalf("factory calls = %+v", factory)
	}
	if client.sendCodeCalls != 1 || client.sendCodePhone != "+14155552671" {
		t.Fatalf("sendCode = %+v", client)
	}
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1 (NestJS finally block)", client.closeCalls)
	}

	if len(store.savedKeys) != 1 || len(store.savedTTLs) != 1 {
		t.Fatalf("store saves = %v", store.savedKeys)
	}
	if got, want := store.savedKeys[0], "situation-monitor:telegram-auth:"+wantRequestID; got != want {
		t.Fatalf("cache key = %q, want %q", got, want)
	}
	if got, want := store.savedTTLs[0], 10*time.Minute; got != want {
		t.Fatalf("cache TTL = %s, want %s", got, want)
	}
	wantDocument := `{"requestId":"` + wantRequestID + `","orgId":"org-1","actorId":"user-1","telegramApiId":"123","telegramApiHash":"hash","phoneNumber":"+14155552671","phoneCodeHash":"code-hash","session":"SESSION-1","createdAt":"2026-10-20T20:47:16.123Z"}`
	if got := string(store.savedData[0]); got != wantDocument {
		t.Fatalf("pending document = %s, want %s", got, wantDocument)
	}

	phoneHash := sha256.Sum256([]byte("+14155552671"))
	wantKeys := []string{
		"situation-monitor:telegram-auth-start:user:org-1:user-1",
		"situation-monitor:telegram-auth-start:ip:org-1:203.0.113.5",
		"situation-monitor:telegram-auth-start:phone:org-1:" + hex.EncodeToString(phoneHash[:]),
	}
	if len(limiter.keys) != len(wantKeys) {
		t.Fatalf("rate limit keys = %v, want %v", limiter.keys, wantKeys)
	}
	for index, wantKey := range wantKeys {
		if limiter.keys[index] != wantKey {
			t.Fatalf("rate limit key[%d] = %q, want %q", index, limiter.keys[index], wantKey)
		}
		if limiter.windows[index] != 600 {
			t.Fatalf("rate limit window[%d] = %d, want 600", index, limiter.windows[index])
		}
	}
	if limiter.limits[0] != 5 || limiter.limits[1] != 15 || limiter.limits[2] != 3 {
		t.Fatalf("rate limits = %v, want user=5 ip=15 phone=3", limiter.limits)
	}
	if settings.updateCalls != 0 {
		t.Fatalf("startAuth must not update settings")
	}
}

func TestStartAuthSkipsIPBucketWithoutClientIP(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
	limiter := &fakeTelegramAuthLimiter{}
	service := newTestTelegramAuthService(settings, &fakeTelegramAuthFactory{client: client}, newFakeTelegramAuthStore(), limiter)

	if _, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		PhoneNumber: "+14155552671",
	}, "   "); err != nil {
		t.Fatalf("startAuth error = %v", err)
	}
	if len(limiter.keys) != 2 {
		t.Fatalf("rate limit keys = %v, want user + phone only", limiter.keys)
	}
}

func TestStartAuthRateLimitRunsBeforeTelegram(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}

	cases := []struct {
		name       string
		denyKey    string
		contains   bool
		wantKeys   int
		wantLimits []int
	}{
		{
			name:       "user bucket",
			denyKey:    "situation-monitor:telegram-auth-start:user:org-1:user-1",
			wantKeys:   1,
			wantLimits: []int{5},
		},
		{
			name:       "ip bucket",
			denyKey:    ":telegram-auth-start:ip:",
			contains:   true,
			wantKeys:   2,
			wantLimits: []int{5, 15},
		},
		{
			name:       "phone bucket",
			denyKey:    ":telegram-auth-start:phone:",
			contains:   true,
			wantKeys:   3,
			wantLimits: []int{5, 15, 3},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
			factory := &fakeTelegramAuthFactory{client: client}
			limiter := &fakeTelegramAuthLimiter{denyKey: testCase.denyKey, denyContains: testCase.contains}
			service := newTestTelegramAuthService(settings, factory, newFakeTelegramAuthStore(), limiter)
			_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
				PhoneNumber: "+14155552671",
			}, "203.0.113.5")
			requireTelegramAuthCoded(t, err, 429, telegramAuthCodeRateLimit)
			if factory.calls != 0 {
				t.Fatalf("factory calls = %d, rate limit must run before the MTProto client", factory.calls)
			}
			if len(limiter.keys) != testCase.wantKeys {
				t.Fatalf("rate limit keys = %v, want %d calls", limiter.keys, testCase.wantKeys)
			}
			for index, wantLimit := range testCase.wantLimits {
				if limiter.limits[index] != wantLimit {
					t.Fatalf("limit[%d] = %d, want %d", index, limiter.limits[index], wantLimit)
				}
			}
		})
	}
}

func TestStartAuthLimiterFailureIsFailClosed(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
	factory := &fakeTelegramAuthFactory{client: client}
	limiter := &fakeTelegramAuthLimiter{err: errors.New("redis down")}
	service := newTestTelegramAuthService(settings, factory, newFakeTelegramAuthStore(), limiter)

	_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		PhoneNumber: "+14155552671",
	}, "")
	requireTelegramAuthCoded(t, err, 429, telegramAuthCodeRateLimit)
	if factory.calls != 0 {
		t.Fatalf("factory calls = %d, fail-closed limiter must not reach Telegram", factory.calls)
	}
}

func TestStartAuthCredentialResolution(t *testing.T) {
	cases := []struct {
		name          string
		inputAPIID    optionalString
		inputAPIHash  optionalString
		storedAPIID   string
		storedAPIHash string
		wantAPIID     int
		wantAPIHash   string
		wantCode      string
	}{
		{
			name:          "body wins over stored",
			inputAPIID:    optionalString{state: presenceValue, value: "456"},
			inputAPIHash:  optionalString{state: presenceValue, value: "bodyhash"},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantAPIID:     456,
			wantAPIHash:   "bodyhash",
		},
		{
			name:          "stored fallback",
			inputAPIID:    optionalString{state: presenceMissing},
			inputAPIHash:  optionalString{state: presenceMissing},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantAPIID:     123,
			wantAPIHash:   "storehash",
		},
		{
			name:          "null body members fall back",
			inputAPIID:    optionalString{state: presenceNull},
			inputAPIHash:  optionalString{state: presenceNull},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantAPIID:     123,
			wantAPIHash:   "storehash",
		},
		{
			name:          "blank body members fall back",
			inputAPIID:    optionalString{state: presenceValue, value: "  "},
			inputAPIHash:  optionalString{state: presenceValue, value: "  "},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantAPIID:     123,
			wantAPIHash:   "storehash",
		},
		{
			name:          "body api id normalized through Number",
			inputAPIID:    optionalString{state: presenceValue, value: "00456"},
			inputAPIHash:  optionalString{state: presenceValue, value: "  hash  "},
			storedAPIID:   "",
			storedAPIHash: "",
			wantAPIID:     456,
			wantAPIHash:   "hash",
		},
		{
			name:          "missing both credentials",
			inputAPIID:    optionalString{state: presenceMissing},
			inputAPIHash:  optionalString{state: presenceMissing},
			storedAPIID:   "",
			storedAPIHash: "",
			wantCode:      telegramAuthCodeAPICredentialsNeeded,
		},
		{
			name:          "missing hash only",
			inputAPIID:    optionalString{state: presenceValue, value: "123"},
			inputAPIHash:  optionalString{state: presenceMissing},
			storedAPIID:   "",
			storedAPIHash: "",
			wantCode:      telegramAuthCodeAPICredentialsNeeded,
		},
		{
			name:          "non digital body api id",
			inputAPIID:    optionalString{state: presenceValue, value: "12a"},
			inputAPIHash:  optionalString{state: presenceValue, value: "hash"},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantCode:      telegramAuthCodeAPIIDInvalid,
		},
		{
			name:          "zero body api id",
			inputAPIID:    optionalString{state: presenceValue, value: "0"},
			inputAPIHash:  optionalString{state: presenceValue, value: "hash"},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantCode:      telegramAuthCodeAPIIDInvalid,
		},
		{
			name:          "negative body api id",
			inputAPIID:    optionalString{state: presenceValue, value: "-123"},
			inputAPIHash:  optionalString{state: presenceValue, value: "hash"},
			storedAPIID:   "123",
			storedAPIHash: "storehash",
			wantCode:      telegramAuthCodeAPIIDInvalid,
		},
		{
			name:          "non digital stored api id",
			inputAPIID:    optionalString{state: presenceMissing},
			inputAPIHash:  optionalString{state: presenceMissing},
			storedAPIID:   "abc",
			storedAPIHash: "storehash",
			wantCode:      telegramAuthCodeAPIIDInvalid,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			settings := &fakeTelegramAuthSettings{
				effective: EffectiveSettings{TelegramAPIID: testCase.storedAPIID, TelegramAPIHash: testCase.storedAPIHash},
			}
			client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
			factory := &fakeTelegramAuthFactory{client: client}
			service := newTestTelegramAuthService(settings, factory, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})

			_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
				TelegramAPIID:   testCase.inputAPIID,
				TelegramAPIHash: testCase.inputAPIHash,
				PhoneNumber:     "+14155552671",
			}, "")
			if testCase.wantCode != "" {
				requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
				if factory.calls != 0 {
					t.Fatalf("factory calls = %d, invalid credentials must not reach Telegram", factory.calls)
				}
				return
			}
			if err != nil {
				t.Fatalf("startAuth error = %v", err)
			}
			if factory.apiID != testCase.wantAPIID || factory.apiHash != testCase.wantAPIHash {
				t.Fatalf("factory = %d/%q, want %d/%q", factory.apiID, factory.apiHash, testCase.wantAPIID, testCase.wantAPIHash)
			}
		})
	}
}

func TestStartAuthSettingsFailureIsNotCoded(t *testing.T) {
	settingsErr := errors.New("mysql down")
	settings := &fakeTelegramAuthSettings{effectiveErr: settingsErr}
	factory := &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}
	service := newTestTelegramAuthService(settings, factory, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})

	_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		PhoneNumber: "+14155552671",
	}, "")
	var coded *telegramAuthCodedError
	if errors.As(err, &coded) {
		t.Fatalf("settings failure must stay a service error, got %+v", coded)
	}
	if !errors.Is(err, settingsErr) {
		t.Fatalf("error = %v, want the settings error", err)
	}
	if factory.calls != 0 {
		t.Fatalf("factory calls = %d", factory.calls)
	}
}

func TestStartAuthPhoneValidation(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	factory := &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}
	service := newTestTelegramAuthService(settings, factory, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})

	cases := map[string]string{
		"":                  telegramAuthCodeInvalidInput,
		"   ":               telegramAuthCodeInvalidInput,
		"14155552671":       telegramAuthCodePhoneFormatInvalid,
		"+123456":           telegramAuthCodePhoneFormatInvalid,
		"+1415555267111111": telegramAuthCodePhoneFormatInvalid,
	}
	for phone, wantCode := range cases {
		_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
			PhoneNumber: phone,
		}, "")
		requireTelegramAuthCoded(t, err, 400, wantCode)
	}
	if factory.calls != 0 {
		t.Fatalf("factory calls = %d, invalid phone must not reach Telegram", factory.calls)
	}
}

func TestStartAuthTelegramErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		sendErr  error
		wantCode string
	}{
		{"phone invalid", errors.New("PHONE_NUMBER_INVALID"), telegramAuthCodePhoneInvalid},
		{"flood wait", errors.New("FLOOD_WAIT_120"), telegramAuthCodeRateLimit},
		{"api id invalid", errors.New("API_ID_INVALID"), telegramAuthCodeAPIIDInvalid},
		{"unknown", errors.New("boom"), telegramAuthCodeFailed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
			client := &fakeTelegramAuthClient{sendCodeErr: testCase.sendErr}
			service := newTestTelegramAuthService(settings, &fakeTelegramAuthFactory{client: client}, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})

			_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
				PhoneNumber: "+14155552671",
			}, "")
			requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
			if client.closeCalls != 1 {
				t.Fatalf("close calls = %d, want 1", client.closeCalls)
			}
		})
	}
}

func TestStartAuthFactoryAndExportFailures(t *testing.T) {
	cases := []struct {
		name     string
		factory  *fakeTelegramAuthFactory
		client   *fakeTelegramAuthClient
		wantCode string
	}{
		{
			name:     "factory connect failure",
			factory:  &fakeTelegramAuthFactory{err: errors.New("connect failed")},
			wantCode: telegramAuthCodeFailed,
		},
		{
			name:     "session export failure",
			factory:  &fakeTelegramAuthFactory{},
			client:   &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, exportErr: errors.New("export failed")},
			wantCode: telegramAuthCodeFailed,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.factory.client == nil {
				testCase.factory.client = testCase.client
			}
			settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
			service := newTestTelegramAuthService(settings, testCase.factory, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})
			_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
				PhoneNumber: "+14155552671",
			}, "")
			requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
		})
	}
}

func TestStartAuthCacheSaveFailureIsFlattened(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
	store := newFakeTelegramAuthStore()
	store.saveErr = errors.New("redis down")
	service := newTestTelegramAuthService(settings, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

	_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		PhoneNumber: "+14155552671",
	}, "")
	// NestJS cache.set is inside startAuth's try/catch, so the cache failure is
	// flattened to TELEGRAM_AUTH_FAILED.
	requireTelegramAuthCoded(t, err, 400, telegramAuthCodeFailed)
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", client.closeCalls)
	}
}

func TestStartAuthRequestIDFailureIsFlattened(t *testing.T) {
	settings := &fakeTelegramAuthSettings{effective: EffectiveSettings{TelegramAPIID: "123", TelegramAPIHash: "hash"}}
	client := &fakeTelegramAuthClient{sendCodeResult: TelegramSentCode{PhoneCodeHash: "h"}, session: "S"}
	service := newTestTelegramAuthService(settings, &fakeTelegramAuthFactory{client: client}, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})
	service.newRequestID = func() (string, error) { return "", errors.New("entropy exhausted") }

	_, err := service.startAuth(context.Background(), "org-1", "user-1", StartTelegramAuthInput{
		PhoneNumber: "+14155552671",
	}, "")
	requireTelegramAuthCoded(t, err, 400, telegramAuthCodeFailed)
}

// ---- completeAuth ----

func testTelegramAuthPending() telegramAuthPending {
	return telegramAuthPending{
		RequestID:       testTelegramAuthRequestID,
		OrgID:           "org-1",
		ActorID:         "user-1",
		TelegramAPIID:   "123",
		TelegramAPIHash: "hash",
		PhoneNumber:     "+14155552671",
		PhoneCodeHash:   "code-hash",
		Session:         "SESSION-1",
		CreatedAt:       "2026-10-20T20:47:16.123Z",
	}
}

func TestCompleteAuthSuccess(t *testing.T) {
	client := &fakeTelegramAuthClient{session: "FINAL-SESSION"}
	factory := &fakeTelegramAuthFactory{client: client}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	settings := &fakeTelegramAuthSettings{}
	service := newTestTelegramAuthService(settings, factory, store, &fakeTelegramAuthLimiter{})

	completed, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
	if err != nil {
		t.Fatalf("completeAuth error = %v", err)
	}
	if completed.TelegramAPIID != "123" || completed.TelegramAPIHash != "hash" || completed.TelegramSession != "FINAL-SESSION" {
		t.Fatalf("completed = %+v", completed)
	}
	if factory.calls != 1 || factory.apiID != 123 || factory.apiHash != "hash" || factory.session != "SESSION-1" {
		t.Fatalf("factory = %+v", factory)
	}
	if client.signInCalls != 1 || client.signInPhone != "+14155552671" || client.signInHash != "code-hash" || client.signInCode != "12345" {
		t.Fatalf("signIn = %+v", client)
	}
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", client.closeCalls)
	}
	wantKey := "situation-monitor:telegram-auth:" + testTelegramAuthRequestID
	if len(store.deletedKeys) != 1 || store.deletedKeys[0] != wantKey {
		t.Fatalf("deleted keys = %v, want [%s]", store.deletedKeys, wantKey)
	}
	if len(store.savedKeys) != 0 {
		t.Fatalf("completeAuth must not write the cache")
	}
}

func TestCompleteAuthTrimsRequestValues(t *testing.T) {
	client := &fakeTelegramAuthClient{session: "FINAL"}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

	input := CompleteTelegramAuthInput{
		RequestID: "  " + testTelegramAuthRequestID + "  ",
		PhoneCode: "  12345  ",
	}
	if _, err := service.completeAuth(context.Background(), "org-1", "user-1", input); err != nil {
		t.Fatalf("completeAuth error = %v", err)
	}
	if client.signInCode != "12345" {
		t.Fatalf("signIn code = %q, want trimmed", client.signInCode)
	}
}

func TestCompleteAuthExpiredAndMismatch(t *testing.T) {
	cases := []struct {
		name    string
		seed    bool
		pending telegramAuthPending
		orgID   string
		actorID string
		code    string
	}{
		{name: "missing pending request", seed: false, orgID: "org-1", actorID: "user-1", code: telegramAuthCodeRequestExpired},
		{name: "other organization", seed: true, pending: testTelegramAuthPending(), orgID: "org-2", actorID: "user-1", code: telegramAuthCodeRequestMismatch},
		{name: "other actor", seed: true, pending: testTelegramAuthPending(), orgID: "org-1", actorID: "user-2", code: telegramAuthCodeRequestMismatch},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &fakeTelegramAuthClient{session: "FINAL"}
			factory := &fakeTelegramAuthFactory{client: client}
			store := newFakeTelegramAuthStore()
			if testCase.seed {
				pending := testCase.pending
				pending.RequestID = testTelegramAuthRequestID
				testTelegramAuthSeedPending(t, store, pending)
			}
			service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, factory, store, &fakeTelegramAuthLimiter{})

			_, err := service.completeAuth(context.Background(), testCase.orgID, testCase.actorID, testTelegramAuthCompleteInput())
			requireTelegramAuthCoded(t, err, 400, testCase.code)
			if factory.calls != 0 {
				t.Fatalf("factory calls = %d, tenant isolation must run before Telegram", factory.calls)
			}
		})
	}
}

func TestCompleteAuthSignUpRequired(t *testing.T) {
	client := &fakeTelegramAuthClient{signInErr: ErrTelegramSignUpRequired}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

	_, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
	requireTelegramAuthCoded(t, err, 400, telegramAuthCodeSignUpRequired)
	if client.passwordCalls != 0 {
		t.Fatalf("password calls = %d", client.passwordCalls)
	}
	if len(store.deletedKeys) != 0 {
		t.Fatalf("failed complete must keep the pending request: %v", store.deletedKeys)
	}
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", client.closeCalls)
	}
}

func TestCompleteAuthPasswordRequired(t *testing.T) {
	for _, signInErr := range []error{
		ErrTelegramPasswordNeeded,
		errors.New("rpc error SESSION_PASSWORD_NEEDED"),
	} {
		client := &fakeTelegramAuthClient{signInErr: signInErr}
		store := newFakeTelegramAuthStore()
		testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
		service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

		_, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
		requireTelegramAuthCoded(t, err, 400, telegramAuthCodePasswordRequired)
		if client.passwordCalls != 0 {
			t.Fatalf("password calls = %d, want 0 without a password", client.passwordCalls)
		}
	}
}

func TestCompleteAuthPasswordFlow(t *testing.T) {
	cases := []struct {
		name        string
		signInErr   error
		passwordErr error
		wantCode    string
	}{
		{name: "sentinel password needed", signInErr: ErrTelegramPasswordNeeded},
		{name: "text password needed", signInErr: errors.New("SESSION_PASSWORD_NEEDED")},
		{name: "wrong password", signInErr: ErrTelegramPasswordNeeded, passwordErr: errors.New("PASSWORD_HASH_INVALID"), wantCode: telegramAuthCodePasswordInvalid},
		{name: "password still needed after password step", signInErr: ErrTelegramPasswordNeeded, passwordErr: ErrTelegramPasswordNeeded, wantCode: telegramAuthCodePasswordRequired},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &fakeTelegramAuthClient{
				signInErr:   testCase.signInErr,
				passwordErr: testCase.passwordErr,
				session:     "FINAL",
			}
			store := newFakeTelegramAuthStore()
			testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
			service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

			input := testTelegramAuthCompleteInput()
			input.Password = optionalString{state: presenceValue, value: "  secret  "}
			completed, err := service.completeAuth(context.Background(), "org-1", "user-1", input)
			if testCase.wantCode != "" {
				requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
				return
			}
			if err != nil {
				t.Fatalf("completeAuth error = %v", err)
			}
			if completed.TelegramSession != "FINAL" {
				t.Fatalf("completed = %+v", completed)
			}
			if client.passwordCalls != 1 || client.password != "secret" {
				t.Fatalf("password call = %d/%q, want trimmed password", client.passwordCalls, client.password)
			}
			if len(store.deletedKeys) != 1 {
				t.Fatalf("pending request must be deleted after success")
			}
		})
	}
}

func TestCompleteAuthRequireValues(t *testing.T) {
	cases := []struct {
		name    string
		input   CompleteTelegramAuthInput
		wantMsg string
	}{
		{
			name:    "empty requestId",
			input:   CompleteTelegramAuthInput{RequestID: "   ", PhoneCode: "12345"},
			wantMsg: "requestId is required",
		},
		{
			name:    "empty phoneCode",
			input:   CompleteTelegramAuthInput{RequestID: testTelegramAuthRequestID, PhoneCode: "\t"},
			wantMsg: "phoneCode is required",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}, newFakeTelegramAuthStore(), &fakeTelegramAuthLimiter{})
			_, err := service.completeAuth(context.Background(), "org-1", "user-1", testCase.input)
			coded := requireTelegramAuthCoded(t, err, 400, telegramAuthCodeInvalidInput)
			if coded.detail != testCase.wantMsg {
				t.Fatalf("detail = %q, want %q", coded.detail, testCase.wantMsg)
			}
		})
	}
}

func TestCompleteAuthCacheFailures(t *testing.T) {
	loadErr := errors.New("redis down")
	cases := []struct {
		name      string
		setup     func(store *fakeTelegramAuthStore, client *fakeTelegramAuthClient)
		wantCode  string
		wantPlain bool
	}{
		{
			name: "null document is expired",
			setup: func(store *fakeTelegramAuthStore, _ *fakeTelegramAuthClient) {
				store.values[telegramAuthCacheKey(testTelegramAuthRequestID)] = []byte("null")
			},
			wantCode: telegramAuthCodeRequestExpired,
		},
		{
			name: "empty document is expired",
			setup: func(store *fakeTelegramAuthStore, _ *fakeTelegramAuthClient) {
				store.values[telegramAuthCacheKey(testTelegramAuthRequestID)] = []byte("")
			},
			wantCode: telegramAuthCodeRequestExpired,
		},
		{
			name: "corrupt document is a 500",
			setup: func(store *fakeTelegramAuthStore, _ *fakeTelegramAuthClient) {
				store.values[telegramAuthCacheKey(testTelegramAuthRequestID)] = []byte("{oops")
			},
			wantPlain: true,
		},
		{
			name:      "load failure is a 500",
			setup:     func(store *fakeTelegramAuthStore, _ *fakeTelegramAuthClient) { store.loadErr = loadErr },
			wantPlain: true,
		},
		{
			name: "delete failure is TELEGRAM_AUTH_FAILED",
			setup: func(store *fakeTelegramAuthStore, _ *fakeTelegramAuthClient) {
				testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
				store.deleteErr = errors.New("redis del down")
			},
			wantCode: telegramAuthCodeFailed,
		},
		{
			name: "unknown sign in error",
			setup: func(store *fakeTelegramAuthStore, client *fakeTelegramAuthClient) {
				testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
				client.signInErr = errors.New("boom")
			},
			wantCode: telegramAuthCodeFailed,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := &fakeTelegramAuthClient{session: "FINAL"}
			store := newFakeTelegramAuthStore()
			testCase.setup(store, client)
			service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

			_, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
			if testCase.wantPlain {
				var coded *telegramAuthCodedError
				if errors.As(err, &coded) {
					t.Fatalf("error must stay a service error, got %+v", coded)
				}
				if err == nil {
					t.Fatal("expected an error")
				}
				return
			}
			requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
		})
	}
}

func TestCompleteAuthExportFailure(t *testing.T) {
	client := &fakeTelegramAuthClient{session: "FINAL", exportErr: errors.New("export failed")}
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, testTelegramAuthPending())
	service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: client}, store, &fakeTelegramAuthLimiter{})

	_, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
	requireTelegramAuthCoded(t, err, 400, telegramAuthCodeFailed)
	if len(store.deletedKeys) != 0 {
		t.Fatalf("failed export must keep the pending request")
	}
}

func TestCompleteAuthCorruptAPIID(t *testing.T) {
	pending := testTelegramAuthPending()
	pending.TelegramAPIID = "not-a-number"
	store := newFakeTelegramAuthStore()
	testTelegramAuthSeedPending(t, store, pending)
	service := newTestTelegramAuthService(&fakeTelegramAuthSettings{}, &fakeTelegramAuthFactory{client: &fakeTelegramAuthClient{}}, store, &fakeTelegramAuthLimiter{})

	_, err := service.completeAuth(context.Background(), "org-1", "user-1", testTelegramAuthCompleteInput())
	requireTelegramAuthCoded(t, err, 400, telegramAuthCodeAPIIDInvalid)
}

// ---- normalization helpers ----

func TestNormalizeTelegramAuthAPIIDIfProvided(t *testing.T) {
	cases := []struct {
		value      string
		wantString string
		wantInt    int
		wantCode   string
	}{
		{value: "", wantString: "", wantInt: 0},
		{value: "   ", wantString: "", wantInt: 0},
		{value: "123", wantString: "123", wantInt: 123},
		{value: "00123", wantString: "123", wantInt: 123},
		{value: " 123 ", wantString: "123", wantInt: 123},
		{value: "4294967296", wantString: "4294967296", wantInt: 4294967296},
		{value: "abc", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: "12a", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: "-1", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: "1.5", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: "0", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: "000", wantCode: telegramAuthCodeAPIIDInvalid},
		{value: strings.Repeat("9", 400), wantCode: telegramAuthCodeAPIIDInvalid},
	}
	for _, testCase := range cases {
		gotString, gotInt, err := normalizeTelegramAuthAPIIDIfProvided(testCase.value)
		if testCase.wantCode != "" {
			requireTelegramAuthCoded(t, err, 400, testCase.wantCode)
			continue
		}
		if err != nil {
			t.Fatalf("normalize(%q) error = %v", testCase.value, err)
		}
		if gotString != testCase.wantString || gotInt != testCase.wantInt {
			t.Fatalf("normalize(%q) = %q/%d, want %q/%d", testCase.value, gotString, gotInt, testCase.wantString, testCase.wantInt)
		}
	}
}

func TestNewTelegramAuthRequestIDIsUUIDv4(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		value, err := newTelegramAuthRequestID()
		if err != nil {
			t.Fatalf("newTelegramAuthRequestID error = %v", err)
		}
		if !pattern.MatchString(value) {
			t.Fatalf("id = %q, want RFC 4122 version 4", value)
		}
		if seen[value] {
			t.Fatalf("duplicate id %q", value)
		}
		seen[value] = true
	}
}

func TestDecodeTelegramAuthPendingRejectsFalsyDocuments(t *testing.T) {
	for _, payload := range []string{"", "null", "false", "0", "-0", "0.0", `""`} {
		_, found, err := decodeTelegramAuthPending([]byte(payload))
		if err != nil || found {
			t.Fatalf("decode(%q) found=%v err=%v, want not found", payload, found, err)
		}
	}
}

func TestDecodeTelegramAuthPendingTruthyNonObject(t *testing.T) {
	// NestJS JSON.parse yields a truthy primitive/array whose properties are
	// undefined, so completeAuth reports TELEGRAM_AUTH_REQUEST_MISMATCH; the
	// decoder reproduces that with found=true and a zero pending document.
	for _, payload := range []string{"[]", `"str"`, "123", "true", "[1,2]"} {
		pending, found, err := decodeTelegramAuthPending([]byte(payload))
		if err != nil {
			t.Fatalf("decode(%q) error = %v", payload, err)
		}
		if !found {
			t.Fatalf("decode(%q) found=false, want found truthy", payload)
		}
		if pending != (telegramAuthPending{}) {
			t.Fatalf("decode(%q) = %+v, want zero pending", payload, pending)
		}
	}
}

func TestTelegramAuthRedisAdaptersWithoutClient(t *testing.T) {
	store := newRedisTelegramAuthStore(nil)
	if _, _, err := store.Load(context.Background(), "k"); !errors.Is(err, errTelegramAuthRedisUnavailable) {
		t.Fatalf("load error = %v", err)
	}
	if err := store.Save(context.Background(), "k", nil, time.Second); !errors.Is(err, errTelegramAuthRedisUnavailable) {
		t.Fatalf("save error = %v", err)
	}
	if err := store.Delete(context.Background(), "k"); !errors.Is(err, errTelegramAuthRedisUnavailable) {
		t.Fatalf("delete error = %v", err)
	}

	closed := newRedisTelegramAuthRateLimiter(nil, false)
	if allowed, err := closed.Consume(context.Background(), "k", 1, 600); err != nil || allowed {
		t.Fatalf("fail-closed consume = %v/%v, want false/nil", allowed, err)
	}
	open := newRedisTelegramAuthRateLimiter(nil, true)
	if allowed, err := open.Consume(context.Background(), "k", 1, 600); err != nil || !allowed {
		t.Fatalf("fail-open consume = %v/%v, want true/nil", allowed, err)
	}
}
