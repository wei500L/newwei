package authfactors

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
)

// withUserLock runs fn while holding the caller's per-user MySQL session lock
// (`GET_LOCK(name, 10)`) on one dedicated *sql.Conn.
//
// The name is derived from the user id alone — never from the organization —
// because a TOTP factor is a global user state shared by every membership. The
// identical name is computed by the NestJS helper `mfaUserLockName`, so a Nest
// writer and a Go writer for the same user serialize against each other.
//
// The connection is pinned for the whole read-verify-commit-invalidate
// sequence, so the lock is held across the database commit and the profile
// cache invalidation. Release uses its own short timeout derived from
// context.WithoutCancel: a cancelled client request must not leave the lock
// unreleased, and must not be able to skip the release path either.
//
// A failed RELEASE_LOCK means the physical connection may still hold the lock.
// It is evicted from the pool (returning driver.ErrBadConn from Raw makes
// database/sql close it) instead of being handed to the next caller.
func (s *Service) withUserLock(ctx context.Context, userID string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return errLockUnavailable
	}
	name := mfaUserLockName(userID)

	acquired := false
	defer func() {
		if !acquired {
			_ = conn.Close()
			return
		}
		releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), mfaLockReleaseTimeout)
		defer cancel()
		var released sql.NullInt64
		releaseErr := conn.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", name).Scan(&released)
		if releaseErr != nil || !released.Valid || released.Int64 != 1 {
			discardSQLConn(conn)
			return
		}
		_ = conn.Close()
	}()

	// MySQL answers 1 when the lock was taken, 0 when the wait timed out and
	// NULL on error, so the flag is scanned as nullable.
	var acquiredFlag sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, mfaLockWaitSeconds).Scan(&acquiredFlag); err != nil {
		return errLockUnavailable
	}
	if !acquiredFlag.Valid {
		return errLockUnavailable
	}
	if acquiredFlag.Int64 != 1 {
		return errLockBusy
	}
	acquired = true

	return fn(ctx)
}

// mfaUserLockName derives the deterministic per-user lock name: `mfa:` followed
// by the first 60 hex characters of the SHA-256 of the UTF-8 user id, giving
// exactly 64 ASCII characters. The NestJS implementation computes the same
// string.
func mfaUserLockName(userID string) string {
	sum := sha256.Sum256([]byte(userID))
	return mfaUserLockPrefix + hex.EncodeToString(sum[:])[:mfaLockHashHexChars]
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
