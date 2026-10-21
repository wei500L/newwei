package queueops

import (
	"errors"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// validationError is the 400 shape: the bodies are the class-validator-style
// messages, joined with "; " by the handler exactly like the NestJS
// GlobalExceptionFilter joins a ValidationPipe message array.
type validationError struct {
	messages []string
}

// Error implements error.
func (e *validationError) Error() string {
	if len(e.messages) == 1 {
		return e.messages[0]
	}
	return "Bad Request"
}

// Messages exposes the individual validation messages.
func (e *validationError) Messages() []string { return e.messages }

func newValidationError(messages ...string) error {
	return &validationError{messages: messages}
}

// statusError is a typed HTTP failure with an optional safe error code. A code
// outside ^[A-Z0-9_]+$ is dropped by authhttp.WriteCodedConflict, so callers only
// set one for the 409s that need machine-readable detail.
type statusError struct {
	status  int
	message string
	code    string
	detail  string
}

// Error implements error.
func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

func newConflict(code, message, detail string) error {
	return &statusError{status: http.StatusConflict, code: code, message: message, detail: detail}
}

// envelopeError is the 422 failure of the DLQ envelope validation: the stored
// dead-letter payload cannot be turned back into an itemPipeline job without
// risking a silent replay of polluted data. The message names the conflicted
// fields so the operator can inspect the job before deleting it.
type envelopeError struct {
	message string
}

// Error implements error.
func (e *envelopeError) Error() string { return e.message }

func newEnvelopeError(message string) error {
	return &envelopeError{message: message}
}

// isEnvelopeError reports whether err is a DLQ envelope validation failure. The
// batch replay path turns these into per-item results instead of a 422.
func isEnvelopeError(err error) bool {
	var target *envelopeError
	return errors.As(err, &target)
}

// writeError maps service errors onto the shared authhttp response shapes.
//
//	validationError -> 400 (messages joined with "; ")
//	envelopeError   -> 422
//	statusError     -> its status; 5xx uses the generic fail-closed bodies
//	anything else   -> 500, the fail-closed Redis/Mongo shape
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		return
	}
	var validation *validationError
	if errors.As(err, &validation) {
		authhttp.WriteBadRequest(w, r, strings.Join(validation.Messages(), "; "))
		return
	}
	var envelope *envelopeError
	if errors.As(err, &envelope) {
		authhttp.WriteHTTPException(w, r, http.StatusUnprocessableEntity, envelope.Error())
		return
	}
	var typed *statusError
	if errors.As(err, &typed) {
		switch {
		case typed.status == http.StatusServiceUnavailable:
			authhttp.WriteDatabaseFailure(w, r)
		case typed.status >= http.StatusInternalServerError:
			authhttp.WriteInternalFailure(w, r)
		case typed.status == http.StatusConflict && typed.code != "":
			authhttp.WriteCodedConflict(w, r, typed.code, typed.message, typed.detail)
		default:
			authhttp.WriteHTTPException(w, r, typed.status, typed.message)
		}
		return
	}
	authhttp.WriteInternalFailure(w, r)
}
