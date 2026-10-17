package newsindicator

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// statusError 是与 Nest HttpException 对齐的服务端错误。
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// inputError 是 400 错误（文案与服务层业务一致）。
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// errLockNotAcquired 表示按组织会话锁未在超时窗口内取得。
var errLockNotAcquired = errors.New("news indicator refresh lock not acquired")

// unavailable 判定数据库不可用类错误（fail-closed 503）。
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
