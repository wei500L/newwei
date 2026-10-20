package dashboardstream

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSharedReadsComputesOncePerBucket(t *testing.T) {
	cache := newSharedReads[[]byte](time.Second)
	var calls atomic.Int32
	compute := func(context.Context) ([]byte, error) {
		calls.Add(1)
		time.Sleep(20 * time.Millisecond)
		return []byte(`{"ok":true}`), nil
	}

	var wg sync.WaitGroup
	results := make([][]byte, 8)
	for index := range results {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			body, err := cache.do(context.Background(), "org-a|range", 7, compute)
			if err != nil {
				t.Errorf("do: %v", err)
				return
			}
			results[slot] = body
		}(index)
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent callers computed %d times, want 1", calls.Load())
	}
	for index, body := range results {
		if string(body) != `{"ok":true}` {
			t.Fatalf("result %d = %s", index, body)
		}
	}

	// The next tick starts a new bucket, so the read runs again: freshness is
	// per interval, not per entry lifetime.
	if _, err := cache.do(context.Background(), "org-a|range", 8, compute); err != nil {
		t.Fatalf("second bucket: %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("next bucket computed %d times, want 2", calls.Load())
	}
}

func TestSharedReadsKeepsOrgKeysApart(t *testing.T) {
	cache := newSharedReads[[]byte](time.Second)
	var calls atomic.Int32
	compute := func(ctx context.Context) ([]byte, error) {
		calls.Add(1)
		return []byte("body-" + ctx.Value(keyOrg).(string)), nil
	}
	ctxA := context.WithValue(context.Background(), keyOrg, "org-a")
	ctxB := context.WithValue(context.Background(), keyOrg, "org-b")
	bodyA, err := cache.do(ctxA, "heat|org-a|1|2", 3, compute)
	if err != nil {
		t.Fatal(err)
	}
	bodyB, err := cache.do(ctxB, "heat|org-b|1|2", 3, compute)
	if err != nil {
		t.Fatal(err)
	}
	if string(bodyA) != "body-org-a" || string(bodyB) != "body-org-b" {
		t.Fatalf("bodies leaked across keys: %s / %s", bodyA, bodyB)
	}
	if calls.Load() != 2 {
		t.Fatalf("distinct keys computed %d times, want 2", calls.Load())
	}
}

// The read is started by whichever connection ticks first. That connection must
// not own the work: a waiter polling the same bucket still gets the result when
// the initiator goes away.
func TestSharedReadsOutlivesInitiator(t *testing.T) {
	cache := newSharedReads[[]byte](5 * time.Second)
	release := make(chan struct{})
	started := make(chan struct{})
	compute := func(ctx context.Context) ([]byte, error) {
		close(started)
		select {
		case <-release:
			return []byte(`{"done":true}`), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	initiator, cancelInitiator := context.WithCancel(context.Background())
	go func() {
		// The initiator leaves while its read is still running.
		<-started
		cancelInitiator()
		close(release)
	}()
	go func() {
		_, _ = cache.do(initiator, "heat|org-a|1|2", 1, compute)
	}()
	<-started
	body, err := cache.do(context.Background(), "heat|org-a|1|2", 1, compute)
	if err != nil {
		t.Fatalf("waiter must not inherit the initiator's cancellation: %v", err)
	}
	if string(body) != `{"done":true}` {
		t.Fatalf("waiter body = %s", body)
	}
}

func TestSharedReadsSharesFailuresAndPrunes(t *testing.T) {
	cache := newSharedReads[[]byte](time.Second)
	failure := errors.New("mysql is down")
	if _, err := cache.do(context.Background(), "k", 1, func(context.Context) ([]byte, error) {
		return nil, failure
	}); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	if _, err := cache.do(context.Background(), "k", 1, func(context.Context) ([]byte, error) {
		t.Fatal("the cached failure must not trigger a second read in the same bucket")
		return nil, nil
	}); !errors.Is(err, failure) {
		t.Fatalf("cached error = %v", err)
	}
	if cache.size() != 1 {
		t.Fatalf("entries = %d", cache.size())
	}
	// Two buckets later the finished entry is collected on the next read.
	if _, err := cache.do(context.Background(), "k2", 3, func(context.Context) ([]byte, error) {
		return []byte("x"), nil
	}); err != nil {
		t.Fatal(err)
	}
	if cache.size() != 1 {
		t.Fatalf("stale entries were not pruned: %d", cache.size())
	}
}

type contextKey string

const keyOrg contextKey = "org"
