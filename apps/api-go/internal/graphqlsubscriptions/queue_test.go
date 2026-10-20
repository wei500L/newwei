package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
)

type fakeQueueState struct {
	mu    sync.Mutex
	jobs  map[string]string
	cache map[string][]byte
	sets  map[string][]byte
	reads []string
}

type fakeQueueStore struct {
	mu      sync.Mutex
	state   *fakeQueueState
	batches chan []StreamEntry
}

func newFakeQueueStore() *fakeQueueStore {
	return &fakeQueueStore{
		state: &fakeQueueState{
			jobs:  map[string]string{},
			cache: map[string][]byte{},
			sets:  map[string][]byte{},
		},
		batches: make(chan []StreamEntry, 32),
	}
}

func (s *fakeQueueStore) ReadStream(ctx context.Context, stream, lastID string, count int64, block time.Duration) ([]StreamEntry, error) {
	s.mu.Lock()
	s.state.reads = append(s.state.reads, lastID)
	s.mu.Unlock()
	select {
	case batch := <-s.batches:
		return batch, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *fakeQueueStore) ReadJobData(_ context.Context, queue, jobID string) (string, bool, error) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	value, ok := s.state.jobs[jobID]
	return value, ok, nil
}

func (s *fakeQueueStore) ReadSharedContext(_ context.Context, key string) ([]byte, bool, error) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	value, ok := s.state.cache[key]
	return append([]byte{}, value...), ok, nil
}

func (s *fakeQueueStore) WriteSharedContext(_ context.Context, key string, body []byte, ttl time.Duration) error {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	s.state.cache[key] = append([]byte{}, body...)
	s.state.sets[key] = append([]byte{}, body...)
	return nil
}

func (s *fakeQueueStore) Close() error { return nil }

func (s *fakeQueueStore) push(entries ...StreamEntry) {
	s.batches <- entries
}

func (s *fakeQueueStore) setJob(jobID, data string) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	s.state.jobs[jobID] = data
}

func (s *fakeQueueStore) deleteJob(jobID string) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	delete(s.state.jobs, jobID)
}

func (s *fakeQueueStore) shared(key string) []byte {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	return append([]byte{}, s.state.cache[key]...)
}

func (s *fakeQueueStore) lastIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.state.reads...)
}

func fixedQueueClock() time.Time {
	return time.Date(2026, 10, 19, 20, 30, 0, 123_000_000, time.UTC)
}

func newTestQueueObserver(t *testing.T, store QueueStore) *QueueObserver {
	t.Helper()
	observer := NewQueueObserver(store)
	observer.clock = fixedQueueClock
	ctx, cancel := context.WithCancel(context.Background())
	observer.Start(ctx)
	t.Cleanup(func() {
		cancel()
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer closeCancel()
		_ = observer.Close(closeCtx)
	})
	return observer
}

func readQueueEvent(t *testing.T, channel <-chan FeedEvent) workspace.QueueEventModel {
	t.Helper()
	select {
	case event := <-channel:
		model, ok := event.Value.(workspace.QueueEventModel)
		if !ok {
			t.Fatalf("queue event value = %T, want workspace.QueueEventModel", event.Value)
		}
		return model
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a queue event")
		return workspace.QueueEventModel{}
	}
}

