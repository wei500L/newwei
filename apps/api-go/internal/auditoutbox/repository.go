package auditoutbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Repository is the MySQL port of the replay chain. It is intentionally narrow:
// the scheduler owns the batch, retry and tenant rules, the implementation owns
// the SQL.
type Repository interface {
	ListPending(ctx context.Context, now time.Time, limit int) ([]Candidate, error)
	ListFailed(ctx context.Context, now time.Time, limit int) ([]Candidate, error)
	ListStaleProcessing(ctx context.Context, staleCutoff time.Time, limit int) ([]Candidate, error)
	LoadPayloads(ctx context.Context, ids []string) (map[string]json.RawMessage, error)
	Claim(ctx context.Context, candidate Candidate) (*Claimed, error)
	FindAuditLog(ctx context.Context, identity AuditIdentity) (string, bool, error)
	InsertAuditLog(ctx context.Context, entry AuditLogEntry) error
	DeleteOutbox(ctx context.Context, id, orgID string) error
	MarkFailed(ctx context.Context, update StatusUpdate) error
	MarkDead(ctx context.Context, update StatusUpdate) error
}

// mysqlRepository is the SQL implementation of Repository over the shared pool.
type mysqlRepository struct {
	db *sql.DB
}

// NewMySQLRepository builds the repository from the shared MySQL pool.
func NewMySQLRepository(db *sql.DB) Repository {
	return &mysqlRepository{db: db}
}

const candidateColumns = "SELECT `id`, `orgId`, `status`, `attempts`, `createdAt` FROM `AuditLogOutbox`"

// ListPending selects due pending rows. The (status, availableAt, createdAt)
// index backs the exact predicate and order.
func (r *mysqlRepository) ListPending(ctx context.Context, now time.Time, limit int) ([]Candidate, error) {
	const query = candidateColumns + " WHERE `status` = 'pending' AND `availableAt` <= ?" +
		" ORDER BY `createdAt` ASC, `id` ASC LIMIT ?"
	return r.listCandidates(ctx, query, now.UTC().Truncate(time.Millisecond), limit)
}

// ListFailed selects due failed rows, including the backoff-expired ones.
func (r *mysqlRepository) ListFailed(ctx context.Context, now time.Time, limit int) ([]Candidate, error) {
	const query = candidateColumns + " WHERE `status` = 'failed' AND `availableAt` <= ?" +
		" ORDER BY `createdAt` ASC, `id` ASC LIMIT ?"
	return r.listCandidates(ctx, query, now.UTC().Truncate(time.Millisecond), limit)
}

// ListStaleProcessing selects processing rows whose claim is older than the
// stale cutoff. The strict `<` comparison keeps a row claimed exactly at the
// cutoff out of this batch, and `lockedAt` NULL never matches.
func (r *mysqlRepository) ListStaleProcessing(ctx context.Context, staleCutoff time.Time, limit int) ([]Candidate, error) {
	const query = candidateColumns + " WHERE `status` = 'processing' AND `lockedAt` < ?" +
		" ORDER BY `createdAt` ASC, `id` ASC LIMIT ?"
	return r.listCandidates(ctx, query, staleCutoff.UTC().Truncate(time.Millisecond), limit)
}

func (r *mysqlRepository) listCandidates(ctx context.Context, query string, args ...any) ([]Candidate, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("auditoutbox: mysql is not configured")
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("auditoutbox: list outbox candidates: %w", err)
	}
	defer rows.Close()

	candidates := make([]Candidate, 0, 32)
	for rows.Next() {
		var candidate Candidate
		var status string
		if err := rows.Scan(&candidate.ID, &candidate.OrgID, &status, &candidate.Attempts, &candidate.CreatedAt); err != nil {
			return nil, fmt.Errorf("auditoutbox: scan outbox candidate: %w", err)
		}
		candidate.Status = Status(status)
		candidate.CreatedAt = candidate.CreatedAt.UTC().Truncate(time.Millisecond)
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auditoutbox: iterate outbox candidates: %w", err)
	}
	return candidates, nil
}

