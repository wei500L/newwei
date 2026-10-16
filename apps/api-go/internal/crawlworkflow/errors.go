package crawlworkflow

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

// inputError 是 400 校验错误（消息文本已按 class-validator +
// GlobalExceptionFilter 拼接规则生成）。
type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

// errMirroredServerError 表示「NestJS 在同一分支会抛未捕获异常」的镜像
// （如 updateDraft 中 input.name 为 null 时的 null.trim() TypeError）。
// 响应与 NestJS 生产环境一致：500 {statusCode, message:"Internal server
// error"}，不带 error 字段。
var errMirroredServerError = errors.New("mirrored server error")

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

// uniqueConflict 判定 MySQL 唯一键冲突（1062）——发布版本号重试用。
func uniqueConflict(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}
