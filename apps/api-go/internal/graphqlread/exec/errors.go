package exec

import (
	"errors"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// ResolverError is one GraphQL failure that reaches the executor from a resolver,
// a guard or the rate limiter — the Go counterpart of an exception that reaches
// NestJS's GlobalExceptionFilter through GqlArgumentsHost.
//
// It deliberately does not cover protocol rejections (a parse error, a validation
// error, an APQ miss, a mutation over GET) or the executor's own projection
// errors: NestJS's filter never sees those, because Apollo answers them before or
// outside a resolver call. Recording them would make the Go event stream a
// superset of the NestJS one.
type ResolverError struct {
	// TraceID is the request trace id.
	TraceID string
	// StatusCode is the HTTP status the error carries; NestJS records the status
	// it resolved from the exception.
	StatusCode int
	// Operation is the root field name (info.fieldName in the NestJS filter).
	Operation string
	// OperationName is the client's operationName.
	OperationName string
	// Message is the message written into the GraphQL error.
	Message string
	// ErrorName is the error class name. It is derived from the status exactly
	// like the REST path, because a Go error has no class of its own.
	ErrorName string
	// OrgID and UserID come from the identity the authentication chain verified.
	OrgID  string
	UserID string
}

// ErrorRecorder receives every resolver failure. cmd/api installs the
// exceptioningest recorder here; a nil recorder disables recording.
type ErrorRecorder func(ResolverError)

// SetErrorRecorder installs the resolver-failure recorder. It must be called
// before the engine serves requests; the engine is not used concurrently while
// this runs.
func (e *Engine) SetErrorRecorder(record ErrorRecorder) {
	if e == nil {
		return
	}
	e.errorRecorder = record
}

// recordResolverError reports one resolver failure to the installed recorder.
//
// A contract.Failure carries the status the GraphQL error will show, so the
// recorded statusCode matches the response. Any other error is an unexpected
// resolver error: the executor masks it as "Internal server error" with status
// 500, and so does this recording.
func (e *Engine) recordResolverError(err error, fieldName, operationName, traceID string, identity contract.Identity) {
	if e == nil || e.errorRecorder == nil || err == nil {
		return
	}
	status := http.StatusInternalServerError
	message := "Internal server error"
	var failure *contract.Failure
	if errors.As(err, &failure) && failure != nil {
		if failure.Status != 0 {
			status = failure.Status
		}
		if status >= 500 && !failure.ExposeMessage {
			message = "Internal server error"
		} else if failure.Message != "" {
			message = failure.Message
		}
	}
	e.errorRecorder(ResolverError{
		TraceID:       traceID,
		StatusCode:    status,
		Operation:     fieldName,
		OperationName: operationName,
		Message:       message,
		ErrorName:     errorNameForStatus(status),
		OrgID:         identity.OrgID,
		UserID:        identity.UserID,
	})
}

// errorNameForStatus maps a GraphQL failure status to the NestJS exception class
// name the filter would have recorded.
//
// The mapping mirrors authhttp's REST one. It is duplicated rather than imported
// because internal/authhttp imports internal/httpx and the GraphQL executor must
// not depend on the REST error package; the eight values are the complete set of
// statuses a resolver or guard can raise here.
func errorNameForStatus(status int) string {
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
