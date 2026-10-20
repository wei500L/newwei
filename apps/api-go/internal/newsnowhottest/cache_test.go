package newsnowhottest

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

type fakeStore struct {
	mu      sync.Mutex
	values  map[string]string
	ttls    map[string]time.Duration
	batches [][]CacheEntry
	mgets   [][]string
	setNX   []string
	evals   []fakeEval

	mgetOverride func(keys []string) ([]string, []bool, error)
}

type fakeEval struct {
	script string
	keys   []string
	args   []string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		values: map[string]string{},
		ttls:   map[string]time.Duration{},
	}
}

func (s *fakeStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.values[key]
	return value, ok, nil
}

func (s *fakeStore) MGet(_ context.Context, keys []string) ([]string, []bool, error) {
	s.mu.Lock()
	s.mgets = append(s.mgets, append([]string{}, keys...))
	override := s.mgetOverride
	s.mu.Unlock()
	if override != nil {
		return override(keys)
	}
	values := make([]string, len(keys))
	found := make([]bool, len(keys))
	s.mu.Lock()
	defer s.mu.Unlock()
	for index, key := range keys {
		if value, ok := s.values[key]; ok {
			values[index] = value
			found[index] = true
		}
	}
	return values, found, nil
}

func (s *fakeStore) Set(_ context.Context, key, value string, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.values[key] = value
	s.ttls[key] = ttl
	return nil
}

func (s *fakeStore) SetMany(_ context.Context, entries []CacheEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.batches = append(s.batches, append([]CacheEntry{}, entries...))
	for _, entry := range entries {
		s.values[entry.Key] = entry.Value
		s.ttls[entry.Key] = entry.TTL
	}
	return nil
}

func (s *fakeStore) SetNX(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setNX = append(s.setNX, key)
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
	s.evals = append(s.evals, fakeEval{script: script, keys: keys, args: args})
	return 1, nil
}

func TestPersistSignalStatesUsesOnePipeline(t *testing.T) {
	store := newFakeStore()
	service := NewService(Options{Store: store, Now: func() time.Time {
		return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	}})
	signals := []Signal{
		{
			SignalSeed: SignalSeed{SignalKey: "k1", Rank: 2},
			CapturedAt: "2026-10-20T12:00:00.000Z",
			State: &SignalState{
				FirstSeenAt: "2026-10-20T09:00:00.000Z",
				LastRank:    intOrNull(5),
			},
		},
		{
			SignalSeed: SignalSeed{SignalKey: "k2", Rank: 1},
			CapturedAt: "2026-10-20T12:00:00.000Z",
		},
	}
	service.persistSignalStates(context.Background(), "org-1", signals)
	if len(store.batches) != 1 {
		t.Fatalf("batches = %d, want 1", len(store.batches))
	}
	batch := store.batches[0]
	if len(batch) != 2 {
		t.Fatalf("entries = %d", len(batch))
	}
	if batch[0].Key != "newsnow:hottest:state:v1:org-1:k1" || batch[0].TTL != 36*time.Hour {
		t.Fatalf("first entry = %+v", batch[0])
	}
	var first SignalState
	if err := json.Unmarshal([]byte(batch[0].Value), &first); err != nil {
		t.Fatalf("decode first state: %v", err)
	}
	if first.FirstSeenAt != "2026-10-20T09:00:00.000Z" || first.LastSeenAt != "2026-10-20T12:00:00.000Z" ||
		!first.LastRank.Valid || first.LastRank.Value != 2 {
		t.Fatalf("first state = %+v", first)
	}
	var second SignalState
	if err := json.Unmarshal([]byte(batch[1].Value), &second); err != nil {
		t.Fatalf("decode second state: %v", err)
	}
	if second.FirstSeenAt != "2026-10-20T12:00:00.000Z" {
		t.Fatalf("new signal firstSeenAt = %q", second.FirstSeenAt)
	}
}

