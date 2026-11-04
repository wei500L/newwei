// Package mysqllock is the single MySQL GET_LOCK helper shared by the settings
// write domains.
//
// Every call pins one *sql.Conn, runs `SELECT GET_LOCK(name, wait)` on it, runs
// the caller's critical section, then releases with an independent short
// timeout. The pinned connection is the session that owns the advisory lock, so
// a failed RELEASE_LOCK (or a non-1 answer) must not return that connection to
// the pool: it is evicted by returning driver.ErrBadConn from Conn.Raw, which
// makes database/sql close the physical session and drop the lock with it.
//
// The wait seconds and the lock names come from each domain, so the NestJS and
// Go writers keep contending on the identical global name.
package mysqllock

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"time"
)

var (
	// ErrNotAcquired reports that GET_LOCK returned 0: another session held the
	// named lock for the whole wait window. Domains map it to their own
	// contention/retry error.
	ErrNotAcquired = errors.New("mysqllock: lock not acquired")
	// ErrUnavailable reports that the lock could not be attempted: the pool was
	// missing, the pinned connection failed, the GET_LOCK query failed, or MySQL
	// answered NULL on an internal error. Domains map it to their own
	// unavailable/fail-closed error.
	ErrUnavailable = errors.New("mysqllock: lock unavailable")
)

// releaseTimeout bounds the RELEASE_LOCK round trip. It deliberately does not
// derive from the request cancellation: a cancelled request must still release
// the lock instead of leaking it until the session closes.
const releaseTimeout = 5 * time.Second

// WithLock runs fn while holding the named MySQL session lock on a dedicated
// connection from db.
//
// fn receives the request context; any error it returns propagates unchanged, so
// a business error is never rewritten as a lock outage. The lock is held across
// the whole fn, including a nested transaction that uses the same context and
// pool.
func WithLock(ctx context.Context, db *sql.DB, name string, waitSeconds int, fn func(context.Context) error) error {
	if db == nil {
		return ErrUnavailable
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return ErrUnavailable
	}
	acquired := false
	defer func() {
		if !acquired {
			_ = conn.Close()
			return
		}
		if !release(ctx, conn, name) {
			discard(conn)
			return
		}
		_ = conn.Close()
	}()

	// MySQL answers 1 when the lock was taken, 0 when the wait timed out and
	// NULL on error, so the flag is scanned as nullable.
	var flag sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", name, waitSeconds).Scan(&flag); err != nil {
		return ErrUnavailable
	}
	if !flag.Valid {
		return ErrUnavailable
	}
	if flag.Int64 != 1 {
		return ErrNotAcquired
	}
	acquired = true
	return fn(ctx)
}

// release runs RELEASE_LOCK on its own short context derived from ctx values
// (but not its cancellation) and reports whether the server confirmed 1.
func release(ctx context.Context, conn *sql.Conn, name string) bool {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), releaseTimeout)
	defer cancel()
	var released sql.NullInt64
	if err := conn.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", name).Scan(&released); err != nil {
		return false
	}
	return released.Valid && released.Int64 == 1
}

// discard marks the pinned connection unusable so database/sql closes the
// physical session instead of returning a possibly still-locked connection to
// the pool.
func discard(conn *sql.Conn) {
	if conn == nil {
		return
	}
	_ = conn.Raw(func(any) error { return driver.ErrBadConn })
}
