//go:build integration

package realtimeintegration

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/classificationalert"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// classificationSchedulerName is the metrics label value shared with NestJS
// (scheduler_runs_total{scheduler="classification_quality_alerts"}). The
// constant is duplicated here on purpose: the assertion checks the external
// contract, not an internal identifier.
const classificationSchedulerName = "classification_quality_alerts"

// summaryCall is one observed SummaryEvaluator invocation.
type summaryCall struct {
	OrgID  string
	Window string
}

// fakeSummaryEvaluator records calls, injects failures per org and can block a
// call so the org-lock test can observe the lease while the summary is running.
type fakeSummaryEvaluator struct {
	mu       sync.Mutex
	calls    []summaryCall
	failOn   map[string]error
	delay    time.Duration
	inFlight int
	peak     int
	// block, when set, is called at the beginning of an evaluation. Tests use
	// it to signal "the lock holder entered the summary" and wait for release.
	block func(orgID string)
}

func (f *fakeSummaryEvaluator) EvaluateClassificationQualityAlerts(ctx context.Context, orgID, window string) error {
	f.mu.Lock()
	f.calls = append(f.calls, summaryCall{OrgID: orgID, Window: window})
	block := f.block
	delay := f.delay
	failErr := f.failOn[orgID]
	f.inFlight++
	if f.inFlight > f.peak {
		f.peak = f.inFlight
	}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()
	if block != nil {
		block(orgID)
	}
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return failErr
}

// maxInFlight reports the peak number of concurrent evaluations observed.
func (f *fakeSummaryEvaluator) maxInFlight() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.peak
}

func (f *fakeSummaryEvaluator) recordedCalls() []summaryCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]summaryCall, len(f.calls))
	copy(out, f.calls)
	return out
}

// fakeActiveOrgs is the injectable active-org lister.
type fakeActiveOrgs struct {
	orgIDs []string
	err    error
}

func (f *fakeActiveOrgs) ListActiveOrgIDs(context.Context) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return append([]string(nil), f.orgIDs...), nil
}

// fakeConcurrency is the injectable concurrency reader.
type fakeConcurrency struct {
	value int
	err   error
}

func (f *fakeConcurrency) ReadClassificationQualityAlertOrgConcurrency(context.Context) (int, error) {
	return f.value, f.err
}

