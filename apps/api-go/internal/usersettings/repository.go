// user-settings MySQL 只读 repository（Go-批2A onboarding 起步，Go-批2B
// 扩展 rss-reader / spacetime-timeline，Go-批3B 扩展 war-map / newsnow /
// situation-monitor——三个端点共享同一条私有单 key 查询，situation-monitor
// 是唯一的三 key 聚合查询）。
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
	// WarMapKey 是 war-map 设置的固定存储 key（Go-批3B）。
	WarMapKey SettingKey = "ui:war-map:settings:v1"
	// NewsnowKey 是 newsnow 设置的固定存储 key（Go-批3B）。
	NewsnowKey SettingKey = "ui:newsnow:settings:v1"
	// SituationMonitorMonitorsKey 是 situation-monitor 自定义监控项的
	// 固定存储 key（Go-批3B）。
	SituationMonitorMonitorsKey SettingKey = "ui:situation-monitor:monitors:v1"
	// SituationMonitorLayoutKey 是 situation-monitor 布局的固定存储 key
	//（Go-批3B）。
	SituationMonitorLayoutKey SettingKey = "ui:situation-monitor:layout:v1"
	// SituationMonitorSettingsKey 是 situation-monitor 设置的固定存储 key
	//（Go-批3B）。
	SituationMonitorSettingsKey SettingKey = "ui:situation-monitor:settings:v1"
)

// Repository 是 user-settings 只读查询接口（六个确定性 GET 端点，
// NestJS user-settings.service.ts 的 findUnique / findMany 语义）。
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
	// FindWarMap 返回该 org+user 的 war-map 记录；无记录时
	// Found=false（非错误）。
	FindWarMap(ctx context.Context, orgID, userID string) (Record, error)
	// FindNewsnow 返回该 org+user 的 newsnow 记录；无记录时
	// Found=false（非错误）。
	FindNewsnow(ctx context.Context, orgID, userID string) (Record, error)
	// FindSituationMonitor 一次查询聚合该 org+user 的 situation-monitor
	// 三条固定 key 记录（NestJS findMany 语义：返回的 Records 按 monitors/
	// layout/settings 各自 Found 标记，查询 WHERE orgId+userId+key IN
	// (三个编译期常量)——不接受任何请求传入的 key）。
	FindSituationMonitor(ctx context.Context, orgID, userID string) (SituationMonitorRecords, error)
}

// SituationMonitorRecords 是 situation-monitor 三个固定 key 的聚合结果。
type SituationMonitorRecords struct {
	Monitors Record
	Layout   Record
	Settings Record
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

// FindWarMap 查询 war-map 设置（固定 key WarMapKey）。
func (r *MySQLRepository) FindWarMap(ctx context.Context, orgID, userID string) (Record, error) {
	return r.findByKey(ctx, orgID, userID, WarMapKey)
}

// FindNewsnow 查询 newsnow 设置（固定 key NewsnowKey）。
func (r *MySQLRepository) FindNewsnow(ctx context.Context, orgID, userID string) (Record, error) {
	return r.findByKey(ctx, orgID, userID, NewsnowKey)
}

// FindSituationMonitor 一次真实查询聚合三个固定 key（NestJS findMany
// 语义：WHERE orgId+userId+key IN 三个编译期常量；每 key 至多一条——
// orgId+userId+key 联合唯一）。任何一条记录缺失只是 Found=false（业务
// 结果），与 NestJS「无对应记录时该字段为 null」一致。
func (r *MySQLRepository) FindSituationMonitor(ctx context.Context, orgID, userID string) (SituationMonitorRecords, error) {
	const query = "SELECT `key`, value, updatedAt FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` IN (?, ?, ?)"

	rows, err := r.db.QueryContext(ctx, query, orgID, userID,
		SituationMonitorMonitorsKey, SituationMonitorLayoutKey, SituationMonitorSettingsKey)
	if err != nil {
		return SituationMonitorRecords{}, fmt.Errorf("%w: query situation-monitor: %v", ErrDatabase, err)
	}
	defer rows.Close()

	records := SituationMonitorRecords{}
	for rows.Next() {
		var key string
		var value []byte
		var updatedAt sql.NullTime
		if err := rows.Scan(&key, &value, &updatedAt); err != nil {
			return SituationMonitorRecords{}, fmt.Errorf("%w: scan situation-monitor: %v", ErrDatabase, err)
		}
		if !updatedAt.Valid {
			return SituationMonitorRecords{}, fmt.Errorf("%w: updatedAt is NULL", ErrDatabase)
		}
		record := Record{Found: true, Value: value, UpdatedAt: updatedAt.Time}
		switch SettingKey(key) {
		case SituationMonitorMonitorsKey:
			records.Monitors = record
		case SituationMonitorLayoutKey:
			records.Layout = record
		case SituationMonitorSettingsKey:
			records.Settings = record
		}
	}
	if err := rows.Err(); err != nil {
		return SituationMonitorRecords{}, fmt.Errorf("%w: iterate situation-monitor: %v", ErrDatabase, err)
	}
	return records, nil
}

// findByKey 是五个单 key 端点共享的唯一查询实现（key 是编译期固定常量，
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
