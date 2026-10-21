package classificationalert

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// ---- fakes ----

// fakeTickGate records the claim arguments and returns a canned result.
type fakeTickGate struct {
	mu      sync.Mutex
	claimed bool
	err     error
	calls   int
	keys    []string
	ttls    []time.Duration
	nows    []time.Time
}

// ClaimTick implements TickGate.
func (g *fakeTickGate) ClaimTick(_ context.Context, key string, ttl time.Duration, now time.Time) (bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	g.keys = append(g.keys, key)
	g.ttls = append(g.ttls, ttl)
	g.nows = append(g.nows, now)
	return g.claimed, g.err
}

// callCount returns the number of claims observed so far.
func (g *fakeTickGate) callCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

// fakeActiveOrgs returns a canned active-organization list.
type fakeActiveOrgs struct {
	mu    sync.Mutex
	ids   []string
	err   error
	calls int
}

// ListActiveOrgIDs implements ActiveOrgLister.
func (l *fakeActiveOrgs) ListActiveOrgIDs(context.Context) ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	return append([]string{}, l.ids...), l.err
}

// callCount returns the number of list calls observed so far.
func (l *fakeActiveOrgs) callCount() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.calls
}

// fakeConcurrency returns a canned runtime concurrency.
type fakeConcurrency struct {
	mu    sync.Mutex
	value int
	err   error
	calls int
}

// ReadClassificationQualityAlertOrgConcurrency implements OrgConcurrencyReader.
func (r *fakeConcurrency) ReadClassificationQualityAlertOrgConcurrency(context.Context) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return r.value, r.err
}

// callCount returns the number of reads observed so far.
func (r *fakeConcurrency) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// fakeOrgLocker simulates CacheService.withLock, including an optional held key
// so the skipped branch is reachable without Redis.
type fakeOrgLocker struct {
	mu   sync.Mutex
	held map[string]bool
	err  error
	keys []string
	ttls []time.Duration
}

// newFakeOrgLocker builds an empty locker.
func newFakeOrgLocker() *fakeOrgLocker {
	return &fakeOrgLocker{held: map[string]bool{}}
}

// hold marks key as already leased by another owner.
func (l *fakeOrgLocker) hold(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.held[key] = true
}

// WithLock implements OrgLocker.
func (l *fakeOrgLocker) WithLock(ctx context.Context, key string, ttl time.Duration, runner func(context.Context) error) (bool, error) {
	l.mu.Lock()
	l.keys = append(l.keys, key)
	l.ttls = append(l.ttls, ttl)
	if l.err != nil {
		err := l.err
		l.mu.Unlock()
		return false, err
	}
	if l.held[key] {
		l.mu.Unlock()
		return false, nil
	}
	l.held[key] = true
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.held, key)
		l.mu.Unlock()
	}()
	return true, runner(ctx)
}

// lockCalls returns the recorded keys and TTLs.
func (l *fakeOrgLocker) lockCalls() ([]string, []time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.keys...), append([]time.Duration{}, l.ttls...)
}

// summaryCall is one recorded summary evaluation.
type summaryCall struct {
	orgID  string
	window string
}

// fakeSummary records the summary calls, tracks the in-flight peak and can block
// or panic to exercise the fan-out.
type fakeSummary struct {
	mu       sync.Mutex
	calls    []summaryCall
	errs     map[string]error
	hook     func(ctx context.Context, orgID, window string)
	inFlight int
	peak     int
}

// EvaluateClassificationQualityAlerts implements SummaryEvaluator.
func (s *fakeSummary) EvaluateClassificationQualityAlerts(ctx context.Context, orgID, window string) error {
	s.mu.Lock()
	s.calls = append(s.calls, summaryCall{orgID: orgID, window: window})
	s.inFlight++
	if s.inFlight > s.peak {
		s.peak = s.inFlight
	}
	hook := s.hook
	err := s.errs[orgID]
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()
	}()
	if hook != nil {
		hook(ctx, orgID, window)
	}
	return err
}

