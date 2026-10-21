package queueorgstats

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
)

// testLogger discards the tracker's log lines so a failing transition can be
// asserted on the store calls instead of on the output.
func testLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// terminalCall is one recorded TERMINAL_AND_REMOVE invocation.
type terminalCall struct {
	jobID  string
	orgID  string
	status JobStatus
}

// removeCall is one recorded REMOVE_JOB invocation.
type removeCall struct {
	orgID string
	jobID string
}

// fakeStore is the in-memory Store. ReadStream serves batches in order, then
// blocks until the context ends so a read loop always terminates.
type fakeStore struct {
	mu sync.Mutex

	reads      int
	lastIDs    []string
	batches    [][]StreamEvent
	readErr    error
	readHook   func(call int)
	metas      map[string]JobMeta
	jobs       map[string]*bullmqwire.Job
	metaErr    error
	jobErr     error
	upsertErrs map[string]error
	upserts    []UpsertJobMetaInput
	terminals  []terminalCall
	removals   []removeCall
	closed     bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		metas:      map[string]JobMeta{},
		jobs:       map[string]*bullmqwire.Job{},
		upsertErrs: map[string]error{},
	}
}

func (s *fakeStore) ReadStream(ctx context.Context, lastID string, count int64, block time.Duration) ([]StreamEvent, error) {
	s.mu.Lock()
	call := s.reads
	s.reads++
	s.lastIDs = append(s.lastIDs, lastID)
	var batch []StreamEvent
	if call < len(s.batches) {
		batch = s.batches[call]
	}
	err := s.readErr
	hook := s.readHook
	s.mu.Unlock()

	if hook != nil {
		hook(call)
	}
	if err != nil {
		return nil, err
	}
	if batch != nil {
		return batch, nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (s *fakeStore) GetJobMeta(_ context.Context, jobID string) (JobMeta, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.metaErr != nil {
		return JobMeta{}, false, s.metaErr
	}
	meta, found := s.metas[jobID]
	return meta, found, nil
}

func (s *fakeStore) GetJob(_ context.Context, jobID string) (*bullmqwire.Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.jobErr != nil {
		return nil, s.jobErr
	}
	return s.jobs[jobID], nil
}

func (s *fakeStore) UpsertJobMetaAndCount(_ context.Context, input UpsertJobMetaInput) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.upsertErrs[input.JobID]; err != nil {
		return err
	}
	s.upserts = append(s.upserts, input)
	s.metas[input.JobID] = input.Meta
	return nil
}

func (s *fakeStore) TransitionTerminalAndRemove(_ context.Context, jobID, orgID string, status JobStatus) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.terminals = append(s.terminals, terminalCall{jobID: jobID, orgID: orgID, status: status})
	delete(s.metas, jobID)
	return nil
}

func (s *fakeStore) RemoveJob(_ context.Context, orgID, jobID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removals = append(s.removals, removeCall{orgID: orgID, jobID: jobID})
	delete(s.metas, jobID)
	return nil
}

func (s *fakeStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *fakeStore) readCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads
}

func (s *fakeStore) lastIDCalls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.lastIDs...)
}

func (s *fakeStore) recordedUpserts() []UpsertJobMetaInput {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]UpsertJobMetaInput(nil), s.upserts...)
}

func (s *fakeStore) recordedTerminals() []terminalCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]terminalCall(nil), s.terminals...)
}

func (s *fakeStore) recordedRemovals() []removeCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]removeCall(nil), s.removals...)
}

func (s *fakeStore) wasClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// fakeLease is the cronlock surface. It never talks to Redis: acquired selects
// the owner answer and leaseCtx is the context whose cancellation simulates a
// lost lease.
type fakeLease struct {
	mu       sync.Mutex
	acquired bool
	err      error
	calls    int
	keys     []string
	ttls     []time.Duration
	onCall   func(call int)
	leaseCtx context.CancelFunc
}

func (l *fakeLease) WithRenewableLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	l.mu.Lock()
	l.calls++
	l.keys = append(l.keys, key)
	l.ttls = append(l.ttls, ttl)
	call := l.calls
	acquired := l.acquired
	err := l.err
	hook := l.onCall
	l.mu.Unlock()

	if hook != nil {
		hook(call)
	}
	if err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	l.mu.Lock()
	l.leaseCtx = cancel
	l.mu.Unlock()
	defer cancel()
	return true, runner(runCtx)
}

