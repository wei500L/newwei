package infrastructuresettings

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
// GlobalExceptionFilter response shapes. code/detail are only used by the 409
// conflict payloads that carry a safe error code.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// errLockUnavailable reports that the global MySQL session lock could not be
// acquired (timeout, refused connection or failed handshake). The response is
// the NestJS ServiceUnavailableException shape, and the underlying lock tool
// name and connection details never reach the client.
var errLockUnavailable = errors.New("infrastructuresettings: session lock unavailable")

// contractError is the minimal Go mirror of the GlobalExceptionFilter REST
// error shape. Field declaration order is the serialization order.
type contractError struct {
	statusCode int
	message    string
	errorName  string
	code       string
	detail     string
}

// writeContractError writes one contract error with a NestJS-equivalent body
// (statusCode, message, error, optional code/detail, traceId, path, timestamp).
//
// authhttp exposes writers for every shape this unit needs except the
// ServiceUnavailableException rendered by the NestJS lock timeout (a 503 that
// still carries `error: "Service Unavailable"`). authhttp is a shared, read-only
// package for this batch, so that single shape is produced here.
//
// `path` is GlobalExceptionFilter's `request?.url`, which in Express is the
// path INCLUDING the query string, so r.URL.RequestURI() is used and not
// r.URL.Path.
func writeContractError(w http.ResponseWriter, r *http.Request, body contractError) {
	payload := struct {
		StatusCode int    `json:"statusCode"`
		Message    string `json:"message"`
		Error      string `json:"error,omitempty"`
		Code       string `json:"code,omitempty"`
		Detail     string `json:"detail,omitempty"`
		TraceID    string `json:"traceId"`
		Path       string `json:"path"`
		Timestamp  string `json:"timestamp"`
	}{
		StatusCode: body.statusCode,
		Message:    body.message,
		Error:      body.errorName,
		Code:       body.code,
		Detail:     body.detail,
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
// ServiceUnavailableException: 503, the generic production message and
// error "Service Unavailable".
func writeServiceUnavailable(w http.ResponseWriter, r *http.Request) {
	writeContractError(w, r, contractError{
		statusCode: http.StatusServiceUnavailable,
		message:    "Internal server error",
		errorName:  "Service Unavailable",
	})
}

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusConflict && coded.code != "":
			authhttp.WriteCodedConflict(w, r, coded.code, coded.message, coded.detail)
		case coded.status == http.StatusConflict:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
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
	log.Printf("infrastructuresettings: %v", err)
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

// addAll appends several messages in order.
func (v *validationErrors) addAll(messages []string) {
	v.messages = append(v.messages, messages...)
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
