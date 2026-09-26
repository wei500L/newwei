package usersettings

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

// upsertSQL 是 UserSetting 联合唯一键 (orgId, userId, key) 上的真正
// upsert（一条语句，避免先查后插的并发竞态）。
//
// id 必须由 Go 显式写入：Prisma @default(cuid()) 在客户端生成，MySQL
// 列没有 DEFAULT（见 migration 20260117123000）。ON DUPLICATE 不改 id、
// 不改 createdAt（createdAt 只在 INSERT 时走 DATETIME(3) 的
// CURRENT_TIMESTAMP(3)）。updatedAt 由本语句写入，截断到毫秒——对齐
// JavaScript Date 与 Prisma @updatedAt 的毫秒语义，避免 DATETIME(3)
// 对亚毫秒四舍五入。
//
// 别名语法是 MySQL 8.0.19+（CI 为 8.4）。key 是保留字，列名反引号。
const upsertSQL = "INSERT INTO UserSetting (id, orgId, userId, `key`, value, updatedAt) " +
	"VALUES (?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt"

// UpsertFixed 把规范化后的 JSON 写入八个固定 key 之一。
//
// orgID/userID 只能来自调用方已验证的身份，不得来自请求体。key 不在
// 编译期封闭集合内时拒绝执行（不把请求输入当成存储 key）。value 必须
// 是规范化后的 JSON 文档。失败返回 ErrDatabase，错误文本不含 DSN、
// token 或身份。
func (r *MySQLRepository) UpsertFixed(ctx context.Context, orgID, userID string, key SettingKey, value []byte) error {
	if orgID == "" || userID == "" {
		return fmt.Errorf("%w: missing identity", ErrDatabase)
	}
	if !isFixedSettingKey(key) {
		return fmt.Errorf("%w: refusing non-fixed key", ErrDatabase)
	}
	if len(value) == 0 || !json.Valid(value) {
		return fmt.Errorf("%w: value is not json", ErrDatabase)
	}
	id, err := newUserSettingID()
	if err != nil {
		return fmt.Errorf("%w: id: %v", ErrDatabase, err)
	}
	updatedAt := time.Now().UTC().Truncate(time.Millisecond)
	if _, err := r.db.ExecContext(ctx, upsertSQL, id, orgID, userID, string(key), string(value), updatedAt); err != nil {
		return fmt.Errorf("%w: upsert user-setting: %v", ErrDatabase, err)
	}
	return nil
}

// isFixedSettingKey 是八个存储 key 的封闭集合（与 repository.go 常量一致）。
func isFixedSettingKey(key SettingKey) bool {
	switch key {
	case OnboardingKey, RSSReaderKey, SpacetimeTimelineKey, WarMapKey, NewsnowKey,
		SituationMonitorMonitorsKey, SituationMonitorLayoutKey, SituationMonitorSettingsKey:
		return true
	default:
		return false
	}
}

// newUserSettingID 生成主键。schema 的 id 是 VARCHAR(191) NOT NULL 且
// 没有数据库默认值——Prisma cuid() 在写入前由客户端填入。这里用 12
// 字节随机数做成 25 字符（'c' + 24 hex），碰撞空间足够，不依赖数据库
// 自动生成。
func newUserSettingID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}