// recordedCalls returns the summary calls observed so far.
func (s *fakeSummary) recordedCalls() []summaryCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]summaryCall{}, s.calls...)
}

// peakInFlight returns the maximum number of concurrent summary calls.
func (s *fakeSummary) peakInFlight() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak
}

// ---- harness ----

// testHarness bundles a scheduler and the fakes behind it.
type testHarness struct {
	scheduler   *Scheduler
	gate        *fakeTickGate
	orgs        *fakeActiveOrgs
	concurrency *fakeConcurrency
	locker      *fakeOrgLocker
	summary     *fakeSummary
}

// fixedNow is the deterministic clock used by every test.
func fixedNow() time.Time {
	return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
}

// newHarness builds a fully fake-wired scheduler with one active organization.
func newHarness(t *testing.T) *testHarness {
	t.Helper()
	harness := &testHarness{
		gate:        &fakeTickGate{claimed: true},
		orgs:        &fakeActiveOrgs{ids: []string{"org-1"}},
		concurrency: &fakeConcurrency{value: 4},
		locker:      newFakeOrgLocker(),
		summary:     &fakeSummary{errs: map[string]error{}},
	}
	scheduler, err := NewScheduler(Options{
		Summary:     harness.summary,
		ActiveOrgs:  harness.orgs,
		Concurrency: harness.concurrency,
		TickGate:    harness.gate,
		OrgLocker:   harness.locker,
		Now:         fixedNow,
	})
	if err != nil {
		t.Fatalf("NewScheduler: %v", err)
	}
	harness.scheduler = scheduler
	return harness
}

// tickOutcome is one asynchronous EvaluateOnce result.
type tickOutcome struct {
	result TickResult
	err    error
}

// runEvaluateAsync evaluates one tick in the background.
func runEvaluateAsync(harness *testHarness) <-chan tickOutcome {
	done := make(chan tickOutcome, 1)
	go func() {
		result, err := harness.scheduler.EvaluateOnce(context.Background())
		done <- tickOutcome{result: result, err: err}
	}()
	return done
}

// waitForStarts reads count started workers or fails the test.
func waitForStarts(t *testing.T, started <-chan string, count int) {
	t.Helper()
	seen := 0
	for seen < count {
		select {
		case <-started:
			seen++
		case <-time.After(2 * time.Second):
			t.Fatalf("only %d/%d workers started", seen, count)
		}
	}
}

// waitFor polls condition until it holds or the deadline passes.
func waitFor(t *testing.T, deadline time.Duration, condition func() bool) {
	t.Helper()
	stop := time.Now().Add(deadline)
	for time.Now().Before(stop) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition not met within %s", deadline)
}

// schedulerRunCount reads one scheduler_runs_total series from the shared
// registry, so the tests assert the metric without registering a family.
func schedulerRunCount(t *testing.T, status string) int {
	t.Helper()
	prefix := `scheduler_runs_total{scheduler="` + MetricSchedulerName + `",status="` + status + `"} `
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		value, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, prefix)))
		if err != nil {
			t.Fatalf("parse metric line %q: %v", line, err)
		}
		return value
	}
	return 0
}

// ---- tests ----

// TestNewSchedulerRequiresSummary locks the constructor contract: the summary
// evaluator cannot be defaulted.
func TestNewSchedulerRequiresSummary(t *testing.T) {
	if _, err := NewScheduler(Options{}); err == nil {
		t.Fatal("NewScheduler without a Summary must fail")
	}
}

