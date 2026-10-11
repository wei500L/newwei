package contentsubscriptions

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
)

var errLockNotAcquired = errors.New("content subscription lock not acquired")

type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

type storedSubscription struct {
	ID              string
	Kind            string
	NormalizedValue string
	DisplayValue    string
	TaxonomyPath    sql.NullString
	TaxonomyVersion sql.NullString
	Source          string
	Metadata        []byte
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type insertSubscription struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
	TaxonomyPath    *string
	TaxonomyVersion string
	Source          string
	Metadata        []byte
}

func (s *Service) withUserLock(ctx context.Context, orgID, userID string, fn func(context.Context, *sql.Conn) error) error {
	if s == nil || s.db == nil {
		return errors.New("content subscription store is not configured")
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	name := subscriptionLockName(orgID, userID)
	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, lockTimeoutSeconds).Scan(&acquired); err != nil {
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

// subscriptionLockName 只由已鉴权的 orgId 与 userId 组成。超过 MySQL
// 64 字符锁名上限时改用 sha256，避免把别的身份拼进锁名。
func subscriptionLockName(orgID, userID string) string {
	raw := "ucs:" + orgID + ":" + userID
	if len([]rune(raw)) <= 64 {
		return raw
	}
	sum := sha256.Sum256([]byte(orgID + "\x00" + userID))
	encoded := hex.EncodeToString(sum[:])
	return "ucs:" + encoded[:60]
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

func (s *Service) readCounts(ctx context.Context, q queryer, orgID, userID string) (counts, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT kind, COUNT(*) FROM UserContentSubscription WHERE orgId = ? AND userId = ? GROUP BY kind",
		orgID, userID,
	)
	if err != nil {
		return counts{}, err
	}
	defer rows.Close()
	out := emptyCounts()
	for rows.Next() {
		var kind string
		var n int
		if err := rows.Scan(&kind, &n); err != nil {
			return counts{}, err
		}
		if n < 0 {
			n = 0
		}
		out.set(kind, n)
	}
	return out, rows.Err()
}

func (s *Service) listSubscriptions(ctx context.Context, q queryer, orgID, userID string) ([]storedSubscription, error) {
	rows, err := q.QueryContext(ctx, `
SELECT id, kind, normalizedValue, displayValue, taxonomyPath, source, metadata, createdAt, updatedAt
FROM UserContentSubscription
WHERE orgId = ? AND userId = ?
ORDER BY taxonomyPath ASC, kind ASC, displayValue ASC`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubscriptions(rows, false)
}

func scanSubscriptions(rows *sql.Rows, withVersion bool) ([]storedSubscription, error) {
	var out []storedSubscription
	for rows.Next() {
		var row storedSubscription
		var metadata []byte
		if withVersion {
			if err := rows.Scan(
				&row.ID, &row.Kind, &row.NormalizedValue, &row.DisplayValue,
				&row.TaxonomyPath, &row.TaxonomyVersion, &row.Source, &metadata,
				&row.CreatedAt, &row.UpdatedAt,
			); err != nil {
				return nil, err
			}
		} else {
			if err := rows.Scan(
				&row.ID, &row.Kind, &row.NormalizedValue, &row.DisplayValue,
				&row.TaxonomyPath, &row.Source, &metadata, &row.CreatedAt, &row.UpdatedAt,
			); err != nil {
				return nil, err
			}
		}
		row.Metadata = metadata
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Service) findSubscriptionsByPairs(ctx context.Context, q queryer, orgID, userID string, entries []normalizedEntry) (map[string]storedSubscription, error) {
	found := map[string]storedSubscription{}
	if len(entries) == 0 {
		return found, nil
	}
	args := make([]any, 0, 2+len(entries)*2)
	args = append(args, orgID, userID)
	var b stringsBuilder
	b.WriteString(`SELECT id, kind, normalizedValue, displayValue, taxonomyPath, taxonomyVersion, source, metadata, createdAt, updatedAt
FROM UserContentSubscription
WHERE orgId = ? AND userId = ? AND (`)
	for i, entry := range entries {
		if i > 0 {
			b.WriteString(" OR ")
		}
		b.WriteString("(kind = ? AND normalizedValue = ?)")
		args = append(args, entry.Kind, entry.NormalizedValue)
	}
	b.WriteString(")")
	rows, err := q.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanned, err := scanSubscriptions(rows, true)
	if err != nil {
		return nil, err
	}
	for _, row := range scanned {
		found[subscriptionKey(row.Kind, row.NormalizedValue)] = row
	}
	return found, nil
}

type stringsBuilder struct {
	buf []byte
}

func (b *stringsBuilder) WriteString(s string) { b.buf = append(b.buf, s...) }
func (b *stringsBuilder) String() string       { return string(b.buf) }

func (s *Service) insertSubscriptions(ctx context.Context, q queryer, orgID, userID string, rows []insertSubscription, at time.Time, ignoreDuplicates bool) error {
	if len(rows) == 0 {
		return nil
	}
	args := make([]any, 0, len(rows)*12)
	var b stringsBuilder
	verb := "INSERT INTO"
	if ignoreDuplicates {
		verb = "INSERT IGNORE INTO"
	}
	b.WriteString(verb + ` UserContentSubscription
(id, orgId, userId, kind, normalizedValue, displayValue, taxonomyPath, taxonomyVersion, source, metadata, createdAt, updatedAt)
VALUES `)
	for i, row := range rows {
		id, err := newRowID()
		if err != nil {
			return err
		}
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?)")
		var taxonomy any
		if row.TaxonomyPath != nil {
			taxonomy = *row.TaxonomyPath
		}
		metadata := row.Metadata
		if len(metadata) == 0 {
			metadata = []byte("{}")
		}
		source := row.Source
		if source == "" {
			source = "manual"
		}
		args = append(args, id, orgID, userID, row.Kind, row.NormalizedValue, row.DisplayValue, taxonomy, emptyAsNull(row.TaxonomyVersion), source, metadata, at, at)
	}
	_, err := q.ExecContext(ctx, b.String(), args...)
	return err
}

func (s *Service) deleteSubscriptionsByIDs(ctx context.Context, q queryer, orgID, userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	args := make([]any, 0, 2+len(ids))
	args = append(args, orgID, userID)
	var b stringsBuilder
	b.WriteString("DELETE FROM UserContentSubscription WHERE orgId = ? AND userId = ? AND id IN (")
	for i, id := range ids {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString("?")
		args = append(args, id)
	}
	b.WriteString(")")
	_, err := q.ExecContext(ctx, b.String(), args...)
	return err
}

func (s *Service) listKindIDs(ctx context.Context, q queryer, orgID, userID, kind string) ([]storedSubscription, error) {
	rows, err := q.QueryContext(ctx, `
SELECT id, kind, normalizedValue, displayValue, taxonomyPath, source, metadata, createdAt, updatedAt
FROM UserContentSubscription
WHERE orgId = ? AND userId = ? AND kind = ?`, orgID, userID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubscriptions(rows, false)
}

func (s *Service) settingExists(ctx context.Context, q queryer, orgID, userID, key string) (bool, error) {
	var id string
	err := q.QueryRowContext(ctx,
		"SELECT id FROM UserSetting WHERE orgId = ? AND userId = ? AND `key` = ? LIMIT 1",
		orgID, userID, key,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) readSetting(ctx context.Context, q queryer, orgID, userID, key string) ([]byte, bool, error) {
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

func (s *Service) upsertSetting(ctx context.Context, q queryer, orgID, userID, key string, value []byte, at time.Time) error {
	id, err := newRowID()
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, "INSERT INTO UserSetting (id, orgId, userId, `key`, value, updatedAt) "+
		"VALUES (?, ?, ?, ?, ?, ?) AS new_row "+
		"ON DUPLICATE KEY UPDATE value = new_row.value, updatedAt = new_row.updatedAt",
		id, orgID, userID, key, value, at,
	)
	return err
}

func (s *Service) subscriptionKeys(ctx context.Context, q queryer, orgID, userID string) ([]struct{ Kind, Normalized string }, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT kind, normalizedValue FROM UserContentSubscription WHERE orgId = ? AND userId = ?",
		orgID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct{ Kind, Normalized string }
	for rows.Next() {
		var item struct{ Kind, Normalized string }
		if err := rows.Scan(&item.Kind, &item.Normalized); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Service) topicValues(ctx context.Context, q queryer, orgID, userID string) ([]string, error) {
	rows, err := q.QueryContext(ctx,
		"SELECT normalizedValue FROM UserContentSubscription WHERE orgId = ? AND userId = ? AND kind = ?",
		orgID, userID, "topic",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, rows.Err()
}

func classifyError(err error) int {
	if err == nil {
		return 0
	}
	if errors.Is(err, errLockNotAcquired) || errors.Is(err, driver.ErrBadConn) || errors.Is(err, context.DeadlineExceeded) {
		return 503
	}
	var mysqlErr *mysqlDriver.MySQLError
	if errors.As(err, &mysqlErr) {
		switch mysqlErr.Number {
		case 1040, 1042, 1043, 1053, 1159, 1160, 1161, 2002, 2003, 2006, 2013:
			return 503
		default:
			return 500
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return 503
	}
	return 500
}

func isDuplicateKey(err error) bool {
	var mysqlErr *mysqlDriver.MySQLError
	return errors.As(err, &mysqlErr) && mysqlErr.Number == 1062
}

func jsonArray(values []string) []byte {
	if values == nil {
		values = []string{}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return []byte("[]")
	}
	return encoded
}

func mustObject(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("{}")
	}
	return encoded
}

func emptyAsNull(value string) any {
	if value == "" {
		return nil
	}
	return value
}
