package userdigest

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// mysqlDeliveryRepository is the SQL implementation of DeliveryRepository.
type mysqlDeliveryRepository struct {
	db *sql.DB
}

// NewMySQLDeliveryRepository builds the MySQL port from the shared pool.
func NewMySQLDeliveryRepository(db *sql.DB) DeliveryRepository {
	return &mysqlDeliveryRepository{db: db}
}

// ListActiveOrgIDs mirrors ActiveOrgRegistryService.loadActiveOrgs: only active
// organizations, ordered by id ASC.
func (r *mysqlDeliveryRepository) ListActiveOrgIDs(ctx context.Context) ([]string, error) {
	if r == nil || r.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	rows, err := r.db.QueryContext(ctx, "SELECT id FROM Org WHERE isActive = 1 ORDER BY id ASC")
	if err != nil {
		return nil, fmt.Errorf("%w: list active orgs: %v", errMySQL, err)
	}
	defer rows.Close()
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("%w: scan active org: %v", errMySQL, err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: iterate active orgs: %v", errMySQL, err)
	}
	return ids, nil
}

// ListDueSchedules reads one key-set page of due schedules for one
// organization. The predicate mirrors the NestJS Prisma query: enabled, a
// non-null nextRunAt at or before the fixed organization cutoff, an active user
// and an active membership in an active organization. id is the stable
// tie-breaker after nextRunAt and updatedAt.
func (r *mysqlDeliveryRepository) ListDueSchedules(ctx context.Context, orgID string, cutoff time.Time, cursor *DeliveryCursor, limit int) ([]DeliveryScheduleRecord, error) {
	if r == nil || r.db == nil {
		return nil, fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	if limit <= 0 {
		return nil, fmt.Errorf("userdigest: delivery scan limit must be positive")
	}
	query := "SELECT s.id, s.orgId, s.userId, s.enabled, s.timezone, s.sendHour, s.sendMinute, s.nextRunAt, s.updatedAt, s.lastStatus, s.lastError, " +
		"u.email, u.emailVerified, u.firstName " +
		"FROM UserDigestDeliverySchedule s " +
		"INNER JOIN `User` u ON u.id = s.userId " +
		"INNER JOIN Membership m ON m.userId = s.userId AND m.orgId = s.orgId " +
		"INNER JOIN Org o ON o.id = s.orgId " +
		"WHERE s.orgId = ? AND s.enabled = 1 AND s.nextRunAt IS NOT NULL AND s.nextRunAt <= ? " +
		"AND u.isActive = 1 AND m.isActive = 1 AND o.isActive = 1"
	args := []any{orgID, cutoff.UTC().Truncate(time.Millisecond)}
	if cursor != nil {
		// The row-value comparison keeps the page boundary on the exact values
		// read earlier. updatedAt is the original DATETIME(3) value, so writes
		// performed while this page is processed cannot move the cursor.
		query += " AND (s.nextRunAt, s.updatedAt, s.id) > (?, ?, ?)"
		args = append(args, cursor.NextRunAt.UTC().Truncate(time.Millisecond), cursor.UpdatedAt.UTC().Truncate(time.Millisecond), cursor.ID)
	}
	query += " ORDER BY s.nextRunAt ASC, s.updatedAt ASC, s.id ASC LIMIT ?"
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: list due digest schedules: %v", errMySQL, err)
	}
	defer rows.Close()
	records := make([]DeliveryScheduleRecord, 0, limit)
	for rows.Next() {
		var record DeliveryScheduleRecord
		var verified sql.NullTime
		var lastError sql.NullString
		if err := rows.Scan(
			&record.ID,
			&record.OrgID,
			&record.UserID,
			&record.Enabled,
			&record.Timezone,
			&record.SendHour,
			&record.SendMinute,
			&record.NextRunAt,
			&record.UpdatedAt,
			&record.LastStatus,
			&lastError,
			&record.Email,
			&verified,
			&record.FirstName,
		); err != nil {
			return nil, fmt.Errorf("%w: scan due digest schedule: %v", errMySQL, err)
		}
		record.EmailVerified = verified.Valid
		if lastError.Valid {
			value := lastError.String
			record.LastError = &value
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: iterate due digest schedules: %v", errMySQL, err)
	}
	return records, nil
}

// ClaimDueSlot runs the conditional update that claims one due slot. It matches
// the row by id, org, enabled and the exact old nextRunAt so a concurrent
// disable or reschedule wins the race and leaves the row untouched.
func (r *mysqlDeliveryRepository) ClaimDueSlot(ctx context.Context, record DeliveryScheduleRecord, claim DeliverySlotClaim) (bool, error) {
	if r == nil || r.db == nil {
		return false, fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	statusAt := claim.LastStatusAt.UTC().Truncate(time.Millisecond)
	const query = "UPDATE UserDigestDeliverySchedule SET enabled = ?, nextRunAt = ?, lastStatus = ?, lastStatusAt = ?, lastError = ?, updatedAt = ? " +
		"WHERE id = ? AND orgId = ? AND enabled = 1 AND nextRunAt = ?"
	result, err := r.db.ExecContext(ctx, query,
		claim.Enabled,
		nullableTimeArg(claim.NextRunAt),
		claim.LastStatus,
		statusAt,
		nullableStringArg(claim.LastError),
		statusAt,
		record.ID,
		record.OrgID,
		record.NextRunAt.UTC().Truncate(time.Millisecond),
	)
	if err != nil {
		return false, fmt.Errorf("%w: claim digest schedule slot: %v", errMySQL, err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("%w: claim digest schedule slot count: %v", errMySQL, err)
	}
	return affected == 1, nil
}

// UpdateClaimedSlot writes the result of a slot this process already claimed.
// COALESCE keeps the previous lastSentAt when the update carries nil, matching
// the NestJS update that does not touch lastSentAt on a failure.
func (r *mysqlDeliveryRepository) UpdateClaimedSlot(ctx context.Context, record DeliveryScheduleRecord, update DeliveryClaimedUpdate) error {
	if r == nil || r.db == nil {
		return fmt.Errorf("%w: mysql is not configured", errMySQL)
	}
	statusAt := update.LastStatusAt.UTC().Truncate(time.Millisecond)
	const query = "UPDATE UserDigestDeliverySchedule SET lastSentAt = COALESCE(?, lastSentAt), lastStatus = ?, lastStatusAt = ?, lastError = ?, updatedAt = ? " +
		"WHERE id = ? AND orgId = ?"
	if _, err := r.db.ExecContext(ctx, query,
		nullableTimeArg(update.LastSentAt),
		update.LastStatus,
		statusAt,
		nullableStringArg(update.LastError),
		statusAt,
		record.ID,
		record.OrgID,
	); err != nil {
		return fmt.Errorf("%w: update claimed digest schedule: %v", errMySQL, err)
	}
	return nil
}

// nullableTimeArg converts a nullable pointer into the driver value. It is a
// driver boundary helper, not a business container.
func nullableTimeArg(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Truncate(time.Millisecond)
}

// nullableStringArg converts a nullable string pointer into the driver value.
func nullableStringArg(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