// loseLease cancels the runner context, which is what
// cronlock.WithRenewableLock does when a renewal fails.
func (l *fakeLease) loseLease() {
	l.mu.Lock()
	cancel := l.leaseCtx
	l.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (l *fakeLease) callCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

func (l *fakeLease) lastKey() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.keys) == 0 {
		return ""
	}
	return l.keys[len(l.keys)-1]
}

func (l *fakeLease) lastTTL() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.ttls) == 0 {
		return 0
	}
	return l.ttls[len(l.ttls)-1]
}

// waitUntil polls condition for at most timeout; the tracker runs in its own
// goroutine, so the assertions on its side effects are eventually consistent.
func waitUntil(t *testing.T, timeout time.Duration, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s did not happen within %s", what, timeout)
}

func TestStatusForEvent(t *testing.T) {
	cases := []struct {
		event string
		want  JobStatus
		ok    bool
	}{
		{eventWaiting, JobStatusWaiting, true},
		{eventDelayed, JobStatusDelayed, true},
		{eventActive, JobStatusActive, true},
		{eventCompleted, JobStatusCompleted, true},
		{eventFailed, JobStatusFailed, true},
		{eventRemoved, "", false},
		{"progress", "", false},
		{"", "", false},
	}
	for _, testCase := range cases {
		status, ok := statusForEvent(testCase.event)
		if ok != testCase.ok || status != testCase.want {
			t.Fatalf("statusForEvent(%q) = (%q, %t), want (%q, %t)",
				testCase.event, status, ok, testCase.want, testCase.ok)
		}
	}
}

func TestSelectTransition(t *testing.T) {
	cases := []struct {
		name   string
		meta   JobMeta
		status JobStatus
		want   transitionAction
	}{
		{
			name:   "repeated status is a no-op",
			meta:   JobMeta{Status: JobStatusActive, KeepCompleted: true, KeepFailed: true},
			status: JobStatusActive,
			want:   transitionSkip,
		},
		{
			name:   "completed without retention counts then removes the meta",
			meta:   JobMeta{Status: JobStatusActive, KeepCompleted: false, KeepFailed: true},
			status: JobStatusCompleted,
			want:   transitionTerminalRemove,
		},
		{
			name:   "completed with retention is a plain transition",
			meta:   JobMeta{Status: JobStatusActive, KeepCompleted: true, KeepFailed: true},
			status: JobStatusCompleted,
			want:   transitionUpsert,
		},
		{
			name:   "failed without retention counts then removes the meta",
			meta:   JobMeta{Status: JobStatusActive, KeepCompleted: true, KeepFailed: false},
			status: JobStatusFailed,
			want:   transitionTerminalRemove,
		},
		{
			name:   "failed with retention is a plain transition",
			meta:   JobMeta{Status: JobStatusActive, KeepCompleted: true, KeepFailed: true},
			status: JobStatusFailed,
			want:   transitionUpsert,
		},
		{
			name:   "non-terminal change is a plain transition even without retention",
			meta:   JobMeta{Status: JobStatusWaiting, KeepCompleted: false, KeepFailed: false},
			status: JobStatusActive,
			want:   transitionUpsert,
		},
		{
			name:   "delayed to waiting is a plain transition",
			meta:   JobMeta{Status: JobStatusDelayed, KeepCompleted: false, KeepFailed: false},
			status: JobStatusWaiting,
			want:   transitionUpsert,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := selectTransition(testCase.meta, testCase.status); got != testCase.want {
				t.Fatalf("selectTransition = %d, want %d", got, testCase.want)
			}
		})
	}
}

