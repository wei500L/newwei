package authfactors

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqllock"
)

// withUserLock runs fn while holding the caller's per-user MySQL session lock
// (`GET_LOCK(name, mfaLockWaitSeconds)`) through the shared mysqllock helper.
//
// The name is derived from the user id alone — never from the organization —
// because a TOTP factor is a global user state shared by every membership. The
// identical name is computed by the NestJS helper `mfaUserLockName`, so a Nest
// writer and a Go writer for the same user serialize against each other.
//
// The helper pins a dedicated *sql.Conn for the whole read-verify-commit-
// invalidate sequence, releases on an independent short context, and evicts the
// physical connection when RELEASE_LOCK does not confirm.
func (s *Service) withUserLock(ctx context.Context, userID string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	err := mysqllock.WithLock(ctx, s.db, mfaUserLockName(userID), mfaLockWaitSeconds, fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) {
		return errLockBusy
	}
	if errors.Is(err, mysqllock.ErrUnavailable) {
		return errLockUnavailable
	}
	return err
}

// mfaUserLockName derives the deterministic per-user lock name: `mfa:` followed
// by the first 60 hex characters of the SHA-256 of the UTF-8 user id, giving
// exactly 64 ASCII characters. The NestJS implementation computes the same
// string.
func mfaUserLockName(userID string) string {
	sum := sha256.Sum256([]byte(userID))
	return mfaUserLockPrefix + hex.EncodeToString(sum[:])[:mfaLockHashHexChars]
}
