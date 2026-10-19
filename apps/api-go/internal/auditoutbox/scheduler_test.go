package auditoutbox

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"
)

// TestMergeCandidatesKeepsNestOrderingAndLimit covers the selection contract:
// per-status reads already apply createdAt/id ordering and the 200 limit; the
// merge keeps the first occurrence per id (pending, failed, stale processing),
// then sorts globally and cuts to 200.
func TestMergeCandidatesKeepsNestOrderingAndLimit(t *testing.T) {
	base := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)
	build := func(prefix string, count int, start int) []Candidate {
		group := make([]Candidate, 0, count)
		for index := 0; index < count; index++ {
			group = append(group, Candidate{
				ID:        prefix + "-" + strconv.Itoa(index),
				OrgID:     "org-1",
				Status:    StatusPending,
				CreatedAt: base.Add(time.Duration(start+index) * time.Second),
			})
		}
		return group
	}

	pending := build("p", 200, 0)
	failed := build("f", 200, 50)
	stale := build("s", 200, 100)
	// A duplicate id across groups must keep the first occurrence (pending).
	failed[10].ID = pending[10].ID
	failed[10].Status = StatusFailed

	merged := mergeCandidates([][]Candidate{pending, failed, stale}, 200)
	if len(merged) != 200 {
		t.Fatalf("merged length = %d, want 200", len(merged))
	}
	for index := 1; index < len(merged); index++ {
		previous, current := merged[index-1], merged[index]
		if current.CreatedAt.Before(previous.CreatedAt) {
			t.Fatalf("candidate %d is out of order: %s before %s", index, current.CreatedAt, previous.CreatedAt)
		}
		if current.CreatedAt.Equal(previous.CreatedAt) && current.ID < previous.ID {
			t.Fatalf("candidate %d breaks the id tie-breaker", index)
		}
	}
	seen := make(map[string]struct{}, len(merged))
	for _, candidate := range merged {
		if _, ok := seen[candidate.ID]; ok {
			t.Fatalf("duplicate id %q survived the merge", candidate.ID)
		}
		seen[candidate.ID] = struct{}{}
	}
	for _, candidate := range merged {
		if candidate.ID == pending[10].ID {
			if candidate.Status != StatusPending {
				t.Fatalf("duplicate id kept status %q, want the first occurrence pending", candidate.Status)
			}
			break
		}
	}
}

// TestRunTickSkipsWhenLeaseHeld proves the cron lease is the only gate: a held
// lease means no scan and no release of someone else's lease.
func TestRunTickSkipsWhenLeaseHeld(t *testing.T) {
	repo := &fakeRepository{}
	locks := &fakeLockStore{acquired: false}
	scheduler := newTestScheduler(repo, locks, time.Now)

	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if repo.totalListCalls() != 0 {
		t.Fatalf("list calls = %d, want 0", repo.totalListCalls())
	}
	if locks.releaseCalls != 0 {
		t.Fatalf("release calls = %d, want 0", locks.releaseCalls)
	}
}

// TestRunTickMarksTenantMismatchDead covers the tenant check: a payload whose
// orgId differs from the outbox row never inserts an AuditLog row and is parked
// as dead with the original attempts+1.
func TestRunTickMarksTenantMismatchDead(t *testing.T) {
	candidate := Candidate{
		ID:        "outbox-1",
		OrgID:     "org-row",
		Status:    StatusPending,
		Attempts:  2,
		CreatedAt: time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC),
	}
	repo := &fakeRepository{
		pending: []Candidate{candidate},
		payloads: map[string]json.RawMessage{
			candidate.ID: json.RawMessage(`{"orgId":"org-other","resource":"audit","action":"create","createdAt":"2026-10-19T10:00:00.000Z"}`),
		},
	}
	locks := &fakeLockStore{acquired: true}
	scheduler := newTestScheduler(repo, locks, time.Now)

	if err := scheduler.runTick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(repo.claimCalls) != 0 || len(repo.inserted) != 0 {
		t.Fatalf("claim calls = %d insert calls = %d, want 0", len(repo.claimCalls), len(repo.inserted))
	}
	payloadIDs := repo.payloadIDSnapshot()
	if len(payloadIDs) != 1 || payloadIDs[0] != candidate.ID {
		t.Fatalf("payload preload ids = %v, want only the selected candidate", payloadIDs)
	}
	dead := repo.deadSnapshot()
	if len(dead) != 1 {
		t.Fatalf("dead updates = %d, want 1", len(dead))
	}
	if dead[0].Attempts != 3 || dead[0].Message != invalidPayloadMessage {
		t.Fatalf("dead update = %+v", dead[0])
	}
	if locks.releaseCalls != 1 {
		t.Fatalf("release calls = %d, want 1", locks.releaseCalls)
	}
}

