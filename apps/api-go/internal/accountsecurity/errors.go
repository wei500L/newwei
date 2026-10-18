package accountsecurity

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// httpError is a status-coded failure that the handler maps onto the NestJS
// GlobalExceptionFilter response shapes. code/detail are only used by the 409
// conflict payload carried by the password CAS failure.
type httpError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements the error interface.
func (e *httpError) Error() string { return e.message }

// errNoDatabase is returned when the shared MySQL pool was not injected.
var errNoDatabase = errors.New("accountsecurity: mysql is not configured")

// errNoRedis is returned when the shared Redis client was not injected.
var errNoRedis = errors.New("accountsecurity: redis is not configured")

// dbError marks a MySQL failure so the handler can answer the NestJS Prisma
// 503 shape without leaking SQL text.
type dbError struct{ err error }

// Error implements the error interface.
func (e *dbError) Error() string { return e.err.Error() }

// Unwrap exposes the underlying driver error for errors.Is/As.
func (e *dbError) Unwrap() error { return e.err }

// dbWrap tags a MySQL error. A nil error stays nil.
func dbWrap(err error) error {
	if err == nil {
		return nil
	}
	return &dbError{err: err}
}

// redisError marks a Redis failure. NestJS surfaces an ioredis failure as a
// non-HttpException, i.e. a 500 "Internal server error".
type redisError struct{ err error }

// Error implements the error interface.
func (e *redisError) Error() string { return e.err.Error() }

// Unwrap exposes the underlying client error for errors.Is/As.
func (e *redisError) Unwrap() error { return e.err }

// redisWrap tags a Redis error. A nil error stays nil.
func redisWrap(err error) error {
	if err == nil {
		return nil
	}
	return &redisError{err: err}
}

// errInvalidBody reproduces the ValidationPipe error for a body that is not a
// JSON object at all (`forbidUnknownValues: true`).
var errInvalidBody = &httpError{
	status:  http.StatusBadRequest,
	message: "an unknown value was passed to the validate function",
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
		case coded.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	var redisFailure *redisError
	if errors.As(err, &redisFailure) {
		log.Printf("accountsecurity: redis failure: %v", redisFailure.err)
		authhttp.WriteInternalFailure(w, r)
		return
	}
	if errors.Is(err, errNoRedis) {
		log.Printf("accountsecurity: redis is not configured")
		authhttp.WriteInternalFailure(w, r)
		return
	}
	var dbFailure *dbError
	if errors.As(err, &dbFailure) {
		log.Printf("accountsecurity: database failure: %v", dbFailure.err)
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	if errors.Is(err, errNoDatabase) {
		log.Printf("accountsecurity: mysql is not configured")
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	log.Printf("accountsecurity: %v", err)
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

// badRequest builds one 400 with the exact NestJS message.
func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

// unauthorized builds one 401 with an explicit message (never used for the
// passport-level generic failure, which authhttp.WriteUnauthorized handles).
func unauthorized(message string) error {
	return &httpError{status: http.StatusUnauthorized, message: message}
}
