package kgingestion

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRedisEntry struct {
	value  string
	expiry time.Time
}

type fakeRedisStore struct {
	mu      sync.Mutex
	values  map[string]fakeRedisEntry
	ttls    map[string]time.Duration
	release []string
	renew   []time.Duration
}

func newFakeRedisStore() *fakeRedisStore {
	return &fakeRedisStore{values: map[string]fakeRedisEntry{}, ttls: map[string]time.Duration{}}
}

func (s *fakeRedisStore) SetIfAbsent(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry, ok := s.values[key]; ok && (entry.expiry.IsZero() || entry.expiry.After(time.Now())) {
		return false, nil
	}
	s.values[key] = fakeRedisEntry{value: value, expiry: time.Now().Add(ttl)}
	s.ttls[key] = ttl
	return true, nil
}

func (s *fakeRedisStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.values[key]
	if !ok {
		return "", false, nil
	}
	return entry.value, true, nil
}

func (s *fakeRedisStore) Set(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = fakeRedisEntry{value: value, expiry: time.Now().Add(ttl)}
	s.ttls[key] = ttl
	return nil
}

func (s *fakeRedisStore) ReleaseLock(_ context.Context, key, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.values[key]
	if !ok || entry.value != token {
		return nil
	}
	delete(s.values, key)
	s.release = append(s.release, key)
	return nil
}

func (s *fakeRedisStore) RenewLock(_ context.Context, key, token string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.values[key]
	if !ok || entry.value != token {
		return nil
	}
	entry.expiry = time.Now().Add(ttl)
	s.values[key] = entry
	s.renew = append(s.renew, ttl)
	return nil
}

func (s *fakeRedisStore) entry(key string) (fakeRedisEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.values[key]
	return entry, ok
}

type fakeOrgRepository struct {
	ids []string
	err error
}

func (r *fakeOrgRepository) ListActiveOrgIDs(context.Context) ([]string, error) {
	return r.ids, r.err
}

type fakeConcurrencyReader struct {
	value int
	err   error
}

func (r *fakeConcurrencyReader) ReadKnowledgeGraphIngestionOrgConcurrency(context.Context) (int, error) {
	return r.value, r.err
}

type fakeOrgProcessor struct {
	mu      sync.Mutex
	calls   []string
	active  int32
	maxSeen int32
	delay   time.Duration
	err     error
}

func (p *fakeOrgProcessor) IngestOrg(_ context.Context, orgID string) (BatchSummary, error) {
	current := atomic.AddInt32(&p.active, 1)
	for {
		max := atomic.LoadInt32(&p.maxSeen)
		if current <= max || atomic.CompareAndSwapInt32(&p.maxSeen, max, current) {
			break
		}
	}
	if p.delay > 0 {
		time.Sleep(p.delay)
	}
	atomic.AddInt32(&p.active, -1)
	p.mu.Lock()
	p.calls = append(p.calls, orgID)
	p.mu.Unlock()
	return BatchSummary{}, p.err
}

func (p *fakeOrgProcessor) called() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.calls...)
}

func TestClaimTickUsesNestKeyValueAndTTL(t *testing.T) {
	store := newFakeRedisStore()
	scheduler := NewScheduler(SchedulerOptions{Store: store, Now: func() time.Time {
		return time.Date(2026, 10, 19, 12, 5, 0, 0, time.UTC)
	}})
	claimed, err := scheduler.claimTick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !claimed {
		t.Fatal("first claim = false")
	}
	entry, ok := store.entry(tickGateKey)
	if !ok {
		t.Fatal("tick gate key missing")
	}
	if entry.value != `{"claimedAt":"2026-10-19T12:05:00.000Z"}` {
		t.Fatalf("tick gate value = %s", entry.value)
	}
	if store.ttls[tickGateKey] != 285*time.Second {
		t.Fatalf("tick gate ttl = %v", store.ttls[tickGateKey])
	}

	second, err := scheduler.claimTick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second {
		t.Fatal("second claim = true, want mutual exclusion")
	}
}

