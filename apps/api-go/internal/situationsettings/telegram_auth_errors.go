package situationsettings

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// This file holds the error-code translation of
// SituationMonitorTelegramAuthService.toBadRequest/toErrorMessage plus the
// {code,message,detail} body that GlobalExceptionFilter turns into the HTTP
// response.
//
// GlobalExceptionFilter (apps/api/src/common/filters/global-exception.filter.ts)
// builds the REST body as:
//
//	normalized = { statusCode, message, error, ...safePayload }
//	body       = { ...normalized, traceId, path, timestamp }
//
// where safePayload is {code, detail?} only when `code` is a string matching
// ^[A-Z0-9_]+$ (isSafeErrorCode, line 319), `message` is the HttpException
// response message (`code` for BadRequestException({code, message: code})),
// and `error` is the HTTP status enum name ("Bad Request" line 331,
// "Too Many Requests"). The BadRequestException created by the service is
// exactly `{code, message: code, detail?}` (situation-monitor-telegram-auth
// .service.ts badRequest()), so the client sees `message` and `code` with the
// same value and `detail` only for TELEGRAM_AUTH_INVALID_INPUT.

// Telegram auth error codes, verbatim from the NestJS service.
const (
	telegramAuthCodeAPIIDInvalid         = "TELEGRAM_AUTH_API_ID_INVALID"
	telegramAuthCodeAPICredentialsNeeded = "TELEGRAM_AUTH_API_CREDENTIALS_REQUIRED"
	telegramAuthCodeAuthRestartRequired  = "TELEGRAM_AUTH_RESTART_REQUIRED"
	telegramAuthCodeCodeExpired          = "TELEGRAM_AUTH_CODE_EXPIRED"
	telegramAuthCodeCodeInvalid          = "TELEGRAM_AUTH_CODE_INVALID"
	telegramAuthCodeCodeRequired         = "TELEGRAM_AUTH_CODE_REQUIRED"
	telegramAuthCodeFailed               = "TELEGRAM_AUTH_FAILED"
	telegramAuthCodeInvalidInput         = "TELEGRAM_AUTH_INVALID_INPUT"
	telegramAuthCodePasswordInvalid      = "TELEGRAM_AUTH_PASSWORD_INVALID"
	telegramAuthCodePasswordRequired     = "TELEGRAM_AUTH_PASSWORD_REQUIRED"
	telegramAuthCodePhoneBanned          = "TELEGRAM_AUTH_PHONE_BANNED"
	telegramAuthCodePhoneFormatInvalid   = "TELEGRAM_AUTH_PHONE_FORMAT_INVALID"
	telegramAuthCodePhoneInvalid         = "TELEGRAM_AUTH_PHONE_INVALID"
	telegramAuthCodePhoneUnoccupied      = "TELEGRAM_AUTH_PHONE_UNOCCUPIED"
	telegramAuthCodeRateLimit            = "TELEGRAM_AUTH_RATE_LIMIT"
	telegramAuthCodeRequestExpired       = "TELEGRAM_AUTH_REQUEST_EXPIRED"
	telegramAuthCodeRequestMismatch      = "TELEGRAM_AUTH_REQUEST_MISMATCH"
	telegramAuthCodeSignUpRequired       = "TELEGRAM_AUTH_SIGNUP_REQUIRED"
)

// telegramAuthCodePattern is the NestJS /^TELEGRAM_AUTH_[A-Z0-9_]+$/ test used
// when a BadRequestException carries only a message.
var telegramAuthCodePattern = regexp.MustCompile(`^TELEGRAM_AUTH_[A-Z0-9_]+$`)

// telegramAuthCodedError is BadRequestException({code, message: code, detail?})
// or TooManyRequestsException({code, message: code, detail?}). It is the Go
// mirror of "HttpException whose response object has a string code" and is
// passed through unchanged by toBadRequest, exactly like NestJS rethrows a
// coded BadRequestException.
type telegramAuthCodedError struct {
	statusCode int
	code       string
	detail     string
}

func (e *telegramAuthCodedError) Error() string { return e.code }

// telegramAuthBadRequest builds BadRequestException({code, message: code}).
func telegramAuthBadRequest(code string) error {
	return &telegramAuthCodedError{statusCode: http.StatusBadRequest, code: code}
}

// telegramAuthBadRequestWithDetail builds
// BadRequestException({code, message: code, detail}).
func telegramAuthBadRequestWithDetail(code, detail string) error {
	return &telegramAuthCodedError{statusCode: http.StatusBadRequest, code: code, detail: detail}
}

// telegramAuthTooManyRequests builds
// TooManyRequestsException({code, message: code}).
func telegramAuthTooManyRequests(code string) error {
	return &telegramAuthCodedError{statusCode: http.StatusTooManyRequests, code: code}
}

