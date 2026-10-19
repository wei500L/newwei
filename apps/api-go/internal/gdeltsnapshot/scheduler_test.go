package gdeltsnapshot

import (
	"context"
	"testing"
	"time"
)

// TestSchedulerTicksOnTheQuarterBoundary runs one real tick. The fake clock
// starts one second before a boundary, so the aligned tick fires quickly; the
// rebuild itself uses the no-op sleep and the stub GDELT server.
func TestSchedulerTicksOnTheQuarterBoundary(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	rig.now = time.Date(2026, 10, 20, 12, 14, 59, 0, time.UTC)

	scheduler := NewScheduler(rig.service)
	scheduler.Start(context.Background())
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := scheduler.Close(closeCtx); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && rig.store.rowCount() == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if rig.stub.requestCount() != 6 {
		t.Fatalf("requests = %d, want the six category requests of one tick", rig.stub.requestCount())
	}
	if got := rig.store.rowCount(); got != 1 {
		t.Fatalf("rows = %d, want 1", got)
	}
}

// TestSchedulerDisabledServiceDoesNotTouchAnything proves a disabled service never
// reaches the lease or GDELT.
func TestSchedulerDisabledServiceDoesNotTouchAnything(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: false, responses: allCategoriesArticles()})
	scheduler := NewScheduler(rig.service)

	// A disabled service returns before the lock, so the tick must not even try.
	scheduler.Start(context.Background())
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := scheduler.Close(closeCtx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if rig.lock.calls != 0 || rig.stub.requestCount() != 0 {
		t.Error("a disabled scheduler touched the lock or GDELT")
	}
}

// TestSchedulerCloseIsIdempotent covers repeated shutdown calls.
func TestSchedulerCloseIsIdempotent(t *testing.T) {
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	scheduler := NewScheduler(rig.service)
	scheduler.Start(context.Background())
	for attempt := 0; attempt < 3; attempt++ {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := scheduler.Close(closeCtx); err != nil {
			t.Fatalf("Close %d: %v", attempt, err)
		}
		cancel()
	}
}
