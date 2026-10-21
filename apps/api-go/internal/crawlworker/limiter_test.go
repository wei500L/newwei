package crawlworker

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// waitUntil polls the condition until it holds or the deadline expires. The
// limiter tests assert ordering between goroutines, so they need to know a
// waiter is queued before the next step; polling the limiter state is the
// deterministic form of that check.
func waitUntil(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

// limiterQueueLengths reports the queued waiters per class.
func limiterQueueLengths(limiter *concurrencyLimiter) (hot, normal int) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	return len(limiter.hot), len(limiter.normal)
}

func TestLimiterServesHotWaitersFirst(t *testing.T) {
	limiter := newConcurrencyLimiter(1)
	ctx := context.Background()
	holder, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal)
	if err != nil {
		t.Fatalf("acquire the holder slot: %v", err)
	}

	acquired := make(chan string, 2)
	releaseHot := make(chan struct{})
	var group sync.WaitGroup
	group.Add(2)
	go func() {
		defer group.Done()
		slot, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal)
		if err != nil {
			acquired <- "normal-error"
			return
		}
		defer slot()
		acquired <- "normal"
	}()
	waitUntil(t, "the normal waiter", func() bool {
		_, normal := limiterQueueLengths(limiter)
		return normal == 1
	})
	go func() {
		defer group.Done()
		slot, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot)
		if err != nil {
			acquired <- "hot-error"
			return
		}
		defer slot()
		acquired <- "hot"
		// Hold the slot until the test releases it, so the normal waiter cannot
		// observe a free slot in between.
		<-releaseHot
	}()
	waitUntil(t, "the hot waiter", func() bool {
		hot, _ := limiterQueueLengths(limiter)
		return hot == 1
	})

	holder()
	select {
	case got := <-acquired:
		if got != "hot" {
			t.Fatalf("first slot went to %q, want hot", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no waiter acquired the released slot")
	}
	// The normal waiter stays queued while the hot attempt holds the slot.
	select {
	case got := <-acquired:
		t.Fatalf("normal waiter acquired a runnable slot before the hot attempt finished: %q", got)
	case <-time.After(50 * time.Millisecond):
	}
	hotQueued, normalQueued := limiterQueueLengths(limiter)
	if hotQueued != 0 || normalQueued != 1 {
		t.Fatalf("queued waiters = hot %d / normal %d, want 0/1", hotQueued, normalQueued)
	}
	close(releaseHot)
	select {
	case got := <-acquired:
		if got != "normal" {
			t.Fatalf("second slot went to %q, want normal", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the normal waiter never acquired the released slot")
	}
	group.Wait()
}

func TestLimiterCapacityGrowthDrainsHotBeforeNormal(t *testing.T) {
	limiter := newConcurrencyLimiter(1)
	ctx := context.Background()
	holder, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal)
	if err != nil {
		t.Fatalf("acquire the holder slot: %v", err)
	}

	acquired := make(chan string, 2)
	release := make(chan struct{})
	go func() {
		if slot, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal); err == nil {
			defer slot()
			acquired <- "normal"
			<-release
		}
	}()
	waitUntil(t, "the normal waiter", func() bool {
		_, normal := limiterQueueLengths(limiter)
		return normal == 1
	})
	go func() {
		if slot, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot); err == nil {
			defer slot()
			acquired <- "hot"
			<-release
		}
	}()
	waitUntil(t, "the hot waiter", func() bool {
		hot, _ := limiterQueueLengths(limiter)
		return hot == 1
	})

	// Growing the capacity by one drains the hot waiter only: the growing slot is
	// reserved for the hot class even though the normal waiter has been queued
	// longer.
	limiter.setCapacity(2)
	waitUntil(t, "the hot waiter to take the new slot", func() bool {
		hot, normal := limiterQueueLengths(limiter)
		_, active := limiter.stats()
		return hot == 0 && normal == 1 && active == 2
	})
	if first := <-acquired; first != "hot" {
		t.Fatalf("first drained waiter = %q, want hot", first)
	}

	// Releasing the holder frees the slot the normal waiter has been waiting for.
	holder()
	if second := <-acquired; second != "normal" {
		t.Fatalf("second drained waiter = %q, want normal", second)
	}
	close(release)
	waitUntil(t, "the slots to drain", func() bool {
		_, active := limiter.stats()
		return active == 0
	})
}

