package situationsettings

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// TestToTelegramAuthBadRequestCodeTable pins the exact includes-order chain of
// SituationMonitorTelegramAuthService.toBadRequest and the fallback code.
func TestToTelegramAuthBadRequestCodeTable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"phone code invalid", errors.New("rpc error: PHONE_CODE_INVALID"), telegramAuthCodeCodeInvalid},
		{"generic code invalid", errors.New("CODE_INVALID"), telegramAuthCodeCodeInvalid},
		{"code invalid wins over code expired", errors.New("CODE_INVALID then PHONE_CODE_EXPIRED"), telegramAuthCodeCodeInvalid},
		{"phone code expired", errors.New("PHONE_CODE_EXPIRED"), telegramAuthCodeCodeExpired},
		{"password hash invalid", errors.New("PASSWORD_HASH_INVALID"), telegramAuthCodePasswordInvalid},
		{"session password needed", errors.New("SESSION_PASSWORD_NEEDED"), telegramAuthCodePasswordRequired},
		{"flood wait is a 400 rate limit", errors.New("FLOOD_WAIT_32"), telegramAuthCodeRateLimit},
		{"phone number invalid", errors.New("PHONE_NUMBER_INVALID"), telegramAuthCodePhoneInvalid},
		{"phone number banned", errors.New("PHONE_NUMBER_BANNED"), telegramAuthCodePhoneBanned},
		{"phone number unoccupied", errors.New("PHONE_NUMBER_UNOCCUPIED"), telegramAuthCodePhoneUnoccupied},
		{"phone code empty", errors.New("PHONE_CODE_EMPTY"), telegramAuthCodeCodeRequired},
		{"api id invalid", errors.New("API_ID_INVALID"), telegramAuthCodeAPIIDInvalid},
		{"auth restart", errors.New("AUTH_RESTART"), telegramAuthCodeAuthRestartRequired},
		{"lowercase is matched uppercase", errors.New("phone_code_invalid"), telegramAuthCodeCodeInvalid},
		{"wrapped error still matches", errors.Join(errors.New("context"), errors.New("SESSION_PASSWORD_NEEDED")), telegramAuthCodePasswordRequired},
		{"unknown falls back to failed", errors.New("network unreachable"), telegramAuthCodeFailed},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			mapped := toTelegramAuthBadRequest(testCase.err)
			var coded *telegramAuthCodedError
			if !errors.As(mapped, &coded) {
				t.Fatalf("mapped error = %T, want *telegramAuthCodedError", mapped)
			}
			if coded.code != testCase.want {
				t.Fatalf("code = %q, want %q", coded.code, testCase.want)
			}
			if coded.statusCode != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", coded.statusCode)
			}
		})
	}
}

func TestToTelegramAuthBadRequestPassesCodedErrorsThrough(t *testing.T) {
	original := &telegramAuthCodedError{statusCode: http.StatusTooManyRequests, code: telegramAuthCodeRateLimit}
	mapped := toTelegramAuthBadRequest(original)
	var coded *telegramAuthCodedError
	if !errors.As(mapped, &coded) || coded != original {
		t.Fatalf("mapped = %#v, want the original coded error", mapped)
	}

	detail := telegramAuthBadRequestWithDetail(telegramAuthCodeInvalidInput, "requestId is required")
	mapped = toTelegramAuthBadRequest(detail)
	if !errors.As(mapped, &coded) || coded.detail != "requestId is required" {
		t.Fatalf("mapped = %#v, want the detail preserved", mapped)
	}
}

func TestToTelegramAuthBadRequestWrapsFlatBadRequest(t *testing.T) {
	mapped := toTelegramAuthBadRequest(badRequest(telegramAuthCodeRequestExpired))
	var coded *telegramAuthCodedError
	if !errors.As(mapped, &coded) {
		t.Fatalf("mapped = %T, want coded", mapped)
	}
	if coded.code != telegramAuthCodeRequestExpired || coded.detail != "" {
		t.Fatalf("coded = %+v, want the code kept without detail", coded)
	}

	mapped = toTelegramAuthBadRequest(badRequest("something else"))
	if !errors.As(mapped, &coded) {
		t.Fatalf("mapped = %T, want coded", mapped)
	}
	if coded.code != telegramAuthCodeInvalidInput || coded.detail != "something else" {
		t.Fatalf("coded = %+v, want INVALID_INPUT with the message in detail", coded)
	}
}

