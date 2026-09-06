// user-settings MySQL 只读 repository（Go-批2A onboarding 起步，Go-批2B
// 扩展 rss-reader / spacetime-timeline——三个端点共享同一条私有查询）。
//
// 约束：
//   - 纯 database/sql + go-sql-driver/mysql，不引入 ORM/Web 框架/DI；
//   - SQL 参数化，查询条件同时包含 orgId / userId / 固定 key（租户隔离）；
//   - key 只能是本包的编译期固定 SettingKey 常量（下方封闭集合），公开
//     方法按端点语义命名并绑定各自 key——不接受来自 URL/query/body/
//     header 的任意 key；
//   - 正确区分 sql.ErrNoRows（无记录，业务结果）与真实数据库错误；
//   - 使用调用方传入的 ctx（shadow runner 的超时能取消数据库请求）；
//   - 错误对外只暴露通用错误体（ErrDatabase），详细信息只进服务端日志；
//     DSN 解析错误不含 DSN 原文（见 mysql_repository.go 的 parseMySQLURL
//     ——错误信息只有 scheme/host 缺失等结构信息）。
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

// SettingKey 是 UserSetting 表中允许查询的存储 key 类型。
//
// 它把「可查询的 key」收敛为编译期封闭集合（下方常量）——Repository 的
// 公开方法只按端点语义暴露查询，key 不出现在任何函数签名里，请求侧
// 无法传入任意 key。
type SettingKey string

const (
	// OnboardingKey 是 onboarding 设置的固定存储 key（Go-批2A）。
	OnboardingKey SettingKey = "ui:onboarding:settings:v1"
	// RSSReaderKey 是 rss-reader 设置的固定存储 key（Go-批2B）。
	RSSReaderKey SettingKey = "ui:rss-reader:settings:v1"
	// SpacetimeTimelineKey 是 spacetime-timeline 设置的固定存储 key（Go-批2B）。
	SpacetimeTimelineKey SettingKey = "ui:spacetime-timeline:settings:v1"
)

// Repository 是 user-settings 只读查询接口（三个确定性 GET 端点，
// NestJS user-settings.service.ts 的 findUnique 语义）。
type Repository interface {
	// FindOnboarding 返回该 org+user 的 onboarding 记录；无记录时
	// Found=false（非错误）。
	FindOnboarding(ctx context.Context, orgID, userID string) (Record, error)
	// FindRSSReader 返回该 org+user 的 rss-reader 记录；无记录时
	// Found=false（非错误）。
	FindRSSReader(ctx context.Context, orgID, userID string) (Record, error)
	// FindSpacetimeTimeline 返回该 org+user 的 spacetime-timeline 记录；
	// 无记录时 Found=false（非错误）。
	FindSpacetimeTimeline(ctx context.Context, orgID, userID string) (Record, error)
}

// MySQLRepository 是 UserSetting 表的只读访问实现。
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository 用已打开的连接池构造 repository。
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

// FindOnboarding 查询 onboarding 设置（固定 key OnboardingKey）。
func (r *MySQLRepository) FindOnboarding(ctx context.Context, orgID, userID string) (Record, error) {
	return r.findByKey(ctx, orgID, userID, OnboardingKey)
}

// FindRSSReader 查询 rss-reader 设置（固定 key RSSReaderKey）。
func (r *MySQLRepository) FindRSSReader(ctx context.Context, orgID, userID string) (Record, error) {
	return r.findByKey(ctx, orgID, userID, RSSReaderKey)
}

// FindSpacetimeTimeline 查询 spacetime-timeline 设置（固定 key
// SpacetimeTimelineKey）。
func (r *MySQLRepository) FindSpacetimeTimeline(ctx context.Context, orgID, userID string) (Record, error) {
	return r.findByKey(ctx, orgID, userID, SpacetimeTimelineKey)
}

// findByKey 是三个端点共享的唯一查询实现（key 是编译期固定常量，
// 绝非请求输入）。
//
// 只取 value 与 updatedAt（最小列集）；DATETIME(3) 无时区，driver 以
// time.Time 返回时按 UTC 解释（DSN parseTime=true + loc=UTC）。
// key 是 MySQL 保留字——列名必须反引号转义（远端 MySQL 集成测试
// 捕获的 1064 语法错误，见 PR #14 run 34047356388）。
func (r *MySQLRepository) findByKey(ctx context.Context, orgID, userID string, key SettingKey) (Record, error) {
	const query = "SELECT value, updatedAt FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` = ? LIMIT 1"

	var value []byte
	var updatedAt sql.NullTime
	err := r.db.QueryRowContext(ctx, query, orgID, userID, key).Scan(&value, &updatedAt)
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
