package accountdata

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// httpError is a status-coded failure rendered with the NestJS exception shape.
type httpError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// badRequest builds the NestJS BadRequestException message verbatim.
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// tooManyRequests builds the NestJS TooManyRequestsException message verbatim.
func tooManyRequests(message string) error {
	return &httpError{status: http.StatusTooManyRequests, message: message}
}

// dbError marks a MySQL failure. NestJS surfaces a Prisma failure as a 503
// fail-closed answer, so the export never leaks SQL text.
type dbError struct{ err error }

// Error implements the error interface.
func (e *dbError) Error() string { return e.err.Error() }

// Unwrap exposes the driver error for errors.Is/As.
func (e *dbError) Unwrap() error { return e.err }

func dbWrap(err error) error {
	if err == nil {
		return nil
	}
	return &dbError{err: err}
}

// redisError marks a Redis failure (a non-HttpException in NestJS, i.e. 500).
type redisError struct{ err error }

// Error implements the error interface.
func (e *redisError) Error() string { return e.err.Error() }

// Unwrap exposes the client error for errors.Is/As.
func (e *redisError) Unwrap() error { return e.err }

func redisWrap(err error) error {
	if err == nil {
		return nil
	}
	return &redisError{err: err}
}

// mongoError marks a Mongo failure (also a non-HttpException in NestJS).
type mongoError struct{ err error }

// Error implements the error interface.
func (e *mongoError) Error() string { return e.err.Error() }

// Unwrap exposes the driver error for errors.Is/As.
func (e *mongoError) Unwrap() error { return e.err }

func mongoWrap(err error) error {
	if err == nil {
		return nil
	}
	return &mongoError{err: err}
}

// writeServiceError maps a pre-body failure onto the NestJS error contract.
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
	var dbFailure *dbError
	if errors.As(err, &dbFailure) {
		log.Printf("accountdata: database failure: %v", dbFailure.err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	var redisFailure *redisError
	if errors.As(err, &redisFailure) {
		log.Printf("accountdata: redis failure: %v", redisFailure.err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	var mongoFailure *mongoError
	if errors.As(err, &mongoFailure) {
		log.Printf("accountdata: mongo failure: %v", mongoFailure.err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	log.Printf("accountdata: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