// TestDeliverDeduplicatesExistingAuditLog covers the at-least-once retry: when
// the identity already exists, the row is not inserted again but the outbox row
// is still deleted.
func TestDeliverDeduplicatesExistingAuditLog(t *testing.T) {
	candidate := Candidate{ID: "outbox-1", OrgID: "org-1", Status: StatusFailed, Attempts: 3}
	payload := &normalizedPayload{
		OrgID:     "org-1",
		ActorID:   strPtr("user-1"),
		Resource:  "audit",
		Action:    "create",
		CreatedAt: time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC),
	}
	repo := &fakeRepository{
		claimed:    &Claimed{ID: candidate.ID, OrgID: candidate.OrgID, Attempts: 4},
		existingID: "audit-1",
	}
	scheduler := newTestScheduler(repo, &fakeLockStore{}, time.Now)

	if err := scheduler.deliver(context.Background(), candidate, payload); err != nil {
		t.Fatal(err)
	}
	if len(repo.inserted) != 0 {
		t.Fatalf("insert calls = %d, want 0", len(repo.inserted))
	}
	if len(repo.deleteCalls) != 1 || repo.deleteCalls[0] != candidate.ID {
		t.Fatalf("delete calls = %v", repo.deleteCalls)
	}
}

// TestDeliverLosingClaimSkipsWrites covers claim competition: zero affected
// rows means another executor owns the entry, so nothing else runs.
func TestDeliverLosingClaimSkipsWrites(t *testing.T) {
	candidate := Candidate{ID: "outbox-1", OrgID: "org-1", Status: StatusPending}
	payload := &normalizedPayload{OrgID: "org-1", Resource: "audit", Action: "create"}
	repo := &fakeRepository{claimed: nil}
	scheduler := newTestScheduler(repo, &fakeLockStore{}, time.Now)

	if err := scheduler.deliver(context.Background(), candidate, payload); err != nil {
		t.Fatal(err)
	}
	if repo.findCalls != 0 || len(repo.inserted) != 0 || len(repo.deleteCalls) != 0 {
		t.Fatalf("find = %d insert = %d delete = %d, want 0", repo.findCalls, len(repo.inserted), len(repo.deleteCalls))
	}
}

// TestDeliverFailureBackoffAndDead covers the attempts read from the claim: a
// ninth failure is rescheduled with the capped exponential delay, a tenth is
// parked as dead.
func TestDeliverFailureBackoffAndDead(t *testing.T) {
	now := time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC)
	payload := &normalizedPayload{
		OrgID:     "org-1",
		Resource:  "audit",
		Action:    "create",
		CreatedAt: now,
	}

	repo := &fakeRepository{
		claimed: &Claimed{Attempts: 9},
		findErr: errors.New("ledger unavailable"),
	}
	scheduler := newTestScheduler(repo, &fakeLockStore{}, func() time.Time { return now })
	scheduler.deps.Rand = func() float64 { return 0.5 }
	candidate := Candidate{ID: "outbox-1", OrgID: "org-1", Status: StatusPending}

	if err := scheduler.deliver(context.Background(), candidate, payload); err != nil {
		t.Fatal(err)
	}
	failed := repo.failedSnapshot()
	if len(failed) != 1 {
		t.Fatalf("failed updates = %d, want 1", len(failed))
	}
	if failed[0].Attempts != 9 || failed[0].Message != "ledger unavailable" {
		t.Fatalf("failed update = %+v", failed[0])
	}
	if want := now.Add(8 * time.Minute); !failed[0].AvailableAt.Equal(want) {
		t.Fatalf("availableAt = %s, want %s", failed[0].AvailableAt, want)
	}

	repo = &fakeRepository{
		claimed: &Claimed{Attempts: 10},
		findErr: errors.New("ledger unavailable"),
	}
	scheduler = newTestScheduler(repo, &fakeLockStore{}, func() time.Time { return now })
	if err := scheduler.deliver(context.Background(), candidate, payload); err != nil {
		t.Fatal(err)
	}
	if len(repo.failedSnapshot()) != 0 {
		t.Fatalf("failed update written at the attempt limit")
	}
	dead := repo.deadSnapshot()
	if len(dead) != 1 || dead[0].Attempts != 10 || dead[0].Message != "ledger unavailable" {
		t.Fatalf("dead update = %+v", dead)
	}
}

