package dataruntimesettings

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"net/http"
)

// withSessionLock runs fn while holding one global MySQL session lock
// (GET_LOCK(name, 10)) on a dedicated *sql.Conn.
//
// The connection is pinned for the whole read-modify-write sequence, so the lock
// is held across the database commit, the audit write and the cache
// invalidation. Release uses its own short timeout derived from
// context.WithoutCancel: a cancelled client request must not leave the lock
// unreleased, and must not be able to skip the release path either.
//
// A failed RELEASE_LOCK means the physical connection may still hold the lock.
// It is evicted from the pool (returning driver.ErrBadConn from Raw makes
// database/sql close it) instead of being handed to the next caller.
//
// Failure mapping mirrors the NestJS wrapper:
//   - GET_LOCK returning 0 (somebody else holds the lock for the whole timeout)
//     becomes the domain-specific 409 retry contract carrying busyMessage;
//   - a missing pool, a failed connection or a failed GET_LOCK query becomes
//     errLockUnavailable, which the handler renders as the generic 503.
func (s *Service) withSessionLock(ctx context.Context, lockName, busyMessage string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errLockUnavailable
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return errLockUnavailable
	}

	acquired := false
	defer func() {
		if !acquired {
			_ = conn.Close()
			return
		}
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lockReleaseTimeout)
		defer cancel()
		var released sql.NullInt64
		releaseErr := conn.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", lockName).Scan(&released)
		if releaseErr != nil || !released.Valid || released.Int64 != 1 {
			discardSQLConn(conn)
			return
		}
		_ = conn.Close()
	}()

	var acquiredFlag sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", lockName, lockWaitSeconds).Scan(&acquiredFlag); err != nil {
		return errLockUnavailable
	}
	if !acquiredFlag.Valid {
		// MySQL reports NULL for GET_LOCK on an internal error.
		return errLockUnavailable
	}
	if acquiredFlag.Int64 != 1 {
		return &httpError{status: http.StatusConflict, message: busyMessage}
	}
	acquired = true

	return fn(ctx)
}

// discardSQLConn marks a pooled connection unusable so database/sql closes the
// physical session instead of returning a possibly still-locked connection to
// the pool.
func discardSQLConn(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
}