func TestQueueEventDataShapesAndStreamCursor(t *testing.T) {
	store := newFakeQueueStore()
	store.setJob("job-1", `{"orgId":"org-a"}`)
	observer := newTestQueueObserver(t, store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed := observer.Subscribe(ctx, "org-a")

	entry := func(id, event string, fields map[string]string) StreamEntry {
		base := map[string]string{"event": event, "jobId": "job-1"}
		for key, value := range fields {
			base[key] = value
		}
		return StreamEntry{ID: id, Fields: base}
	}
	store.push(
		entry("1-0", "active", map[string]string{"prev": "waiting"}),
		entry("2-0", "progress", map[string]string{"data": "0"}),
		entry("3-0", "progress", map[string]string{"data": "false"}),
		entry("4-0", "progress", map[string]string{"data": "null"}),
		entry("5-0", "progress", map[string]string{"data": `{"p":1}`}),
		entry("6-0", "progress", map[string]string{"data": `[1,2]`}),
		entry("7-0", "completed", map[string]string{"returnvalue": `{"ok":true}`}),
		entry("8-0", "completed", map[string]string{"returnvalue": `[1]`}),
		entry("9-0", "completed", map[string]string{"returnvalue": `null`}),
		entry("10-0", "failed", map[string]string{"failedReason": "boom"}),
		entry("11-0", "failed", map[string]string{"failedReason": ""}),
		entry("12-0", "waiting", nil),
	)

	type expectation struct {
		event string
		data  string
	}
	expectations := []expectation{
		{"ACTIVE", `{"prev":"waiting"}`},
		{"PROGRESS", `{"progress":0}`},
		{"PROGRESS", `{"progress":false}`},
		{"PROGRESS", `{"progress":null}`},
		{"PROGRESS", `{"p":1}`},
		{"PROGRESS", `[1,2]`},
		{"COMPLETED", `{"ok":true}`},
		{"COMPLETED", `{"returnvalue":[1]}`},
		{"COMPLETED", `{"returnvalue":null}`},
		{"FAILED", `{"reason":"boom"}`},
		{"FAILED", ""},
	}
	for index, expected := range expectations {
		model := readQueueEvent(t, feed)
		if model.Event != expected.event {
			t.Fatalf("event[%d] = %q, want %q", index, model.Event, expected.event)
		}
		if model.Timestamp != "2026-10-19T20:30:00.123Z" {
			t.Fatalf("timestamp = %q, want observation time in UTC milliseconds", model.Timestamp)
		}
		if expected.data == "" {
			if model.Data != nil {
				t.Fatalf("event[%d] data = %q, want null", index, *model.Data)
			}
			continue
		}
		if model.Data == nil || *model.Data != expected.data {
			t.Fatalf("event[%d] data = %v, want %s", index, model.Data, expected.data)
		}
	}

	deadline := time.Now().Add(2 * time.Second)
	for len(store.lastIDs()) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	ids := store.lastIDs()
	if len(ids) < 2 || ids[0] != "$" {
		t.Fatalf("stream reads = %v, want the first read to start at $", ids)
	}
	if ids[1] != "12-0" {
		t.Fatalf("second stream read = %q, want the last observed id 12-0", ids[1])
	}
}

func TestQueueTerminalAfterJobRemovalKeepsSharedContext(t *testing.T) {
	store := newFakeQueueStore()
	store.setJob("job-1", `{"orgId":"org-a","pipelineJobId":"pipeline-1","sourceId":"source-1"}`)
	observer := newTestQueueObserver(t, store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed := observer.Subscribe(ctx, "org-a")

	store.push(StreamEntry{ID: "1-0", Fields: map[string]string{
		"event": "active", "jobId": "job-1", "prev": "waiting",
	}})
	active := readQueueEvent(t, feed)
	if active.Event != "ACTIVE" {
		t.Fatalf("active event = %q", active.Event)
	}
	if len(store.shared("queue:pipeline:jobctx:job-1")) == 0 {
		t.Fatal("active observation must write the shared job context")
	}
	store.deleteJob("job-1")
	store.push(StreamEntry{ID: "2-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"ok":true}`,
	}})
	completed := readQueueEvent(t, feed)
	if completed.Event != "COMPLETED" || completed.Data == nil || *completed.Data != `{"ok":true}` {
		t.Fatalf("completed = %+v (data=%v)", completed, completed.Data)
	}
	waitFor(t, "local context cleanup", func() bool {
		observer.mu.Lock()
		defer observer.mu.Unlock()
		_, stillPresent := observer.local["job-1"]
		return !stillPresent
	})
	var shared map[string]any
	if err := json.Unmarshal(store.shared("queue:pipeline:jobctx:job-1"), &shared); err != nil {
		t.Fatalf("shared context: %v", err)
	}
	if shared["orgId"] != "org-a" || shared["pipelineJobId"] != "pipeline-1" || shared["sourceId"] != "source-1" {
		t.Fatalf("shared context = %v", shared)
	}
}

func TestQueueColdInstanceResolvesSharedContext(t *testing.T) {
	store := newFakeQueueStore()
	warm := NewQueueObserver(store)
	warm.clock = fixedQueueClock
	warm.storeContext("job-1", queueJobContext{OrgID: "org-a", PipelineJobID: "pipeline-1"})
	store.deleteJob("job-1")

	cold := NewQueueObserver(store)
	cold.clock = fixedQueueClock
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed := cold.Subscribe(ctx, "org-a")
	cold.handle(context.Background(), StreamEntry{ID: "3-0", Fields: map[string]string{
		"event": "progress", "jobId": "job-1", "data": `{"p":1}`,
	}})
	progress := readQueueEvent(t, feed)
	if progress.Event != "PROGRESS" || progress.JobID != "job-1" {
		t.Fatalf("cold progress = %+v", progress)
	}
	cold.mu.Lock()
	_, warmLocal := cold.local["job-1"]
	cold.mu.Unlock()
	if !warmLocal {
		t.Fatal("a shared-cache hit must warm the local context")
	}

	cold.handle(context.Background(), StreamEntry{ID: "4-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"ok":true}`,
	}})
	completed := readQueueEvent(t, feed)
	if completed.Event != "COMPLETED" || completed.JobID != "job-1" {
		t.Fatalf("cold completed = %+v", completed)
	}
	if len(store.shared("queue:pipeline:jobctx:job-1")) == 0 {
		t.Fatal("the terminal event must keep the shared context")
	}
}

