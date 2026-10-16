package llmlogs

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

// inputError 是 400。文案与控制器/服务里的 BadRequestException 逐字一致
// （GlobalExceptionFilter 把 message 原样输出为字符串）。
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// errMongoUnavailable 表示 Mongo 未配置（wire 层已保证 go 模式下必有
// MONGO_URI；这里是防御性兜底）。
var errMongoUnavailable = errors.New("mongo is not configured")

// errDatabaseUnavailable 表示 MySQL 未配置（同样只是防御性兜底）。
var errDatabaseUnavailable = errors.New("mysql is not configured")

// unavailable 判定数据库不可用类错误（fail-closed 503，与 Nest 的 Prisma
// 连接类错误映射一致）。
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
