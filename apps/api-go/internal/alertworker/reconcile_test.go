package alertworker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"sync"
	"testing"
	"time"
)

// callRecorder keeps the order of the reconciliation side effects.
type callRecorder struct {
	mu     sync.Mutex
	events []string
}

func (r *callRecorder) add(event string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *callRecorder) snapshot() []string {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.events...)
}

// fakeRuleSource is the keyset-paginated AlertRule read. pageSize caps the page
// below the caller's limit so the pagination loop is testable with a handful of
// rules; the rules are returned in id order, like the SQL ORDER BY id.
type fakeRuleSource struct {
	mu       sync.Mutex
	rules    []activeRule
	pageSize int
	err      error
	cursors  []string
	batches  int
}

func (s *fakeRuleSource) listActiveRuleBatch(_ context.Context, afterID string, limit int) ([]activeRule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cursors = append(s.cursors, afterID)
	s.batches++
	if s.err != nil {
		return nil, s.err
	}
	size := limit
	if s.pageSize > 0 && s.pageSize < size {
		size = s.pageSize
	}
	page := make([]activeRule, 0, size)
	for _, rule := range s.rules {
		if rule.ID <= afterID {
			continue
		}
		page = append(page, rule)
		if len(page) == size {
			break
		}
	}
	return page, nil
}

func (s *fakeRuleSource) recordedCursors() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.cursors...)
}

func (s *fakeRuleSource) batchCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.batches
}

// scheduleCall is one recorded EnsureRuleSchedule call.
type scheduleCall struct {
	ruleID   string
	orgID    string
	interval int
}

// fakeScheduleWriter records the producer calls and can fail selected rules.
type fakeScheduleWriter struct {
	mu          sync.Mutex
	recorder    *callRecorder
	calls       []scheduleCall
	intervals   map[string]int
	errs        map[string]error
	delay       time.Duration
	inFlight    int
	maxInFlight int
}

func newFakeScheduleWriter() *fakeScheduleWriter {
	return &fakeScheduleWriter{intervals: map[string]int{}, errs: map[string]error{}}
}

func (w *fakeScheduleWriter) EnsureRuleSchedule(_ context.Context, ruleID, orgID string, checkIntervalSec int) error {
	w.mu.Lock()
	w.inFlight++
	if w.inFlight > w.maxInFlight {
		w.maxInFlight = w.inFlight
	}
	delay := w.delay
	err := w.errs[ruleID]
	w.mu.Unlock()

	if delay > 0 {
		time.Sleep(delay)
	}

	w.mu.Lock()
	w.inFlight--
	w.calls = append(w.calls, scheduleCall{ruleID: ruleID, orgID: orgID, interval: checkIntervalSec})
	w.intervals[ruleID] = checkIntervalSec
	w.mu.Unlock()
	w.recorder.add("schedule:" + ruleID)
	return err
}

func (w *fakeScheduleWriter) recordedCalls() []scheduleCall {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]scheduleCall(nil), w.calls...)
}

func (w *fakeScheduleWriter) peakInFlight() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.maxInFlight
}

// fakeDefaults records the default-rule pass.
type fakeDefaults struct {
	mu       sync.Mutex
	calls    int
	err      error
	recorder *callRecorder
}

func (d *fakeDefaults) ensure(ctx context.Context) error {
	d.mu.Lock()
	d.calls++
	err := d.err
	d.mu.Unlock()
	if err == nil {
		d.recorder.add("ensureDefaults")
	}
	return err
}

func (d *fakeDefaults) callCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

// fakeRuleScheduleLease is the cronlock surface. acquired selects the owner
// answer; the recorded key and TTL are the lease contract assertions.
type fakeRuleScheduleLease struct {
	mu       sync.Mutex
	acquired bool
	err      error
	calls    int
	key      string
	ttl      time.Duration
}

