package modelaccesssettings

import (
	"context"
	"database/sql"
	"errors"

	"github.com/wei500L/newwei/apps/api-go/internal/platform/mysqllock"
)

// Global MySQL session lock names. They are the exact literals
// apps/api/src/modules/system-settings/model-access-settings.lock.ts uses, so a
// NestJS write and a Go write on the same singleton contend on the same lock.
//
// No orgId/userId suffix is appended: the protected data (SystemSetting.key
// model_service / openai_keys) is itself a global singleton, so every writer must
// serialize on one name. A process-local mutex, a Redis lease or a row-level
// FOR UPDATE would not do: the row may not exist yet (first write) or may be
// deleted by the sibling reset, and other writers live in other processes.
const (
	lockNameModelService  = "model-access:model-service:v1"
	lockNameOpenAiKeys    = "model-access:openai-keys:v1"
	lockNameProxyLBConfig = "model-access:proxy-load-balancing:v1"
)

// lockWaitSeconds is the GET_LOCK timeout. A timeout is never bypassed: the write
// is abandoned and reported as 503.
const lockWaitSeconds = 10

// mysqlLock holds global MySQL session advisory locks on a connection from the
// shared pool through mysqllock. It is the lockManager production implementation.
type mysqlLock struct {
	db *sql.DB
}

// WithSessionLock runs fn while holding one global MySQL advisory lock.
//
// mysqllock pins a dedicated pooled connection for GET_LOCK / RELEASE_LOCK and
// evicts it when the release does not confirm, so a failed release never leaks a
// still-locked session back into the pool. A missing pool, a connection error,
// a GET_LOCK timeout (0) or a NULL answer aborts the write as 503 instead of
// writing anyway. Any error fn returns propagates unchanged, so a business or
// encryption error is never rewritten as a lock outage.
func (l *mysqlLock) WithSessionLock(ctx context.Context, name string, fn func(context.Context) error) error {
	if l == nil || l.db == nil {
		return errNoDatabase
	}
	err := mysqllock.WithLock(ctx, l.db, name, lockWaitSeconds, fn)
	if errors.Is(err, mysqllock.ErrNotAcquired) || errors.Is(err, mysqllock.ErrUnavailable) {
		return errLockUnavailable
	}
	return err
}
