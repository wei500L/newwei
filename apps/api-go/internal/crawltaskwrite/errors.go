package crawltaskwrite

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// statusError mirrors a NestJS HttpException. REST renders it through the
// GlobalExceptionFilter shape; GraphQL maps it to the same field failure.
type statusError struct {
	status  int
	message string
}

// Error implements error.
func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// validationError is the ValidationPipe 400: the message is the array of
// class-validator strings.
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

// Messages exposes the class-validator array.
func (e *validationError) Messages() []string { return e.messages }

func newValidationError(messages []string) error {
	return &validationError{messages: messages}
}

// unavailable reports database-unavailable errors, which fail closed with the
// same 503 shape as Prisma connection errors in NestJS.
func unavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var mysqlErr *mysqlDriver.MySQLError
	if errors.As(err, &mysqlErr) {
		switch mysqlErr.Number {
		case 1040, 1042, 1043, 1053, 1159, 1160, 1161, 2002, 2003, 2006, 2013:
			return true
		}
	}
	var netErr net.Error
	return errors.As(err, &netErr)
}

// HTTPStatus exposes a typed HTTP failure to the GraphQL adapter without
// leaking the unexported error type.
func HTTPStatus(err error) (status int, message string, ok bool) {
	var typed *statusError
	if errors.As(err, &typed) {
		return typed.status, typed.message, true
	}
	var validation *validationError
	if errors.As(err, &validation) {
		return 400, validation.Error(), true
	}
	return 0, "", false
}