// TestEvaluateOnceSkippedByTickGate proves the gate is claimed with the NestJS
// key and TTL, and that a lost claim never lists organizations.
func TestEvaluateOnceSkippedByTickGate(t *testing.T) {
	harness := newHarness(t)
	harness.gate.claimed = false

	result, err := harness.scheduler.EvaluateOnce(context.Background())
	if err != nil {
		t.Fatalf("EvaluateOnce: %v", err)
	}
	if result.Claimed {
		t.Fatal("Claimed = true, want false")
	}
	if harness.orgs.callCount() != 0 {
		t.Fatalf("active org list calls = %d, want 0", harness.orgs.callCount())
	}
	if len(harness.summary.recordedCalls()) != 0 {
		t.Fatal("summary must not run when the tick gate is lost")
	}

	harness.gate.mu.Lock()
	defer harness.gate.mu.Unlock()
	if harness.gate.calls != 1 {
		t.Fatalf("gate calls = %d, want 1", harness.gate.calls)
	}
	if harness.gate.keys[0] != tickGateKey {
		t.Fatalf("gate key = %q, want %q", harness.gate.keys[0], tickGateKey)
	}
	if harness.gate.ttls[0] != tickGateTTL {
		t.Fatalf("gate ttl = %v, want %v", harness.gate.ttls[0], tickGateTTL)
	}
	if !harness.gate.nows[0].Equal(fixedNow()) {
		t.Fatalf("gate now = %v, want %v", harness.gate.nows[0], fixedNow())
	}
}

// TestEvaluateOnceGateErrorFailsTick locks the fail-closed gate: a Redis error
// fails the tick instead of evaluating without the gate.
func TestEvaluateOnceGateErrorFailsTick(t *testing.T) {
	harness := newHarness(t)
	harness.gate.err = errors.New("redis down")

	if _, err := harness.scheduler.EvaluateOnce(context.Background()); err == nil {
		t.Fatal("EvaluateOnce must fail when the tick gate errors")
	}
	if harness.orgs.callCount() != 0 {
		t.Fatalf("active org list calls = %d, want 0", harness.orgs.callCount())
	}
}

// TestEvaluateOnceEmptyOrgListStopsEarly mirrors evaluate() returning before
// getRuntimeSettings when there is no active organization.
func TestEvaluateOnceEmptyOrgListStopsEarly(t *testing.T) {
	harness := newHarness(t)
	harness.orgs.ids = nil
	harness.concurrency.err = errInvalidRuntimeSettings

	result, err := harness.scheduler.EvaluateOnce(context.Background())
	if err != nil {
		t.Fatalf("EvaluateOnce: %v", err)
	}
	if !result.Claimed {
		t.Fatal("Claimed = false, want true")
	}
	if result.OrgCount != 0 || len(result.OrgResults) != 0 {
		t.Fatalf("org count = %d results = %d, want 0", result.OrgCount, len(result.OrgResults))
	}
	if harness.concurrency.callCount() != 0 {
		t.Fatalf("concurrency reads = %d, want 0", harness.concurrency.callCount())
	}
}

