package gdeltsnapshot

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// snapshotRow is one inserted SituationMonitorExternalSnapshot row. The Prisma
// model has no unique key, so every rebuild appends a row; sensitivity to the
// history window is a prune concern, not an upsert concern.
type snapshotRow struct {
	ID          string
	Scope       string
	VariantKey  string
	Status      Status
	Source      string
	Payload     []byte
	Warnings    []byte
	Diagnostics []byte
	GeneratedAt time.Time
	ExpiresAt   time.Time
}

// aggregateRow is the projected 24 hour window the status summary needs. It
// replaces loading and JSON-parsing every stored payload.
type aggregateRow struct {
	RecentCount          int
	ValidPayloadCount    int
	CompletedCount       int
	RateLimitedCount     int
	AvailableCategorySum int
	LastFullSuccessAt    *time.Time
	LastNonSuccessAt     *time.Time
}

// storePort is the MySQL surface the snapshot chain needs.
type storePort interface {
	// LatestPayload reads the newest stored payload for the global snapshot.
	LatestPayload(ctx context.Context) ([]byte, bool, error)
	// Insert appends one history row.
	Insert(ctx context.Context, row snapshotRow) error
	// Prune deletes rows generated before cutoff and reports the row count.
	Prune(ctx context.Context, cutoff time.Time) (int64, error)
	// Aggregates projects the 24 hour metrics window.
	Aggregates(ctx context.Context, now time.Time) (aggregateRow, error)
}

// mysqlStore is storePort over the shared *sql.DB.
type mysqlStore struct {
	db *sql.DB
}

// errNoDatabase is reported when the store is used without a connection pool.
var errNoDatabase = errors.New("gdeltsnapshot: mysql is not configured")

// LatestPayload mirrors the Prisma findFirst in readSnapshot: newest
// generatedAt first, createdAt as the tie-break.
func (s *mysqlStore) LatestPayload(ctx context.Context) ([]byte, bool, error) {
	if s.db == nil {
		return nil, false, errNoDatabase
	}
	var payload []byte
	err := s.db.QueryRowContext(ctx, `
SELECT payload FROM SituationMonitorExternalSnapshot
WHERE scope = ? AND variantKey = ?
ORDER BY generatedAt DESC, createdAt DESC
LIMIT 1`, scope, variantKey).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return payload, true, nil
}

