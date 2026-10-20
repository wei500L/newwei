package newsnowhottest

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newsnowsources"
)

type fakeCatalog struct{ ids []string }

func (c fakeCatalog) HottestSourceIDs() []string { return c.ids }

func (c fakeCatalog) Source(sourceID string) (SourceDescriptor, bool) {
	for _, id := range c.ids {
		if id == sourceID {
			return SourceDescriptor{ID: id, Name: id, Column: "hottest"}, true
		}
	}
	return SourceDescriptor{}, false
}

type fakeSources struct{}

func (fakeSources) FetchSource(context.Context, string, bool) (newsnowsources.SourceResponse, error) {
	return newsnowsources.SourceResponse{Items: []newsnowsources.NewsItem{}}, nil
}

func (fakeSources) FetchBatch(context.Context, []string, bool) newsnowsources.BatchResponse {
	return newsnowsources.BatchResponse{Results: []newsnowsources.SourceResponse{}, Errors: []newsnowsources.BatchError{}}
}

type fakeOrgs struct{ ids []string }

func (o fakeOrgs) ListActiveOrgIDs(context.Context) ([]string, error) { return o.ids, nil }

type fakeConcurrency struct{ value int }

func (c fakeConcurrency) ReadNewsnowHottestAnalysisOrgConcurrency(context.Context) (int, error) {
	return c.value, nil
}

// TestSchedulerClaimsOnceAndSkipsLockedOrgs proves the tick gate is claimed once
// and that an organization whose lock is held is skipped without writing its
// projection.
func TestSchedulerClaimsOnceAndSkipsLockedOrgs(t *testing.T) {
	store := newFakeStore()
	service := NewService(Options{
		Store:   store,
		Catalog: fakeCatalog{},
		Sources: fakeSources{},
		Now:     func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
	scheduler := NewScheduler(SchedulerOptions{
		Store:    store,
		Orgs:     fakeOrgs{ids: []string{"org-1", "org-2"}},
		Settings: fakeConcurrency{value: 2},
		Service:  service,
		Now:      func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
	})
	// Pre-hold the second organization's lock.
	store.values["lock:"+hottestOrgLockKeyPrefix+"org-2"] = "other-token"

	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatalf("tick: %v", err)
	}
	if _, ok := store.values["newsnow:hottest:analysis:v1:org-1:fresh"]; !ok {
		t.Fatal("org-1 projection was not written")
	}
	if _, ok := store.values["newsnow:hottest:analysis:v1:org-2:fresh"]; ok {
		t.Fatal("org-2 projection must be skipped while its lock is held")
	}
	if _, ok := store.values[hottestTickGateKey]; !ok {
		t.Fatal("tick gate was not claimed")
	}

	// A second tick cannot claim the gate and must not rewrite any projection.
	delete(store.values, "newsnow:hottest:analysis:v1:org-1:fresh")
	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatalf("second tick: %v", err)
	}
	if _, ok := store.values["newsnow:hottest:analysis:v1:org-1:fresh"]; ok {
		t.Fatal("second tick must be skipped by the existing tick gate")
	}
}

// TestWarmSchedulerFetchesActiveSources checks the warm lock and the active
// source iteration.
func TestWarmSchedulerFetchesActiveSources(t *testing.T) {
	store := newFakeStore()
	registry := NewActiveSourceRegistry()
	registry.SetActiveSources("socket-1", "org-1", []string{" s1 ", "s2", "s1"})
	registry.SetActiveSources("socket-2", "org-2", []string{"s3"})
	if got := registry.GetAllActiveSourceIDs(); len(got) != 3 {
		t.Fatalf("active sources = %v", got)
	}
	fetcher := &countingSources{}
	scheduler := NewWarmScheduler(WarmSchedulerOptions{
		Store:    store,
		Sources:  fetcher,
		Registry: registry,
	})
	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatalf("warm tick: %v", err)
	}
	if len(fetcher.ids) != 3 {
		t.Fatalf("fetched = %v", fetcher.ids)
	}
	if _, ok := store.values["lock:"+warmLockKey]; !ok {
		t.Fatal("warm lock was not taken")
	}
	if ttl := store.ttls["lock:"+warmLockKey]; ttl != 55*time.Second {
		t.Fatalf("warm lock ttl = %v", ttl)
	}
}

type countingSources struct {
	mu  sync.Mutex
	ids []string
}

func (s *countingSources) FetchSource(_ context.Context, sourceID string, _ bool) (newsnowsources.SourceResponse, error) {
	s.mu.Lock()
	s.ids = append(s.ids, sourceID)
	s.mu.Unlock()
	return newsnowsources.SourceResponse{Items: []newsnowsources.NewsItem{}}, nil
}

func (s *countingSources) FetchBatch(context.Context, []string, bool) newsnowsources.BatchResponse {
	return newsnowsources.BatchResponse{Results: []newsnowsources.SourceResponse{}, Errors: []newsnowsources.BatchError{}}
}
