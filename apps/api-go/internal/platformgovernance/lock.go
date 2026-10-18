package platformgovernance

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// errLockNotAcquired reports that GET_LOCK returned something other than 1
// within the wait window (0 = timeout, NULL = error), which maps to the 409 the
// NestJS SituationMonitorLockError path produces.
var errLockNotAcquired = errors.New("platformgovernance: settings lock not acquired")

// withSettingsLock runs fn while holding the named MySQL session lock on a
// dedicated connection, mirroring apps/api withMysqlSessionLock:
//
//	SELECT GET_LOCK(name, 10) -- must return 1
//	... fn ...
//	SELECT RELEASE_LOCK(name) -- independent 2s context, best effort
//
// The lock is a session lock, so it must NOT be taken inside a Prisma/Go
// transaction and must not be acquired twice in one request (the second
// acquisition would wait on the first until GET_LOCK times out).
func (s *Service) withSettingsLock(ctx context.Context, name string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		_ = conn.Close()
	}()

	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, llmLogSettingsLockWaitSeconds).Scan(&acquired); err != nil {
		return err
	}
	if !acquired.Valid || acquired.Int64 != 1 {
		return errLockNotAcquired
	}
	defer releaseSettingsLock(conn, name)

	return fn(ctx)
}

// releaseSettingsLock releases the session lock on its own short context so a
// cancelled request context cannot leave the lock held until the connection
// closes.
func releaseSettingsLock(conn *sql.Conn, name string) {
	releaseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = conn.ExecContext(releaseCtx, "SELECT RELEASE_LOCK(?)", name)
}
