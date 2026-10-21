package itempipeline

// O2: per-news-source coalescing of the ops snapshot refresh.
//
// NewsSourceOpsSnapshotService.refreshSnapshotForSource costs six MySQL reads
// plus one upsert and one Redis write, and QueueProcessor calls it at the start,
// success and failure of every item. The Go worker keeps the same data but
// collapses bursts for one source: at most one refresh per window (1s), with a
// trailing refresh guaranteed after the last state change. The snapshot can
// therefore lag at most one window behind the final write, which the ops read
// model already tolerates (the row is derived data, never authoritative for the
// pipeline). Errors are logged and swallowed exactly like the NestJS call.

import (
	"context"
	"log"
	"math/rand"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newssourcescheduler"
)

// SnapshotRefresher refreshes the ops snapshot of one news source.
type SnapshotRefresher interface {
	Refresh(ctx context.Context, orgID, sourceID string) error
}

// schedulerSnapshotRefresher adapts the scheduler service without changing it.
type schedulerSnapshotRefresher struct {
	service *newssourcescheduler.Service
}

// NewSchedulerSnapshotRefresher reuses the scheduler's snapshot writer.
func NewSchedulerSnapshotRefresher(service *newssourcescheduler.Service) SnapshotRefresher {
	return schedulerSnapshotRefresher{service: service}
}

// Refresh implements SnapshotRefresher.
func (r schedulerSnapshotRefresher) Refresh(ctx context.Context, orgID, sourceID string) error {
	if r.service == nil {
		return nil
	}
	return r.service.RefreshSnapshot(ctx, orgID, sourceID)
}

type snapshotKey struct {
	OrgID    string
	SourceID string
}

type snapshotState struct {
	LastRefresh time.Time
	Pending     bool
	Timer       *time.Timer
}

type snapshotCoalescer struct {
	refresher SnapshotRefresher
	window    time.Duration
	now       func() time.Time
	mu        sync.Mutex
	states    map[snapshotKey]*snapshotState
}

func newSnapshotCoalescer(refresher SnapshotRefresher, window time.Duration, now func() time.Time) *snapshotCoalescer {
	if now == nil {
		now = time.Now
	}
	if window <= 0 {
		window = time.Second
	}
	return &snapshotCoalescer{
		refresher: refresher,
		window:    window,
		now:       now,
		states:    make(map[snapshotKey]*snapshotState),
	}
}

// request schedules a refresh for one source. It never blocks the job.
func (c *snapshotCoalescer) request(orgID, sourceID string) {
	if c == nil || c.refresher == nil {
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
		go c.refresh(orgID, sourceID)
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
	c.refresh(key.OrgID, key.SourceID)
}

func (c *snapshotCoalescer) refresh(orgID, sourceID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := c.refresher.Refresh(ctx, orgID, sourceID); err != nil {
		log.Printf("itempipeline: failed to refresh news source ops snapshot orgId=%s sourceId=%s: %v",
			orgID, sourceID, err)
	}
}

// randomFloat64 is Math.random for the jittered backoff.
func randomFloat64() float64 {
	return rand.Float64()
}
