package infrastructuresettings

import (
	"context"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqllock"
)

// withSessionLock runs fn while holding one global MySQL session lock
// (GET_LOCK(name, lockWaitSeconds)) through the shared mysqllock helper.
//
// The helper pins a dedicated *sql.Conn for the whole read-modify-write
// sequence, so the lock is held across the database commit, the audit write and
// the cache invalidation. It releases on an independent short context so a
// cancelled client request never leaves the lock unreleased, and it evicts the
// physical connection when RELEASE_LOCK does not confirm.
func (s *Service) withSessionLock(ctx context.Context, lockName string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	err := mysqllock.WithLock(ctx, s.db, lockName, lockWaitSeconds, fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) || errors.Is(err, mysqllock.ErrUnavailable) {
		return errLockUnavailable
	}
	return err
}