func TestLimiterCloseRejectsWaitersAndNewAcquires(t *testing.T) {
	limiter := newConcurrencyLimiter(1)
	ctx := context.Background()
	holder, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot)
	if err != nil {
		t.Fatalf("acquire the holder slot: %v", err)
	}

	errs := make(chan error, 2)
	go func() {
		_, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal)
		errs <- err
	}()
	waitUntil(t, "the normal waiter", func() bool {
		_, normal := limiterQueueLengths(limiter)
		return normal == 1
	})
	go func() {
		_, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot)
		errs <- err
	}()
	waitUntil(t, "the hot waiter", func() bool {
		hot, _ := limiterQueueLengths(limiter)
		return hot == 1
	})

	limiter.close()
	for index := 0; index < 2; index++ {
		select {
		case err := <-errs:
			if !errors.Is(err, errLimiterShuttingDown) {
				t.Fatalf("waiter error = %v, want the shutting-down error", err)
			}
			if err.Error() != "Global crawl concurrency limiter is shutting down" {
				t.Fatalf("waiter error text = %q", err.Error())
			}
		case <-time.After(2 * time.Second):
			t.Fatal("a waiter was not rejected by close")
		}
	}
	if _, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot); !errors.Is(err, errLimiterClosed) {
		t.Fatalf("acquire after close = %v, want the closed error", err)
	} else if err.Error() != "Global crawl concurrency limiter is closed" {
		t.Fatalf("closed error text = %q", err.Error())
	}
	holder()
}

func TestLimiterContextCancellationWithdrawsTheWaiter(t *testing.T) {
	limiter := newConcurrencyLimiter(1)
	holder, err := limiter.acquire(context.Background(), crawlqueue.PriorityClassNormal)
	if err != nil {
		t.Fatalf("acquire the holder slot: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := limiter.acquire(ctx, crawlqueue.PriorityClassNormal)
		result <- err
	}()
	waitUntil(t, "the waiter", func() bool {
		_, normal := limiterQueueLengths(limiter)
		return normal == 1
	})
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("acquire error = %v, want context.Canceled", err)
	}
	waitUntil(t, "the waiter removal", func() bool {
		_, normal := limiterQueueLengths(limiter)
		return normal == 0
	})
	holder()
}

func TestLimiterUnknownClassBehavesAsNormal(t *testing.T) {
	limiter := newConcurrencyLimiter(1)
	holder, err := limiter.acquire(context.Background(), crawlqueue.PriorityClassHot)
	if err != nil {
		t.Fatalf("acquire the holder slot: %v", err)
	}
	ctx := context.Background()
	acquired := make(chan string, 2)
	go func() {
		if slot, err := limiter.acquire(ctx, crawlqueue.PriorityClass("weird")); err == nil {
			defer slot()
			acquired <- "unknown-class"
		}
	}()
	waitUntil(t, "the unknown-class waiter", func() bool {
		hot, normal := limiterQueueLengths(limiter)
		return normal == 1 && hot == 0
	})
	go func() {
		if slot, err := limiter.acquire(ctx, crawlqueue.PriorityClassHot); err == nil {
			defer slot()
			acquired <- "hot"
		}
	}()
	waitUntil(t, "the hot waiter", func() bool {
		hot, _ := limiterQueueLengths(limiter)
		return hot == 1
	})
	holder()
	if first := <-acquired; first != "hot" {
		t.Fatalf("first slot = %q, want hot", first)
	}
	if second := <-acquired; second != "unknown-class" {
		t.Fatalf("second slot = %q, want the unknown class as normal", second)
	}
}
