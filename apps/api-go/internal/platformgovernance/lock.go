package platformgovernance

import (
	"context"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqllock"
)

// errLockNotAcquired reports that GET_LOCK returned 0 within the wait window,
// which maps to the 409 the NestJS SituationMonitorLockError path produces.
var errLockNotAcquired = errors.New("platformgovernance: settings lock not acquired")

// withSettingsLock runs fn while holding the named MySQL session lock through
// the shared mysqllock helper.
//
// The helper pins a dedicated connection, releases on an independent short
// timeout and evicts the physical connection when RELEASE_LOCK does not confirm.
// Previously this package returned the connection to the pool after a failed
// release, which leaked the session lock to the next request; the eviction is
// the fix.
//
// The lock is a session lock, so it must NOT be taken inside a transaction and
// must not be acquired twice in one request (the second acquisition would wait
// on the first until GET_LOCK times out).
func (s *Service) withSettingsLock(ctx context.Context, name string, fn func(context.Context) error) error {
	if s == nil || s.db == nil {
		return errNoDatabase
	}
	err := mysqllock.WithLock(ctx, s.db, name, llmLogSettingsLockWaitSeconds, fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) {
		return errLockNotAcquired
	}
	return err
}
