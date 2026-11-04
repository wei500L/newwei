package llmgatewayprofiles

import (
	"context"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqllock"
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

// lockTimeoutSeconds resolves the configured GET_LOCK wait.
func (s *Service) lockTimeoutSeconds() int {
	if s == nil || s.cfg.LockTimeoutSeconds <= 0 {
		return defaultLockTimeoutSeconds
	}
	return s.cfg.LockTimeoutSeconds
}

// withProfilesLock runs fn while holding ProfilesLockName through the shared
// mysqllock helper on the main pool.
//
// mysqllock pins one dedicated pooled connection and evicts it when
// RELEASE_LOCK does not confirm, so a failed release never leaks a still-locked
// session back into the pool; the separate MaxIdleConns(0) pool this package
// used to open is no longer needed. A failed acquisition returns
// errLockUnavailable before fn runs, and request cancellation still triggers the
// release attempt.
func (s *Service) withProfilesLock(ctx context.Context, fn func(context.Context) error) error {
	if s == nil {
		return errNoDatabase
	}
	if s.lockFn != nil {
		return s.lockFn(ctx, fn)
	}
	if s.db == nil {
		return errNoDatabase
	}
	err := mysqllock.WithLock(ctx, s.db, ProfilesLockName, s.lockTimeoutSeconds(), fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) {
		return errLockUnavailable
	}
	return err
}
