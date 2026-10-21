package crawlexecution

// O2: per-(org, source) coalescing of the Redis queue-count runtime state.
//
// syncSourceQueueCounts is CrawlExecutionResultsService.syncSourceQueueCounts ->
// NewsSourceOpsSnapshotService.syncQueueCounts: one grouped CrawlTask count plus
// one Redis runtime-state write holding crawlTaskQueuedCount and
// crawlTaskRunningCount (news-source-ops-snapshot.service.ts:180-207). It is
// called at crawl start, success and failure, and concurrent tasks of one source
// can call it dozens of times per second, so the request is coalesced: at most
// one refresh per window, with a trailing refresh guaranteed after the last
// state change. The two counts are derived data, so they can lag at most one
// window behind the last write; failures are logged and swallowed and never fail
// a crawl.
//
// The refresh body is the Redis write only. The MySQL NewsSourceOpsSnapshot row
// belongs to refreshSnapshotForSource, which only the NestJS QueueProcessor (and
// therefore the #130 item pipeline path) calls; the crawl path never writes it.

import (
	"context"
	"log"
	"sync"
	"time"
)

// snapshotCoalesceWindow is the per-source coalescing window (1s).
const snapshotCoalesceWindow = time.Second

// snapshotRefreshTimeout bounds one coalesced refresh.
const snapshotRefreshTimeout = 10 * time.Second

// snapshotRefresher refreshes the derived ops data of one news source.
type snapshotRefresher interface {
	Refresh(ctx context.Context, orgID, sourceID string) error
}

// snapshotRefresherFunc adapts a function to snapshotRefresher.
type snapshotRefresherFunc func(ctx context.Context, orgID, sourceID string) error

// Refresh implements snapshotRefresher.
func (f snapshotRefresherFunc) Refresh(ctx context.Context, orgID, sourceID string) error {
	if f == nil {
		return nil
	}
	return f(ctx, orgID, sourceID)
}

// snapshotKey identifies one coalescing slot.
type snapshotKey struct {
	OrgID    string
	SourceID string
}

// snapshotState is one slot's bookkeeping.
type snapshotState struct {
	LastRefresh time.Time
	Pending     bool
	Timer       *time.Timer
}

// snapshotCoalescer collapses refresh requests per source. It owns no context:
// trailing refreshes run detached from the crawl that requested them.
type snapshotCoalescer struct {
	refresher snapshotRefresher
	window    time.Duration
	now       func() time.Time
	mu        sync.Mutex
	states    map[snapshotKey]*snapshotState
}

// newSnapshotCoalescer builds a coalescer; a non-positive window falls back to
// one second.
func newSnapshotCoalescer(refresher snapshotRefresher, window time.Duration, now func() time.Time) *snapshotCoalescer {
	if now == nil {
		now = time.Now
	}
	if window <= 0 {
		window = snapshotCoalesceWindow
	}
	return &snapshotCoalescer{
		refresher: refresher,
		window:    window,
		now:       now,
		states:    make(map[snapshotKey]*snapshotState),
	}
}

// request schedules a refresh for one source. It never blocks the crawl: the
// first request inside an idle window refreshes immediately in the background,
// every later request inside the same window is folded into one trailing
// refresh when the window closes.
func (c *snapshotCoalescer) request(orgID, sourceID string) {
	if c == nil || c.refresher == nil || orgID == "" || sourceID == "" {
		return
	}
	key := snapshotKey{OrgID: orgID, SourceID: sourceID}
	c.mu.Lock()
	state := c.states[key]
	if state == nil {
		state = &snapshotState{}
		c.states[key] = state
	}
	now := c.now()
	if state.LastRefresh.IsZero() || now.Sub(state.LastRefresh) >= c.window {
		state.LastRefresh = now
		c.mu.Unlock()
		go c.refreshDetached(orgID, sourceID)
		return
	}
	state.Pending = true
	if state.Timer == nil {
		delay := c.window - now.Sub(state.LastRefresh)
		if delay < 0 {
			delay = 0
		}
		state.Timer = time.AfterFunc(delay, func() {
			c.trailing(key)
		})
	}
	c.mu.Unlock()
}

// trailing runs the deferred refresh that covers every request observed inside
// the window.
func (c *snapshotCoalescer) trailing(key snapshotKey) {
	c.mu.Lock()
	state := c.states[key]
	if state == nil {
		c.mu.Unlock()
		return
	}
	state.Timer = nil
	if !state.Pending {
		c.mu.Unlock()
		return
	}
	state.Pending = false
	state.LastRefresh = c.now()
	c.mu.Unlock()
	c.refreshDetached(key.OrgID, key.SourceID)
}

// refreshDetached runs one refresh with its own deadline so a cancelled crawl
// context cannot skip the trailing refresh.
func (c *snapshotCoalescer) refreshDetached(orgID, sourceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), snapshotRefreshTimeout)
	defer cancel()
	c.refresh(ctx, orgID, sourceID)
}

// refresh runs one refresh and logs a failure.
func (c *snapshotCoalescer) refresh(ctx context.Context, orgID, sourceID string) {
	if c == nil || c.refresher == nil {
		return
	}
	if err := c.refresher.Refresh(ctx, orgID, sourceID); err != nil {
		log.Printf("crawlexecution: failed to refresh news source ops snapshot orgId=%s sourceId=%s: %v",
			orgID, sourceID, err)
	}
}

// flush stops every pending timer and runs the deferred refreshes synchronously
// with the caller's context. It is the worker shutdown hook: after it returns no
// coalesced refresh is still pending.
func (c *snapshotCoalescer) flush(ctx context.Context) {
	if c == nil || c.refresher == nil {
		return
	}
	type pendingRefresh struct {
		OrgID    string
		SourceID string
	}
	pending := make([]pendingRefresh, 0, len(c.states))
	c.mu.Lock()
	for key, state := range c.states {
		if state.Timer != nil {
			state.Timer.Stop()
			state.Timer = nil
		}
		if !state.Pending {
			continue
		}
		state.Pending = false
		state.LastRefresh = c.now()
		pending = append(pending, pendingRefresh{OrgID: key.OrgID, SourceID: key.SourceID})
	}
	c.mu.Unlock()
	for _, entry := range pending {
		c.refresh(ctx, entry.OrgID, entry.SourceID)
	}
}

// FlushSnapshots runs every pending coalesced ops snapshot refresh. The crawl
// worker calls it during shutdown (crawlexecution has no Close of its own) so
// the last queue-count/ops-snapshot change is never dropped.
func (s *Service) FlushSnapshots(ctx context.Context) {
	if s == nil || s.snapshots == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.snapshots.flush(ctx)
}

// refreshSourceQueueCounts is the coalesced refresh body: the NestJS
// syncQueueCounts runtime-state write, field for field (crawlTaskQueuedCount,
// crawlTaskRunningCount, everything else preserved). It never touches the MySQL
// ops snapshot. A failure is returned so the coalescer can log it; the crawl
// never fails because of it.
func (s *Service) refreshSourceQueueCounts(ctx context.Context, orgID, sourceID string) error {
	if s.db == nil || s.redis == nil {
		return nil
	}
	return s.writeSourceQueueCounts(ctx, orgID, sourceID)
}