func TestQueueValidJobContextBeatsLocalCache(t *testing.T) {
	store := newFakeQueueStore()
	observer := NewQueueObserver(store)
	observer.clock = fixedQueueClock
	observer.storeContext("job-1", queueJobContext{OrgID: "org-a"})
	store.setJob("job-1", `{"orgId":" org-b "}`)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	oldFeed := observer.Subscribe(ctx, "org-a")
	newFeed := observer.Subscribe(ctx, "org-b")
	observer.handle(context.Background(), StreamEntry{ID: "4-0", Fields: map[string]string{
		"event": "progress", "jobId": "job-1", "data": `{"p":1}`,
	}})
	select {
	case event := <-oldFeed:
		t.Fatalf("old organization received %+v", event)
	case <-time.After(100 * time.Millisecond):
	}
	event := readQueueEvent(t, newFeed)
	if event.Event != "PROGRESS" {
		t.Fatalf("new organization event = %+v", event)
	}
	var shared map[string]any
	if err := json.Unmarshal(store.shared("queue:pipeline:jobctx:job-1"), &shared); err != nil {
		t.Fatalf("shared context: %v", err)
	}
	if shared["orgId"] != "org-b" {
		t.Fatalf("shared orgId = %v, want the valid job context to win", shared["orgId"])
	}
}

func TestQueueFanoutPerInstanceOnce(t *testing.T) {
	store := newFakeQueueStore()
	store.setJob("job-1", `{"orgId":"org-a"}`)
	observer := newTestQueueObserver(t, store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := observer.Subscribe(ctx, "org-a")
	second := observer.Subscribe(ctx, "org-a")

	store.push(StreamEntry{ID: "1-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"ok":true}`,
	}})
	one := readQueueEvent(t, first)
	two := readQueueEvent(t, second)
	if one.JobID != "job-1" || two.JobID != "job-1" || one.Event != "COMPLETED" || two.Event != "COMPLETED" {
		t.Fatalf("fanout events = %+v / %+v", one, two)
	}
	select {
	case extra := <-first:
		t.Fatalf("per-instance observer delivered a duplicate event: %+v", extra)
	case <-time.After(100 * time.Millisecond):
	}
	if len(store.lastIDs()) == 0 {
		t.Fatal("the shared observer must issue the stream reads")
	}
}
