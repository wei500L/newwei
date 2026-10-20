package startupreconcile

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeLease struct {
	mu      sync.Mutex
	held    bool
	calls   int
	lastKey string
}

func (l *fakeLease) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	l.mu.Lock()
	l.calls++
	l.lastKey = key
	held := l.held
	l.mu.Unlock()
	if held {
		return false, nil
	}
	return true, runner(ctx)
}

type fakeSettings struct {
	taskDays int
	taskErr  error
	llmDays  int
	llmErr   error
	calls    int
}

func (s *fakeSettings) ReconcileTaskLogRetention(context.Context) (int, error) {
	s.calls++
	return s.taskDays, s.taskErr
}

func (s *fakeSettings) ReconcileLLMRequestLogRetention(context.Context) (int, error) {
	s.calls++
	return s.llmDays, s.llmErr
}

type fakeIndex struct {
	calls int
	err   error
}

func (i *fakeIndex) EnsureIndex(context.Context) error {
	i.calls++
	return i.err
}

// TestRunOnceReconcilesEveryPart proves the three parts run independently and
// that failures are joined instead of skipping the next part.
func TestRunOnceReconcilesEveryPart(t *testing.T) {
	settings := &fakeSettings{taskDays: 14, llmErr: errors.New("llm ttl failed")}
	index := &fakeIndex{}
	lease := &fakeLease{}
	reconciler := New(Deps{Settings: settings, Search: index, Lock: lease})

	acquired, err := reconciler.RunOnce(context.Background())
	if !acquired {
		t.Fatal("lease was not acquired")
	}
	if err == nil || !strings.Contains(err.Error(), "llm request log TTL") {
		t.Fatalf("error = %v", err)
	}
	if settings.calls != 2 {
		t.Fatalf("settings calls = %d, want 2", settings.calls)
	}
	if index.calls != 1 {
		t.Fatalf("index calls = %d, want 1 (one failure must not skip it)", index.calls)
	}
	if lease.lastKey != lockName {
		t.Fatalf("lease key = %q, want %q", lease.lastKey, lockName)
	}
}

// TestRunOnceSkipsWhenLeaseHeld proves the multi-replica guard: a held lease
// runs nothing.
func TestRunOnceSkipsWhenLeaseHeld(t *testing.T) {
	settings := &fakeSettings{taskDays: 14}
	index := &fakeIndex{}
	reconciler := New(Deps{Settings: settings, Search: index, Lock: &fakeLease{held: true}})

	acquired, err := reconciler.RunOnce(context.Background())
	if acquired || err != nil {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	if settings.calls != 0 || index.calls != 0 {
		t.Fatalf("work ran without the lease: settings=%d index=%d", settings.calls, index.calls)
	}
}

// TestRunOnceWithoutWorkDoesNotTakeLease pins the legacy-safe behavior when the
// caller passes no reconcilers.
func TestRunOnceWithoutWorkDoesNotTakeLease(t *testing.T) {
	lease := &fakeLease{}
	acquired, err := New(Deps{Lock: lease}).RunOnce(context.Background())
	if acquired || err != nil {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	if lease.calls != 0 {
		t.Fatalf("lease calls = %d, want 0", lease.calls)
	}
}