// TestRealtimeClassificationSchedulerIntegration covers the Go port of the
// NestJS ClassificationQualityAlertSchedulerService against a real Redis:
//
//	a) tick gate: two scheduler instances evaluating concurrently share
//	   cron:classification-quality-alert:tick-gate, so exactly one tick runs;
//	b) org lock: concurrent evaluations of the same org serialize on
//	   lock:quality:classification:alert-scheduler:<orgId>:1h;
//	c) fan-out: the concurrency from SystemSetting bounds in-flight orgs while
//	   results keep the active-org input order;
//	d) every Summary evaluation receives window="1h";
//	e) a failing org is reported as failed (warn only) and recorded in
//	   scheduler_runs_total; the tick does not panic and other orgs complete.
func TestRealtimeClassificationSchedulerIntegration(t *testing.T) {
	t.Run("tick_gate", func(t *testing.T) {
		h := newHarness(t)
		summary := &fakeSummaryEvaluator{}
		options := classificationalert.Options{
			DB:          h.db,
			Redis:       h.redis,
			Summary:     summary,
			ActiveOrgs:  &fakeActiveOrgs{orgIDs: []string{"org-gate-1"}},
			Concurrency: &fakeConcurrency{value: 4},
		}
		first := newClassificationScheduler(t, options)
		second := newClassificationScheduler(t, options)

		type outcome struct {
			result classificationalert.TickResult
			err    error
		}
		outcomes := make(chan outcome, 2)
		var wg sync.WaitGroup
		for _, scheduler := range []*classificationalert.Scheduler{first, second} {
			wg.Add(1)
			go func(scheduler *classificationalert.Scheduler) {
				defer wg.Done()
				result, err := scheduler.EvaluateOnce(h.ctx)
				outcomes <- outcome{result: result, err: err}
			}(scheduler)
		}
		wg.Wait()
		close(outcomes)

		claimed, skipped := 0, 0
		for observed := range outcomes {
			if observed.err != nil {
				t.Fatalf("EvaluateOnce: %v", observed.err)
			}
			if observed.result.Claimed {
				claimed++
			} else {
				skipped++
			}
		}
		if claimed != 1 || skipped != 1 {
			t.Fatalf("tick gate outcomes = claimed:%d skipped:%d, want exactly one claimed tick", claimed, skipped)
		}
		if calls := summary.recordedCalls(); len(calls) != 1 {
			t.Fatalf("Summary evaluated %d times, want 1 (only the tick-gate winner may fan out)", len(calls))
		}
	})

	t.Run("org_lock", func(t *testing.T) {
		h := newHarness(t)
		const orgID = "org-lock-1"
		physicalLockKey := "lock:quality:classification:alert-scheduler:" + orgID + ":1h"

		entered := make(chan struct{}, 1)
		release := make(chan struct{})
		var releaseOnce sync.Once
		releaseHolder := func() { releaseOnce.Do(func() { close(release) }) }
		// Unblock the fake summary even if an assertion fails while the lease is
		// held, so a failed test does not leak a lock-renewing goroutine.
		t.Cleanup(releaseHolder)
		summary := &fakeSummaryEvaluator{
			block: func(string) {
				entered <- struct{}{}
				<-release
			},
		}
		scheduler := newClassificationScheduler(t, classificationalert.Options{
			DB:      h.db,
			Redis:   h.redis,
			Summary: summary,
		})

		results := make(chan classificationalert.OrgResult, 2)
		var wg sync.WaitGroup
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results <- scheduler.EvaluateOrg(h.ctx, orgID)
			}()
		}

		select {
		case <-entered:
		case <-time.After(defaultFrameTimeout):
			t.Fatal("first EvaluateOrg never entered the Summary evaluator")
		}
		// While the holder is blocked inside the summary, the other EvaluateOrg
		// must give up on the lease and return Skipped without calling Summary.
		var contender classificationalert.OrgResult
		select {
		case contender = <-results:
		case <-time.After(defaultFrameTimeout):
			t.Fatal("concurrent EvaluateOrg did not return while the org lease was held")
		}
		if contender.Outcome != classificationalert.OrgOutcomeSkipped {
			t.Fatalf("concurrent EvaluateOrg outcome = %q (%v), want skipped while the lease is held", contender.Outcome, contender.Err)
		}
		// The lease is visible on the shared Redis key the NestJS scheduler uses.
		if exists, err := h.redis.Exists(h.ctx, physicalLockKey).Result(); err != nil {
			t.Fatalf("check org lock key: %v", err)
		} else if exists != 1 {
			t.Fatalf("org lock key %q does not exist while the summary is running", physicalLockKey)
		}
		releaseHolder()
		wg.Wait()
		close(results)

		completed, skipped := 0, 0
		for result := range results {
			switch result.Outcome {
			case classificationalert.OrgOutcomeCompleted:
				completed++
			case classificationalert.OrgOutcomeSkipped:
				skipped++
			default:
				t.Fatalf("EvaluateOrg outcome = %q (%v), want completed or skipped", result.Outcome, result.Err)
			}
		}
		if completed != 1 || skipped != 1 {
			t.Fatalf("org lock outcomes = completed:%d skipped:%d, want exactly one lock holder", completed, skipped)
		}
		if calls := summary.recordedCalls(); len(calls) != 1 {
			t.Fatalf("Summary evaluated %d times for one org, want 1", len(calls))
		}
		waitFor(t, time.Second, 10*time.Millisecond, "org lock key release", func() bool {
			value, err := h.redis.Exists(h.ctx, physicalLockKey).Result()
			return err == nil && value == 0
		})
	})

	t.Run("fanout_and_window", func(t *testing.T) {
		h := newHarness(t)
		// Seed four active orgs and one inactive control org. The default
		// active-org reader sorts by id ASC, so the expected fan-out order is
		// fixed by the fixture.
		expectedOrgs := []string{"org-fanout-1", "org-fanout-2", "org-fanout-3", "org-fanout-4"}
		for _, orgID := range expectedOrgs {
			h.seedOrg(t, orgID, true)
		}
		h.seedOrg(t, "org-fanout-inactive", false)
		// The stored settings JSON keeps every documented concurrency field
		// valid (NestJS validates the whole object) while bounding the
		// classification fan-out to 2 workers.
		h.seedSystemSetting(t, "multi_tenant_scheduler_runtime_settings",
			`{"realtimeSignalsOrgConcurrency":4,"newsEventsTimelineOrgConcurrency":2,"newsEventsIngestionOrgConcurrency":4,`+
				`"knowledgeGraphIngestionOrgConcurrency":4,"sentimentSnapshotOrgConcurrency":2,"newsnowHottestAnalysisOrgConcurrency":6,`+
				`"classificationQualityAlertOrgConcurrency":2,"newsIndicatorAssociationOrgConcurrency":2,`+
				`"crawlQualityTaskSnapshotOrgConcurrency":2,"situationMonitorOrefDefaultRuleOrgConcurrency":16,`+
				`"userDigestDeliveryOrgConcurrency":4}`)

		summary := &fakeSummaryEvaluator{delay: 40 * time.Millisecond}
		scheduler := newClassificationScheduler(t, classificationalert.Options{
			DB:      h.db,
			Redis:   h.redis,
			Summary: summary,
		})

		result, err := scheduler.EvaluateOnce(h.ctx)
		if err != nil {
			t.Fatalf("EvaluateOnce: %v", err)
		}
		if !result.Claimed {
			t.Fatal("EvaluateOnce did not claim the tick on a clean Redis key space")
		}
		if result.OrgCount != len(expectedOrgs) {
			t.Fatalf("tick orgCount = %d, want %d active orgs", result.OrgCount, len(expectedOrgs))
		}
		if result.Concurrency != 2 {
			t.Fatalf("tick concurrency = %d, want 2 from multi_tenant_scheduler_runtime_settings", result.Concurrency)
		}
		if len(result.OrgResults) != len(expectedOrgs) {
			t.Fatalf("tick orgResults = %d entries, want %d", len(result.OrgResults), len(expectedOrgs))
		}
		for index, orgID := range expectedOrgs {
			if got := result.OrgResults[index].OrgID; got != orgID {
				t.Fatalf("orgResults[%d].orgId = %q, want %q (fan-out must preserve the input order)", index, got, orgID)
			}
		}
		calls := summary.recordedCalls()
		if len(calls) != len(expectedOrgs) {
			t.Fatalf("Summary evaluated %d orgs, want %d (inactive org must be skipped)", len(calls), len(expectedOrgs))
		}
		for _, call := range calls {
			if call.Window != "1h" {
				t.Fatalf("Summary window = %q, want %q", call.Window, "1h")
			}
		}
		// The fake delay plus the concurrency bound let the test observe the
		// fan-out width without relying on wall-clock timing alone: with 4 orgs
		// and 2 workers a correctly parallel fan-out must reach 2 in flight.
		if summary.maxInFlight() > 2 {
			t.Fatalf("fan-out ran %d Summary calls in flight, want at most 2", summary.maxInFlight())
		}
		if summary.maxInFlight() < 2 {
			t.Logf("fan-out peak in-flight = %d (want 2); the scheduler still bounded the fan-out", summary.maxInFlight())
		}
	})

	t.Run("failure_warns_and_metrics", func(t *testing.T) {
		h := newHarness(t)
		h.seedOrg(t, "org-fail-1", true)
		h.seedOrg(t, "org-fail-2", true)
		summary := &fakeSummaryEvaluator{
			failOn: map[string]error{"org-fail-2": fmt.Errorf("classification summary unavailable")},
		}
		scheduler := newClassificationScheduler(t, classificationalert.Options{
			DB:          h.db,
			Redis:       h.redis,
			Summary:     summary,
			ActiveOrgs:  &fakeActiveOrgs{orgIDs: []string{"org-fail-1", "org-fail-2"}},
			Concurrency: &fakeConcurrency{value: 2},
		})

		result, err := scheduler.EvaluateOnce(h.ctx)
		if err != nil {
			t.Fatalf("EvaluateOnce returned a tick-level error, want warn-only org failure: %v", err)
		}
		if result.FailedOrgs != 1 {
			t.Fatalf("tick failedOrgs = %d, want 1", result.FailedOrgs)
		}
		if result.CompletedOrgs != 1 {
			t.Fatalf("tick completedOrgs = %d, want 1 (a failing org must not abort the others)", result.CompletedOrgs)
		}
		if calls := summary.recordedCalls(); len(calls) != 2 {
			t.Fatalf("Summary evaluated %d orgs, want 2", len(calls))
		}

		// The scheduler records the Prometheus counter shared with NestJS.
		rendered := metrics.Render()
		wantFailure := `scheduler_runs_total{scheduler="` + classificationSchedulerName + `",status="failure"}`
		if !strings.Contains(rendered, wantFailure) {
			t.Fatalf("metrics.Render() does not expose %q (rendered=%s)", wantFailure, rendered)
		}
		wantSuccess := `scheduler_runs_total{scheduler="` + classificationSchedulerName + `",status="success"}`
		if !strings.Contains(rendered, wantSuccess) {
			t.Fatalf("metrics.Render() does not expose %q (rendered=%s)", wantSuccess, rendered)
		}
	})
}

// newClassificationScheduler builds and cleans up one scheduler instance. It
// deliberately does not call Start: the tests drive EvaluateOnce/EvaluateOrg
// directly so no background ticker runs in CI.
func newClassificationScheduler(t *testing.T, options classificationalert.Options) *classificationalert.Scheduler {
	t.Helper()
	scheduler, err := classificationalert.NewScheduler(options)
	if err != nil {
		t.Fatalf("classificationalert.NewScheduler: %v", err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := scheduler.Close(closeCtx); err != nil {
			t.Logf("classificationalert.Close: %v", err)
		}
	})
	return scheduler
}
