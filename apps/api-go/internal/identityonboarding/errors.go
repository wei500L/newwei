package identityonboarding

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// httpError is one status-coded business failure. The handler renders it with
// the NestJS GlobalExceptionFilter shapes: message kept, error name derived
// from the status, no safe code.
type httpError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

func forbidden(message string) error {
	return &httpError{status: http.StatusForbidden, message: message}
}

func notFound(message string) error {
	return &httpError{status: http.StatusNotFound, message: message}
}

func unauthorized(message string) error {
	return &httpError{status: http.StatusUnauthorized, message: message}
}

func conflict(message string) error {
	return &httpError{status: http.StatusConflict, message: message}
}

// errNoDatabase reports a missing MySQL handle. It maps to the fail-closed 503
// the rest of the gateway uses for an unavailable database.
var errNoDatabase = errors.New("identityonboarding: mysql is not configured")

// validationErrors accumulates class-validator style messages. The global
// ValidationPipe joins them with "; " through GlobalExceptionFilter.
type validationErrors struct {
	messages []string
}

func (v *validationErrors) add(message string) { v.messages = append(v.messages, message) }

func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return badRequest(strings.Join(v.messages, "; "))
}

// errInvalidBody reports a body that is not a JSON object. NestJS maps a
// malformed body onto the same BadRequestException shape ("Unexpected token in
// JSON body" is the message the neighbouring units settled on).
var errInvalidBody = &httpError{status: http.StatusBadRequest, message: "Unexpected token in JSON body"}

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch coded.status {
		case http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case http.StatusForbidden:
			authhttp.WriteHTTPException(w, r, http.StatusForbidden, coded.message)
		case http.StatusInternalServerError, http.StatusServiceUnavailable:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	// Everything else is the NestJS production 500. The detail only reaches the
	// server log; raw tokens, password hashes and SMTP credentials never do.
	log.Printf("identityonboarding: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// bodyKind classifies the raw body the way Express body-parser does.
type bodyKind int

const (
	// bodyAbsent means the content type was not JSON; NestJS validates an empty
	// object in that case.
	bodyAbsent bodyKind = iota
	// bodyOK means the body decoded as JSON.
	bodyOK
	// bodyInvalidJSON means the body was not valid JSON.
	bodyInvalidJSON
	// bodyTooLarge means the body exceeded the configured limit.
	bodyTooLarge
)

// maxBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxBodyBytes = 10 << 20

// readBodyOrFail reads the body and writes the contract-equivalent error when it
// cannot be used.
func readBodyOrFail(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	body, kind := readRequestBody(r)
	switch kind {
	case bodyTooLarge:
		authhttp.WritePayloadTooLarge(w, r)
		return nil, false
	case bodyInvalidJSON:
		authhttp.WriteBadRequest(w, r, "Unexpected token in JSON body")
		return nil, false
	case bodyAbsent:
		return []byte("{}"), true
	default:
		return body, true
	}
}

// writeResponse renders a response with the content type Express res.json
// produces (explicit charset, no trailing newline, HTML escaping disabled so
// values containing & or < stay byte-identical). T is the concrete response
// struct, so no business value crosses an untyped boundary.
func writeResponse[T any](w http.ResponseWriter, r *http.Request, status int, body T) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		writeServiceError(w, r, err)
		return
	}
	payload := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}
