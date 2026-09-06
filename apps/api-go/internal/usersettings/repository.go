// onboarding MySQL 只读 repository（Go-批2A）。
//
// 约束：
//   - 纯 database/sql + go-sql-driver/mysql，不引入 ORM/Web 框架/DI；
//   - SQL 参数化，查询条件同时包含 orgId / userId / 固定 key（租户隔离）；
//   - 正确区分 sql.ErrNoRows（无记录，业务结果）与真实数据库错误；
//   - 使用调用方传入的 ctx（shadow runner 的超时能取消数据库请求）；
//   - 错误对外只暴露通用错误体，DSN/凭据不进入错误文本（见 dsn.go 的
//     errNoSecrets 包装）。
package usersettings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrDatabase 是数据库访问失败的通用错误（对 shadow 结果只返回这一种；
// 详细错误只进服务端日志，不含凭据）。
var ErrDatabase = errors.New("user-settings database error")

// Repository 是 onboarding 只读查询接口。
type Repository interface {
	// FindOnboarding 返回该 org+user 的 onboarding 记录；无记录时
	// Found=false（非错误）。
	FindOnboarding(ctx context.Context, orgID, userID string) (Record, error)
}

// MySQLRepository 是 UserSetting 表的只读访问实现。
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository 用已打开的连接池构造 repository。
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

// FindOnboarding 查询 UserSetting 表（参数化，三条件租户隔离）。
//
// 只取 value 与 updatedAt（最小列集）；DATETIME(3) 无时区，driver 以
// time.Time 返回时按 UTC 解释（DSN parseTime=true + loc=UTC）。
// key 是 MySQL 保留字——列名必须反引号转义（远端 MySQL 集成测试
// 捕获的 1064 语法错误，见 PR #14 run 34047356388）。
func (r *MySQLRepository) FindOnboarding(ctx context.Context, orgID, userID string) (Record, error) {
	const query = "SELECT value, updatedAt FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` = ? LIMIT 1"

	var value []byte
	var updatedAt sql.NullTime
	err := r.db.QueryRowContext(ctx, query, orgID, userID, OnboardingKey).Scan(&value, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{Found: false}, nil
	}
	if err != nil {
		return Record{}, fmt.Errorf("%w: query user-setting: %v", ErrDatabase, err)
	}
	if !updatedAt.Valid {
		// schema 约束 NOT NULL——出现即数据异常，按数据库错误口径处理。
		return Record{}, fmt.Errorf("%w: updatedAt is NULL", ErrDatabase)
	}
	return Record{Found: true, Value: value, UpdatedAt: updatedAt.Time}, nil
}
