package processeditemoutbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

const (
	outboxType       = "processed_item"
	statusPending    = "pending"
	statusFailed     = "failed"
	statusProcessing = "processing"
	statusDead       = "dead"

	staleLockWindow = 5 * time.Minute
	maxAttempts     = 10
	retryBaseDelay  = 30 * time.Second
	backoffCap      = 5
)

// itemMetaColumns mirrors the Prisma select in deliverOutboxPayload. The lookup
// is by id only, like findUnique, so the payload's organization is not used to
// narrow this read (the read model still embeds the ItemMeta orgId).
const itemMetaColumns = "`id`, `orgId`, `externalId`, `name`, `status`, `mongoRef`, `version`, `publishedAt`, `sortAt`, `createdAt`, `updatedAt`"

type mysqlStore struct {
	db *sql.DB
}

type claimedEntry struct {
	ID       string
	OrgID    string
	Attempts int
}

// listDueIDs is the lightweight scan: only ids are selected, ordered by the
// legacy createdAt ascending key. The payload can contain a large embedding,
// so it is read after the CAS claim succeeds.
func (s *mysqlStore) listDueIDs(ctx context.Context, now time.Time, limit int) ([]string, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("processeditemoutbox: mysql is not configured")
	}
	const query = "SELECT `id` FROM `MongoOutbox` WHERE `type` = ? AND (" +
		"(`status` = ? AND `availableAt` <= ?) OR " +
		"(`status` = ? AND `availableAt` <= ?) OR " +
		"(`status` = ? AND `lockedAt` < ?)" +
		") ORDER BY `createdAt` ASC LIMIT ?"
	rows, err := s.db.QueryContext(ctx, query, outboxType,
		statusPending, now,
		statusFailed, now,
		statusProcessing, now.Add(-staleLockWindow),
		limit)
	if err != nil {
		return nil, fmt.Errorf("processeditemoutbox: scan outbox: %w", err)
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("processeditemoutbox: scan outbox id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("processeditemoutbox: iterate outbox ids: %w", err)
	}
	return ids, nil
}

// claim performs the same conditional update as claimOutboxEntry. The update
// and the attempts read share one transaction; a zero row count means another
// executor (NestJS immediate delivery, its in-process retry, or another Go
// replica) won the race.
func (s *mysqlStore) claim(ctx context.Context, id string, now time.Time) (*claimedEntry, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("processeditemoutbox: mysql is not configured")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	const update = "UPDATE `MongoOutbox` SET `status` = ?, `lockedAt` = ?, `attempts` = `attempts` + 1," +
		" `lastError` = NULL, `updatedAt` = ? WHERE `id` = ? AND `type` = ? AND (" +
		"(`status` = ? AND `availableAt` <= ?) OR " +
		"(`status` = ? AND `availableAt` <= ?) OR " +
		"(`status` = ? AND `lockedAt` < ?))"
	result, err := tx.ExecContext(ctx, update,
		statusProcessing, now, now, id, outboxType,
		statusPending, now,
		statusFailed, now,
		statusProcessing, now.Add(-staleLockWindow))
	if err != nil {
		return nil, fmt.Errorf("processeditemoutbox: claim outbox %s: %w", id, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		return nil, nil
	}
	claimed := &claimedEntry{ID: id}
	err = tx.QueryRowContext(ctx,
		"SELECT `orgId`, `attempts` FROM `MongoOutbox` WHERE `id` = ?", id,
	).Scan(&claimed.OrgID, &claimed.Attempts)
	if err != nil {
		return nil, fmt.Errorf("processeditemoutbox: read claimed outbox %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (s *mysqlStore) loadPayload(ctx context.Context, id string) ([]byte, error) {
	var payload []byte
	err := s.db.QueryRowContext(ctx,
		"SELECT `payload` FROM `MongoOutbox` WHERE `id` = ?", id,
	).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("processeditemoutbox: outbox row disappeared after claim")
	}
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func (s *mysqlStore) markFailed(ctx context.Context, id string, attempts int, message string, availableAt, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE `MongoOutbox` SET `status` = ?, `lastError` = ?, `availableAt` = ?, `lockedAt` = NULL,"+
			" `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		statusFailed, message, availableAt, max(attempts, 1), now, id)
	return err
}

func (s *mysqlStore) markDead(ctx context.Context, id string, attempts int, message string, now time.Time) error {
	_, err := s.db.ExecContext(ctx,
		"UPDATE `MongoOutbox` SET `status` = ?, `lastError` = ?, `availableAt` = ?, `lockedAt` = NULL,"+
			" `attempts` = ?, `updatedAt` = ? WHERE `id` = ?",
		statusDead, message, now, max(attempts, 1), now, id)
	return err
}

func (s *mysqlStore) deleteOutbox(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM `MongoOutbox` WHERE `id` = ?", id)
	return err
}

// findItemMeta ports the unbounded findUnique used by delivery. A deleted item
// yields nil and delivery continues; that is the legacy orphan behavior.
func (s *mysqlStore) findItemMeta(ctx context.Context, id string) (*itemsreading.ItemMetaRow, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT "+itemMetaColumns+" FROM `ItemMeta` WHERE `id` = ? LIMIT 1", id)
	var meta itemsreading.ItemMetaRow
	var publishedAt sql.NullTime
	var sortAt, createdAt, updatedAt time.Time
	err := row.Scan(&meta.ID, &meta.OrgID, &meta.ExternalID, &meta.Name, &meta.Status,
		&meta.MongoRef, &meta.Version, &publishedAt, &sortAt, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if publishedAt.Valid {
		value := itemsreading.NewISOTime(publishedAt.Time)
		meta.PublishedAt = &value
	}
	meta.SortAt = itemsreading.NewISOTime(sortAt)
	meta.CreatedAt = itemsreading.NewISOTime(createdAt)
	meta.UpdatedAt = itemsreading.NewISOTime(updatedAt)
	return &meta, nil
}

// updateItemMeta writes the same conditional updateMany as NestJS: duplicate
// metas keep their status and only non-duplicates become completed.
func (s *mysqlStore) updateItemMeta(ctx context.Context, id, name string, updateName bool, publishedAt *time.Time, sortAt time.Time, now time.Time) error {
	query := "UPDATE `ItemMeta` SET `status` = ?"
	args := []any{itemsreading.ItemStatusCompleted}
	if updateName {
		query += ", `name` = ?"
		args = append(args, name)
	}
	if publishedAt != nil {
		query += ", `publishedAt` = ?, `sortAt` = ?"
		args = append(args, *publishedAt, sortAt)
	}
	query += ", `updatedAt` = ? WHERE `id` = ? AND `status` <> ?"
	args = append(args, now, id, itemsreading.ItemStatusDuplicate)
	_, err := s.db.ExecContext(ctx, query, args...)
	return err
}