func TestHandleEventDispatchesTransitions(t *testing.T) {
	store := newFakeStore()
	store.metas["job-completed"] = JobMeta{
		OrgID: "org-1", Status: JobStatusActive, KeepCompleted: false, KeepFailed: true,
	}
	store.metas["job-removed"] = JobMeta{
		OrgID: "org-2", Status: JobStatusWaiting, KeepCompleted: false, KeepFailed: true,
	}
	store.jobs["job-completed"] = &bullmqwire.Job{
		Data: json.RawMessage(`{"orgId":"org-1"}`),
		Opts: json.RawMessage(`{"removeOnComplete":true}`),
	}
	tracker := newTracker(store, &fakeLease{}, testLogger(), false)
	ctx := context.Background()

	tracker.handleEvent(ctx, StreamEvent{ID: "1-0", Event: eventActive, JobID: "job-completed"})
	if got := len(store.recordedUpserts()); got != 0 {
		t.Fatalf("a repeated active event wrote %d upserts, want 0", got)
	}

	tracker.handleEvent(ctx, StreamEvent{ID: "2-0", Event: eventCompleted, JobID: "job-completed"})
	terminals := store.recordedTerminals()
	if len(terminals) != 1 || terminals[0].status != JobStatusCompleted || terminals[0].orgID != "org-1" {
		t.Fatalf("completed transition = %+v, want one TERMINAL_AND_REMOVE for org-1", terminals)
	}

	tracker.handleEvent(ctx, StreamEvent{ID: "3-0", Event: eventRemoved, JobID: "job-removed"})
	removals := store.recordedRemovals()
	if len(removals) != 1 || removals[0].jobID != "job-removed" || removals[0].orgID != "org-2" {
		t.Fatalf("removed transition = %+v, want one REMOVE_JOB for job-removed", removals)
	}

	// Unknown events, ignored events and entries without a job id change nothing.
	tracker.handleEvent(ctx, StreamEvent{ID: "4-0", Event: "progress", JobID: "job-completed"})
	tracker.handleEvent(ctx, StreamEvent{ID: "5-0", Event: eventFailed, JobID: ""})
	if got := len(store.recordedUpserts()); got != 0 {
		t.Fatalf("ignored events wrote %d upserts, want 0", got)
	}
	if got := len(store.recordedTerminals()); got != 1 {
		t.Fatalf("ignored events wrote %d terminals, want 1", got)
	}
}

func TestTrackTransitionCreatesMetaFromJobHash(t *testing.T) {
	cases := []struct {
		name          string
		opts          string
		keepCompleted bool
		keepFailed    bool
	}{
		{
			name:          "removeOnComplete true means the completed job is not retained",
			opts:          `{"removeOnComplete":true,"removeOnFail":{"age":604800,"count":10000}}`,
			keepCompleted: false,
			keepFailed:    true,
		},
		{
			name:          "zero age and count means the failed job is not retained",
			opts:          `{"removeOnComplete":{"age":0,"count":0},"removeOnFail":{"age":0,"count":0}}`,
			keepCompleted: false,
			keepFailed:    false,
		},
		{
			name:          "a positive number keeps the job",
			opts:          `{"removeOnComplete":5,"removeOnFail":10000}`,
			keepCompleted: true,
			keepFailed:    true,
		},
		{
			name:          "a missing option keeps the job (BullMQ default)",
			opts:          `{}`,
			keepCompleted: true,
			keepFailed:    true,
		},
		{
			name:          "an explicit false keeps the job",
			opts:          `{"removeOnComplete":false,"removeOnFail":false}`,
			keepCompleted: true,
			keepFailed:    true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			store := newFakeStore()
			store.jobs["job-1"] = &bullmqwire.Job{
				Data: json.RawMessage(`{"orgId":"org-1","pipelineJobId":"pipe-1"}`),
				Opts: json.RawMessage(testCase.opts),
			}
			tracker := newTracker(store, &fakeLease{}, testLogger(), false)

			tracker.trackTransition(context.Background(), "job-1", JobStatusWaiting)

			upserts := store.recordedUpserts()
			if len(upserts) != 1 {
				t.Fatalf("upserts = %d, want 1", len(upserts))
			}
			got := upserts[0]
			if got.JobID != "job-1" || got.Meta.OrgID != "org-1" || got.Meta.Status != JobStatusWaiting {
				t.Fatalf("upsert = %+v, want job-1/org-1/waiting", got)
			}
			if got.Meta.KeepCompleted != testCase.keepCompleted || got.Meta.KeepFailed != testCase.keepFailed {
				t.Fatalf("keep flags = (%t, %t), want (%t, %t)",
					got.Meta.KeepCompleted, got.Meta.KeepFailed, testCase.keepCompleted, testCase.keepFailed)
			}
		})
	}
}

func TestTrackTransitionSkipsUnknownJobs(t *testing.T) {
	cases := []struct {
		name string
		job  *bullmqwire.Job
	}{
		{name: "the job hash is already removed", job: nil},
		{name: "the job payload has no org", job: &bullmqwire.Job{Data: json.RawMessage(`{"pipelineJobId":"pipe-1"}`)}},
		{name: "the job payload has an empty org", job: &bullmqwire.Job{Data: json.RawMessage(`{"orgId":""}`)}},
		{name: "the job payload is not an object", job: &bullmqwire.Job{Data: json.RawMessage(`"text"`)}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			store := newFakeStore()
			if testCase.job != nil {
				store.jobs["job-1"] = testCase.job
			}
			tracker := newTracker(store, &fakeLease{}, testLogger(), false)

			tracker.trackTransition(context.Background(), "job-1", JobStatusActive)

			if got := len(store.recordedUpserts()); got != 0 {
				t.Fatalf("upserts = %d, want 0 for a job without org context", got)
			}
		})
	}
}

