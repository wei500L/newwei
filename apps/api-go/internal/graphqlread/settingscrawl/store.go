package settingscrawl

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// store holds the read-only backends the twenty roots need: MySQL for the
// SystemSetting documents and the settings/crawl tables, Redis for the source
// policy sync-status comparison, and Mongo for crawl task result effects.
type store struct {
	db    *sql.DB
	mongo *mongo.Database
	redis *redis.Client
	now   func() time.Time
}

// clock returns the injectable clock so tests can pin timestamps.
func (s *store) clock() time.Time {
	if s != nil && s.now != nil {
		return s.now()
	}
	return time.Now()
}

// selectSetting reads one SystemSetting row value. A missing row reports
// found=false with a nil error, mirroring Prisma findUnique returning null.
func (s *store) selectSetting(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, sql.ErrConnDone
	}
	var value []byte
	err := s.db.QueryRowContext(
		ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

// upsertSettingIfAbsent writes a bootstrap document only while the key is still
// absent (ON DUPLICATE KEY UPDATE is a no-op), so a concurrent mutable writer is
// never overwritten and the bootstrap is idempotent.
func (s *store) upsertSettingIfAbsent(ctx context.Context, key string, payload []byte, description string) error {
	if s == nil || s.db == nil {
		return sql.ErrConnDone
	}
	_, err := s.db.ExecContext(ctx,
		"INSERT INTO SystemSetting (`key`, value, isPublic, description, createdAt, updatedAt) VALUES (?, ?, 0, ?, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE `key` = `key`",
		key, payload, description,
	)
	return err
}

// redisGetBytes reads a Redis key and reports found=false for a missing key.
func (s *store) redisGetBytes(ctx context.Context, key string) ([]byte, bool, error) {
	if s == nil || s.redis == nil {
		return nil, false, nil
	}
	raw, err := s.redis.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, false, nil
	}
	return raw, true, nil
}