// TestCloseStopsNewClaims proves shutdown stops new entries without deleting
// anything: the stop signal drains the worker pool before any claim.
func TestCloseStopsNewClaims(t *testing.T) {
	repo := &fakeRepository{}
	scheduler := newTestScheduler(repo, &fakeLockStore{acquired: true}, time.Now)
	scheduler.Start(context.Background())
	closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := scheduler.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	if !scheduler.stopped() {
		t.Fatal("scheduler is not stopped after Close")
	}
	scheduler.processCandidates(context.Background(), []Candidate{
		{ID: "outbox-1", OrgID: "org-1", Status: StatusPending},
	}, map[string]json.RawMessage{})
	if len(repo.claimCalls) != 0 {
		t.Fatalf("claim calls = %d after Close, want 0", len(repo.claimCalls))
	}
}

func newTestScheduler(repo *fakeRepository, locks *fakeLockStore, now func() time.Time) *Scheduler {
	return NewScheduler(Deps{
		Repository: repo,
		Locks:      locks,
		Now:        now,
		Rand:       func() float64 { return 0.5 },
	})
}

// fakeRepository records every call under a mutex so the concurrent workers can
// use one instance.
type fakeRepository struct {
	mu sync.Mutex

	pending []Candidate
	failed  []Candidate
	stale   []Candidate

	listCalls int
	payloads  map[string]json.RawMessage
	// payloadIDCalls records each payload preload request so a test can assert
	// the read is scoped to the selected candidates.
	payloadIDCalls [][]string

	claimed  *Claimed
	claimErr error

	claimCalls []Candidate
	findCalls  int
	findErr    error
	existingID string

	inserted     []AuditLogEntry
	deleteCalls  []string
	failedWrites []StatusUpdate
	deadWrites   []StatusUpdate
}

func (r *fakeRepository) ListPending(context.Context, time.Time, int) ([]Candidate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls++
	return r.pending, nil
}

func (r *fakeRepository) ListFailed(context.Context, time.Time, int) ([]Candidate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls++
	return r.failed, nil
}

func (r *fakeRepository) ListStaleProcessing(context.Context, time.Time, int) ([]Candidate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.listCalls++
	return r.stale, nil
}

func (r *fakeRepository) LoadPayloads(_ context.Context, ids []string) (map[string]json.RawMessage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.payloadIDCalls = append(r.payloadIDCalls, append([]string(nil), ids...))
	return r.payloads, nil
}

func (r *fakeRepository) Claim(_ context.Context, candidate Candidate) (*Claimed, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.claimCalls = append(r.claimCalls, candidate)
	return r.claimed, r.claimErr
}

func (r *fakeRepository) FindAuditLog(context.Context, AuditIdentity) (string, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.findCalls++
	if r.findErr != nil {
		return "", false, r.findErr
	}
	if r.existingID != "" {
		return r.existingID, true, nil
	}
	return "", false, nil
}

func (r *fakeRepository) InsertAuditLog(_ context.Context, entry AuditLogEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.inserted = append(r.inserted, entry)
	return nil
}

func (r *fakeRepository) DeleteOutbox(_ context.Context, id, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deleteCalls = append(r.deleteCalls, id)
	return nil
}

func (r *fakeRepository) MarkFailed(_ context.Context, update StatusUpdate) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.failedWrites = append(r.failedWrites, update)
	return nil
}

func (r *fakeRepository) MarkDead(_ context.Context, update StatusUpdate) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deadWrites = append(r.deadWrites, update)
	return nil
}

func (r *fakeRepository) totalListCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.listCalls
}

func (r *fakeRepository) failedSnapshot() []StatusUpdate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StatusUpdate(nil), r.failedWrites...)
}

func (r *fakeRepository) deadSnapshot() []StatusUpdate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]StatusUpdate(nil), r.deadWrites...)
}

func (r *fakeRepository) payloadIDSnapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.payloadIDCalls) == 0 {
		return nil
	}
	return r.payloadIDCalls[0]
}

// fakeLockStore records the cron lease calls.
type fakeLockStore struct {
	acquired     bool
	releaseCalls int
	renewCalls   int
}

func (s *fakeLockStore) SetIfAbsent(context.Context, string, string, time.Duration) (bool, error) {
	return s.acquired, nil
}

func (s *fakeLockStore) RenewLock(context.Context, string, string, time.Duration) error {
	s.renewCalls++
	return nil
}

func (s *fakeLockStore) ReleaseLock(context.Context, string, string) error {
	s.releaseCalls++
	return nil
}