func (l *fakeRuleScheduleLease) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	l.mu.Lock()
	l.calls++
	l.key = key
	l.ttl = ttl
	acquired := l.acquired
	err := l.err
	l.mu.Unlock()
	if err != nil {
		return false, err
	}
	if !acquired {
		return false, nil
	}
	return true, runner(ctx)
}

func (l *fakeRuleScheduleLease) callCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

// testReconciler builds one reconciler over fakes.
func testReconciler(source *fakeRuleSource, writer *fakeScheduleWriter, lease *fakeRuleScheduleLease, defaults *fakeDefaults, concurrency int) *ruleScheduleReconciler {
	return &ruleScheduleReconciler{
		source:         source,
		writer:         writer,
		lease:          lease,
		ensureDefaults: defaults.ensure,
		concurrency:    concurrency,
		logger:         log.New(io.Discard, "", 0),
	}
}

// activeRules builds count active rules with zero-padded r-00 .. r-N ids and
// matching org ids, so the keyset pagination order is the numeric order.
func activeRules(count int) []activeRule {
	rules := make([]activeRule, 0, count)
	for index := 0; index < count; index++ {
		rules = append(rules, activeRule{
			ID:               "r-" + padRuleID(index),
			OrgID:            "org-" + padRuleID(index),
			CheckIntervalSec: 60 + index,
		})
	}
	return rules
}

func padRuleID(value int) string { return fmt.Sprintf("%02d", value) }

// callsByRule indexes the recorded schedule calls by rule id: the reconciliation
// runs the page with a worker pool, so the completion order is not stable.
func callsByRule(calls []scheduleCall) map[string]scheduleCall {
	byRule := make(map[string]scheduleCall, len(calls))
	for _, call := range calls {
		byRule[call.ruleID] = call
	}
	return byRule
}

func TestReconcileRuleSchedulesCreatesDefaultsThenSchedules(t *testing.T) {
	recorder := &callRecorder{}
	source := &fakeRuleSource{rules: activeRules(3)}
	writer := newFakeScheduleWriter()
	writer.recorder = recorder
	defaults := &fakeDefaults{recorder: recorder}
	lease := &fakeRuleScheduleLease{acquired: true}
	reconciler := testReconciler(source, writer, lease, defaults, 4)

	if err := reconciler.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := defaults.callCount(); got != 1 {
		t.Fatalf("default-rule passes = %d, want 1", got)
	}
	events := recorder.snapshot()
	if len(events) == 0 || events[0] != "ensureDefaults" {
		t.Fatalf("events = %v, want the default-rule pass first", events)
	}
	calls := callsByRule(writer.recordedCalls())
	if len(calls) != 3 {
		t.Fatalf("schedule calls = %d, want 3", len(calls))
	}
	for index := 0; index < 3; index++ {
		ruleID := "r-" + padRuleID(index)
		call, ok := calls[ruleID]
		if !ok {
			t.Fatalf("rule %s was not scheduled, calls = %v", ruleID, calls)
		}
		if call.orgID != "org-"+padRuleID(index) {
			t.Fatalf("call %s org = %q, want %q", ruleID, call.orgID, "org-"+padRuleID(index))
		}
		if call.interval != 60+index {
			t.Fatalf("call %s interval = %d, want %d", ruleID, call.interval, 60+index)
		}
	}
	if lease.callCount() != 1 || lease.key != ruleScheduleReconcileLockName {
		t.Fatalf("lease = (%d, %q), want one %q call", lease.callCount(), lease.key, ruleScheduleReconcileLockName)
	}
	if lease.ttl != ruleScheduleReconcileLockTTL {
		t.Fatalf("lease ttl = %s, want %s", lease.ttl, ruleScheduleReconcileLockTTL)
	}
}

