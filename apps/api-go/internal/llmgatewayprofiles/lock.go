package llmgatewayprofiles

import (
	"context"
	"database/sql"
	"log"
	"time"
)

// ProfilesLockName is the global MySQL session lock that serialises every LLM
// gateway profile write. The name is shared with NestJS
// (apps/api/src/modules/system-settings/llm-gateway-profiles.lock.ts) so writers
// on both sides exclude each other during the strangler rollout. It carries no
// orgId/userId because the underlying document is one global row.
const ProfilesLockName = "llm-gateway:profiles:write:v1"

// defaultLockTimeoutSeconds is the GET_LOCK wait, identical to the NestJS
// helper's LOCK_TIMEOUT_SECONDS.
const defaultLockTimeoutSeconds = 10

// lockReleaseTimeout bounds the RELEASE_LOCK attempt that runs after the request
// context is gone: the lock must still be released when the client disconnects.
const lockReleaseTimeout = 5 * time.Second

// lockTimeoutSeconds resolves the configured GET_LOCK wait.
func (s *Service) lockTimeoutSeconds() int {
	if s == nil || s.cfg.LockTimeoutSeconds <= 0 {
		return defaultLockTimeoutSeconds
	}
	return s.cfg.LockTimeoutSeconds
}

// withProfilesLock runs fn while holding ProfilesLockName.
//
// The connection comes from the dedicated lock pool, which retains no idle
// connections: closing the connection always closes the physical session, so a
// failed RELEASE_LOCK evicts the connection (and with it the session lock)
// instead of returning a possibly-still-locked connection to a pool.
//
// The lock is never bypassed: a failed acquisition returns errLockUnavailable
// before fn runs, and request cancellation still triggers the release attempt.
func (s *Service) withProfilesLock(ctx context.Context, fn func(context.Context) error) error {
	if s == nil {
		return errNoDatabase
	}
	if s.lockFn != nil {
		return s.lockFn(ctx, fn)
	}
	if s.lockDB == nil {
		return errNoDatabase
	}
	conn, err := s.lockDB.Conn(ctx)
	if err != nil {
		return err
	}
	acquired, err := acquireProfilesLock(ctx, conn, s.lockTimeoutSeconds())
	if err != nil {
		_ = conn.Close()
		return err
	}
	if !acquired {
		// The pool never retains idle connections, so this closes the physical
		// session as well.
		_ = conn.Close()
		return errLockUnavailable
	}

	runErr := fn(ctx)

	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), lockReleaseTimeout)
	defer cancel()
	if _, err := conn.ExecContext(releaseCtx, "SELECT RELEASE_LOCK(?)", ProfilesLockName); err != nil {
		log.Printf("llmgatewayprofiles: RELEASE_LOCK failed for %q; evicting the lock connection", ProfilesLockName)
	}
	if err := conn.Close(); err != nil {
		log.Printf("llmgatewayprofiles: closing the lock connection failed: %v", err)
	}
	return runErr
}

// acquireProfilesLock issues GET_LOCK and reports whether the lock was granted.
func acquireProfilesLock(ctx context.Context, conn *sql.Conn, timeoutSeconds int) (bool, error) {
	var acquired sql.NullInt64
	if err := conn.QueryRowContext(ctx, "SELECT GET_LOCK(?, ?)", ProfilesLockName, timeoutSeconds).Scan(&acquired); err != nil {
		return false, err
	}
	return acquired.Valid && acquired.Int64 == 1, nil
}
