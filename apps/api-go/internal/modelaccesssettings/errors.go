package modelaccesssettings

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// nestTimestamp is the JavaScript Date.prototype.toISOString() equivalent the
// error bodies carry (millisecond precision, UTC, trailing Z).
func nestTimestamp() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// errNoDatabase is returned when the MySQL pool is not injected. The handler maps
// it to the same fail-closed 503 NestJS produces for Prisma connection errors
// (that 503 carries no `error` field).
var errNoDatabase = errors.New("modelaccesssettings: mysql is not configured")

// errNoRedis is returned when the Redis client is not injected.
var errNoRedis = errors.New("modelaccesssettings: redis is not configured")

// errMachineTokenNotFound reports that no MachineAccessToken row matches the
// presented hash. The authenticator maps it to the same 401 as a revoked token.
var errMachineTokenNotFound = errors.New("modelaccesssettings: machine token not found")

// errLockUnavailable is returned when the global MySQL session lock could not be
// acquired (timeout, connection failure, or a NULL answer from GET_LOCK). It maps
// to 503 whose body keeps error="Service Unavailable", because NestJS raises a
// ServiceUnavailableException (an HttpException) for the same condition — unlike
// the Prisma connection 503, which has no `error` field at all.
var errLockUnavailable = errors.New("modelaccesssettings: settings lock not acquired")

// httpError is a status-coded failure mapped onto the GlobalExceptionFilter
// shapes by writeServiceError.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// writeServiceError maps a service error onto the NestJS error contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status == http.StatusForbidden:
			authhttp.WriteHTTPException(w, r, http.StatusForbidden, coded.message)
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
		// The lock name and the MySQL error text stay in the log; the client only
		// sees the GlobalExceptionFilter shape.
		log.Printf("modelaccesssettings: settings lock not acquired")
		writeServiceUnavailable(w, r)
		return
	}
	if errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("modelaccesssettings: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// serviceUnavailableBody is the local mirror of the GlobalExceptionFilter REST
// shape for a 503 raised by an HttpException. It is declared here (instead of
// reusing authhttp's unexported body) so the field order matches byte-for-byte.
type serviceUnavailableBody struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	TraceID    string `json:"traceId"`
	Path       string `json:"path"`
	Timestamp  string `json:"timestamp"`
}

// writeServiceUnavailable writes the 503 a ServiceUnavailableException produces:
// message is replaced by the generic string because the status is >= 500, while
// `error` keeps the "Service Unavailable" name.
func writeServiceUnavailable(w http.ResponseWriter, r *http.Request) {
	body := serviceUnavailableBody{
		StatusCode: http.StatusServiceUnavailable,
		Message:    "Internal server error",
		Error:      "Service Unavailable",
		TraceID:    httpx.TraceIDFromContext(r.Context()),
		// GlobalExceptionFilter writes `path: request.url`, which in Express is the
		// path *and* the query string; RequestURI reproduces that.
		Path:      r.URL.RequestURI(),
		Timestamp: nestTimestamp(),
	}
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusServiceUnavailable)
	data, err := json.Marshal(body)
	if err != nil {
		return
	}
	_, _ = w.Write(data)
}