// TestEvaluateOnceFanoutOrderAndOrgLockContract verifies the summary call
// arguments, the organization lock key/TTL and the input-ordered results.
func TestEvaluateOnceFanoutOrderAndOrgLockContract(t *testing.T) {
	harness := newHarness(t)
	orgIDs := []string{"org-a", "org-b", "org-c"}
	harness.orgs.ids = orgIDs
	harness.concurrency.value = 2
	harness.summary.hook = func(context.Context, string, string) { time.Sleep(2 * time.Millisecond) }

	successBefore := schedulerRunCount(t, metrics.SchedulerStatusSuccess)

	result, err := harness.scheduler.EvaluateOnce(context.Background())
	if err != nil {
		t.Fatalf("EvaluateOnce: %v", err)
	}
	if !result.Claimed || result.OrgCount != 3 || result.Concurrency != 2 {
		t.Fatalf("result = %+v, want claimed with 3 orgs and concurrency 2", result)
	}
	if result.CompletedOrgs != 3 || result.FailedOrgs != 0 || result.SkippedOrgs != 0 {
		t.Fatalf("counts = completed:%d failed:%d skipped:%d", result.CompletedOrgs, result.FailedOrgs, result.SkippedOrgs)
	}
	if len(result.OrgResults) != len(orgIDs) {
		t.Fatalf("results = %d, want %d", len(result.OrgResults), len(orgIDs))
	}
	for index, orgID := range orgIDs {
		if result.OrgResults[index].OrgID != orgID {
			t.Fatalf("result[%d].OrgID = %q, want %q", index, result.OrgResults[index].OrgID, orgID)
		}
		if result.OrgResults[index].Outcome != OrgOutcomeCompleted {
			t.Fatalf("result[%d].Outcome = %q, want completed", index, result.OrgResults[index].Outcome)
		}
	}

	calls := harness.summary.recordedCalls()
	if len(calls) != len(orgIDs) {
		t.Fatalf("summary calls = %d, want %d", len(calls), len(orgIDs))
	}
	for _, call := range calls {
		if call.window != summaryWindow {
			t.Fatalf("summary window = %q, want %q", call.window, summaryWindow)
		}
	}
	seen := map[string]bool{}
	for _, call := range calls {
		seen[call.orgID] = true
	}
	for _, orgID := range orgIDs {
		if !seen[orgID] {
			t.Fatalf("summary was not called for %s", orgID)
		}
	}

	keys, ttls := harness.locker.lockCalls()
	if len(keys) != len(orgIDs) {
		t.Fatalf("lock calls = %d, want %d", len(keys), len(orgIDs))
	}
	lockKeys := map[string]bool{}
	for _, key := range keys {
		lockKeys[key] = true
	}
	for _, orgID := range orgIDs {
		if !lockKeys[orgLockKey(orgID)] {
			t.Fatalf("missing lock key %q", orgLockKey(orgID))
		}
	}
	for _, ttl := range ttls {
		if ttl != orgLockTTL {
			t.Fatalf("lock ttl = %v, want %v", ttl, orgLockTTL)
		}
	}
	if got := schedulerRunCount(t, metrics.SchedulerStatusSuccess) - successBefore; got != len(orgIDs) {
		t.Fatalf("success metric delta = %d, want %d", got, len(orgIDs))
	}
}

// TestEvaluateOnceClampsConcurrency pins settleWithConcurrency's clamp: a value
// above or below the bounds never widens the worker count.
func TestEvaluateOnceClampsConcurrency(t *testing.T) {
	cases := []struct {
		name         string
		concurrency  int
		orgCount     int
		wantInFlight int
	}{
		{name: "above upper bound clamps to org count", concurrency: 100, orgCount: 5, wantInFlight: 5},
		{name: "non-positive clamps to one", concurrency: -3, orgCount: 3, wantInFlight: 1},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newHarness(t)
			orgIDs := make([]string, 0, testCase.orgCount)
			for index := 0; index < testCase.orgCount; index++ {
				orgIDs = append(orgIDs, "org-"+strconv.Itoa(index))
			}
			harness.orgs.ids = orgIDs
			harness.concurrency.value = testCase.concurrency
			started := make(chan string, testCase.orgCount)
			release := make(chan struct{})
			released := false
			releaseAll := func() {
				if !released {
					released = true
					close(release)
				}
			}
			defer releaseAll()
			harness.summary.hook = func(_ context.Context, orgID, _ string) {
				started <- orgID
				<-release
			}

			done := runEvaluateAsync(harness)
			waitForStarts(t, started, testCase.wantInFlight)
			select {
			case orgID := <-started:
				t.Fatalf("worker %q started beyond the clamp of %d", orgID, testCase.wantInFlight)
			case <-time.After(50 * time.Millisecond):
			}
			releaseAll()

			select {
			case outcome := <-done:
				if outcome.err != nil {
					t.Fatalf("EvaluateOnce: %v", outcome.err)
				}
				if outcome.result.Concurrency != testCase.concurrency {
					t.Fatalf("Concurrency = %d, want the persisted %d", outcome.result.Concurrency, testCase.concurrency)
				}
				if outcome.result.CompletedOrgs != testCase.orgCount {
					t.Fatalf("completed = %d, want %d", outcome.result.CompletedOrgs, testCase.orgCount)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("EvaluateOnce did not finish")
			}
			if peak := harness.summary.peakInFlight(); peak != testCase.wantInFlight {
				t.Fatalf("peak in flight = %d, want %d", peak, testCase.wantInFlight)
			}
		})
	}
}

