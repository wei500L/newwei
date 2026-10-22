package authfactors

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
// GlobalExceptionFilter response shapes. code/detail are only used by the
// conflict payloads that carry a safe error code.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// errLockUnavailable reports that the per-user MySQL session lock could not be
// acquired because the session itself failed (refused connection, failed
// handshake, missing DSN). It maps to the NestJS ServiceUnavailableException
// shape; the lock name and every connection detail stay out of the response.
var errLockUnavailable = errors.New("authfactors: session lock unavailable")

// errLockBusy reports that another request currently holds the per-user lock
// (GET_LOCK returned 0 before the timeout). It maps to the NestJS
// ConflictException shape with the shared retry message.
var errLockBusy = errors.New("authfactors: session lock busy")

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
// `path` is `r.URL.RequestURI()` because GlobalExceptionFilter writes
// `path: request.url` and Express `req.url` is the request target *including* the
// query string. Using `r.URL.Path` alone would drop `?query` from every error
// body of this unit.
//
// authhttp exposes writers for every shape this unit needs except the
// ServiceUnavailableException rendered by the NestJS lock failure (a 503 that
// still carries `error: "Service Unavailable"`). authhttp is a shared,
// read-only package for this batch, so that single shape is produced here.
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

// writeConflict mirrors GlobalExceptionFilter for a NestJS ConflictException
// carrying a plain message (no safe code).
func writeConflict(w http.ResponseWriter, r *http.Request, message string) {
	authhttp.WriteHTTPException(w, r, http.StatusConflict, message)
}

// writeForbiddenMessage mirrors GlobalExceptionFilter for a NestJS
// ForbiddenException with a specific message (as opposed to the
// INSUFFICIENT_PERMISSIONS payload written by authhttp.WriteForbidden).
func writeForbiddenMessage(w http.ResponseWriter, r *http.Request, message string) {
	authhttp.WriteHTTPException(w, r, http.StatusForbidden, message)
}

// writeServiceError maps a service error onto the NestJS error contract.
//
// Ordering matters: a business 400/401/403 raised by the service keeps its own
// status and is never rewritten as a lock or database failure.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusForbidden:
			writeForbiddenMessage(w, r, coded.message)
		case coded.status == http.StatusConflict && coded.code != "":
			authhttp.WriteCodedConflict(w, r, coded.code, coded.message, coded.detail)
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
	if errors.Is(err, errLockBusy) {
		writeConflict(w, r, mfaLockBusyMessage)
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
	// Everything else is the NestJS production 500: the detail only reaches the
	// server log, and secrets, recovery codes, ciphertext and key material are
	// never part of the message.
	log.Printf("authfactors: %v", err)
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