func TestReconcileRuleSchedulesSkipsWhenTheLeaseIsHeld(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(3)}
	writer := newFakeScheduleWriter()
	defaults := &fakeDefaults{}
	lease := &fakeRuleScheduleLease{acquired: false}

	if err := testReconciler(source, writer, lease, defaults, 4).reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := defaults.callCount(); got != 0 {
		t.Fatalf("default-rule passes = %d, want 0 for a foreign lease", got)
	}
	if got := len(writer.recordedCalls()); got != 0 {
		t.Fatalf("schedule calls = %d, want 0 for a foreign lease", got)
	}
	if got := source.batchCount(); got != 0 {
		t.Fatalf("rule reads = %d, want 0 for a foreign lease", got)
	}
}

func TestReconcileRuleSchedulesPaginatesInIDOrder(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(5), pageSize: 2}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{acquired: true}

	if err := testReconciler(source, writer, lease, &fakeDefaults{}, 4).reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	cursors := source.recordedCursors()
	want := []string{"", "r-01", "r-03"}
	if len(cursors) != len(want) {
		t.Fatalf("read cursors = %v, want %v", cursors, want)
	}
	for index := range want {
		if cursors[index] != want[index] {
			t.Fatalf("read cursors = %v, want %v", cursors, want)
		}
	}
	calls := writer.recordedCalls()
	if len(calls) != 5 {
		t.Fatalf("schedule calls = %d, want every active rule exactly once", len(calls))
	}
	seen := map[string]int{}
	for _, call := range calls {
		seen[call.ruleID]++
	}
	for index := 0; index < 5; index++ {
		if seen["r-"+padRuleID(index)] != 1 {
			t.Fatalf("rule r-%s scheduled %d times, want 1", padRuleID(index), seen["r-"+padRuleID(index)])
		}
	}
}

func TestReconcileRuleSchedulesLimitsConcurrency(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(12)}
	writer := newFakeScheduleWriter()
	writer.delay = 5 * time.Millisecond
	lease := &fakeRuleScheduleLease{acquired: true}

	if err := testReconciler(source, writer, lease, &fakeDefaults{}, 3).reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := len(writer.recordedCalls()); got != 12 {
		t.Fatalf("schedule calls = %d, want 12", got)
	}
	if got := writer.peakInFlight(); got > 3 {
		t.Fatalf("peak in flight = %d, want at most 3 (ALERT_RULE_TASK_CONCURRENCY)", got)
	}
	if got := writer.peakInFlight(); got < 2 {
		t.Fatalf("peak in flight = %d, want at least 2 (the pass must run concurrently)", got)
	}
}

func TestReconcileRuleSchedulesFallsBackToTheNestDefaultConcurrency(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(4)}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{acquired: true}

	if err := testReconciler(source, writer, lease, &fakeDefaults{}, 0).reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if got := len(writer.recordedCalls()); got != 4 {
		t.Fatalf("schedule calls = %d, want 4 with the fallback concurrency", got)
	}
}

func TestReconcileRuleSchedulesAggregatesFailures(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(4)}
	writer := newFakeScheduleWriter()
	writer.errs["r-01"] = errors.New("redis is down")
	writer.errs["r-03"] = errors.New("producer rejected the job")
	lease := &fakeRuleScheduleLease{acquired: true}

	err := testReconciler(source, writer, lease, &fakeDefaults{}, 2).reconcile(context.Background())
	if err == nil {
		t.Fatal("reconcile must return the per-rule failures")
	}
	message := err.Error()
	for _, ruleID := range []string{"r-01", "r-03"} {
		if !strings.Contains(message, ruleID) {
			t.Fatalf("error %q does not mention %s", message, ruleID)
		}
	}
	if !strings.Contains(message, "2 of 4") {
		t.Fatalf("error %q must count the failed rules", message)
	}
	// The healthy rules are still reconciled.
	if got := len(writer.recordedCalls()); got != 4 {
		t.Fatalf("schedule attempts = %d, want 4 despite the failures", got)
	}
}