// Insert appends one history row. createdAt keeps the column default, exactly
// like the Prisma create that omits it.
func (s *mysqlStore) Insert(ctx context.Context, row snapshotRow) error {
	if s.db == nil {
		return errNoDatabase
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO SituationMonitorExternalSnapshot
  (id, scope, variantKey, status, source, payload, warnings, diagnostics, generatedAt, expiresAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.ID, row.Scope, row.VariantKey, string(row.Status), row.Source,
		row.Payload, row.Warnings, row.Diagnostics, row.GeneratedAt, row.ExpiresAt,
	)
	return err
}

// Prune mirrors pruneHistory's deleteMany: everything older than the retention
// cutoff for the global snapshot only.
func (s *mysqlStore) Prune(ctx context.Context, cutoff time.Time) (int64, error) {
	if s.db == nil {
		return 0, errNoDatabase
	}
	result, err := s.db.ExecContext(ctx, `
DELETE FROM SituationMonitorExternalSnapshot
WHERE scope = ? AND variantKey = ? AND generatedAt < ?`, scope, variantKey, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// Aggregates runs the projected 24 hour query.
//
// NestJS loads every matching row, including payload, warnings and diagnostics,
// and then parses each payload to derive three counters. Only those counters are
// consumed, so the same numbers are projected here:
//
//   - RecentCount is every row in the window (the success-rate denominator).
//   - ValidPayloadCount is the rows whose payload would pass normalizePayload
//     (an object with non-empty string generatedAt and expiresAt); the average
//     available-category metric uses this denominator.
//   - CompletedCount is the rows whose status column is completed.
//   - RateLimitedCount is the valid rows whose warnings array contains an object
//     with code=gdelt_rate_limited.
//   - AvailableCategorySum is the per-row count of categories with at least one
//     stored headline, summed over the valid rows.
//
// The two scalar subqueries return the newest completed and the newest
// non-success generatedAt.
func (s *mysqlStore) Aggregates(ctx context.Context, now time.Time) (aggregateRow, error) {
	if s.db == nil {
		return aggregateRow{}, errNoDatabase
	}
	windowStart := now.Add(-24 * time.Hour)
	// Placeholder order follows the SQL text: the two scalar subqueries come
	// first, then the derived table's scope/variant/window predicate.
	var row aggregateRow
	var lastFullSuccess, lastNonSuccess sql.NullTime
	err := s.db.QueryRowContext(ctx, aggregatesQuery,
		scope, variantKey,
		scope, variantKey,
		scope, variantKey, windowStart,
	).Scan(
		&row.RecentCount,
		&row.ValidPayloadCount,
		&row.CompletedCount,
		&row.RateLimitedCount,
		&row.AvailableCategorySum,
		&lastFullSuccess,
		&lastNonSuccess,
	)
	if err != nil {
		return aggregateRow{}, err
	}
	if lastFullSuccess.Valid {
		value := lastFullSuccess.Time.UTC()
		row.LastFullSuccessAt = &value
	}
	if lastNonSuccess.Valid {
		value := lastNonSuccess.Time.UTC()
		row.LastNonSuccessAt = &value
	}
	return row, nil
}

// payloadIsValidSQL is the SQL form of the normalizePayload acceptance test:
// an object whose generatedAt and expiresAt are non-empty strings.
const payloadIsValidSQL = `(JSON_TYPE(payload) = 'OBJECT'
      AND JSON_TYPE(payload->'$.generatedAt') = 'STRING'
      AND JSON_UNQUOTE(payload->'$.generatedAt') <> ''
      AND JSON_TYPE(payload->'$.expiresAt') = 'STRING'
      AND JSON_UNQUOTE(payload->'$.expiresAt') <> '')`

// availableCategoriesSQL counts, in SQL, how many categories of one stored
// payload hold at least one headline. A missing or non-array member counts as
// zero, which is what normalizePayload turns it into.
const availableCategoriesSQL = `(IF(JSON_TYPE(payload->'$.headlinesByCategory.politics') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.politics'), 0), 0) > 0)
    + (IF(JSON_TYPE(payload->'$.headlinesByCategory.tech') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.tech'), 0), 0) > 0)
    + (IF(JSON_TYPE(payload->'$.headlinesByCategory.finance') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.finance'), 0), 0) > 0)
    + (IF(JSON_TYPE(payload->'$.headlinesByCategory.gov') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.gov'), 0), 0) > 0)
    + (IF(JSON_TYPE(payload->'$.headlinesByCategory.ai') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.ai'), 0), 0) > 0)
    + (IF(JSON_TYPE(payload->'$.headlinesByCategory.intel') = 'ARRAY', COALESCE(JSON_LENGTH(payload->'$.headlinesByCategory.intel'), 0), 0) > 0)`

// aggregatesQuery is the single-statement projection. The nested derived tables
// let the outer aggregate reuse the validity flag without repeating the payload
// predicates in every counter.
var aggregatesQuery = fmt.Sprintf(`
SELECT
  COUNT(*) AS recentCount,
  COALESCE(SUM(recent.is_valid), 0) AS validPayloadCount,
  COALESCE(SUM(recent.is_completed), 0) AS completedCount,
  COALESCE(SUM(recent.is_rate_limited), 0) AS rateLimitedCount,
  COALESCE(SUM(recent.available_categories), 0) AS availableCategorySum,
  (SELECT candidate.generatedAt FROM SituationMonitorExternalSnapshot candidate
    WHERE candidate.scope = ? AND candidate.variantKey = ? AND candidate.status = 'completed'
    ORDER BY candidate.generatedAt DESC, candidate.createdAt DESC LIMIT 1) AS lastFullSuccessAt,
  (SELECT candidate.generatedAt FROM SituationMonitorExternalSnapshot candidate
    WHERE candidate.scope = ? AND candidate.variantKey = ? AND candidate.status IN ('partial', 'failed')
    ORDER BY candidate.generatedAt DESC, candidate.createdAt DESC LIMIT 1) AS lastNonSuccessAt
FROM (
  SELECT
    base.is_completed,
    base.is_valid,
    CASE
      WHEN base.is_valid = 1
        AND JSON_TYPE(base.warnings_json) = 'ARRAY'
        AND JSON_CONTAINS(base.warnings_json, JSON_OBJECT('code', 'gdelt_rate_limited'))
      THEN 1 ELSE 0
    END AS is_rate_limited,
    CASE WHEN base.is_valid = 1 THEN %s ELSE 0 END AS available_categories
  FROM (
    SELECT
      (status = 'completed') AS is_completed,
      %s AS is_valid,
      payload->'$.warnings' AS warnings_json,
      payload
    FROM SituationMonitorExternalSnapshot
    WHERE scope = ? AND variantKey = ? AND generatedAt >= ?
  ) AS base
) AS recent`, availableCategoriesSQL, payloadIsValidSQL)
