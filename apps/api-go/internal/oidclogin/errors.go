package oidclogin

import (
	"errors"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// serviceError is a status-coded business failure whose message is one of the
// source contract messages.
type serviceError struct {
	status  int
	message string
	cause   error
}

func (e *serviceError) Error() string { return e.message }
func (e *serviceError) Unwrap() error { return e.cause }

// dbFailure marks a MySQL failure so the exchange entry answers the Prisma
// connection 503 instead of disguising it as an invalid handoff.
type dbFailure struct{ err error }

func (e *dbFailure) Error() string { return "database operation failed" }
func (e *dbFailure) Unwrap() error { return e.err }

// cacheFailure marks a Redis failure. The callback turns it into the source
// error redirect; the start/exchange entries answer the production 500.
type cacheFailure struct{ err error }

func (e *cacheFailure) Error() string { return "cache operation failed" }
func (e *cacheFailure) Unwrap() error { return e.err }

func badRequest(message string) error {
	return &serviceError{status: http.StatusBadRequest, message: message}
}

func unauthorized(message string) error {
	return &serviceError{status: http.StatusUnauthorized, message: message}
}

func identityInvalid() error {
	return unauthorized(identityTokenInvalidError)
}

func dbWrap(err error) error    { return &dbFailure{err: err} }
func cacheWrap(err error) error { return &cacheFailure{err: err} }

// callbackErrorMessage mirrors the controller catch: any business or
// infrastructure failure becomes the URL-encoded error query value. It never
// includes a token or an id_token.
func callbackErrorMessage(err error) string {
	var coded *serviceError
	if errors.As(err, &coded) {
		return coded.message
	}
	return err.Error()
}

// writeServiceError maps a start/exchange failure onto the NestJS
// GlobalExceptionFilter contract.
func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	var coded *serviceError
	if errors.As(err, &coded) {
		switch coded.status {
		case http.StatusBadRequest:
			authhttp.WriteBadRequest(w, r, coded.message)
		case http.StatusUnauthorized:
			authhttp.WriteUnauthorized(w, r, coded.message)
		default:
			authhttp.WriteHTTPException(w, r, coded.status, coded.message)
		}
		return
	}
	var databaseErr *dbFailure
	if errors.As(err, &databaseErr) || errors.Is(err, errNoDatabase) {
		authhttp.WriteDatabaseFailure(w, r)
		return
	}
	var cacheErr *cacheFailure
	if errors.As(err, &cacheErr) || errors.Is(err, errNoRedis) {
		authhttp.WriteRedisFailure(w, r)
		return
	}
	log.Printf("oidclogin: %v", err)
	authhttp.WriteInternalFailure(w, r)
}