func TestAcquireLockUsesNestPhysicalKey(t *testing.T) {
	store := newFakeStore()
	lease, err := acquireLock(context.Background(), store, "newsnow:hottest:analysis:v1:org:refresh", analysisLockTTLMillis)
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v %v", lease, err)
	}
	if len(store.setNX) != 1 || store.setNX[0] != "lock:newsnow:hottest:analysis:v1:org:refresh" {
		t.Fatalf("setNX keys = %v", store.setNX)
	}
	if ttl := store.ttls[store.setNX[0]]; ttl != 45*time.Second {
		t.Fatalf("lock ttl = %v", ttl)
	}
	lease.release()
	if len(store.evals) != 1 || len(store.evals[0].keys) != 1 ||
		store.evals[0].keys[0] != "lock:newsnow:hottest:analysis:v1:org:refresh" {
		t.Fatalf("release eval = %+v", store.evals)
	}
}

func TestSetGlobalSnapshotCachesWritesSignatureString(t *testing.T) {
	store := newFakeStore()
	service := NewService(Options{Store: store})
	snapshot := GlobalSnapshot{Signature: "sig-1"}
	service.setGlobalSnapshotCaches(context.Background(),
		buildGlobalSnapshotCacheKey(), buildGlobalSnapshotStaleCacheKey(), buildGlobalSignatureCacheKey(), snapshot)
	if len(store.batches) != 1 || len(store.batches[0]) != 3 {
		t.Fatalf("batch = %+v", store.batches)
	}
	byKey := map[string]CacheEntry{}
	for _, entry := range store.batches[0] {
		byKey[entry.Key] = entry
	}
	if byKey[buildGlobalSnapshotCacheKey()].TTL != 2*time.Hour {
		t.Fatalf("fresh ttl = %v", byKey[buildGlobalSnapshotCacheKey()].TTL)
	}
	if byKey[buildGlobalSnapshotStaleCacheKey()].TTL != 24*time.Hour {
		t.Fatalf("stale ttl = %v", byKey[buildGlobalSnapshotStaleCacheKey()].TTL)
	}
	signature := byKey[buildGlobalSignatureCacheKey()]
	if signature.TTL != 24*time.Hour || signature.Value != `"sig-1"` {
		t.Fatalf("signature entry = %+v", signature)
	}
}

func TestWaitForReadyAnalysisUsesOneMGet(t *testing.T) {
	store := newFakeStore()
	fresh := AnalysisResponse{GeneratedAt: "2026-10-20T12:00:00.000Z", DataState: DataStateReady, Candidates: []EventCandidate{}}
	encoded, _ := marshalJSON(fresh)
	store.values[buildAnalysisCacheKey("org")] = string(encoded)
	service := NewService(Options{Store: store})
	result := service.waitForReadyAnalysis(context.Background(),
		buildAnalysisCacheKey("org"), buildAnalysisStaleCacheKey("org"), true)
	if result == nil || result.GeneratedAt != fresh.GeneratedAt {
		t.Fatalf("waited = %+v", result)
	}
	if len(store.mgets) != 1 || len(store.mgets[0]) != 2 {
		t.Fatalf("mgets = %+v", store.mgets)
	}
}

func TestRunAnalysisInflightMergesConcurrentCalls(t *testing.T) {
	service := &Service{
		inflightAnalysis: map[string]*analysisCall{},
		inflightSnapshot: map[string]*snapshotCall{},
	}
	var calls int
	var mu sync.Mutex
	release := make(chan struct{})
	factory := func() (AnalysisResponse, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		<-release
		return AnalysisResponse{GeneratedAt: "shared"}, nil
	}
	results := make([]AnalysisResponse, 2)
	var wait sync.WaitGroup
	wait.Add(2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			defer wait.Done()
			value, _ := service.runAnalysisInflight("key", factory)
			results[index] = value
		}(index)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	wait.Wait()
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("factory calls = %d, want 1", calls)
	}
	if results[0].GeneratedAt != "shared" || results[1].GeneratedAt != "shared" {
		t.Fatalf("results = %+v", results)
	}
}

func TestNormalizeAnalysisDerivesStateAndReason(t *testing.T) {
	service := NewService(Options{})
	response := service.normalizeAnalysis(AnalysisResponse{})
	if response.DataState != DataStateEmpty || !response.EmptyReason.Valid ||
		response.EmptyReason.Value != string(EmptyNoHottestSourcesConfigured) {
		t.Fatalf("normalized empty = %+v", response)
	}
	response = service.normalizeAnalysis(AnalysisResponse{Candidates: []EventCandidate{{CandidateID: "c"}}})
	if response.DataState != DataStateReady || response.EmptyReason.Valid {
		t.Fatalf("normalized ready = %+v", response)
	}
}
