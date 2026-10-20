package authlogin

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// httpError is a status-coded business failure. Its message is always a contract
// message the NestJS implementation would have produced, never a driver or
// cache detail.
type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string { return e.message }

// dbError marks a MySQL failure so it maps onto the NestJS Prisma-connection
// 503 rather than a business rejection. A database outage must never be
// disguised as "invalid credentials".
type dbError struct{ err error }

func (e *dbError) Error() string { return e.err.Error() }
func (e *dbError) Unwrap() error { return e.err }

// redisError marks a Redis failure. NestJS lets it escape as a non-HttpException
// and the global filter answers the production 500.
type redisError struct{ err error }

func (e *redisError) Error() string { return e.err.Error() }
func (e *redisError) Unwrap() error { return e.err }

var (
	errNoDatabase = errors.New("authlogin: mysql is not configured")
	errNoRedis    = errors.New("authlogin: redis is not configured")
	// errMailerNotConfigured is returned by the nil mailer guard; the real
	// transport reports its own missing-configuration error.
	errMailerNotConfigured = errors.New("authlogin: smtp transport is not configured")
)

func dbWrap(err error) error    { return &dbError{err: err} }
func redisWrap(err error) error { return &redisError{err: err} }

func badRequest(message string) error {
	return &httpError{status: http.StatusBadRequest, message: message}
}

func unauthorized(message string) error {
	return &httpError{status: http.StatusUnauthorized, message: message}
}

func tooManyRequests(message string) error {
	return &httpError{status: http.StatusTooManyRequests, message: message}
}

// writeServiceError maps a service failure onto the GlobalExceptionFilter
// contract. Order matters: a coded business failure always wins over the generic
// infrastructure shapes, and an unknown error is logged and answered with the
// production 500 so no driver text or secret can reach the client.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *httpError
	if errors.As(err, &coded) {
		switch coded.status {
		case http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		case http.StatusBadRequest:
			authhttp.WriteBadRequest(w, r, coded.message)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	var databaseErr *dbError
	if errors.As(err, &databaseErr) || errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	var cacheErr *redisError
	if errors.As(err, &cacheErr) || errors.Is(err, errNoRedis) {
		authhttp.WriteRedisFailure(w, r)
		return
	}
	log.Printf("authlogin: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
