package emailsettings

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
	"github.com/wei500L/newwei/apps/api-go/internal/smtpmail"
)

type execCall struct {
	query string
	args  []any
}

type fakeDB struct {
	values map[string][]byte
	execs  []execCall
}

func (f *fakeDB) Exec(_ context.Context, query string, args ...any) error {
	f.execs = append(f.execs, execCall{query: query, args: args})
	return nil
}

func (f *fakeDB) QueryValue(_ context.Context, key string) ([]byte, bool, error) {
	value, ok := f.values[key]
	return value, ok, nil
}

func baseConfig() Config {
	return Config{
		SMTP: SMTPConfig{
			Host:                  "smtp.example.com",
			Port:                  465,
			Secure:                true,
			User:                  "admin@example.com",
			Pass:                  "secret",
			From:                  "admin@example.com",
			MaxConnections:        5,
			MaxMessages:           100,
			RateDeltaMs:           1000,
			RateLimit:             10,
			ConnectionTimeoutMs:   10000,
			GreetingTimeoutMs:     10000,
			SocketTimeoutMs:       30000,
			TLSRejectUnauthorized: true,
		},
		AuthCodeTTLSeconds:      300,
		AuthCodeCooldownSeconds: 90,
		AuthCodeMaxAttempts:     3,
	}
}

func TestAuthCodeSettingsNormalization(t *testing.T) {
	db := &fakeDB{values: map[string][]byte{
		authCodeSettingsRowKey: []byte(`{"ttlSeconds":10,"cooldownSeconds":99999,"maxAttempts":"x"}`),
	}}
	service := NewService(db, nil, baseConfig())
	got, err := service.settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.TTLSeconds != 60 || got.CooldownSeconds != 3600 || got.MaxAttempts != 3 {
		t.Fatalf("normalized = %+v", got)
	}
}

func TestAuthCodeSettingsEnvironmentFallbackWhenNoRow(t *testing.T) {
	service := NewService(&fakeDB{}, nil, baseConfig())
	got, err := service.settings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.TTLSeconds != 300 || got.CooldownSeconds != 90 || got.MaxAttempts != 3 {
		t.Fatalf("fallback = %+v", got)
	}
}

