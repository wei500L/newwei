package realtimesocket

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

const (
	// revalidationQueryTimeout bounds one blacklist/authz lookup of a
	// revalidation tick. It is a safety net only: a MySQL stall must not keep a
	// revalidation goroutine alive after Close.
	revalidationQueryTimeout = 5 * time.Second
	// revalidationCacheMaxEntries bounds the shared per-cycle derivation cache.
	// Pruning starts above this size and only drops entries that were not
	// consulted for two cycles, so normal console traffic never reaches it.
	revalidationCacheMaxEntries = 4096
)

// identityKey is the cache key of one DB identity derivation.
type identityKey struct {
	userID string
	orgID  string
}

// revalidationOutcome is the result of one identity re-derivation. Either
// authorization is set (identity/permissions valid), rejection is set (the DB
// state rejects the identity), or infrastructure error is set (fail open).
type revalidationOutcome struct {
	authorization *authz.Authorization
	rejection     string
	infraError    error
	checkedAt     time.Time
}

// revalidationCache coalesces the per-socket B2 ticks of this process: every
// (userId, orgId) pair is re-derived at most once per revalidation period even
// when the user holds sockets on several namespaces (O3). Concurrent ticks for
// the same identity share one in-flight query.
type revalidationCache struct {
	ttl time.Duration

	mu        sync.Mutex
	entries   map[identityKey]*revalidationCacheEntry
	lastPrune time.Time
}

type revalidationCacheEntry struct {
	// lock serializes the fetch for this identity.
	lock sync.Mutex
	// outcome and valid are guarded by lock.
	outcome revalidationOutcome
	valid   bool
	// lastUsed is guarded by revalidationCache.mu.
	lastUsed time.Time
}

func newRevalidationCache(ttl time.Duration) *revalidationCache {
	return &revalidationCache{
		ttl:     ttl,
		entries: map[identityKey]*revalidationCacheEntry{},
	}
}

// resolve returns the derivation for key, running fetch at most once per ttl.
// Infrastructure failures are cached for the same period too: the contract is
// "at most one query per identity per cycle", and a failing database must not
// turn 30s ticks into a query storm.
func (c *revalidationCache) resolve(ctx context.Context, key identityKey, fetch func(context.Context) revalidationOutcome) revalidationOutcome {
	if c == nil || c.ttl <= 0 {
		outcome := fetch(ctx)
		outcome.checkedAt = time.Now()
		return outcome
	}

	now := time.Now()
	c.mu.Lock()
	entry := c.entries[key]
	if entry == nil {
		entry = &revalidationCacheEntry{}
		c.entries[key] = entry
	}
	entry.lastUsed = now
	c.pruneLocked(now)
	c.mu.Unlock()

	entry.lock.Lock()
	defer entry.lock.Unlock()
	if entry.valid && time.Since(entry.outcome.checkedAt) < c.ttl {
		return entry.outcome
	}
	outcome := fetch(ctx)
	outcome.checkedAt = time.Now()
	entry.outcome = outcome
	entry.valid = true
	return outcome
}

// pruneLocked drops entries unused for two cycles. It must be called with the
// cache mutex held and only reads fields guarded by that mutex.
func (c *revalidationCache) pruneLocked(now time.Time) {
	if len(c.entries) <= revalidationCacheMaxEntries {
		return
	}
	if !c.lastPrune.IsZero() && now.Sub(c.lastPrune) < c.ttl {
		return
	}
	c.lastPrune = now
	cutoff := now.Add(-2 * c.ttl)
	for key, entry := range c.entries {
		if entry.lastUsed.Before(cutoff) {
			delete(c.entries, key)
		}
	}
}

// revalidateLoop ticks the B2 identity revalidation of one namespace socket.
// All five namespaces enable it in this batch (the NestJS quality gateway does
// not, which is a known baseline inconsistency fixed here); a failed check
// disconnects the whole Engine.IO connection silently, exactly like
// attachTokenRevalidation + client.disconnect(true).
func (r *Runtime) revalidateLoop(state *socketState) {
	defer r.revalidateWG.Done()
	if r.revalidateInterval <= 0 {
		return
	}
	ticker := time.NewTicker(r.revalidateInterval)
	defer ticker.Stop()
	for {
		select {
		case <-state.session.Context().Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(state.session.Context(), revalidationQueryTimeout)
			keep := r.keepSession(ctx, state)
			cancel()
			if !keep {
				// Token revalidation disconnects are silent: no <ns>:error event.
				state.session.Disconnect()
				return
			}
		}
	}
}

// keepSession applies one revalidation tick in the NestJS order: expiry first,
// then the access-token blacklist, then the DB membership/permission
// re-derivation. Infrastructure errors fail open (keep the connection); any
// business rejection drops it.
func (r *Runtime) keepSession(ctx context.Context, state *socketState) bool {
	// 1. exp: DateTime.now()/1000 >= exp, evaluated on the verified claim only.
	if !state.expiresAt.IsZero() && !time.Now().Before(state.expiresAt) {
		return false
	}
	// 2. jti: logout must cut the live socket.
	if err := r.auth.ensureNotRevoked(ctx, state.jti); err != nil {
		if _, rejected := authRejection(err); rejected {
			return false
		}
		log.Printf("realtimesocket: revalidation blacklist lookup failed, keeping %s socket: %v", state.spec.namespace, err)
		return true
	}
	// 3. membership/user/org status and permissions re-derived from MySQL via
	// the per-cycle shared cache.
	key := identityKey{userID: state.identity.UserID, orgID: state.identity.OrgID}
	outcome := r.revalidation.resolve(ctx, key, func(fetchCtx context.Context) revalidationOutcome {
		authorization, err := r.auth.authorize(fetchCtx, state.identity.UserID, state.identity.OrgID)
		if err != nil {
			if message, rejected := authRejection(err); rejected {
				return revalidationOutcome{rejection: message}
			}
			return revalidationOutcome{infraError: err}
		}
		return revalidationOutcome{authorization: authorization}
	})
	if outcome.infraError != nil {
		log.Printf("realtimesocket: revalidation authorization lookup failed, keeping %s socket: %v", state.spec.namespace, outcome.infraError)
		return true
	}
	if outcome.rejection != "" {
		return false
	}
	return state.spec.allows(outcome.authorization)
}
