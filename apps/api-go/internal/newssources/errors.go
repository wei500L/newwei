package newssources

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"
	"strings"

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

// HTTPStatus exposes a typed HTTP failure to other migrated units that reuse
// this package's machine-token authentication.
func HTTPStatus(err error) (status int, message string, ok bool) {
	var typed *statusError
	if errors.As(err, &typed) {
		return typed.status, typed.message, true
	}
	return 0, "", false
}

func duplicateURL(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	if !errors.As(err, &mysqlErr) || mysqlErr.Number != 1062 {
		return false
	}
	text := strings.ToLower(mysqlErr.Message)
	return strings.Contains(text, "url") || strings.Contains(text, "newssource_orgid_url_key")
}
