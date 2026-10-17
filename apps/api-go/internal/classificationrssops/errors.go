package classificationrssops

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// statusError is a typed service error that maps onto an HTTP status and
// message, mirroring the NestJS HttpException the controller would have thrown.
// It is the single error type crossing the service/handler boundary, so the
// handler can reproduce the GlobalExceptionFilter response shape.
type statusError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *statusError) Error() string { return e.message }

// newStatus builds a typed HTTP-mapped error.
func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// statusOf extracts the HTTP status and message from a typed service error.
// ok is false when err is not a statusError.
func statusOf(err error) (int, string, bool) {
	var status *statusError
	if errors.As(err, &status) {
		return status.status, status.message, true
	}
	return 0, "", false
}

// unavailable reports whether err looks like a database outage. The classification
// answers fail closed with the same 503 the NestJS Prisma connection errors map
// to; the classification list mirrors internal/adminlogs, internal/llmlogs and
// internal/qualityoverview so every Go batch classifies outages identically.
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