func TestReconcileRuleSchedulesIsIdempotent(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(3)}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{acquired: true}
	reconciler := testReconciler(source, writer, lease, &fakeDefaults{}, 4)

	if err := reconciler.reconcile(context.Background()); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	first := callsByRule(writer.recordedCalls())
	if err := reconciler.reconcile(context.Background()); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	all := writer.recordedCalls()
	if len(first) != 3 || len(all) != 6 {
		t.Fatalf("calls after two cycles = %d, want 3 then 6", len(all))
	}
	// Both cycles issue the same (rule, interval) pair for every rule: the
	// producer's remove-then-upsert makes a repeated cycle a no-op on the queue.
	second := callsByRule(all[3:])
	for ruleID, call := range first {
		if second[ruleID] != call {
			t.Fatalf("cycle two call for %s = %+v, want the first cycle call %+v", ruleID, second[ruleID], call)
		}
	}
}

func TestReconcileRuleSchedulesPropagatesTheDefaultRuleFailure(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(2)}
	writer := newFakeScheduleWriter()
	defaults := &fakeDefaults{err: errors.New("mysql is down")}
	lease := &fakeRuleScheduleLease{acquired: true}

	err := testReconciler(source, writer, lease, defaults, 4).reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "mysql is down") {
		t.Fatalf("reconcile error = %v, want the default-rule failure", err)
	}
	if got := len(writer.recordedCalls()); got != 0 {
		t.Fatalf("schedule calls = %d, want 0 when the default-rule pass fails", got)
	}
}

func TestReconcileRuleSchedulesPropagatesTheRuleReadFailure(t *testing.T) {
	source := &fakeRuleSource{err: errors.New("mysql is down")}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{acquired: true}

	err := testReconciler(source, writer, lease, &fakeDefaults{}, 4).reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "mysql is down") {
		t.Fatalf("reconcile error = %v, want the rule read failure", err)
	}
	if got := len(writer.recordedCalls()); got != 0 {
		t.Fatalf("schedule calls = %d, want 0 when the rule read fails", got)
	}
}

func TestReconcileRuleSchedulesRequiresALease(t *testing.T) {
	reconciler := &ruleScheduleReconciler{
		source: &fakeRuleSource{rules: activeRules(1)},
		writer: newFakeScheduleWriter(),
		logger: log.New(io.Discard, "", 0),
	}
	err := reconciler.reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "redis lease") {
		t.Fatalf("reconcile error = %v, want a missing-lease error", err)
	}
}

func TestReconcileRuleSchedulesReturnsTheLeaseError(t *testing.T) {
	source := &fakeRuleSource{rules: activeRules(1)}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{err: errors.New("redis is down")}

	err := testReconciler(source, writer, lease, &fakeDefaults{}, 4).reconcile(context.Background())
	if err == nil || !strings.Contains(err.Error(), "redis is down") {
		t.Fatalf("reconcile error = %v, want the lease error", err)
	}
	if got := len(writer.recordedCalls()); got != 0 {
		t.Fatalf("schedule calls = %d, want 0 when the lease fails", got)
	}
}

func TestReconcileRuleSchedulesStopsOnACancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	source := &fakeRuleSource{rules: activeRules(2)}
	writer := newFakeScheduleWriter()
	lease := &fakeRuleScheduleLease{acquired: true}

	err := testReconciler(source, writer, lease, &fakeDefaults{}, 4).reconcile(ctx)
	if err == nil {
		t.Fatal("reconcile must report the cancelled cycle")
	}
	if got := len(writer.recordedCalls()); got != 0 {
		t.Fatalf("schedule calls = %d, want 0 for a cancelled cycle", got)
	}
}

func TestRuleTaskConcurrencyDefaultMatchesNest(t *testing.T) {
	config := Config{}.normalized()
	if config.RuleTaskConcurrency != 16 {
		t.Fatalf("default rule task concurrency = %d, want 16 (ALERT_RULE_TASK_CONCURRENCY)",
			config.RuleTaskConcurrency)
	}
	config = Config{RuleTaskConcurrency: 5}.normalized()
	if config.RuleTaskConcurrency != 5 {
		t.Fatalf("configured rule task concurrency = %d, want 5", config.RuleTaskConcurrency)
	}
}