// LoadPayloads reads the payload of the selected candidates in one statement.
// Rows deleted between the scan and this read are simply absent from the map,
// and the scheduler skips them.
func (r *mysqlRepository) LoadPayloads(ctx context.Context, ids []string) (map[string]json.RawMessage, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("auditoutbox: mysql is not configured")
	}
	if len(ids) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	query := "SELECT `id`, `payload` FROM `AuditLogOutbox` WHERE `id` IN (" + placeholders + ")"
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("auditoutbox: load outbox payloads: %w", err)
	}
	defer rows.Close()

	payloads := make(map[string]json.RawMessage, len(ids))
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, fmt.Errorf("auditoutbox: scan outbox payload: %w", err)
		}
		payloads[id] = json.RawMessage(raw)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auditoutbox: iterate outbox payloads: %w", err)
	}
	return payloads, nil
}

const claimDueSQL = "UPDATE `AuditLogOutbox` SET `status` = 'processing', `lockedAt` = ?, `attempts` = `attempts` + 1," +
	" `lastError` = NULL, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `status` = ? AND `availableAt` <= ?"

const claimStaleSQL = "UPDATE `AuditLogOutbox` SET `status` = 'processing', `lockedAt` = ?, `attempts` = `attempts` + 1," +
	" `lastError` = NULL, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ? AND `status` = 'processing' AND `lockedAt` < ?"

// Claim runs the short conditional claim transaction. The update matches the
// row id, the observed status, the tenant id and the due/stale condition; zero
// affected rows means another executor already handled the row and the caller
// skips it. The claim instant is read fresh here, exactly like the NestJS
// method that recomputes `now` instead of reusing the batch instant.
func (r *mysqlRepository) Claim(ctx context.Context, candidate Candidate) (*Claimed, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("auditoutbox: mysql is not configured")
	}
	now := nowMillis()
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("auditoutbox: begin claim transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var result sql.Result
	if candidate.Status == StatusProcessing {
		result, err = tx.ExecContext(ctx, claimStaleSQL, now, now, candidate.ID, candidate.OrgID, now.Add(-staleLockWindow))
	} else {
		result, err = tx.ExecContext(ctx, claimDueSQL, now, now, candidate.ID, candidate.OrgID, string(candidate.Status), now)
	}
	if err != nil {
		return nil, fmt.Errorf("auditoutbox: claim outbox entry: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("auditoutbox: claim outbox entry count: %w", err)
	}
	if affected == 0 {
		return nil, nil
	}

	var claimed Claimed
	if err := tx.QueryRowContext(ctx,
		"SELECT `id`, `orgId`, `attempts` FROM `AuditLogOutbox` WHERE `id` = ? AND `orgId` = ?",
		candidate.ID, candidate.OrgID,
	).Scan(&claimed.ID, &claimed.OrgID, &claimed.Attempts); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("auditoutbox: read claimed outbox entry: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("auditoutbox: commit claim transaction: %w", err)
	}
	return &claimed, nil
}

// FindAuditLog runs the five-column dedupe lookup. A nil actor identity is an
// `IS NULL` predicate, never `= NULL`.
func (r *mysqlRepository) FindAuditLog(ctx context.Context, identity AuditIdentity) (string, bool, error) {
	if r == nil || r.db == nil {
		return "", false, errors.New("auditoutbox: mysql is not configured")
	}
	query := "SELECT `id` FROM `AuditLog` WHERE `orgId` = ? AND `resource` = ? AND `action` = ? AND `createdAt` = ?"
	args := []any{
		identity.OrgID,
		identity.Resource,
		identity.Action,
		identity.CreatedAt.UTC().Truncate(time.Millisecond),
	}
	if identity.ActorID == nil {
		query += " AND `actorId` IS NULL"
	} else {
		query += " AND `actorId` = ?"
		args = append(args, *identity.ActorID)
	}
	query += " LIMIT 1"

	var id string
	if err := r.db.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("auditoutbox: find audit log: %w", err)
	}
	return id, true, nil
}