func TestAuthCodeDTORanges(t *testing.T) {
	cases := []struct {
		body string
		want string
	}{
		{`{"ttlSeconds":59,"cooldownSeconds":10,"maxAttempts":1}`, "ttlSeconds must not be less than 60"},
		{`{"ttlSeconds":1801,"cooldownSeconds":10,"maxAttempts":1}`, "ttlSeconds must not be greater than 1800"},
		{`{"ttlSeconds":300.5,"cooldownSeconds":10,"maxAttempts":1}`, "ttlSeconds must be an integer number"},
		{`{"ttlSeconds":"300","cooldownSeconds":10,"maxAttempts":1}`, "ttlSeconds must be an integer number"},
		{`{}`, "ttlSeconds must not be greater than 1800; ttlSeconds must not be less than 60"},
	}
	for _, tc := range cases {
		_, err := parseAuthCodeDTO([]byte(tc.body))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("body %s error = %v, want %q", tc.body, err, tc.want)
		}
	}
	got, err := parseAuthCodeDTO([]byte(`{"ttlSeconds":60,"cooldownSeconds":3600,"maxAttempts":10}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.TTLSeconds != 60 || got.CooldownSeconds != 3600 || got.MaxAttempts != 10 {
		t.Fatalf("accepted = %+v", got)
	}
}

func TestVerifyCacheTTLAndSingleFlight(t *testing.T) {
	var calls atomic.Int64
	now := time.UnixMilli(1_700_000_000_000)
	service := NewServiceForTest(nil, nil, baseConfig(), func(context.Context) error {
		calls.Add(1)
		return nil
	}, nil, func() time.Time { return now })

	if err := service.verify.verifyCached(context.Background(), time.Minute); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	if err := service.verify.verifyCached(context.Background(), time.Minute); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("verify calls = %d, want 1 inside TTL", calls.Load())
	}
	now = now.Add(31 * time.Second)
	if err := service.verify.verifyCached(context.Background(), time.Minute); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("verify calls = %d, want 2 after TTL", calls.Load())
	}

	// Forced verify (TTL 0) still shares one in-flight attempt.
	var shared atomic.Int64
	slow := NewServiceForTest(nil, nil, baseConfig(), func(context.Context) error {
		shared.Add(1)
		time.Sleep(50 * time.Millisecond)
		return nil
	}, nil, func() time.Time { return now })
	var wg sync.WaitGroup
	for index := 0; index < 20; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = slow.verify.verifyCached(context.Background(), 0)
		}()
	}
	wg.Wait()
	if shared.Load() != 1 {
		t.Fatalf("concurrent verifies = %d, want 1", shared.Load())
	}
}

func TestVerifyCacheReportsFailure(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	failure := errors.New("connection refused")
	service := NewServiceForTest(nil, nil, baseConfig(), func(context.Context) error { return failure }, nil, func() time.Time { return now })
	_ = service.verify.verifyCached(context.Background(), time.Minute)
	status := service.verify.status()
	if status.OK == nil || *status.OK || status.Error == nil || *status.Error != "connection refused" {
		t.Fatalf("status = %+v", status)
	}
	if status.CheckedAt == nil || *status.CheckedAt != "2023-11-14T22:13:20.000Z" {
		t.Fatalf("checkedAt = %v", status.CheckedAt)
	}
	// Never-run status is all null.
	empty := newVerifyCache(nil, func(context.Context) error { return nil }).status()
	if empty.OK != nil || empty.CheckedAt != nil || empty.Error != nil {
		t.Fatalf("empty status = %+v", empty)
	}
}

func TestSendTestRejectsForeignRecipientWith400(t *testing.T) {
	service := NewServiceForTest(&fakeDB{}, nil, baseConfig(), func(context.Context) error { return nil }, nil, time.Now)
	_, err := service.sendTest(context.Background(), "other@elsewhere.com", "", "")
	var coded *settingshttp.Error
	if !errors.As(err, &coded) || coded.Status != 400 {
		t.Fatalf("err = %v, want 400", err)
	}
	if coded.Message != emailTestNotAllowedReason {
		t.Fatalf("message = %q", coded.Message)
	}
}

func TestSendTestSendsToConfiguredAccountAndReturnsResult(t *testing.T) {
	var sent smtpmail.Message
	service := NewServiceForTest(&fakeDB{}, nil, baseConfig(),
		func(context.Context) error { return nil },
		func(_ context.Context, message smtpmail.Message) (smtpmail.Result, error) {
			sent = message
			return smtpmail.Result{MessageID: message.MessageID, Accepted: []string{message.To}, Rejected: []string{}}, nil
		},
		func() time.Time { return time.UnixMilli(1_700_000_000_000) })
	result, err := service.sendTest(context.Background(), " ADMIN@example.com ", "  ", "trace-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.To != "ADMIN@example.com" || result.MessageID == "" || len(result.Accepted) != 1 {
		t.Fatalf("result = %+v", result)
	}
	if sent.Subject != "Test email" || !strings.Contains(sent.Text, "2023-11-14T22:13:20.000Z") ||
		!strings.Contains(sent.HTML, "Modular API") || sent.TraceID != "trace-1" {
		t.Fatalf("message = %+v", sent)
	}
}

func TestSendTestEmptyRecipientUsesSMTPUser(t *testing.T) {
	service := NewServiceForTest(&fakeDB{}, nil, baseConfig(),
		func(context.Context) error { return nil },
		func(_ context.Context, message smtpmail.Message) (smtpmail.Result, error) {
			return smtpmail.Result{MessageID: message.MessageID, Accepted: []string{message.To}}, nil
		},
		time.Now)
	result, err := service.sendTest(context.Background(), "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if result.To != "admin@example.com" {
		t.Fatalf("to = %q", result.To)
	}
}

func TestUpdateSettingsUpsertsAndAudits(t *testing.T) {
	db := &fakeDB{}
	service := NewService(db, nil, baseConfig())
	updated, err := service.updateSettings(context.Background(), "org-1", "user-1",
		AuthCodeSettings{TTLSeconds: 1800, CooldownSeconds: 10, MaxAttempts: 10})
	if err != nil {
		t.Fatal(err)
	}
	if updated.TTLSeconds != 1800 {
		t.Fatalf("updated = %+v", updated)
	}
	if len(db.execs) != 2 {
		t.Fatalf("execs = %d, want upsert + audit", len(db.execs))
	}
	if !strings.Contains(db.execs[0].query, "INSERT INTO SystemSetting") ||
		strings.Contains(db.execs[0].query, "description =") {
		t.Fatalf("upsert query = %q (description must only be set on insert)", db.execs[0].query)
	}
	if !strings.Contains(string(db.execs[1].query), "INSERT INTO AuditLog") {
		t.Fatalf("audit query = %q", db.execs[1].query)
	}
	if action := db.execs[1].args[4]; action != emailAuditAction {
		t.Fatalf("audit action = %v", action)
	}
}

func TestEmailTestDTOValidation(t *testing.T) {
	if _, _, err := parseTestDTO([]byte(`{"to":"not-an-email"}`)); err == nil {
		t.Fatal("expected an email validation error")
	}
	if to, subject, err := parseTestDTO([]byte(`{"to":null,"subject":null}`)); err != nil || to != "" || subject != "" {
		t.Fatalf("null optional fields: to=%q subject=%q err=%v", to, subject, err)
	}
	if _, _, err := parseTestDTO([]byte(`{"subject":"` + strings.Repeat("x", 141) + `"}`)); err == nil {
		t.Fatal("expected a subject length error")
	}
}

// TestEmailDTORejectsUnknownProperties pins ValidationPipe's whitelist +
// forbidNonWhitelisted: a member the DTO does not declare is a 400 instead of
// being silently ignored.
func TestEmailDTORejectsUnknownProperties(t *testing.T) {
	if _, err := parseAuthCodeDTO([]byte(`{"ttlSeconds":300,"cooldownSeconds":60,"maxAttempts":3,"ttl":60}`)); err == nil ||
		!strings.Contains(err.Error(), "property ttl should not exist") {
		t.Fatalf("auth-code unknown property error = %v", err)
	}
	if _, err := parseAuthCodeDTO([]byte(`{"ttlSeconds":300,"cooldownSeconds":60,"maxAttempts":3}`)); err != nil {
		t.Fatalf("valid auth-code body = %v", err)
	}
	if _, _, err := parseTestDTO([]byte(`{"to":"admin@example.com","extra":true}`)); err == nil ||
		!strings.Contains(err.Error(), "property extra should not exist") {
		t.Fatalf("test unknown property error = %v", err)
	}
	if _, _, err := parseTestDTO([]byte(`{"to":"admin@example.com"}`)); err != nil {
		t.Fatalf("valid test body = %v", err)
	}
	// `__proto__` is deleted by the ValidationPipe before validation.
	if _, err := parseAuthCodeDTO([]byte(`{"ttlSeconds":300,"cooldownSeconds":60,"maxAttempts":3,"__proto__":{"x":1}}`)); err != nil {
		t.Fatalf("__proto__ must be skipped: %v", err)
	}
}