func TestTrackTransitionWithExistingMeta(t *testing.T) {
	store := newFakeStore()
	store.metas["job-1"] = JobMeta{
		OrgID: "org-1", Status: JobStatusWaiting, KeepCompleted: true, KeepFailed: true,
	}
	tracker := newTracker(store, &fakeLease{}, testLogger(), false)
	ctx := context.Background()

	tracker.trackTransition(ctx, "job-1", JobStatusWaiting)
	if got := len(store.recordedUpserts()); got != 0 {
		t.Fatalf("a repeated status wrote %d upserts, want 0", got)
	}

	tracker.trackTransition(ctx, "job-1", JobStatusActive)
	upserts := store.recordedUpserts()
	if len(upserts) != 1 || upserts[0].Meta.Status != JobStatusActive || upserts[0].Meta.OrgID != "org-1" {
		t.Fatalf("upserts = %+v, want one active transition for org-1", upserts)
	}
	if !upserts[0].Meta.KeepCompleted || !upserts[0].Meta.KeepFailed {
		t.Fatalf("the existing keep flags must be carried over, got %+v", upserts[0].Meta)
	}

	tracker.trackTransition(ctx, "job-1", JobStatusDelayed)
	if got := len(store.recordedUpserts()); got != 2 {
		t.Fatalf("upserts = %d, want 2 after delayed", got)
	}
}

func TestTrackRemoval(t *testing.T) {
	store := newFakeStore()
	store.metas["job-1"] = JobMeta{
		OrgID: "org-1", Status: JobStatusWaiting, KeepCompleted: false, KeepFailed: true,
	}
	tracker := newTracker(store, &fakeLease{}, testLogger(), false)
	ctx := context.Background()

	tracker.trackRemoval(ctx, "job-1")
	removals := store.recordedRemovals()
	if len(removals) != 1 || removals[0] != (removeCall{orgID: "org-1", jobID: "job-1"}) {
		t.Fatalf("removals = %+v, want one REMOVE_JOB for org-1/job-1", removals)
	}

	// A removed job without metadata was never counted (or was already dropped
	// by the terminal path), so the removal must not touch the counters again.
	tracker.trackRemoval(ctx, "job-2")
	if got := len(store.recordedRemovals()); got != 1 {
		t.Fatalf("removals = %d, want 1 for a job without metadata", got)
	}
}

