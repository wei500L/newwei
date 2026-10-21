package crawlworkflow

import "errors"

// ErrorStatus exposes the NestJS HttpException status and message this package's
// service errors carry, so HTTP units in other packages can render them with the
// GlobalExceptionFilter shape instead of collapsing a documented 404/400 into a
// 500.
//
// It is a read-only accessor: the errors themselves, their statuses and their
// messages are unchanged, and every existing caller keeps matching on the error
// value it already matched on.
func ErrorStatus(err error) (status int, message string, ok bool) {
	var serviceError *statusError
	if errors.As(err, &serviceError) {
		return serviceError.status, serviceError.message, true
	}
	var validationError *inputError
	if errors.As(err, &validationError) {
		return 400, validationError.Message, true
	}
	return 0, "", false
}