const insertAuditLogSQL = "INSERT INTO `AuditLog` (`id`, `orgId`, `actorId`, `resource`, `action`, `metadata`, `ipAddress`, `createdAt`)" +
	" VALUES (?, ?, ?, ?, ?, ?, ?, ?)"

// InsertAuditLog writes the recovered audit row with the business createdAt
// from the payload.
func (r *mysqlRepository) InsertAuditLog(ctx context.Context, entry AuditLogEntry) error {
	if r == nil || r.db == nil {
		return errors.New("auditoutbox: mysql is not configured")
	}
	if _, err := r.db.ExecContext(ctx, insertAuditLogSQL,
		entry.ID,
		entry.OrgID,
		nullableStringArg(entry.ActorID),
		entry.Resource,
		entry.Action,
		metadataArg(entry),
		nullableStringArg(entry.IPAddress),
		entry.CreatedAt.UTC().Truncate(time.Millisecond),
	); err != nil {
		return fmt.Errorf("auditoutbox: insert audit log: %w", err)
	}
	return nil
}

// DeleteOutbox removes the delivered row, scoped by id and tenant id.
func (r *mysqlRepository) DeleteOutbox(ctx context.Context, id, orgID string) error {
	if r == nil || r.db == nil {
		return errors.New("auditoutbox: mysql is not configured")
	}
	if _, err := r.db.ExecContext(ctx,
		"DELETE FROM `AuditLogOutbox` WHERE `id` = ? AND `orgId` = ?", id, orgID,
	); err != nil {
		return fmt.Errorf("auditoutbox: delete outbox entry: %w", err)
	}
	return nil
}

const markFailedSQL = "UPDATE `AuditLogOutbox` SET `status` = 'failed', `lastError` = ?, `availableAt` = ?," +
	" `lockedAt` = NULL, `attempts` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"

// MarkFailed reschedules the entry with the failure message and backoff
// instant. updatedAt is written explicitly because the Go chain does not go
// through Prisma's @updatedAt.
func (r *mysqlRepository) MarkFailed(ctx context.Context, update StatusUpdate) error {
	if r == nil || r.db == nil {
		return errors.New("auditoutbox: mysql is not configured")
	}
	now := nowMillis()
	if _, err := r.db.ExecContext(ctx, markFailedSQL,
		update.Message,
		update.AvailableAt.UTC().Truncate(time.Millisecond),
		maxInt(update.Attempts, 1),
		now,
		update.ID,
		update.OrgID,
	); err != nil {
		return fmt.Errorf("auditoutbox: mark outbox failed: %w", err)
	}
	return nil
}

const markDeadSQL = "UPDATE `AuditLogOutbox` SET `status` = 'dead', `lastError` = ?, `availableAt` = ?," +
	" `lockedAt` = NULL, `attempts` = ?, `updatedAt` = ? WHERE `id` = ? AND `orgId` = ?"

// MarkDead parks the entry after the attempt limit or an invalid payload.
func (r *mysqlRepository) MarkDead(ctx context.Context, update StatusUpdate) error {
	if r == nil || r.db == nil {
		return errors.New("auditoutbox: mysql is not configured")
	}
	now := nowMillis()
	if _, err := r.db.ExecContext(ctx, markDeadSQL,
		update.Message,
		update.AvailableAt.UTC().Truncate(time.Millisecond),
		maxInt(update.Attempts, 1),
		now,
		update.ID,
		update.OrgID,
	); err != nil {
		return fmt.Errorf("auditoutbox: mark outbox dead: %w", err)
	}
	return nil
}

// metadataArg maps the payload presence onto the JSON column: absent sends SQL
// NULL, an explicit JSON null sends the literal `null` (a JSON null value).
// This is the same split the Go producers use when they insert []byte directly.
func metadataArg(entry AuditLogEntry) any {
	if !entry.HasMetadata || len(entry.Metadata) == 0 {
		return nil
	}
	return []byte(entry.Metadata)
}

// nullableStringArg converts a nullable pointer into the driver value.
func nullableStringArg(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
