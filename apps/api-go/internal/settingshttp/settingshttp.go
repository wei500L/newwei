// Package settingshttp holds the small HTTP/response/validation toolkit shared
// by the three settings-diagnostics migrations. It mirrors the helpers already
// duplicated in the other Go domains (request body limits, class-validator
// message strings, the NestJS GlobalExceptionFilter shape and Prisma-compatible
// row ids) so the new packages do not each grow their own copy.
package settingshttp

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// MaxBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const MaxBodyBytes = 10 << 20

// Error is a status-coded failure with a contract message.
type Error struct {
	Status  int
	Message string
}

// Error implements error.
func (e *Error) Error() string { return e.Message }

// BadRequest builds a 400.
func BadRequest(message string) error {
	return &Error{Status: http.StatusBadRequest, Message: message}
}

// Forbidden builds a 403.
func Forbidden(message string) error {
	return &Error{Status: http.StatusForbidden, Message: message}
}

// ServiceUnavailable builds a 503.
func ServiceUnavailable(message string) error {
	return &Error{Status: http.StatusServiceUnavailable, Message: message}
}

// IsStatus reports whether err is a coded error with the given status.
func IsStatus(err error, status int) bool {
	var coded *Error
	return errors.As(err, &coded) && coded.Status == status
}

// WriteServiceError maps a service error onto the NestJS error contract. Unknown
// errors are logged without their text and answered with the production 500.
func WriteServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *Error
	if errors.As(err, &coded) {
		switch {
		case coded.Status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.Message)
		case coded.Status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.Status, coded.Message)
		}
		return
	}
	log.Printf("settingshttp: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// ValidationErrors accumulates class-validator style messages.
type ValidationErrors struct {
	Messages []string
}

// Add appends one message.
func (v *ValidationErrors) Add(message string) { v.Messages = append(v.Messages, message) }

// Empty reports whether nothing was collected.
func (v *ValidationErrors) Empty() bool { return len(v.Messages) == 0 }

// Err converts the collected messages into the 400 the client sees. The global
// filter joins the class-validator array with "; ".
func (v *ValidationErrors) Err() error {
	if v.Empty() {
		return nil
	}
	return &Error{Status: http.StatusBadRequest, Message: strings.Join(v.Messages, "; ")}
}

// BodyKind classifies the raw body the way Express body-parser does.
type BodyKind int

const (
	// BodyAbsent means the content type was not JSON.
	BodyAbsent BodyKind = iota
	// BodyOK means the body decoded as JSON.
	BodyOK
	// BodyInvalidJSON means the body was not valid JSON.
	BodyInvalidJSON
	// BodyTooLarge means the body exceeded the configured limit.
	BodyTooLarge
)

// ReadBody reads a JSON body with the shared size limit.
func ReadBody(r *http.Request) ([]byte, BodyKind) {
	if !IsJSONContentType(r.Header.Get("Content-Type")) {
		return nil, BodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, MaxBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, BodyTooLarge
		}
		return data, BodyInvalidJSON
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return data, BodyInvalidJSON
	}
	return data, BodyOK
}

// ReadBodyOrFail reads the body and writes the contract error when it cannot be
// used. It returns false when the caller must stop.
func ReadBodyOrFail(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, kind := ReadBody(r)
	switch kind {
	case BodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return nil, false
	case BodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, "Unexpected token in JSON body")
		return nil, false
	case BodyAbsent:
		return []byte("{}"), true
	default:
		return body, true
	}
}

// IsJSONContentType reports whether the header selects the JSON body parser.
func IsJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

// WriteJSON renders one response with the content type Express res.json emits
// (explicit charset, no trailing newline).
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, body any) {
	payload, err := json.Marshal(body)
	if err != nil {
		authhttp.WriteInternalFailure(w, r)
		return
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// NowMillis returns the current UTC time truncated to milliseconds, matching the
// DATETIME(3) columns Prisma writes.
func NowMillis() time.Time { return time.Now().UTC().Truncate(time.Millisecond) }

// NestTimestamp formats a time like JavaScript Date.toISOString().
func NestTimestamp(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// NewRowID generates a client-side identifier in the shape Prisma's cuid()
// produces ('c' plus 24 hex characters).
func NewRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
