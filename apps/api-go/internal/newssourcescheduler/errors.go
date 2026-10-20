package newssourcescheduler

import (
	"errors"
	"net/http"
)

// statusError is a NestJS HttpException-shaped failure. The HTTP handler renders
// it through authhttp.WriteHTTPException so the body matches the NestJS global
// exception filter.
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// asStatus exposes the typed failure.
func asStatus(err error) *statusError {
	var typed *statusError
	if errors.As(err, &typed) {
		return typed
	}
	return nil
}

// notFoundSource is the shared org-isolation failure.
func notFoundSource() error {
	return newStatus(http.StatusNotFound, "News source not found")
}
