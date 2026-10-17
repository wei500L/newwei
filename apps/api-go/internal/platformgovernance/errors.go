package platformgovernance

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// errNoDatabase is returned when the MySQL pool was not injected. The handler
// maps it to the same fail-closed 503 NestJS produces for Prisma connection
// errors.
var errNoDatabase = errors.New("platformgovernance: mysql is not configured")

// errNoRedis is returned when the Redis client was not injected. Redis failures
// are tolerated on the read path (the handler logs a warning and falls back to
// MySQL) exactly like NestJS, so this error only fails the request when the
// database is also unavailable.
var errNoRedis = errors.New("platformgovernance: redis is not configured")

// errNoMongo is returned when the Mongo database was not injected. Every route
// that needs Mongo maps it to the generic 500 shape.
var errNoMongo = errors.New("platformgovernance: mongo is not configured")

// httpError is a status-coded failure that the handler maps onto the
// GlobalExceptionFilter response shapes.
type httpError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// writeServiceError maps a service error onto the NestJS error contract.
//
// NestJS only carries a message for HttpExceptions; a non-HttpException (or a
// 5xx) becomes the production shape {statusCode, message:"Internal server
// error"} with no error field, which authhttp.WriteInternalFailure renders.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch {
		case coded.status == http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case coded.status >= http.StatusInternalServerError:
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
	log.Printf("platformgovernance: %v", err)
	authhttp.WriteInternalFailure(w, r)
}

// badRequest builds the flat 400 both NestJS services raise for values that pass
// the DTO but fail a service-level rule.
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// forbidden builds the platform-admin 403. The text is byte-identical to
// PlatformAccessService.assertPlatformAdmin.
func forbidden() error {
	return &httpError{status: http.StatusForbidden, message: "Platform admin access required"}
}

// conflict builds the llm-request-log settings lock 409.
func conflict(message string) error {
	return &httpError{status: http.StatusConflict, message: message}
}

// internalError builds the generic 500 the TTL reconciliation failure path
// returns when it refuses to write the settings row.
func internalError() error {
	return &httpError{status: http.StatusInternalServerError, message: "Internal server error"}
}