func TestTrackTransitionFailureDoesNotAbortTheEventLoop(t *testing.T) {
	store := newFakeStore()
	store.upsertErrs["job-broken"] = errors.New("redis is down")
	store.jobs["job-broken"] = &bullmqwire.Job{Data: json.RawMessage(`{"orgId":"org-1"}`)}
	store.jobs["job-good"] = &bullmqwire.Job{Data: json.RawMessage(`{"orgId":"org-2"}`)}
	store.batches = [][]StreamEvent{{
		{ID: "1-0", Event: eventWaiting, JobID: "job-broken"},
		{ID: "2-0", Event: eventWaiting, JobID: "job-good"},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store.readHook = func(call int) {
		if call == 1 {
			cancel()
		}
	}
	tracker := newTracker(store, &fakeLease{}, testLogger(), false)
	tracker.readRetryDelay = time.Millisecond

	tracker.readEvents(ctx)

	upserts := store.recordedUpserts()
	if len(upserts) != 1 || upserts[0].JobID != "job-good" {
		t.Fatalf("upserts = %+v, want only job-good (a failed event must not stop the loop)", upserts)
	}
	if got := store.readCount(); got != 2 {
		t.Fatalf("reads = %d, want 2 (the batch and the read that observed the cancelled context)", got)
	}
}

func TestReadEventsAdvancesTheCursor(t *testing.T) {
	store := newFakeStore()
	store.metas["job-1"] = JobMeta{OrgID: "org-1", Status: JobStatusWaiting, KeepCompleted: false, KeepFailed: true}
	store.jobs["job-2"] = &bullmqwire.Job{Data: json.RawMessage(`{"orgId":"org-2"}`)}
	store.batches = [][]StreamEvent{
		{{ID: "1-0", Event: eventActive, JobID: "job-1"}},
		{
			{ID: "2-0", Event: eventWaiting, JobID: "job-2"},
			{ID: "3-0", Event: "progress", JobID: "job-2"},
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store.readHook = func(call int) {
		if call == 2 {
			cancel()
		}
	}
	tracker := newTracker(store, &fakeLease{}, testLogger(), false)

	tracker.readEvents(ctx)

	want := []string{"$", "1-0", "3-0"}
	got := store.lastIDCalls()
	if len(got) != len(want) {
		t.Fatalf("XREAD cursors = %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("XREAD cursors = %v, want %v", got, want)
		}
	}
}

func TestAcquireAndReadSkipsReadsWhenNotTheOwner(t *testing.T) {
	store := newFakeStore()
	lease := &fakeLease{acquired: false}
	tracker := newTracker(store, lease, testLogger(), false)

	acquired, err := tracker.acquireAndRead(context.Background())
	if err != nil {
		t.Fatalf("acquireAndRead: %v", err)
	}
	if acquired {
		t.Fatal("acquireAndRead must report acquired=false for a foreign lease")
	}
	if got := store.readCount(); got != 0 {
		t.Fatalf("reads = %d, want 0 while another instance owns the lease", got)
	}
	if lease.lastKey() != lockName {
		t.Fatalf("lease key = %q, want %q", lease.lastKey(), lockName)
	}
	if lease.lastTTL() != lockTTL {
		t.Fatalf("lease ttl = %s, want %s", lease.lastTTL(), lockTTL)
	}
}

func TestAcquireAndReadStopsWhenTheLeaseIsLost(t *testing.T) {
	store := newFakeStore()
	store.jobs["job-1"] = &bullmqwire.Job{Data: json.RawMessage(`{"orgId":"org-1"}`)}
	store.batches = [][]StreamEvent{{{ID: "1-0", Event: eventWaiting, JobID: "job-1"}}}
	lease := &fakeLease{acquired: true}
	store.readHook = func(call int) {
		if call == 0 {
			// cronlock cancels the runner context when a renewal fails; the
			// read loop must observe it and stop instead of reading again.
			lease.loseLease()
		}
	}
	tracker := newTracker(store, lease, testLogger(), false)

	acquired, err := tracker.acquireAndRead(context.Background())
	if err != nil {
		t.Fatalf("acquireAndRead: %v", err)
	}
	if !acquired {
		t.Fatal("acquireAndRead must report acquired=true")
	}
	if got := store.readCount(); got != 1 {
		t.Fatalf("reads = %d, want exactly 1 after the lease was lost", got)
	}

	// The next ownership attempt finds another owner and must not read either.
	lease.mu.Lock()
	lease.acquired = false
	lease.mu.Unlock()
	acquired, err = tracker.acquireAndRead(context.Background())
	if err != nil || acquired {
		t.Fatalf("second acquireAndRead = (%t, %v), want (false, nil)", acquired, err)
	}
	if got := store.readCount(); got != 1 {
		t.Fatalf("reads = %d, want 1 after the second attempt", got)
	}
}

func TestRunCompetesAgainAfterLosingTheLease(t *testing.T) {
	store := newFakeStore()
	store.jobs["job-1"] = &bullmqwire.Job{Data: json.RawMessage(`{"orgId":"org-1"}`)}
	store.batches = [][]StreamEvent{{{ID: "1-0", Event: eventWaiting, JobID: "job-1"}}}
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()

	lease := &fakeLease{acquired: true}
	store.readHook = func(call int) {
		if call == 0 {
			// Lose the lease after the first batch: the loop must stop reading
			// and compete again.
			lease.mu.Lock()
			lease.acquired = false
			lease.mu.Unlock()
			lease.loseLease()
		}
	}
	lease.onCall = func(call int) {
		if call == 2 {
			cancelParent()
		}
	}
	tracker := newTracker(store, lease, testLogger(), false)
	tracker.retryDelay = time.Millisecond
	tracker.readRetryDelay = time.Millisecond

	if err := tracker.Start(parent); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitUntil(t, 5*time.Second, "the tracker to compete for the lease again", func() bool {
		return lease.callCount() >= 2
	})
	if err := tracker.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !store.wasClosed() {
		t.Fatal("Close must close the blocking store")
	}
	if got := store.readCount(); got != 1 {
		t.Fatalf("reads = %d, want 1 (a foreign lease must not read)", got)
	}
	if got := len(store.recordedUpserts()); got != 1 {
		t.Fatalf("upserts = %d, want the one event before the lease was lost", got)
	}
}

func TestRunToleratesLeaseErrors(t *testing.T) {
	store := newFakeStore()
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	lease := &fakeLease{err: errors.New("redis is down")}
	lease.onCall = func(call int) {
		if call == 3 {
			cancelParent()
		}
	}
	tracker := newTracker(store, lease, testLogger(), false)
	tracker.retryDelay = time.Millisecond

	if err := tracker.Start(parent); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitUntil(t, 5*time.Second, "the tracker to retry the lease", func() bool {
		return lease.callCount() >= 3
	})
	if err := tracker.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := store.readCount(); got != 0 {
		t.Fatalf("reads = %d, want 0 when the lease cannot be acquired", got)
	}
}

func TestNewRequiresRedisAndBlockingOptions(t *testing.T) {
	if _, err := New(Options{}); !errors.Is(err, ErrNoRedis) {
		t.Fatalf("New without redis = %v, want ErrNoRedis", err)
	}
	if _, err := New(Options{Redis: redis.NewClient(&redis.Options{Addr: "127.0.0.1:0"})}); !errors.Is(err, ErrNoBlockingOptions) {
		t.Fatalf("New without blocking options = %v, want ErrNoBlockingOptions", err)
	}
}

func TestStartErrors(t *testing.T) {
	if err := newTracker(nil, &fakeLease{}, testLogger(), false).Start(context.Background()); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("Start without a store = %v, want ErrNotConfigured", err)
	}
	tracker := newTracker(newFakeStore(), &fakeLease{}, testLogger(), false)
	if err := tracker.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := tracker.Start(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Start after Close = %v, want ErrClosed", err)
	}
}

func TestStartIsIdempotent(t *testing.T) {
	store := newFakeStore()
	lease := &fakeLease{acquired: false}
	tracker := newTracker(store, lease, testLogger(), false)
	if err := tracker.Start(context.Background()); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if err := tracker.Start(context.Background()); err != nil {
		t.Fatalf("second Start: %v", err)
	}
	if err := tracker.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestKeepFlag(t *testing.T) {
	if keepFlag(true) != keepFlagTrue || keepFlag(false) != keepFlagFalse {
		t.Fatalf("keepFlag = (%q, %q), want (%q, %q)", keepFlag(true), keepFlag(false), keepFlagTrue, keepFlagFalse)
	}
}

// TestScriptsMatchNestSource pins the three scripts to the SHA-256 of the
// template literals in apps/api/src/modules/queue/queue-org-stats.service.ts.
// They are copied byte for byte (including the leading newline and the two-space
// indentation), because the counters are shared with the NestJS readers.
func TestScriptsMatchNestSource(t *testing.T) {
	cases := []struct {
		name   string
		script string
		digest string
	}{
		{
			name:   "UPSERT_AND_TRANSITION_LUA",
			script: upsertAndTransitionScript,
			digest: "c077003c4d10ac1296d94ebc4371e633ce9723ddad7133aa16639599530f3b5c",
		},
		{
			name:   "REMOVE_JOB_LUA",
			script: removeJobScript,
			digest: "4c07baa8f280ab550318118264f90ea5880757b14986ba875202355884057117",
		},
		{
			name:   "TERMINAL_AND_REMOVE_LUA",
			script: terminalAndRemoveScript,
			digest: "93725e9889bd468c1b6d3ae7865db4533a63bde0939a87262021b2cd1a8a4d04",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			sum := sha256.Sum256([]byte(testCase.script))
			if got := hex.EncodeToString(sum[:]); got != testCase.digest {
				t.Fatalf("%s sha256 = %s, want %s (the NestJS script changed or the copy drifted)",
					testCase.name, got, testCase.digest)
			}
			if len(testCase.script) == 0 || testCase.script[0] != '\n' {
				t.Fatalf("%s must keep the leading newline of the template literal", testCase.name)
			}
		})
	}
}

func TestMetaAndCountsKeys(t *testing.T) {
	if got := metaKey("42"); got != "queue:itemPipeline:job:42:meta" {
		t.Fatalf("metaKey = %q", got)
	}
	if got := countsKey("org-1"); got != "queue:itemPipeline:org:org-1:counts" {
		t.Fatalf("countsKey = %q", got)
	}
	if queueKeys.Events != "bull:itemPipeline:events" {
		t.Fatalf("event stream key = %q", queueKeys.Events)
	}
}
