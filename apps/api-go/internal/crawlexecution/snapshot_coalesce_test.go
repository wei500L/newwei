package crawlexecution

// O2: the per-source coalescer must refresh on the first change, collapse the
// bursts inside the window, always refresh once after the last change and flush
// everything on shutdown.

import (
	"context"
	"sync"
	"testing"
	"time"
)

// recordingRefresher counts the coalesced refreshes.
type recordingRefresher struct {
	mu    sync.Mutex
	calls []string
}

func (r *recordingRefresher) Refresh(_ context.Context, orgID, sourceID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, orgID+"/"+sourceID)
	return nil
}

func (r *recordingRefresher) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

// snapshot copies the recorded calls under the lock.
func (r *recordingRefresher) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

// waitFor polls until the predicate holds or the deadline expires.
func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not reached before the deadline")
}

func TestSnapshotCoalescerRefreshesImmediatelyThenTrailing(t *testing.T) {
	refresher := &recordingRefresher{}
	coalescer := newSnapshotCoalescer(refresher, 30*time.Millisecond, nil)

	coalescer.request("org-1", "source-1")
	waitFor(t, func() bool { return refresher.count() == 1 })

	// Three changes inside the window collapse into one trailing refresh.
	coalescer.request("org-1", "source-1")
	coalescer.request("org-1", "source-1")
	coalescer.request("org-1", "source-1")
	waitFor(t, func() bool { return refresher.count() == 2 })

	// The trailing refresh happened after the last change and nothing else is
	// scheduled afterwards.
	time.Sleep(80 * time.Millisecond)
	if got := refresher.count(); got != 2 {
		t.Fatalf("refreshes = %d, want 2", got)
	}
}

func TestSnapshotCoalescerRefreshesEachSourceIndependently(t *testing.T) {
	refresher := &recordingRefresher{}
	coalescer := newSnapshotCoalescer(refresher, 30*time.Millisecond, nil)
	coalescer.request("org-1", "source-1")
	coalescer.request("org-1", "source-2")
	coalescer.request("org-2", "source-1")
	waitFor(t, func() bool { return refresher.count() == 3 })
}

func TestSnapshotCoalescerFlushRunsPendingRefreshes(t *testing.T) {
	refresher := &recordingRefresher{}
	coalescer := newSnapshotCoalescer(refresher, 200*time.Millisecond, nil)

	coalescer.request("org-1", "source-1")
	waitFor(t, func() bool { return refresher.count() == 1 })
	coalescer.request("org-1", "source-1")
	coalescer.request("org-1", "source-2")

	coalescer.flush(context.Background())
	if got := refresher.count(); got != 3 {
		t.Fatalf("refreshes after flush = %d, want 3", got)
	}
	// The pending timers were stopped, so nothing fires later.
	time.Sleep(300 * time.Millisecond)
	if got := refresher.count(); got != 3 {
		t.Fatalf("refreshes after the window = %d, want 3", got)
	}
}

func TestServiceSyncSourceQueueCountsFeedsTheCoalescer(t *testing.T) {
	service := New(Options{Now: fixedNow})
	// The refresh body itself needs MySQL and Redis; the coalescer wiring is
	// independent of them, so the test replaces it with a recorder.
	refresher := &recordingRefresher{}
	service.snapshots = newSnapshotCoalescer(refresher, 200*time.Millisecond, fixedNow)

	sourceID := "source-1"
	service.syncSourceQueueCounts(context.Background(), "org-1", &sourceID)
	waitFor(t, func() bool { return refresher.count() == 1 })

	// A second change is pending and must be flushed on shutdown.
	service.syncSourceQueueCounts(context.Background(), "org-1", &sourceID)
	service.FlushSnapshots(context.Background())
	if got := refresher.count(); got != 2 {
		t.Fatalf("refreshes = %d, want 2", got)
	}
	if calls := refresher.snapshot(); len(calls) != 2 || calls[0] != "org-1/source-1" {
		t.Fatalf("refreshes = %#v", calls)
	}
}

func TestSyncSourceQueueCountsWithoutSourceIsNoOp(t *testing.T) {
	service := New(Options{Now: fixedNow})
	refresher := &recordingRefresher{}
	service.snapshots = newSnapshotCoalescer(refresher, 50*time.Millisecond, fixedNow)
	service.syncSourceQueueCounts(context.Background(), "org-1", nil)
	empty := ""
	service.syncSourceQueueCounts(context.Background(), "org-1", &empty)
	time.Sleep(20 * time.Millisecond)
	if refresher.count() != 0 {
		t.Fatalf("refreshes = %#v", refresher.snapshot())
	}
}

func TestRefreshSourceQueueCountsSkipsWithoutHandles(t *testing.T) {
	// The refresh body is the Redis runtime-state write; without MySQL/Redis it is
	// a no-op and never an error.
	service := New(Options{Now: fixedNow})
	if err := service.refreshSourceQueueCounts(context.Background(), "org-1", "source-1"); err != nil {
		t.Fatalf("refresh error = %v", err)
	}
}

func TestSnapshotCoalescerUsesInjectedClockForTheWindow(t *testing.T) {
	refresher := &recordingRefresher{}
	current := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	coalescer := newSnapshotCoalescer(refresher, time.Second, func() time.Time { return current })

	coalescer.request("org-1", "source-1")
	waitFor(t, func() bool { return refresher.count() == 1 })

	// Inside the window a second change is deferred.
	coalescer.request("org-1", "source-1")
	time.Sleep(20 * time.Millisecond)
	if got := refresher.count(); got != 1 {
		t.Fatalf("refreshes inside the window = %d, want 1", got)
	}

	// Once the injected clock passes the window the next change refreshes
	// immediately.
	current = current.Add(2 * time.Second)
	coalescer.request("org-1", "source-1")
	waitFor(t, func() bool { return refresher.count() == 2 })

	// Flushing must not duplicate anything: the deferred change is covered by the
	// immediate refresh above.
	coalescer.flush(context.Background())
	if got := refresher.count(); got != 2 {
		t.Fatalf("refreshes after flush = %d, want 2", got)
	}
}