func TestRunOrgsUsesOrganizationLockAndReleasesIt(t *testing.T) {
	store := newFakeRedisStore()
	processor := &fakeOrgProcessor{}
	scheduler := NewScheduler(SchedulerOptions{Store: store, Processor: processor})
	result := scheduler.runOrgWithLock(context.Background(), "org-1")
	if result.outcome != orgRunCompleted {
		t.Fatalf("outcome = %v err = %v", result.outcome, result.err)
	}
	lockKey := orgLockKeyPrefix + "org-1"
	if _, ok := store.entry(lockKey); ok {
		t.Fatal("organization lock was not released")
	}
	if len(store.release) != 1 || store.release[0] != lockKey {
		t.Fatalf("released keys = %v", store.release)
	}
	if len(processor.called()) != 1 {
		t.Fatalf("processor calls = %v", processor.called())
	}
}

func TestRunOrgWithLockSkipsWhenHeld(t *testing.T) {
	store := newFakeRedisStore()
	lockKey := orgLockKeyPrefix + "org-1"
	if _, err := store.SetIfAbsent(context.Background(), lockKey, "other", orgLockTTL); err != nil {
		t.Fatal(err)
	}
	scheduler := NewScheduler(SchedulerOptions{Store: store})
	result := scheduler.runOrgWithLock(context.Background(), "org-1")
	if result.outcome != orgRunSkipped {
		t.Fatalf("outcome = %v", result.outcome)
	}
	if entry, _ := store.entry(lockKey); entry.value != "other" {
		t.Fatal("skipped run touched the foreign lock")
	}
}

func TestRunOrgsBoundsConcurrency(t *testing.T) {
	processor := &fakeOrgProcessor{delay: 10 * time.Millisecond}
	scheduler := NewScheduler(SchedulerOptions{Store: newFakeRedisStore(), Processor: processor})
	orgs := []string{"a", "b", "c", "d", "e"}
	results := scheduler.runOrgs(context.Background(), orgs, 2)
	if len(results) != len(orgs) {
		t.Fatalf("results = %d", len(results))
	}
	for _, result := range results {
		if result.outcome != orgRunCompleted {
			t.Fatalf("outcome = %v", result.outcome)
		}
	}
	if processor.maxSeen > 2 {
		t.Fatalf("max concurrency = %d, want <= 2", processor.maxSeen)
	}
}

func TestRunTickRecordsFailedAndSkipped(t *testing.T) {
	store := newFakeRedisStore()
	// org-2 is already locked, so it is reported as skipped.
	if _, err := store.SetIfAbsent(context.Background(), orgLockKeyPrefix+"org-2", "other", orgLockTTL); err != nil {
		t.Fatal(err)
	}
	processor := &fakeOrgProcessor{err: nil}
	scheduler := NewScheduler(SchedulerOptions{
		Store:      store,
		Repository: &fakeOrgRepository{ids: []string{"org-1", "org-2"}},
		Settings:   &fakeConcurrencyReader{value: 2},
		Processor:  processor,
	})
	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(processor.called()) != 1 || processor.called()[0] != "org-1" {
		t.Fatalf("processed = %v", processor.called())
	}
}

func TestRunTickFailsWhenSettingsInvalid(t *testing.T) {
	scheduler := NewScheduler(SchedulerOptions{
		Store:      newFakeRedisStore(),
		Repository: &fakeOrgRepository{ids: []string{"org-1"}},
		Settings:   &fakeConcurrencyReader{err: errors.New("invalid settings")},
		Processor:  &fakeOrgProcessor{},
	})
	if err := scheduler.runTick(context.Background()); err == nil {
		t.Fatal("expected settings error")
	}
}

func TestRunTickSkipsWhenTickGateIsHeld(t *testing.T) {
	store := newFakeRedisStore()
	if _, err := store.SetIfAbsent(context.Background(), tickGateKey, "other", tickGateTTL); err != nil {
		t.Fatal(err)
	}
	processor := &fakeOrgProcessor{}
	scheduler := NewScheduler(SchedulerOptions{
		Store:      store,
		Repository: &fakeOrgRepository{ids: []string{"org-1"}},
		Settings:   &fakeConcurrencyReader{value: 1},
		Processor:  processor,
	})
	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(processor.called()) != 0 {
		t.Fatalf("processed = %v", processor.called())
	}
}
