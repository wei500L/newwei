package emailsettings

import (
	"context"
	"database/sql"
	"errors"
)

// DB is the production MySQL access used by the unit. It owns no pool of its
// own: the shared *sql.DB is injected by main.
type DB struct {
	pool *sql.DB
}

// NewDB wraps the shared MySQL pool.
func NewDB(pool *sql.DB) *DB { return &DB{pool: pool} }

// Exec runs one statement.
func (d *DB) Exec(ctx context.Context, query string, args ...any) error {
	if d == nil || d.pool == nil {
		return errors.New("emailsettings: mysql is not configured")
	}
	_, err := d.pool.ExecContext(ctx, query, args...)
	return err
}

// QueryValue reads SystemSetting.value for one key.
func (d *DB) QueryValue(ctx context.Context, key string) ([]byte, bool, error) {
	if d == nil || d.pool == nil {
		return nil, false, errors.New("emailsettings: mysql is not configured")
	}
	var raw []byte
	err := d.pool.QueryRowContext(ctx,
		"SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}