// TestEvaluateOnceInvalidConcurrencyFailsTick locks the NestJS failure
// semantics: an unusable persisted value rejects the whole tick before any
// organization runs.
func TestEvaluateOnceInvalidConcurrencyFailsTick(t *testing.T) {
	harness := newHarness(t)
	harness.concurrency.err = errInvalidRuntimeSettings

	result, err := harness.scheduler.EvaluateOnce(context.Background())
	if err == nil {
		t.Fatal("EvaluateOnce must fail on invalid runtime settings")
	}
	if !result.Claimed {
		t.Fatal("the tick was already claimed before the settings read")
	}
	if len(harness.summary.recordedCalls()) != 0 {
		t.Fatal("summary must not run when the concurrency setting is invalid")
	}
}

// TestEvaluateOnceActiveOrgErrorFailsTick proves an unreadable active-org list
// fails the tick without reading the runtime settings.
func TestEvaluateOnceActiveOrgErrorFailsTick(t *testing.T) {
	harness := newHarness(t)
	harness.orgs.err = errors.New("mysql down")

	if _, err := harness.scheduler.EvaluateOnce(context.Background()); err == nil {
		t.Fatal("EvaluateOnce must fail when the active org list errors")
	}
	if harness.concurrency.callCount() != 0 {
		t.Fatalf("concurrency reads = %d, want 0", harness.concurrency.callCount())
	}
}

// TestEvaluateOrgOutcomes covers completed, skipped and failed single-org runs.
func TestEvaluateOrgOutcomes(t *testing.T) {
	t.Run("completed", func(t *testing.T) {
		harness := newHarness(t)
		successBefore := schedulerRunCount(t, metrics.SchedulerStatusSuccess)

		result := harness.scheduler.EvaluateOrg(context.Background(), "org-1")
		if result.Outcome != OrgOutcomeCompleted || result.Err != nil {
			t.Fatalf("result = %+v, want completed", result)
		}
		keys, ttls := harness.locker.lockCalls()
		if len(keys) != 1 || keys[0] != orgLockKey("org-1") {
			t.Fatalf("lock keys = %v, want [%s]", keys, orgLockKey("org-1"))
		}
		if ttls[0] != orgLockTTL {
			t.Fatalf("lock ttl = %v, want %v", ttls[0], orgLockTTL)
		}
		calls := harness.summary.recordedCalls()
		if len(calls) != 1 || calls[0].orgID != "org-1" || calls[0].window != summaryWindow {
			t.Fatalf("summary calls = %+v", calls)
		}
		if got := schedulerRunCount(t, metrics.SchedulerStatusSuccess) - successBefore; got != 1 {
			t.Fatalf("success metric delta = %d, want 1", got)
		}
	})

	t.Run("lease held by another owner", func(t *testing.T) {
		harness := newHarness(t)
		harness.locker.hold(orgLockKey("org-1"))

		result := harness.scheduler.EvaluateOrg(context.Background(), "org-1")
		if result.Outcome != OrgOutcomeSkipped {
			t.Fatalf("Outcome = %q, want skipped", result.Outcome)
		}
		if len(harness.summary.recordedCalls()) != 0 {
			t.Fatal("summary must not run while the lease is held")
		}
	})

	t.Run("lease error is a rejected failure", func(t *testing.T) {
		harness := newHarness(t)
		harness.locker.err = errors.New("redis down")

		result := harness.scheduler.EvaluateOrg(context.Background(), "org-1")
		if result.Outcome != OrgOutcomeFailed || result.Err == nil {
			t.Fatalf("result = %+v, want failed with an error", result)
		}
		if len(harness.summary.recordedCalls()) != 0 {
			t.Fatal("summary must not run when the lease cannot be taken")
		}
	})

	t.Run("summary error records a failure", func(t *testing.T) {
		harness := newHarness(t)
		summaryErr := errors.New("mongo down")
		harness.summary.errs["org-1"] = summaryErr
		failureBefore := schedulerRunCount(t, metrics.SchedulerStatusFailure)

		result := harness.scheduler.EvaluateOrg(context.Background(), "org-1")
		if result.Outcome != OrgOutcomeFailed {
			t.Fatalf("Outcome = %q, want failed", result.Outcome)
		}
		if !errors.Is(result.Err, summaryErr) {
			t.Fatalf("Err = %v, want %v", result.Err, summaryErr)
		}
		if got := schedulerRunCount(t, metrics.SchedulerStatusFailure) - failureBefore; got != 1 {
			t.Fatalf("failure metric delta = %d, want 1", got)
		}
	})
}

