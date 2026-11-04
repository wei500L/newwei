package dataruntimesettings

import (
	"context"
	"errors"
	"net/http"

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
//
// Failure mapping mirrors the NestJS wrapper:
//   - GET_LOCK returning 0 (somebody else holds the lock for the whole timeout)
//     becomes the domain-specific 409 retry contract carrying busyMessage;
//   - a missing pool, a failed connection, a failed GET_LOCK query or a NULL
//     answer becomes errLockUnavailable, which the handler renders as the
//     generic 503.
func (s *Service) withSessionLock(ctx context.Context, lockName, busyMessage string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errLockUnavailable
	}
	err := mysqllock.WithLock(ctx, s.db, lockName, lockWaitSeconds, fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) {
		return &httpError{status: http.StatusConflict, message: busyMessage}
	}
	if errors.Is(err, mysqllock.ErrUnavailable) {
		return errLockUnavailable
	}
	return err
}
