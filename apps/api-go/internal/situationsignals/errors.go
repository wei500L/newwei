package situationsignals

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// statusError is a status-coded failure that the handler maps onto the NestJS
// GlobalExceptionFilter response shapes.
type statusError struct {
	status  int
	message string
}

// Error implements the error interface.
func (e *statusError) Error() string { return e.message }

// newStatus builds a status-coded error.
func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

var (
	// errNoDatabase is reported when a takeover path has no MySQL pool.
	errNoDatabase = errors.New("situation signals store is not configured")

	// errRefreshRunMissing is the single 404 shared by a nonexistent record, a
	// record owned by another organization and a record whose task window does
	// not parse. The three are deliberately indistinguishable.
	errRefreshRunMissing = newStatus(404, "Situation Monitor refresh run not found.")

	// errSignalIDRequired is the S1 fix: a blank signalId is a client error.
	errSignalIDRequired = newStatus(400, "signalId is required")
)

// unavailable reports whether a MySQL/Redis failure is a connection-class
// failure that NestJS would surface as a 503 rather than a generic 500.
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
