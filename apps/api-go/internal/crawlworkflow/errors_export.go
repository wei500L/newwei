package crawlworkflow

import (
	"errors"
)

// This file exposes the error classification the sibling packages need when they
// call the workflow bridges. It adds no behaviour: the same statusError /
// inputError values the workflow HTTP routes already map are reported here.

// StatusOf returns the HTTP status and message of a statusError, or ok=false for
// any other error. The trial-run and replay entries use it to keep the source's
// 404/400 texts ("Workflow not found", "Workflow version not found", "Workflow has
// no published version").
func StatusOf(err error) (status int, message string, ok bool) {
	var typed *statusError
	if errors.As(err, &typed) {
		return typed.status, typed.message, true
	}
	return 0, "", false
}

// IsInputError reports whether err is the 400-class validation error
// (inputError). Callers map it to BadRequest with InputErrorMessage.
func IsInputError(err error) bool {
	var typed *inputError
	return errors.As(err, &typed)
}

// InputErrorMessage returns the message of an inputError.
func InputErrorMessage(err error) string {
	var typed *inputError
	if errors.As(err, &typed) {
		return typed.Message
	}
	return ""
}
