package llmgatewayprofiles

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// errLockUnavailable reports that the global profiles write lock could not be
// acquired. NestJS maps the same condition to ServiceUnavailableException, so
// both sides answer 503 and never continue without mutual exclusion.
var errLockUnavailable = errors.New("llmgatewayprofiles: profiles write lock not acquired")

// httpError is a status-coded failure mapped onto the GlobalExceptionFilter
// response shapes. code/detail carry the safe payload fields.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// badRequest builds a 400 with the class-validator message string.
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// notFound builds a 404 with the NestJS NotFoundException message.
func notFound(message string) error {
	return &httpError{status: http.StatusNotFound, message: message}
}

// forbidden builds a 403 whose message is passed through, matching a NestJS
// ForbiddenException("...") after GlobalExceptionFilter normalisation.
func forbidden(message string) error {
	return &httpError{status: http.StatusForbidden, message: message}
}

// errorResponse is the GlobalExceptionFilter REST body. Field order matches the
// NestJS spread order so byte-equivalent contract comparisons hold.
type errorResponse struct {
	StatusCode          int      `json:"statusCode"`
	Message             string   `json:"message"`
	Error               string   `json:"error,omitempty"`
	Code                string   `json:"code,omitempty"`
	Detail              string   `json:"detail,omitempty"`
	RequiredPermissions []string `json:"requiredPermissions,omitempty"`
	PermissionsMode     string   `json:"permissionsMode,omitempty"`
	TraceID             string   `json:"traceId"`
	Path                string   `json:"path"`
	Timestamp           string   `json:"timestamp"`
}

// nestTimestamp is new Date().toISOString() (millisecond UTC).
func nestTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// writeErrorResponse writes one contract error body.
func writeErrorResponse(w http.ResponseWriter, r *http.Request, body errorResponse) {
	body.TraceID = httpx.TraceIDFromContext(r.Context())
	body.Path = r.URL.Path
	body.Timestamp = nestTimestamp()
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(body.StatusCode)
	data, err := json.Marshal(body)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}

// writeServiceUnavailable writes the 503 the lock timeout produces:
// ServiceUnavailableException() after GlobalExceptionFilter replaced the message
// with the production generic text.
func writeServiceUnavailable(w http.ResponseWriter, r *http.Request) {
	writeErrorResponse(w, r, errorResponse{
		StatusCode: http.StatusServiceUnavailable,
		Message:    "Internal server error",
		Error:      "Service Unavailable",
	})
}

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusServiceUnavailable:
			writeServiceUnavailable(w, r)
		case coded.status == http.StatusConflict && coded.code != "":
			authhttp.WriteCodedConflict(w, r, coded.code, coded.message, coded.detail)
		case coded.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	if errors.Is(err, errLockUnavailable) {
		log.Printf("llmgatewayprofiles: %v", err)
		writeServiceUnavailable(w, r)
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("llmgatewayprofiles: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
