package situationmonitors

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

var (
	errNameRequired    = newStatus(400, "Monitor name is required")
	errKeywordRequired = newStatus(400, "At least one keyword is required")
	errLimitReached    = newStatus(400, "Manual monitor limit reached")
	errSystemReadOnly  = newStatus(400, "System sync monitor is read only")
	errSystemDelete    = newStatus(400, "System sync monitor cannot be deleted")
	errMonitorMissing  = newStatus(404, "Monitor not found")
	errLockNotAcquired = errors.New("content subscription lock not acquired")
)

func unavailable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errLockNotAcquired) || errors.Is(err, driver.ErrBadConn) || errors.Is(err, context.DeadlineExceeded) {
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
