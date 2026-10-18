package modelaccesssettings

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
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

// lockReleaseTimeout bounds the RELEASE_LOCK round trip. It deliberately does NOT
// derive from the request context: a cancelled request must still release the
// lock instead of leaking it.
const lockReleaseTimeout = 3 * time.Second

// errLockReleaseFailed marks a RELEASE_LOCK that did not confirm.
var errLockReleaseFailed = errors.New("modelaccesssettings: settings lock release failed")

// mysqlLock holds global MySQL session advisory locks on a dedicated session per
// acquisition. It is the lockManager production implementation.
type mysqlLock struct {
	dsn string
}

// WithSessionLock runs fn while holding one global MySQL advisory lock.
//
// Protocol (identical to the NestJS withMysqlSessionLock adapter):
//  1. open a DEDICATED MySQL session for this acquisition, so GET_LOCK and
//     RELEASE_LOCK run on the same connection and the session is destroyed at the
//     end of the call;
//  2. `SELECT GET_LOCK(?, 10)` and require exactly 1 — 0, NULL or an error aborts
//     the request without touching the data (never "write anyway");
//  3. run fn; any error it returns propagates unchanged, so a business 400 or an
//     encryption 400 is never rewritten as a lock outage;
//  4. release with an independent short timeout and, whatever happens, close the
//     dedicated session. Closing the session is what makes the release
//     unconditional: MySQL drops every advisory lock a session holds when the
//     session ends, so a failed RELEASE_LOCK can never leave the lock held.
//
// The lock is held across the configuration write, the audit handling and the
// cache invalidation performed by fn, so a nested transaction (if any) has
// committed before the release.
func (l *mysqlLock) WithSessionLock(ctx context.Context, name string, fn func(context.Context) error) error {
	if l == nil || l.dsn == "" {
		return errNoDatabase
	}
	session, err := usersettings.OpenMySQLFromURL(l.dsn)
	if err != nil {
		log.Printf("modelaccesssettings: settings lock session open failed: %v", err)
		return errLockUnavailable
	}
	// Closing the pool closes the physical session (and therefore releases every
	// advisory lock it still holds). It always runs after fn.
	defer func() {
		if closeErr := session.Close(); closeErr != nil {
			log.Printf("modelaccesssettings: settings lock session close failed: %v", closeErr)
		}
	}()

	var acquired sql.NullInt64
	acquireCtx, acquireCancel := context.WithTimeout(ctx, time.Duration(lockWaitSeconds+5)*time.Second)
	acquireErr := session.QueryRowContext(acquireCtx, "SELECT GET_LOCK(?, ?)", name, lockWaitSeconds).Scan(&acquired)
	acquireCancel()
	if acquireErr != nil || !acquired.Valid || acquired.Int64 != 1 {
		if acquireErr != nil {
			log.Printf("modelaccesssettings: settings lock acquisition failed: %v", acquireErr)
		}
		return errLockUnavailable
	}

	runErr := fn(ctx)

	releaseCtx, releaseCancel := context.WithTimeout(context.Background(), lockReleaseTimeout)
	var released sql.NullInt64
	releaseErr := session.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", name).Scan(&released)
	releaseCancel()
	if releaseErr != nil || !released.Valid || released.Int64 != 1 {
		// The deferred Close still destroys the session, which releases the lock
		// server-side even though RELEASE_LOCK did not confirm.
		log.Printf("modelaccesssettings: %v", errLockReleaseFailed)
	}
	return runErr
}
