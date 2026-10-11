package newsbehavior

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

const (
	signalSource = "source"
	signalTopic  = "topic"
	signalEntity = "entity"
	signalItem   = "item"
	signalEvent  = "event"
	signalDomain = "domain"
)

type signalDelta struct {
	signalType string
	signalKey  string
	delta      float64
}

// upsertAggregateSQL 在 (orgId, userId, signalType, signalKey) 上累加。
// id 由客户端写入：Prisma @default(cuid()) 没有数据库默认值。
// createdAt 只在插入时写；冲突时只推进 score、lastInteractedAt、updatedAt。
const upsertAggregateSQL = "INSERT INTO UserNewsBehaviorAggregate " +
	"(id, orgId, userId, signalType, signalKey, score, lastInteractedAt, createdAt, updatedAt) " +
	"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE " +
	"score = UserNewsBehaviorAggregate.score + new_row.score, " +
	"lastInteractedAt = new_row.lastInteractedAt, " +
	"updatedAt = new_row.updatedAt"

const upsertSnapshotSQL = "INSERT INTO UserNewsSimilaritySnapshot " +
	"(id, orgId, userId, dirty, createdAt, updatedAt) " +
	"VALUES (?, ?, ?, ?, ?, ?) AS new_row " +
	"ON DUPLICATE KEY UPDATE dirty = 1, updatedAt = new_row.updatedAt"

const deleteAggregatesSQL = "DELETE FROM UserNewsBehaviorAggregate WHERE orgId = ? AND userId = ?"

const deleteSnapshotSQL = "DELETE FROM UserNewsSimilaritySnapshot WHERE orgId = ? AND userId = ?"

const dirtyOthersSQL = "UPDATE UserNewsSimilaritySnapshot SET dirty = 1, updatedAt = ? WHERE orgId = ? AND userId <> ?"

// newBehaviorID 是 'c' + 24 hex。不导出，避免和 usersettings 的生成器耦在一起。
func newBehaviorID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func (s *Service) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("%w: database is not configured", errDB)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return classifyDB(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return classifyDB(err)
	}
	return nil
}

func classifyDB(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, errDB) || errors.Is(err, errDBUnavailable) {
		return err
	}
	if dbUnavailable(err) {
		return fmt.Errorf("%w: %v", errDBUnavailable, err)
	}
	return fmt.Errorf("%w: %v", errDB, err)
}

func dbUnavailable(err error) bool {
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, sql.ErrConnDone) {
		return true
	}
	var op *net.OpError
	if errors.As(err, &op) {
		return true
	}
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		switch mysqlErr.Number {
		case 1040, 1054, 1146, 2002, 2003, 2006, 2013:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection refused") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "connection reset") ||
		strings.Contains(msg, "no such host") ||
		strings.Contains(msg, "i/o timeout")
}

func mergeDeltas(deltas []signalDelta) []signalDelta {
	index := make(map[string]int, len(deltas))
	out := make([]signalDelta, 0, len(deltas))
	for _, delta := range deltas {
		if delta.signalKey == "" || math.Abs(delta.delta) <= scoreEpsilon {
			continue
		}
		key := delta.signalType + ":" + delta.signalKey
		if i, ok := index[key]; ok {
			out[i].delta = round4(out[i].delta + delta.delta)
			continue
		}
		index[key] = len(out)
		out = append(out, delta)
	}
	return out
}

// persistAggregateDeltas 先提交聚合，再按 60 秒节流把本用户和同组织
// 其他用户的相似度快照标脏。节流键写上之后，事务失败也不会删掉它——
// Nest 同样不会回滚这把 Redis 锁。
func (s *Service) persistAggregateDeltas(ctx context.Context, orgID, userID string, deltas []signalDelta) error {
	merged := mergeDeltas(deltas)
	if len(merged) == 0 {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := s.withTx(ctx, func(tx *sql.Tx) error {
		for _, delta := range merged {
			if err := upsertAggregate(ctx, tx, orgID, userID, delta, now); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}
	return s.markSnapshotsDirty(ctx, orgID, userID)
}

func upsertAggregate(ctx context.Context, tx *sql.Tx, orgID, userID string, delta signalDelta, now time.Time) error {
	id, err := newBehaviorID()
	if err != nil {
		return fmt.Errorf("newsbehavior: new id: %w", err)
	}
	_, err = tx.ExecContext(ctx, upsertAggregateSQL,
		id, orgID, userID, delta.signalType, delta.signalKey, delta.delta, now, now, now)
	return classifyDB(err)
}

func (s *Service) markSnapshotsDirty(ctx context.Context, orgID, userID string) error {
	acquired, err := s.setIfAbsentAt(ctx, dirtyThrottleKey(orgID, userID), time.Duration(dirtyThrottleSeconds)*time.Second)
	if err != nil {
		return err
	}
	if !acquired {
		return nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if err := upsertOwnSnapshot(ctx, tx, orgID, userID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, dirtyOthersSQL, now, orgID, userID); err != nil {
			return classifyDB(err)
		}
		return nil
	})
}

func upsertOwnSnapshot(ctx context.Context, tx *sql.Tx, orgID, userID string, now time.Time) error {
	id, err := newBehaviorID()
	if err != nil {
		return fmt.Errorf("newsbehavior: new id: %w", err)
	}
	_, err = tx.ExecContext(ctx, upsertSnapshotSQL, id, orgID, userID, 1, now, now)
	return classifyDB(err)
}

func (s *Service) clearStoredProfile(ctx context.Context, orgID, userID string) error {
	now := time.Now().UTC().Truncate(time.Millisecond)
	return s.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, deleteAggregatesSQL, orgID, userID); err != nil {
			return classifyDB(err)
		}
		if _, err := tx.ExecContext(ctx, deleteSnapshotSQL, orgID, userID); err != nil {
			return classifyDB(err)
		}
		if _, err := tx.ExecContext(ctx, dirtyOthersSQL, now, orgID, userID); err != nil {
			return classifyDB(err)
		}
		return nil
	})
}
