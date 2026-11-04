package cronlock

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeStore is an in-memory Store that mirrors the two token-checked scripts.
type fakeStore struct {
	mu sync.Mutex

	values map[string]string
	ttls   map[string]time.Duration

	setnxKeys []string
	renewals  int
	releases  int

	// renewResult overrides the token-checked renewal answer when non-zero.
	renewResult int64
	setnxErr    error
}

func newFakeStore() *fakeStore {
	return &fakeStore{values: map[string]string{}, ttls: map[string]time.Duration{}}
}

func (s *fakeStore) SetNX(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setnxKeys = append(s.setnxKeys, key)
	if s.setnxErr != nil {
		return false, s.setnxErr
	}
	if _, exists := s.values[key]; exists {
		return false, nil
	}
	s.values[key] = value
	s.ttls[key] = ttl
	return true, nil
}

func (s *fakeStore) Eval(_ context.Context, script string, keys []string, args ...string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if strings.Contains(script, "pexpire") {
		s.renewals++
		if s.renewResult != 0 {
			return s.renewResult, nil
		}
		if len(keys) > 0 && len(args) > 0 {
			if current, ok := s.values[keys[0]]; ok && current == args[0] {
				return 1, nil
			}
		}
		return 0, nil
	}
	s.releases++
	if len(keys) > 0 && len(args) > 0 {
		if current, ok := s.values[keys[0]]; ok && current == args[0] {
			delete(s.values, keys[0])
			return 1, nil
		}
	}
	return 0, nil
}

func (s *fakeStore) get(key string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok
}

func TestWithLockAddsPrefixAndReleases(t *testing.T) {
	store := newFakeStore()
	lock := NewStore(store)
	ran := false
	acquired, err := lock.WithLock(context.Background(), "cron:job", time.Minute, func(context.Context) error {
		ran = true
		return nil
	})
	if err != nil || !acquired || !ran {
		t.Fatalf("acquired=%t ran=%t err=%v", acquired, ran, err)
	}
	if len(store.setnxKeys) != 1 || store.setnxKeys[0] != "lock:cron:job" {
		t.Fatalf("physical key = %v, want lock:cron:job", store.setnxKeys)
	}
	if _, ok := store.get("lock:cron:job"); ok {
		t.Fatal("the lease must be released")
	}
}

// TestWithLeaseUsesPhysicalKeyVerbatim proves the full physical key passes
// through unchanged, so a key that already carries "lock:" never gains a second
// prefix and a non-generic key is never rewritten.
func TestWithLeaseUsesPhysicalKeyVerbatim(t *testing.T) {
	store := newFakeStore()
	lock := NewStore(store)
	for _, key := range []string{"lock:cron:already-prefixed", "custom:no-prefix"} {
		acquired, err := lock.WithLease(context.Background(), key, time.Minute, RenewBestEffort, func(context.Context) error {
			return nil
		})
		if err != nil || !acquired {
			t.Fatalf("key %q acquired=%t err=%v", key, acquired, err)
		}
	}
	want := []string{"lock:cron:already-prefixed", "custom:no-prefix"}
	if len(store.setnxKeys) != len(want) {
		t.Fatalf("keys = %v, want %v", store.setnxKeys, want)
	}
	for index := range want {
		if store.setnxKeys[index] != want[index] {
			t.Fatalf("key[%d] = %q, want %q", index, store.setnxKeys[index], want[index])
		}
	}
}

func TestRenewNoneDoesNotRenew(t *testing.T) {
	store := newFakeStore()
	lock := NewStore(store)
	lease, acquired, err := lock.Acquire(context.Background(), "lock:no-renew", 1500*time.Millisecond, RenewNone)
	if err != nil || !acquired {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	time.Sleep(800 * time.Millisecond)
	store.mu.Lock()
	renewals := store.renewals
	store.mu.Unlock()
	if renewals != 0 {
		t.Fatalf("renewMode=none renewed %d times", renewals)
	}
	if err := lease.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.get("lock:no-renew"); ok {
		t.Fatal("release must delete the lease")
	}
}

func TestBestEffortRenews(t *testing.T) {
	store := newFakeStore()
	store.renewResult = 1
	lock := NewStore(store)
	lease, acquired, err := lock.Acquire(context.Background(), "lock:renew", 1500*time.Millisecond, RenewBestEffort)
	if err != nil || !acquired {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	defer func() { _ = lease.Release(context.Background()) }()
	time.Sleep(800 * time.Millisecond)
	store.mu.Lock()
	renewals := store.renewals
	store.mu.Unlock()
	if renewals == 0 {
		t.Fatal("best-effort renewal must run while the lease is held")
	}
}

// TestReleaseIsTokenChecked proves a stale owner never deletes a lease that now
// belongs to somebody else.
func TestReleaseIsTokenChecked(t *testing.T) {
	store := newFakeStore()
	lock := NewStore(store)
	lease, acquired, err := lock.Acquire(context.Background(), "lock:stale", time.Minute, RenewNone)
	if err != nil || !acquired {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	store.mu.Lock()
	store.values["lock:stale"] = "another-owner"
	store.mu.Unlock()
	if err := lease.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	if value, ok := store.get("lock:stale"); !ok || value != "another-owner" {
		t.Fatalf("release deleted a lease it no longer owned: %q ok=%t", value, ok)
	}
}

// TestWithRenewableLockCancelsOnLost proves the guarded renewal cancels the
// runner context when the lease can no longer be extended.
func TestWithRenewableLockCancelsOnLost(t *testing.T) {
	store := newFakeStore()
	store.renewResult = 0
	lock := NewStore(store)
	acquired, err := lock.WithRenewableLock(context.Background(), "renewable", 1200*time.Millisecond, func(ctx context.Context) error {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
			return errors.New("renewal loss never cancelled the runner")
		}
	})
	if !acquired {
		t.Fatalf("acquired=%t err=%v", acquired, err)
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatalf("runner error = %v, want nil or context.Canceled", err)
	}
	if _, ok := store.get("lock:renewable"); ok {
		t.Fatal("the lease must still be released after the loss")
	}
}