// TestEvaluateOnceRecoversPanickingWorker mirrors settleWithConcurrency: a
// throwing organization is rejected, the other organizations still run.
func TestEvaluateOnceRecoversPanickingWorker(t *testing.T) {
	harness := newHarness(t)
	harness.orgs.ids = []string{"org-a", "org-b"}
	harness.summary.hook = func(_ context.Context, orgID, _ string) {
		if orgID == "org-b" {
			panic("boom")
		}
	}

	result, err := harness.scheduler.EvaluateOnce(context.Background())
	if err != nil {
		t.Fatalf("EvaluateOnce: %v", err)
	}
	if result.FailedOrgs != 1 {
		t.Fatalf("FailedOrgs = %d, want 1", result.FailedOrgs)
	}
	// The worker order is not deterministic, so locate the panicking org.
	for _, orgResult := range result.OrgResults {
		if orgResult.OrgID == "org-b" && orgResult.Outcome != OrgOutcomeFailed {
			t.Fatalf("org-b outcome = %q, want failed", orgResult.Outcome)
		}
	}
	completed := 0
	for _, orgResult := range result.OrgResults {
		if orgResult.Outcome == OrgOutcomeCompleted {
			completed++
		}
	}
	if completed != 1 {
		t.Fatalf("completed = %d, want 1", completed)
	}
}

// TestStartWaitsOneIntervalAndCloseStopsTicker proves the @Interval lifecycle:
// no immediate tick, repeated ticks afterwards, and Close stops the loop.
func TestStartWaitsOneIntervalAndCloseStopsTicker(t *testing.T) {
	harness := newHarness(t)
	harness.scheduler.interval = 50 * time.Millisecond
	harness.scheduler.Start(context.Background())

	time.Sleep(5 * time.Millisecond)
	if calls := harness.gate.callCount(); calls != 0 {
		t.Fatalf("gate claims = %d immediately after Start, want 0", calls)
	}
	waitFor(t, 2*time.Second, func() bool { return harness.gate.callCount() >= 2 })

	if err := harness.scheduler.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	stoppedAt := harness.gate.callCount()
	time.Sleep(80 * time.Millisecond)
	if calls := harness.gate.callCount(); calls != stoppedAt {
		t.Fatalf("gate claims grew from %d to %d after Close", stoppedAt, calls)
	}
	if err := harness.scheduler.Close(context.Background()); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

// TestCloseDrainsInFlightTick bounds Close by the caller context and keeps the
// in-flight tick running until its organization evaluation returns.
func TestCloseDrainsInFlightTick(t *testing.T) {
	harness := newHarness(t)
	harness.scheduler.interval = 10 * time.Millisecond
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	harness.summary.hook = func(context.Context, string, string) {
		started <- struct{}{}
		<-block
	}
	harness.scheduler.Start(context.Background())
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduled tick did not reach the summary evaluator")
	}

	closeCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := harness.scheduler.Close(closeCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close error = %v, want context.DeadlineExceeded", err)
	}

	close(block)
	if err := harness.scheduler.Close(context.Background()); err != nil {
		t.Fatalf("Close after drain: %v", err)
	}
}