// toTelegramAuthBadRequest mirrors
// SituationMonitorTelegramAuthService.toBadRequest: a coded exception passes
// through, a Telegram RPC error is matched case-insensitively against the same
// ordered table as NestJS, and everything else logs a warning and becomes
// TELEGRAM_AUTH_FAILED.
func toTelegramAuthBadRequest(err error) error {
	if err == nil {
		return nil
	}

	var coded *telegramAuthCodedError
	if errors.As(err, &coded) {
		return coded
	}

	// A flat BadRequestException (no coded response object): NestJS keeps a
	// message that already looks like a code, otherwise wraps it as
	// TELEGRAM_AUTH_INVALID_INPUT with the original message in `detail`.
	var flat *httpError
	if errors.As(err, &flat) && flat.status == http.StatusBadRequest {
		if telegramAuthCodePattern.MatchString(flat.message) {
			return telegramAuthBadRequest(flat.message)
		}
		return telegramAuthBadRequestWithDetail(telegramAuthCodeInvalidInput, flat.message)
	}

	message := err.Error()
	normalized := strings.ToUpper(message)

	// Order is the NestJS if-chain, do not reorder: several telegram codes
	// share substrings (PHONE_CODE_INVALID contains CODE_INVALID,
	// PHONE_CODE_EXPIRED must be checked before the generic buckets).
	switch {
	case strings.Contains(normalized, "PHONE_CODE_INVALID") || strings.Contains(normalized, "CODE_INVALID"):
		return telegramAuthBadRequest(telegramAuthCodeCodeInvalid)
	case strings.Contains(normalized, "PHONE_CODE_EXPIRED"):
		return telegramAuthBadRequest(telegramAuthCodeCodeExpired)
	case strings.Contains(normalized, "PASSWORD_HASH_INVALID"):
		return telegramAuthBadRequest(telegramAuthCodePasswordInvalid)
	case strings.Contains(normalized, "SESSION_PASSWORD_NEEDED"):
		return telegramAuthBadRequest(telegramAuthCodePasswordRequired)
	case strings.Contains(normalized, "FLOOD_WAIT"):
		// NestJS deliberately answers FLOOD_WAIT with a 400
		// TELEGRAM_AUTH_RATE_LIMIT, not with a 429.
		return telegramAuthBadRequest(telegramAuthCodeRateLimit)
	case strings.Contains(normalized, "PHONE_NUMBER_INVALID"):
		return telegramAuthBadRequest(telegramAuthCodePhoneInvalid)
	case strings.Contains(normalized, "PHONE_NUMBER_BANNED"):
		return telegramAuthBadRequest(telegramAuthCodePhoneBanned)
	case strings.Contains(normalized, "PHONE_NUMBER_UNOCCUPIED"):
		return telegramAuthBadRequest(telegramAuthCodePhoneUnoccupied)
	case strings.Contains(normalized, "PHONE_CODE_EMPTY"):
		return telegramAuthBadRequest(telegramAuthCodeCodeRequired)
	case strings.Contains(normalized, "API_ID_INVALID"):
		return telegramAuthBadRequest(telegramAuthCodeAPIIDInvalid)
	case strings.Contains(normalized, "AUTH_RESTART"):
		return telegramAuthBadRequest(telegramAuthCodeAuthRestartRequired)
	default:
		// NestJS logs the whole error object here. The Go message never
		// contains the session string, the login code or the password (those
		// are never embedded in an error by the client contract), so logging
		// the message stays safe and useful.
		log.Printf("situationsettings: telegram auth request failed: %s", message)
		return telegramAuthBadRequest(telegramAuthCodeFailed)
	}
}

// telegramAuthErrorBody is the GlobalExceptionFilter REST error shape for a
// coded telegram auth failure. Field order is the serialization order of the
// NestJS spread ({...normalized, traceId, path, timestamp}); omitempty matches
// the fields the filter drops.
type telegramAuthErrorBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code,omitempty"`
	Detail     string `json:"detail,omitempty"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// telegramAuthNestTimestamp is new Date().toISOString(): UTC, millisecond
// precision, trailing Z.
func telegramAuthNestTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// writeTelegramAuthCodedError renders a coded 400/429 exactly like
// GlobalExceptionFilter after a BadRequestException/TooManyRequestsException
// carrying {code, message: code, detail?}.
func writeTelegramAuthCodedError(w http.ResponseWriter, r *http.Request, err *telegramAuthCodedError) {
	// `path` is r.URL.Path, the shared authhttp convention. NestJS writes
	// request.url (path + query string); the login routes are called without a
	// query string, so the bytes are identical on the supported surface.
	body := telegramAuthErrorBody{
		StatusCode: err.statusCode,
		Message:    err.code,
		Error:      telegramAuthStatusErrorName(err.statusCode),
		Code:       err.code,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.Path,
		Timestamp:  telegramAuthNestTimestamp(),
	}
	if strings.TrimSpace(err.detail) != "" {
		body.Detail = err.detail
	}
	payload, marshalErr := json.Marshal(body)
	if marshalErr != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(err.statusCode)
	_, _ = w.Write(payload)
}

// telegramAuthStatusErrorName mirrors
// GlobalExceptionFilter.getErrorFromResponse (HttpStatus enum name split into
// words). Only 400 and 429 occur on this surface.
func telegramAuthStatusErrorName(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "Bad Request"
	case http.StatusTooManyRequests:
		return "Too Many Requests"
	default:
		return "Error"
	}
}

// writeTelegramAuthServiceError is the handler-side mapper: coded Telegram auth
// failures use the nested body above, everything else goes through the shared
// situationsettings mapping (flat ValidationPipe/body-parser 400, 503 for a
// missing MySQL pool, generic 500), which matches GlobalExceptionFilter for the
// remaining exception classes.
func writeTelegramAuthServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *telegramAuthCodedError
	if errors.As(err, &coded) {
		writeTelegramAuthCodedError(w, r, coded)
		return
	}
	writeServiceError(w, r, err)
}
