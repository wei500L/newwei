package adminlogs

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// statusError 是与 Nest HttpException 对齐的服务端错误（写响应时经
// authhttp.WriteHTTPException 输出 GlobalExceptionFilter 形状）。
type statusError struct {
	status  int
	message string
}

func (e *statusError) Error() string { return e.message }

func newStatus(status int, message string) error {
	return &statusError{status: status, message: message}
}

// inputError 是 400 错误（文案与控制器里 BadRequestException 的原句一致）。
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// unavailable 判定数据库不可用类错误（fail-closed 503，与 NestJS
// Prisma 连接类错误的映射一致）。
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
