package pipelinerecovery

import "errors"

// statusError carries the NestJS HttpException status and message so the handler
// can render the {statusCode, message, error} body.
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

// newStatus builds one HttpException-shaped error.
func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// statusOf extracts the status of a typed error.
func statusOf(err error) (int, string, bool) {
	var target *statusError
	if errors.As(err, &target) {
		return target.status, target.message, true
	}
	return 0, "", false
}
