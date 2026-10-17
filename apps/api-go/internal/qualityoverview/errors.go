// Package qualityoverview 是管理端质量面板 5 条只读 GET 的 Go 接管实现
// （开关 API_GO_QUALITY_OVERVIEW_MODE=go 时才注册 handler）。
//
// 事实源（逐段翻译，未使用简化版）：
//   - apps/api/src/modules/observability/news-source-quality.controller.ts
//   - apps/api/src/modules/observability/news-source-quality.service.ts
//   - apps/api/src/modules/observability/pipeline-quality.controller.ts
//   - apps/api/src/modules/observability/pipeline-quality.service.ts
//   - apps/api/src/modules/observability/quality-overview.controller.ts
//   - apps/api/src/modules/observability/quality-overview.service.ts
//   - apps/api/src/modules/observability/task-logs.controller.ts
//   - apps/api/src/modules/observability/admin-logs.service.ts 的
//     getQualityTaskLogsOverview / listTaskLogs / summarizeTaskLogs
//   - apps/api/src/modules/observability/observability-snapshot.service.ts 的
//     getOrCreate / buildLockKey（MySQL ObservabilitySnapshot 表 + Redis 锁）
//   - apps/api/src/modules/cache/cache.service.ts 的 withLock / wrap
//   - packages/mongo/src/models/processed-item.ts 与 task-log.ts
//     （Mongoose 默认集合名 processeditems / tasklogs）
//
// 任务日志的聚合与深层脱敏直接调用 internal/adminlogs（同一实现，不维护
// 第二套正则）；流水线质量的 failureTypes.errorName 复用同一脱敏函数。
package qualityoverview

import (
	"context"
	"database/sql/driver"
	"errors"
	"net"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

// unavailable 判定数据库不可用类错误（fail-closed 503，与 Nest 的 Prisma
// 连接类错误映射一致；与 adminlogs/llmlogs 的同一分类）。
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
