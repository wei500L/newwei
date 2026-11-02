package authhttp

import (
	"context"
	"net/http"
	"sync/atomic"
)

// This file is the single seam where an api-go REST failure becomes one
// exception event, mirroring GlobalExceptionFilter.handleHttpException in
// apps/api/src/common/filters/global-exception.filter.ts.
//
// # Why the seam is here
//
// Go's REST handlers do not throw: each classifies a failure and writes the
// NestJS-equivalent status through this package. Those writes are the exact
// counterpart of "the exception reached the filter", so recording at writeError
// covers authentication, authorization, validation and service failures without
// touching the hundreds of call sites that classify them.
//
// A wrapper around the finished response cannot make that distinction: it would
// also record protocol rejections NestJS never filters (an Apollo parse or
// validation result, a body-parser overflow that NestJS converts to a 500 with no
// exception object). Recording at the typed exit keeps the recorded set equal to
// the filter's.
//
// # Identity
//
// orgId/userId must come from an identity the server already verified. The
// authentication chain stores it in the request's identity box
// (SetVerifiedIdentity), so the write site can read it without every handler
// threading it through. Nothing in this file reads a body field or a client
// header for these values.

// ExceptionRecorder receives one classified REST failure. statusCode and message
// are the values written to the client; orgID/userID are empty when the request
// failed before authentication completed.
type ExceptionRecorder func(r *http.Request, statusCode int, orgID, userID, message string)

// identityBox is the per-request holder the authentication chain fills in. It is
// a pointer stored in the request context, so a handler that only has the
// original *http.Request can fill it without reassigning the request.
type identityBox struct{ identity *Identity }

type identityBoxKey struct{}

// IdentityScope installs the per-request identity box and lets the request
// through. It must wrap every request the process serves, because the recorder
// reads the box after a handler has written its error.
func IdentityScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		box := &identityBox{}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityBoxKey{}, box)))
	})
}

// SetVerifiedIdentity records the identity the authentication chain just derived
// from a signature and a database lookup. It is a no-op when the request was not
// wrapped by IdentityScope, so a handler test that skips the middleware does not
// panic.
//
// It must only be called with an identity that came from Authenticate or a
// machine-token resolver. A handler must never build one from a request body or a
// client-supplied header.
func SetVerifiedIdentity(r *http.Request, identity *Identity) {
	if r == nil || identity == nil {
		return
	}
	if box, ok := r.Context().Value(identityBoxKey{}).(*identityBox); ok && box != nil {
		box.identity = identity
	}
}

// verifiedIdentity returns the org and user of the verified identity, or two
// empty strings when the request failed before authentication completed (a 401
// from a missing or invalid token has no identity).
func verifiedIdentity(r *http.Request) (orgID, userID string) {
	if r == nil {
		return "", ""
	}
	box, ok := r.Context().Value(identityBoxKey{}).(*identityBox)
	if !ok || box == nil || box.identity == nil {
		return "", ""
	}
	return box.identity.OrgID, box.identity.UserID
}

// exceptionNameForStatus is the `errorName` an event carries for a failure
// written by this package.
//
// GlobalExceptionFilter records exception.name. For an HttpException that is the
// NestJS class the handler or guard threw, and those names are a deterministic
// function of the status, so the mapping below is the value NestJS would have
// recorded for the equivalent throw.
//
// 500 and unmapped statuses return "Error". At a Go write site there is no
// exception object, an internal failure is not a typed HttpException, and NestJS
// would have recorded the concrete upstream error's own name (for example
// "PrismaClientKnownRequestError") which Go cannot reproduce. "Error" is the
// honest base value and keeps the field populated instead of inventing a class.
//
// No stack is recorded. Go has no exception object whose stack could be captured
// here, and a stack captured at the write site would describe the error-rendering
// helper rather than the code that failed: a misleading artifact rather than
// evidence.
func exceptionNameForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "BadRequestException"
	case http.StatusUnauthorized:
		return "UnauthorizedException"
	case http.StatusForbidden:
		return "ForbiddenException"
	case http.StatusNotFound:
		return "NotFoundException"
	case http.StatusConflict:
		return "ConflictException"
	case http.StatusTooManyRequests:
		return "TooManyRequestsException"
	case http.StatusServiceUnavailable:
		return "ServiceUnavailableException"
	default:
		return "Error"
	}
}

// ExceptionNameForStatus exposes the mapping above to the GraphQL error path,
// which needs the same value for an error surfaced as a GraphQL error extension.
func ExceptionNameForStatus(status int) string { return exceptionNameForStatus(status) }

// exceptionRecorder is the process-wide recorder, installed once during startup
// before the listener opens. atomic.Pointer keeps the read on every error
// response lock-free.
var exceptionRecorder atomic.Pointer[ExceptionRecorder]

// SetExceptionRecorder installs the recorder. A nil recorder disables recording,
// which is the default when the process has no Mongo. Call it before the HTTP
// listener starts.
func SetExceptionRecorder(recorder ExceptionRecorder) {
	if recorder == nil {
		exceptionRecorder.Store(nil)
		return
	}
	installed := recorder
	exceptionRecorder.Store(&installed)
}

// recordException hands one written failure to the installed recorder.
//
// A missing recorder is not an error: the response is already produced and
// recording is a best-effort side channel. A panic inside the recorder would
// change the response, so the call is not deferred into the write path's error
// handling: the recorder implementations enqueue and return.
func recordException(r *http.Request, statusCode int, message string) {
	holder := exceptionRecorder.Load()
	if holder == nil || r == nil {
		return
	}
	orgID, userID := verifiedIdentity(r)
	(*holder)(r, statusCode, orgID, userID, message)
}

// RecordFailure reports a failure a handler wrote with its own body writer instead
// of this package's helpers.
//
// It exists for the few responses whose JSON shape is not the GlobalExceptionFilter
// envelope — the items create route answers a ValidationPipe message *array* rather
// than a joined string, which writeError cannot express. Those responses still
// correspond to an exception the NestJS filter records, so the handler calls this
// after writing them.
//
// message must be the message the client received. Callers that mask an internal
// error must pass the masked text, because the event is not allowed to carry a
// detail the response withholds.
func RecordFailure(r *http.Request, statusCode int, message string) {
	recordException(r, statusCode, message)
}
