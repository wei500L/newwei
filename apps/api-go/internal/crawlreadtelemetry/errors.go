package crawlreadtelemetry

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/adminlogs"
	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// statusError is a typed HTTP failure that maps onto the NestJS
// GlobalExceptionFilter contract. Message is emitted verbatim, like an
// HttpException message.
type statusError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *statusError) Error() string { return e.message }

// newStatusError builds a typed HTTP failure.
func newStatusError(status int, message string) error {
	return &statusError{status: status, message: message}
}

// errDatabase marks a MySQL failure so the handler can answer 503, matching the
// NestJS Prisma connection error mapping.
var errDatabase = errors.New("crawl read telemetry: mysql failure")

// errRedis marks a Redis failure so the handler can answer 500.
var errRedis = errors.New("crawl read telemetry: redis failure")

// errMongo marks a Mongo failure so the handler can answer 500.
var errMongo = errors.New("crawl read telemetry: mongo failure")

// writeServiceError maps a service error onto the shared authhttp error shapes.
// Machine tokens reuse the adminlogs HTTP mapping (401) so the two Go units
// stay identical.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	if status, message, ok := adminlogs.HTTPStatus(err); ok {
		authhttp.WriteHTTPException(w, r, status, message)
		return
	}
	var typed *statusError
	if errors.As(err, &typed) {
		authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		return
	}
	switch {
	case errors.Is(err, errDatabase):
		log.Printf("crawl read telemetry: %v", err)
		authhttp.WriteDatabaseFailure(w, r)
	case errors.Is(err, errRedis), errors.Is(err, errMongo):
		log.Printf("crawl read telemetry: %v", err)
		authhttp.WriteInternalFailure(w, r)
	default:
		log.Printf("crawl read telemetry: %v", err)
		authhttp.WriteInternalFailure(w, r)
	}
}