func TestWriteTelegramAuthCodedErrorBodyShape(t *testing.T) {
	coded := &telegramAuthCodedError{
		statusCode: http.StatusBadRequest,
		code:       telegramAuthCodeRequestExpired,
	}
	recorder := serveTelegramAuthError(t, telegramAuthStartPath, coded)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if got := recorder.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	body := recorder.Body.String()
	// GlobalExceptionFilter: {...normalized, traceId, path, timestamp} with
	// normalized = { statusCode, message, error, code }.
	if !strings.HasPrefix(body, `{"statusCode":400,"message":"TELEGRAM_AUTH_REQUEST_EXPIRED","error":"Bad Request","code":"TELEGRAM_AUTH_REQUEST_EXPIRED","traceId":"`) {
		t.Fatalf("unexpected body prefix: %s", body)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, body)
	}
	if _, hasDetail := payload["detail"]; hasDetail {
		t.Fatalf("detail must be omitted when empty: %v", payload)
	}
	if payload["traceId"] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("traceId = %v", payload["traceId"])
	}
	if payload["path"] != telegramAuthStartPath {
		t.Fatalf("path = %v", payload["path"])
	}
	timestamp, ok := payload["timestamp"].(string)
	if !ok || !regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`).MatchString(timestamp) {
		t.Fatalf("timestamp = %v, want Date.toISOString shape", payload["timestamp"])
	}
}

func TestWriteTelegramAuthCodedErrorRateLimitShape(t *testing.T) {
	coded := &telegramAuthCodedError{
		statusCode: http.StatusTooManyRequests,
		code:       telegramAuthCodeRateLimit,
	}
	recorder := serveTelegramAuthError(t, telegramAuthStartPath, coded)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.HasPrefix(body, `{"statusCode":429,"message":"TELEGRAM_AUTH_RATE_LIMIT","error":"Too Many Requests","code":"TELEGRAM_AUTH_RATE_LIMIT","traceId":"`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

func TestWriteTelegramAuthCodedErrorKeepsDetail(t *testing.T) {
	coded := telegramAuthBadRequestWithDetail(telegramAuthCodeInvalidInput, "requestId is required")
	recorder := serveTelegramAuthError(t, telegramAuthCompletePath, coded)
	body := recorder.Body.String()
	if !strings.HasPrefix(body, `{"statusCode":400,"message":"TELEGRAM_AUTH_INVALID_INPUT","error":"Bad Request","code":"TELEGRAM_AUTH_INVALID_INPUT","detail":"requestId is required","traceId":"`) {
		t.Fatalf("unexpected body: %s", body)
	}
}

// serveTelegramAuthError runs the writer behind the real trace middleware so
// traceId/path/timestamp are populated exactly like production.
func serveTelegramAuthError(t *testing.T, path string, coded *telegramAuthCodedError) *httptest.ResponseRecorder {
	t.Helper()
	handler := httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeTelegramAuthCodedError(w, r, coded)
	}))
	request := httptest.NewRequest(http.MethodPost, path, nil)
	request.Header.Set("x-trace-id", "0123456789abcdef0123456789abcdef")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestTelegramAuthISOTimeMatchesJavaScript(t *testing.T) {
	instant := time.Date(2026, 10, 20, 23, 47, 16, 123_000_000, time.FixedZone("MSK", 3*60*60))
	if got, want := telegramAuthISOTime(instant), "2026-10-20T20:47:16.123Z"; got != want {
		t.Fatalf("telegramAuthISOTime() = %q, want %q", got, want)
	}
	// Millisecond precision is always three digits, including zero.
	instant = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if got, want := telegramAuthISOTime(instant), "2026-01-02T03:04:05.000Z"; got != want {
		t.Fatalf("telegramAuthISOTime() = %q, want %q", got, want)
	}
}
