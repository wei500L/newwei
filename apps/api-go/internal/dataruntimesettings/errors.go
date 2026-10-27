package dataruntimesettings

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// httpError is a status-coded failure that the handler maps onto the NestJS
// GlobalExceptionFilter response shapes.
type httpError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// errLockUnavailable reports that the lock session itself could not be
// established (refused connection, failed handshake, protocol error). The
// response is the NestJS ServiceUnavailableException shape.
//
// A lock that somebody else holds for the whole GET_LOCK timeout is NOT this
// error: the lock helper renders that case as the domain-specific 409 retry
// contract, so a busy lock is never reported as an infrastructure outage.
var errLockUnavailable = errors.New("dataruntimesettings: session lock unavailable")

// contractError is the minimal Go mirror of the GlobalExceptionFilter REST error
// shape. Field declaration order is the serialization order.
type contractError struct {
	statusCode int
	message    string
	errorName  string
}

// writeContractError writes one contract error with a NestJS-equivalent body
// (statusCode, message, error, traceId, path, timestamp).
//
// `path` is GlobalExceptionFilter's `request?.url`, which in Express is the path
// INCLUDING the query string, so r.URL.RequestURI() is used and not r.URL.Path.
func writeContractError(w http.ResponseWriter, r *http.Request, body contractError) {
	payload := struct {
		StatusCode int    `json:"statusCode"`
		Message    string `json:"message"`
		Error      string `json:"error,omitempty"`
		TraceID    string `json:"traceId"`
		Path       string `json:"path"`
		Timestamp  string `json:"timestamp"`
	}{
		StatusCode: body.statusCode,
		Message:    body.message,
		Error:      body.errorName,
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		Path:       r.URL.RequestURI(),
		Timestamp:  nestTimestamp(nowMillis()),
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(body.statusCode)
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

// writeServiceUnavailable mirrors GlobalExceptionFilter for a NestJS
// ServiceUnavailableException: 503, the generic production message and error
// "Service Unavailable".
func writeServiceUnavailable(w http.ResponseWriter, r *http.Request) {
	writeContractError(w, r, contractError{
		statusCode: http.StatusServiceUnavailable,
		message:    "Internal server error",
		errorName:  "Service Unavailable",
	})
}

// writeConflict mirrors NestJS ConflictException: 409 with the retry message and
// error "Conflict".
func writeConflict(w http.ResponseWriter, r *http.Request, message string) {
	writeContractError(w, r, contractError{
		statusCode: http.StatusConflict,
		message:    message,
		errorName:  "Conflict",
	})
}

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusForbidden:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		case coded.status == http.StatusConflict:
			writeConflict(w, r, coded.message)
		case coded.status == http.StatusServiceUnavailable:
			writeServiceUnavailable(w, r)
		case coded.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	if errors.Is(err, errLockUnavailable) {
		writeServiceUnavailable(w, r)
		return
	}
	if errors.Is(err, errNoDatabase) || errors.Is(err, errNoRedis) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("dataruntimesettings: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

// add appends one message.
func (v *validationErrors) add(message string) {
	v.messages = append(v.messages, message)
}

// empty reports whether no message was collected.
func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

// err converts the collected messages into the 400 the client sees:
// GlobalExceptionFilter joins a class-validator message array with "; ".
func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return &httpError{status: http.StatusBadRequest, message: strings.Join(v.messages, "; ")}
}
