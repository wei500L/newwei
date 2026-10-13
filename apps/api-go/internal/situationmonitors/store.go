package situationmonitors

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/contentsubscriptions"
)

type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func (s *Service) withUserLock(ctx context.Context, orgID, userID string, fn func(context.Context, *sql.Conn) error) error {
	if s == nil || s.db == nil {
		return errors.New("situation monitor store is not configured")
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	name := contentsubscriptions.UserLockName(orgID, userID)
	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, contentsubscriptions.UserLockTimeoutSeconds()).Scan(&acquired); err != nil {
		return err
	}
	if !acquired.Valid || acquired.Int64 != 1 {
		return errLockNotAcquired
	}
	defer releaseLock(conn, name)
	return fn(ctx, conn)
}

func releaseLock(conn *sql.Conn, name string) {
	relCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(relCtx, "SELECT RELEASE_LOCK(?)", name)
}

func newRowID() (string, error) {
	var buf [12]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buf[:]), nil
}

func nowMillis() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

func (s *Service) countMonitors(ctx context.Context, q queryer, orgID, userID string) (int, error) {
	var count int
	err := q.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM SituationMonitorMonitor WHERE orgId = ? AND userId = ?",
		orgID, userID,
	).Scan(&count)
	return count, err
}

func (s *Service) countManual(ctx context.Context, q queryer, orgID, userID string) (int, error) {
	var count int
	err := q.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM SituationMonitorMonitor WHERE orgId = ? AND userId = ? AND kind = 'manual'",
		orgID, userID,
	).Scan(&count)
	return count, err
}

func (s *Service) listRows(ctx context.Context, q queryer, orgID, userID string) ([]monitorRow, error) {
	rows, err := q.QueryContext(ctx, monitorSelect+`
WHERE orgId = ? AND userId = ?
ORDER BY kind ASC, createdAt DESC`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMonitors(rows)
}

func (s *Service) findRow(ctx context.Context, q queryer, orgID, userID, id string) (*monitorRow, error) {
	rows, err := q.QueryContext(ctx, monitorSelect+`
WHERE orgId = ? AND userId = ? AND id = ?
LIMIT 1`, orgID, userID, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned, err := scanMonitors(rows)
	if err != nil {
		return nil, err
	}
	if len(scanned) == 0 {
		return nil, nil
	}
	row := scanned[0]
	return &row, nil
}

const monitorSelect = `
SELECT id, kind, name, enabled, color,
  rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexicalTerms, rejectedSuggestions,
  locationName, locationLat, locationLng, locationBounds, locationCountryCode,
  queryEmbeddingModel, queryEmbeddingVector, lastResolvedAt, createdAt, updatedAt
FROM SituationMonitorMonitor
`

func scanMonitors(rows *sql.Rows) ([]monitorRow, error) {
	out := make([]monitorRow, 0)
	for rows.Next() {
		var row monitorRow
		if err := rows.Scan(
			&row.ID, &row.Kind, &row.Name, &row.Enabled, &row.Color,
			&row.RawKeywords, &row.ApprovedTopics, &row.ApprovedEntities, &row.ApprovedSources, &row.ApprovedGeos, &row.ApprovedLexical, &row.Rejected,
			&row.LocationName, &row.LocationLat, &row.LocationLng, &row.LocationBounds, &row.LocationCountry,
			&row.EmbeddingModel, &row.EmbeddingVector, &row.LastResolved, &row.CreatedAt, &row.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

type persistedMonitor struct {
	Name             string
	Enabled          bool
	Color            sql.NullString
	RawKeywords      []byte
	ApprovedTopics   []byte
	ApprovedEntities []byte
	ApprovedSources  []byte
	ApprovedGeos     []byte
	ApprovedLexical  []byte
	Rejected         []byte
	LocationName     any
	LocationLat      any
	LocationLng      any
	LocationBounds   any
	LocationCountry  any
	EmbedModel       any
	EmbedVector      any
	LastResolved     time.Time
}

func (s *Service) insertMonitor(ctx context.Context, q queryer, orgID, userID, kind string, row persistedMonitor, createdAt time.Time) (monitorRow, error) {
	id, err := newRowID()
	if err != nil {
		return monitorRow{}, err
	}
	now := row.LastResolved
	_, err = q.ExecContext(ctx, `
INSERT INTO SituationMonitorMonitor (
  id, orgId, userId, kind, name, enabled, color,
  rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexicalTerms, rejectedSuggestions,
  locationName, locationLat, locationLng, locationBounds, locationCountryCode,
  queryEmbeddingModel, queryEmbeddingVector, lastResolvedAt, createdAt, updatedAt
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, orgID, userID, kind, row.Name, row.Enabled, row.Color,
		row.RawKeywords, row.ApprovedTopics, row.ApprovedEntities, row.ApprovedSources, row.ApprovedGeos, row.ApprovedLexical, row.Rejected,
		row.LocationName, row.LocationLat, row.LocationLng, row.LocationBounds, row.LocationCountry,
		row.EmbedModel, row.EmbedVector, now, createdAt, now,
	)
	if err != nil {
		return monitorRow{}, err
	}
	found, err := s.findRow(ctx, q, orgID, userID, id)
	if err != nil {
		return monitorRow{}, err
	}
	if found == nil {
		return monitorRow{}, errMonitorMissing
	}
	return *found, nil
}

func (s *Service) updateMonitor(ctx context.Context, q queryer, orgID, userID, id string, row persistedMonitor) (monitorRow, error) {
	now := row.LastResolved
	result, err := q.ExecContext(ctx, `
UPDATE SituationMonitorMonitor SET
  name = ?, enabled = ?, color = ?,
  rawKeywords = ?, approvedTopics = ?, approvedEntities = ?, approvedSources = ?, approvedGeos = ?, approvedLexicalTerms = ?,
  rejectedSuggestions = ?,
  locationName = ?, locationLat = ?, locationLng = ?, locationBounds = ?, locationCountryCode = ?,
  queryEmbeddingModel = ?, queryEmbeddingVector = ?, lastResolvedAt = ?, updatedAt = ?
WHERE id = ? AND orgId = ? AND userId = ?`,
		row.Name, row.Enabled, row.Color,
		row.RawKeywords, row.ApprovedTopics, row.ApprovedEntities, row.ApprovedSources, row.ApprovedGeos, row.ApprovedLexical,
		row.Rejected,
		row.LocationName, row.LocationLat, row.LocationLng, row.LocationBounds, row.LocationCountry,
		row.EmbedModel, row.EmbedVector, now, now,
		id, orgID, userID,
	)
	if err != nil {
		return monitorRow{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return monitorRow{}, err
	}
	if affected == 0 {
		return monitorRow{}, errMonitorMissing
	}
	found, err := s.findRow(ctx, q, orgID, userID, id)
	if err != nil {
		return monitorRow{}, err
	}
	if found == nil {
		return monitorRow{}, errMonitorMissing
	}
	return *found, nil
}

func (s *Service) deleteMonitor(ctx context.Context, q queryer, orgID, userID, id string) error {
	_, err := q.ExecContext(ctx,
		"DELETE FROM SituationMonitorMonitor WHERE id = ? AND orgId = ? AND userId = ?",
		id, orgID, userID,
	)
	return err
}

func readSetting(ctx context.Context, q queryer, orgID, userID, key string) ([]byte, bool, error) {
	var value []byte
	err := q.QueryRowContext(ctx,
		"SELECT value FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` = ? LIMIT 1",
		orgID, userID, key,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}
