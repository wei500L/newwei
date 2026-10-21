package crawlworker

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlexecution"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

// fakeTransitions records the BullMQ transitions an attempt requests.
type fakeTransitions struct {
	calls           []string
	updateDataCalls [][]byte
	completedValues []json.RawMessage
	failedReasons   []string
	retryReasons    []string
	retryDelays     []int64
	moveToWaitCalls int
	moveToWaitPTTL  int64
	errors          map[string]error
}

func newFakeTransitions() *fakeTransitions {
	return &fakeTransitions{errors: map[string]error{}}
}

func (f *fakeTransitions) record(name string) error {
	f.calls = append(f.calls, name)
	return f.errors[name]
}

func (f *fakeTransitions) UpdateData(_ context.Context, _ claimedJob, data []byte) error {
	f.updateDataCalls = append(f.updateDataCalls, append([]byte(nil), data...))
	return f.record("updateData")
}

func (f *fakeTransitions) MoveToCompleted(_ context.Context, _ claimedJob, returnValue json.RawMessage, _ int) error {
	f.completedValues = append(f.completedValues, returnValue)
	return f.record("completed")
}

func (f *fakeTransitions) MoveToFailed(_ context.Context, _ claimedJob, reason string, _ int) error {
	f.failedReasons = append(f.failedReasons, reason)
	return f.record("failed")
}

func (f *fakeTransitions) Retry(_ context.Context, _ claimedJob, reason string) error {
	f.retryReasons = append(f.retryReasons, reason)
	f.retryDelays = append(f.retryDelays, 0)
	return f.record("retry")
}

func (f *fakeTransitions) RetryLater(_ context.Context, _ claimedJob, reason string, delayMs int64) error {
	f.retryReasons = append(f.retryReasons, reason)
	f.retryDelays = append(f.retryDelays, delayMs)
	return f.record("retryLater")
}

func (f *fakeTransitions) MoveToWait(_ context.Context, _ claimedJob) (int64, error) {
	f.moveToWaitCalls++
	return f.moveToWaitPTTL, f.record("moveToWait")
}

// fakeRunner is a TaskRunner double.
type fakeRunner struct {
	summary     crawlexecution.FullSummary
	err         error
	calls       int
	orgID       string
	taskID      string
	triggeredBy string
	options     RunOptions
}

func (r *fakeRunner) RunQueuedTask(_ context.Context, orgID, taskID, triggeredByID string, options RunOptions) (crawlexecution.FullSummary, error) {
	r.calls++
	r.orgID, r.taskID, r.triggeredBy = orgID, taskID, triggeredByID
	r.options = options
	return r.summary, r.err
}

// fakeFrontier is a FrontierNodeProcessor double.
type fakeFrontier struct {
	value     json.RawMessage
	err       error
	calls     int
	nodeID    string
	orgID     string
	timeoutMs int
}

func (f *fakeFrontier) ProcessQueuedNode(_ context.Context, nodeID, orgID string, requestTimeoutMs int) (json.RawMessage, error) {
	f.calls++
	f.nodeID, f.orgID, f.timeoutMs = nodeID, orgID, requestTimeoutMs
	return f.value, f.err
}

// fakeActivity is an ActivityCounter double.
type fakeActivity struct {
	calls int
	err   error
}

func (a *fakeActivity) MarkTasksTerminalAtomic(_ context.Context, count int) error {
	a.calls += count
	return a.err
}

// taskCall records one CrawlTask write.
type taskCall struct {
	Kind      string
	TaskID    string
	OrgID     string
	LastError string
}

// fakeTasks is a taskStore double. failFirst rejects the first MarkFailed call so
// the VARCHAR(191) fallback can be observed.
type fakeTasks struct {
	calls     []taskCall
	failFirst bool
	failed    int
	err       error
}

func (s *fakeTasks) MarkFailed(_ context.Context, taskID, orgID, lastError string) error {
	s.calls = append(s.calls, taskCall{Kind: "failed", TaskID: taskID, OrgID: orgID, LastError: lastError})
	s.failed++
	if s.err != nil {
		return s.err
	}
	if s.failFirst && s.failed == 1 {
		return errors.New("Error 1406: Data too long for column 'lastError'")
	}
	return nil
}

func (s *fakeTasks) MarkStalled(_ context.Context, taskID, orgID, lastError string) error {
	s.calls = append(s.calls, taskCall{Kind: "stalled", TaskID: taskID, OrgID: orgID, LastError: lastError})
	return s.err
}

// fakeSnapshots is a Snapshots double.
type fakeSnapshots struct {
	calls []string
	err   error
}

func (s *fakeSnapshots) SyncQueueCounts(_ context.Context, orgID, sourceID string) error {
	s.calls = append(s.calls, orgID+"/"+sourceID)
	return s.err
}

// fakeSettings is a settingsProvider double.
type fakeSettings struct {
	settings      crawlqueue.Settings
	err           error
	invalidations int
}

func (s *fakeSettings) Read(context.Context) (crawlqueue.Settings, error) {
	return s.settings, s.err
}

func (s *fakeSettings) Invalidate() { s.invalidations++ }

// attemptFixture wires an attempt with fakes.
type attemptFixture struct {
	attempt        *attempt
	transitions    *fakeTransitions
	runner         *fakeRunner
	frontier       *fakeFrontier
	activity       *fakeActivity
	tasks          *fakeTasks
	snapshots      *fakeSnapshots
	settings       *fakeSettings
	rateLimitCalls []int64
	rateLimitErr   error
}

func newAttemptFixture() *attemptFixture {
	fixture := &attemptFixture{
		transitions: newFakeTransitions(),
		runner:      &fakeRunner{summary: crawlexecution.FullSummary{Inserted: 2, Skipped: 1}},
		frontier:    &fakeFrontier{value: json.RawMessage(`{"node":7,"processed":true}`)},
		activity:    &fakeActivity{},
		tasks:       &fakeTasks{},
		snapshots:   &fakeSnapshots{},
		settings: &fakeSettings{settings: crawlqueue.Settings{
			MaxConcurrency:          3,
			RequestTimeoutHotMs:     60_000,
			RequestTimeoutNormalMs:  120_000,
			QueueOverloadCooldownMs: 30_000,
		}},
	}
	fixture.attempt = &attempt{
		runner:    fixture.runner,
		frontier:  fixture.frontier,
		limiter:   newConcurrencyLimiter(4),
		settings:  fixture.settings,
		activity:  fixture.activity,
		tasks:     fixture.tasks,
		snapshots: fixture.snapshots,
		rateLimitAll: func(_ context.Context, cooldownMs int64) error {
			fixture.rateLimitCalls = append(fixture.rateLimitCalls, cooldownMs)
			return fixture.rateLimitErr
		},
		config: Config{DefaultTimeoutMs: 90_000},
		log:    func(string, ...any) {},
	}
	return fixture
}

func (f *attemptFixture) hotTarget() queueTarget {
	return queueTarget{Name: crawlqueue.QueueHot, Class: crawlqueue.PriorityClassHot, Transitions: f.transitions}
}

const testJobData = `{"taskId":"task-1","orgId":"org-1","sourceId":"source-1","triggeredById":"user-1","traceId":"trace-1","memoryPressureRequeues":0,"priorityClass":"hot"}`

const testFrontierJobData = `{"taskId":"task-1","orgId":"org-1","sourceId":"source-1","triggeredById":"user-1","traceId":"trace-1","memoryPressureRequeues":0,"priorityClass":"hot","jobKind":"frontier_node","frontierNodeId":"node-7"}`

// testJob builds a claimed job exactly as moveToActive would decode it.
func testJob(t *testing.T, data, opts string, attemptsMade, attemptsStarted int) claimedJob {
	t.Helper()
	job, err := jobFromFlat([]any{
		"id", "job-1",
		"data", data,
		"opts", opts,
		"atm", int64(attemptsMade),
		"ats", int64(attemptsStarted),
	}, "token-1", "job-1")
	if err != nil {
		t.Fatalf("decode the test job: %v", err)
	}
	return job
}

func TestAttemptCompletesACrawlTask(t *testing.T) {
	fixture := newAttemptFixture()
	job := testJob(t, testJobData, `{"attempts":3,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeCompleted {
		t.Fatalf("outcome = %v, want completed", outcome)
	}
	if fixture.runner.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", fixture.runner.calls)
	}
	if fixture.runner.orgID != "org-1" || fixture.runner.taskID != "task-1" || fixture.runner.triggeredBy != "user-1" {
		t.Errorf("runner arguments = %q/%q/%q", fixture.runner.orgID, fixture.runner.taskID, fixture.runner.triggeredBy)
	}
	options := fixture.runner.options
	if options.Attempt != 1 || options.MaxAttempts != 3 {
		t.Errorf("attempt/maxAttempts = %d/%d", options.Attempt, options.MaxAttempts)
	}
	if options.BackoffDelayMs == nil || *options.BackoffDelayMs != 1000 {
		t.Errorf("backoffDelayMs = %v", options.BackoffDelayMs)
	}
	if options.PriorityClass != "hot" {
		t.Errorf("priorityClass = %q", options.PriorityClass)
	}
	if options.RequestTimeoutMs != 60_000 {
		t.Errorf("requestTimeoutMs = %d, want the hot timeout", options.RequestTimeoutMs)
	}
	if len(fixture.transitions.completedValues) != 1 || !json.Valid(fixture.transitions.completedValues[0]) {
		t.Fatalf("completed values = %v", fixture.transitions.completedValues)
	}
	if got := fixture.transitions.calls; len(got) != 1 || got[0] != "completed" {
		t.Errorf("transitions = %v, want only completed", got)
	}
	if fixture.activity.calls != 1 {
		t.Errorf("activity decrements = %d, want 1", fixture.activity.calls)
	}
	if len(fixture.snapshots.calls) != 1 || fixture.snapshots.calls[0] != "org-1/source-1" {
		t.Errorf("snapshot calls = %v", fixture.snapshots.calls)
	}
}

func TestAttemptCompletesAFrontierNode(t *testing.T) {
	fixture := newAttemptFixture()
	job := testJob(t, testFrontierJobData, `{"attempts":3}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeCompleted {
		t.Fatalf("outcome = %v, want completed", outcome)
	}
	if fixture.runner.calls != 0 {
		t.Errorf("the task runner must not run for a frontier node job (calls=%d)", fixture.runner.calls)
	}
	if fixture.frontier.calls != 1 || fixture.frontier.nodeID != "node-7" || fixture.frontier.orgID != "org-1" {
		t.Errorf("frontier call = %+v", fixture.frontier)
	}
	if fixture.frontier.timeoutMs != 60_000 {
		t.Errorf("frontier timeout = %d, want the hot timeout", fixture.frontier.timeoutMs)
	}
	if len(fixture.transitions.completedValues) != 1 || string(fixture.transitions.completedValues[0]) != `{"node":7,"processed":true}` {
		t.Fatalf("returnvalue = %s, want the frontier payload unchanged", fixture.transitions.completedValues[0])
	}
	// only plain crawl tasks were counted at enqueue time.
	if fixture.activity.calls != 0 {
		t.Errorf("activity decrements = %d, want 0 for a frontier job", fixture.activity.calls)
	}
	if len(fixture.snapshots.calls) != 1 {
		t.Errorf("snapshot calls = %v", fixture.snapshots.calls)
	}
}

// TestAttemptRequeuesAFrontierCrawl4aiError locks the cross-package contract the
// integration adds: crawlfrontiernode rethrows the *crawl4ai.Error unchanged
// (crawlfrontiernode service.go returns execErr without wrapping), so the retry
// classification must see the same Status on the frontier_node path as on the
// ordinary task path. Without this seam the whole HTTP status contract would be
// unverified across the two packages.
func TestAttemptRequeuesAFrontierCrawl4aiError(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.frontier.err = &crawl4ai.Error{Status: 503, Message: "crawl4ai request failed\n(status 503)"}
	job := testJob(t, testFrontierJobData, `{"attempts":3,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRetried {
		t.Fatalf("outcome = %v, want retried for a 503 frontier error", outcome)
	}
	if len(fixture.transitions.retryDelays) != 1 || fixture.transitions.retryDelays[0] != 1000 {
		t.Errorf("retry delays = %v, want [1000]", fixture.transitions.retryDelays)
	}
	if len(fixture.transitions.calls) != 1 || fixture.transitions.calls[0] != "retryLater" {
		t.Errorf("transitions = %v, want [retryLater]", fixture.transitions.calls)
	}
	if len(fixture.transitions.failedReasons) != 0 || fixture.activity.calls != 0 {
		t.Errorf("a retried frontier attempt must not run the failure side effects: failed=%v activity=%d",
			fixture.transitions.failedReasons, fixture.activity.calls)
	}
	if fixture.runner.calls != 0 {
		t.Errorf("the task runner must not run for a frontier node job (calls=%d)", fixture.runner.calls)
	}
}

// TestAttemptRequeuesAFrontierMemoryPressureError is the same cross-package
// contract for the memory pressure branch: isMemoryPressureError reads the
// message text, which crawlfrontiernode forwards unchanged.
func TestAttemptRequeuesAFrontierMemoryPressureError(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.frontier.err = &crawl4ai.Error{Status: 503, Message: "browser pool refusing new browser: memory at 97%"}
	job := testJob(t, testFrontierJobData, `{"attempts":5,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)
	fixture.transitions.moveToWaitPTTL = 90_000

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRateLimited {
		t.Fatalf("outcome = %v, want rate-limited for a frontier memory pressure error", outcome)
	}
	if len(fixture.rateLimitCalls) != 1 || fixture.rateLimitCalls[0] != 90_000 {
		t.Fatalf("rate limit calls = %v, want [90000]", fixture.rateLimitCalls)
	}
	if len(fixture.transitions.updateDataCalls) != 1 || fixture.transitions.moveToWaitCalls != 1 {
		t.Errorf("updateData=%d moveToWait=%d, want 1 and 1",
			len(fixture.transitions.updateDataCalls), fixture.transitions.moveToWaitCalls)
	}
	if len(fixture.transitions.failedReasons) != 0 || len(fixture.transitions.retryDelays) != 0 {
		t.Errorf("a requeue must not fail or retry the job: failed=%v retries=%v",
			fixture.transitions.failedReasons, fixture.transitions.retryDelays)
	}
	if fixture.activity.calls != 0 || len(fixture.tasks.calls) != 0 || len(fixture.snapshots.calls) != 0 {
		t.Errorf("a requeue must not run the terminal side effects")
	}
}

func TestAttemptDelaysARetryableFailure(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("upstream connection reset by peer")
	job := testJob(t, testJobData, `{"attempts":3,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRetried {
		t.Fatalf("outcome = %v, want retried", outcome)
	}
	if len(fixture.transitions.retryDelays) != 1 || fixture.transitions.retryDelays[0] != 1000 {
		t.Errorf("retry delays = %v, want [1000]", fixture.transitions.retryDelays)
	}
	if fixture.transitions.calls[0] != "retryLater" {
		t.Errorf("transitions = %v", fixture.transitions.calls)
	}
	if len(fixture.transitions.failedReasons) != 0 || fixture.activity.calls != 0 || len(fixture.tasks.calls) != 0 {
		t.Errorf("a retried attempt must not run the failure side effects: failed=%v activity=%d tasks=%v",
			fixture.transitions.failedReasons, fixture.activity.calls, fixture.tasks.calls)
	}
}

func TestAttemptRetriesImmediatelyWithoutBackoff(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("temporarily unavailable")
	job := testJob(t, testJobData, `{"attempts":2}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRetried {
		t.Fatalf("outcome = %v, want retried", outcome)
	}
	if len(fixture.transitions.retryDelays) != 1 || fixture.transitions.retryDelays[0] != 0 {
		t.Errorf("retry delays = %v, want a zero delay", fixture.transitions.retryDelays)
	}
	if fixture.transitions.calls[0] != "retry" {
		t.Errorf("transitions = %v", fixture.transitions.calls)
	}
}

func TestAttemptFailsANonRetryableErrorImmediately(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = &crawl4ai.Error{Status: 404, Message: "blocked url"}
	job := testJob(t, testJobData, `{"attempts":3,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeUnrecoverable {
		t.Fatalf("outcome = %v, want unrecoverable", outcome)
	}
	if len(fixture.transitions.failedReasons) != 1 || fixture.transitions.failedReasons[0] != "blocked url" {
		t.Fatalf("failed reasons = %v", fixture.transitions.failedReasons)
	}
	if len(fixture.transitions.retryDelays) != 0 {
		t.Errorf("an unrecoverable error must not be retried: %v", fixture.transitions.retryDelays)
	}
	if fixture.activity.calls != 1 {
		t.Errorf("activity decrements = %d, want 1", fixture.activity.calls)
	}
	if len(fixture.tasks.calls) != 1 {
		t.Fatalf("CrawlTask writes = %v", fixture.tasks.calls)
	}
	call := fixture.tasks.calls[0]
	if call.Kind != "failed" || call.TaskID != "task-1" || call.OrgID != "org-1" || call.LastError != "blocked url" {
		t.Errorf("CrawlTask write = %+v", call)
	}
	if len(fixture.snapshots.calls) != 1 {
		t.Errorf("snapshot calls = %v", fixture.snapshots.calls)
	}
}

func TestAttemptFailsOnTheLastAttempt(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("upstream timeout")
	job := testJob(t, testJobData, `{"attempts":2}`, 1, 2)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeFailed {
		t.Fatalf("outcome = %v, want failed", outcome)
	}
	if len(fixture.transitions.failedReasons) != 1 || fixture.transitions.failedReasons[0] != "upstream timeout" {
		t.Errorf("failed reasons = %v", fixture.transitions.failedReasons)
	}
	if len(fixture.tasks.calls) != 1 || len(fixture.snapshots.calls) != 1 || fixture.activity.calls != 1 {
		t.Errorf("final failure side effects = tasks %v, snapshots %v, activity %d",
			fixture.tasks.calls, fixture.snapshots.calls, fixture.activity.calls)
	}
}

func TestAttemptFailsADeferredJobWithoutRunning(t *testing.T) {
	fixture := newAttemptFixture()
	job := testJob(t, testJobData, `{"attempts":3}`, 0, 1)
	// moveStalledJobsToWait stamps `defa` once a job exceeded maxStalledCount;
	// BullMQ fails it before the processor runs.
	job.DeferredFailure = "job stalled more than allowable limit"

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeUnrecoverable {
		t.Fatalf("outcome = %v, want unrecoverable", outcome)
	}
	if fixture.runner.calls != 0 || fixture.frontier.calls != 0 {
		t.Errorf("a deferred job must not run: runner=%d frontier=%d", fixture.runner.calls, fixture.frontier.calls)
	}
	if len(fixture.transitions.failedReasons) != 1 || fixture.transitions.failedReasons[0] != job.DeferredFailure {
		t.Fatalf("failed reasons = %v", fixture.transitions.failedReasons)
	}
	if len(fixture.tasks.calls) != 1 || fixture.tasks.calls[0].LastError != job.DeferredFailure {
		t.Errorf("CrawlTask writes = %v", fixture.tasks.calls)
	}
	if fixture.activity.calls != 1 {
		t.Errorf("activity decrements = %d, want 1", fixture.activity.calls)
	}
}

func TestAttemptRequeuesAMemoryPressureFailure(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("browser pool refusing new browser: memory at 97%")
	job := testJob(t, testJobData, `{"attempts":5,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)
	fixture.transitions.moveToWaitPTTL = 90_000

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRateLimited {
		t.Fatalf("outcome = %v, want rate-limited", outcome)
	}
	if len(fixture.rateLimitCalls) != 1 || fixture.rateLimitCalls[0] != 90_000 {
		t.Fatalf("rate limit calls = %v, want [90000]", fixture.rateLimitCalls)
	}
	if len(fixture.transitions.updateDataCalls) != 1 {
		t.Fatalf("updateData calls = %d, want 1", len(fixture.transitions.updateDataCalls))
	}
	wantData := `{"taskId":"task-1","orgId":"org-1","sourceId":"source-1","triggeredById":"user-1","traceId":"trace-1","memoryPressureRequeues":1,"priorityClass":"hot"}`
	if got := string(fixture.transitions.updateDataCalls[0]); got != wantData {
		t.Errorf("rewritten job data = %s, want %s", got, wantData)
	}
	if fixture.transitions.moveToWaitCalls != 1 {
		t.Errorf("moveToWait calls = %d, want 1", fixture.transitions.moveToWaitCalls)
	}
	if len(fixture.transitions.failedReasons) != 0 || len(fixture.transitions.retryDelays) != 0 {
		t.Errorf("a requeue must not fail or retry the job: failed=%v retries=%v",
			fixture.transitions.failedReasons, fixture.transitions.retryDelays)
	}
	if fixture.activity.calls != 0 || len(fixture.tasks.calls) != 0 || len(fixture.snapshots.calls) != 0 {
		t.Errorf("a requeue must not run the terminal side effects")
	}
}

func TestAttemptFailsWhenTheMemoryPressureBudgetIsSpent(t *testing.T) {
	cases := []struct {
		name          string
		opts          string
		attemptsMade  int
		attemptsStart int
		data          string
	}{
		{
			name:          "started attempts exhausted",
			opts:          `{"attempts":2}`,
			attemptsMade:  1,
			attemptsStart: 2,
			data:          testJobData,
		},
		{
			name:          "requeue budget exhausted",
			opts:          `{"attempts":3}`,
			attemptsMade:  0,
			attemptsStart: 1,
			data:          `{"taskId":"task-1","orgId":"org-1","sourceId":"source-1","traceId":"trace-1","memoryPressureRequeues":2,"priorityClass":"hot"}`,
		},
	}
	for _, testCase := range cases {
		fixture := newAttemptFixture()
		cause := errors.New("crawl4ai refusing new browser: memory at 96%")
		fixture.runner.err = cause
		job := testJob(t, testCase.data, testCase.opts, testCase.attemptsMade, testCase.attemptsStart)

		outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
		if outcome != outcomeUnrecoverable {
			t.Fatalf("%s: outcome = %v, want unrecoverable", testCase.name, outcome)
		}
		if len(fixture.rateLimitCalls) != 0 {
			t.Errorf("%s: rate limit calls = %v, want none", testCase.name, fixture.rateLimitCalls)
		}
		if len(fixture.transitions.updateDataCalls) != 0 {
			t.Errorf("%s: updateData calls = %d, want none", testCase.name, len(fixture.transitions.updateDataCalls))
		}
		if len(fixture.transitions.failedReasons) != 1 || fixture.transitions.failedReasons[0] != cause.Error() {
			t.Errorf("%s: failed reasons = %v", testCase.name, fixture.transitions.failedReasons)
		}
		if len(fixture.tasks.calls) != 1 {
			t.Errorf("%s: CrawlTask writes = %v", testCase.name, fixture.tasks.calls)
		}
	}
}

func TestAttemptFallsBackToTheOriginalErrorWhenRateLimitingFails(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("refusing new browser: memory at 95%")
	fixture.rateLimitErr = errors.New("redis is down")
	job := testJob(t, testJobData, `{"attempts":5,"backoff":{"type":"exponential","delay":1000}}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeRetried {
		t.Fatalf("outcome = %v, want the original error to go through the normal retry path", outcome)
	}
	if len(fixture.transitions.retryDelays) != 1 || fixture.transitions.retryDelays[0] != 1000 {
		t.Errorf("retry delays = %v, want [1000]", fixture.transitions.retryDelays)
	}
	if len(fixture.transitions.updateDataCalls) != 0 || fixture.transitions.moveToWaitCalls != 0 {
		t.Errorf("the requeue state must not be written when the rate limit failed")
	}
}

func TestAttemptFailsWhenTheRequeueStateCannotBePersisted(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New("refusing new browser: memory at 95%")
	fixture.transitions.errors["updateData"] = errors.New("job vanished")
	job := testJob(t, testJobData, `{"attempts":5}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeUnrecoverable {
		t.Fatalf("outcome = %v, want unrecoverable", outcome)
	}
	if fixture.transitions.moveToWaitCalls != 0 {
		t.Errorf("moveToWait calls = %d, want none", fixture.transitions.moveToWaitCalls)
	}
	if len(fixture.transitions.failedReasons) != 1 {
		t.Errorf("failed reasons = %v", fixture.transitions.failedReasons)
	}
}

func TestAttemptAbandonsTheJobWithoutAConcurrencySlot(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.attempt.limiter.close()
	job := testJob(t, testJobData, `{"attempts":3}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeAbandoned {
		t.Fatalf("outcome = %v, want abandoned", outcome)
	}
	if fixture.runner.calls != 0 || len(fixture.transitions.calls) != 0 {
		t.Errorf("an abandoned attempt must not run or transition the job")
	}
}

func TestAttemptUsesTheEnvironmentTimeoutWhenSettingsFail(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.settings.err = errors.New("redis is down")
	job := testJob(t, testJobData, `{"attempts":1}`, 0, 1)

	if outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job); outcome != outcomeCompleted {
		t.Fatalf("outcome = %v, want completed", outcome)
	}
	if fixture.runner.options.RequestTimeoutMs != 90_000 {
		t.Errorf("requestTimeoutMs = %d, want the CRAWL4AI_TIMEOUT_MS fallback", fixture.runner.options.RequestTimeoutMs)
	}
}

func TestAttemptTruncatesTheFailureReasonTo191OnRetry(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = errors.New(strings.Repeat("a", 300))
	fixture.tasks.failFirst = true
	job := testJob(t, testJobData, `{"attempts":1}`, 0, 1)

	outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job)
	if outcome != outcomeUnrecoverable {
		t.Fatalf("outcome = %v, want unrecoverable", outcome)
	}
	if len(fixture.tasks.calls) != 2 {
		t.Fatalf("CrawlTask writes = %d, want 2", len(fixture.tasks.calls))
	}
	if got := utf16Length(fixture.tasks.calls[0].LastError); got != 300 {
		t.Errorf("first lastError length = %d, want 300", got)
	}
	fallback := fixture.tasks.calls[1].LastError
	if got := utf16Length(fallback); got != 191 {
		t.Errorf("fallback lastError length = %d, want 191", got)
	}
	if !strings.HasSuffix(fallback, "…") {
		t.Errorf("fallback lastError = %q, want an ellipsis", fallback)
	}
}

func TestAttemptFallsBackToTheGenericFailureReason(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.runner.err = &crawl4ai.Error{Status: 400, Message: "   "}
	job := testJob(t, testJobData, `{"attempts":1}`, 0, 1)

	if outcome := fixture.attempt.run(context.Background(), fixture.hotTarget(), job); outcome != outcomeUnrecoverable {
		t.Fatalf("outcome = %v, want unrecoverable", outcome)
	}
	if len(fixture.tasks.calls) != 1 || fixture.tasks.calls[0].LastError != failedLastErrorFallback {
		t.Errorf("CrawlTask writes = %v, want the generic failure text", fixture.tasks.calls)
	}
}

func TestStalledSideEffectsRequireTaskData(t *testing.T) {
	fixture := newAttemptFixture()

	fixture.attempt.stalledSideEffects(context.Background(), crawlqueue.QueueHot, "job-1", JobData{})
	if len(fixture.tasks.calls) != 0 || len(fixture.snapshots.calls) != 0 {
		t.Fatalf("a job without taskId/orgId must not write: %v", fixture.tasks.calls)
	}

	fixture.attempt.stalledSideEffects(context.Background(), crawlqueue.QueueHot, "job-1", JobData{
		TaskID:   "task-1",
		OrgID:    "org-1",
		SourceID: stringPointer("source-1"),
	})
	if len(fixture.tasks.calls) != 1 {
		t.Fatalf("CrawlTask writes = %v", fixture.tasks.calls)
	}
	call := fixture.tasks.calls[0]
	if call.Kind != "stalled" || call.LastError != stalledRequeueMessage || call.TaskID != "task-1" || call.OrgID != "org-1" {
		t.Errorf("stalled write = %+v", call)
	}
	if len(fixture.snapshots.calls) != 1 || fixture.snapshots.calls[0] != "org-1/source-1" {
		t.Errorf("snapshot calls = %v", fixture.snapshots.calls)
	}
}

func TestStalledSideEffectsSkipTheSnapshotWhenTheTaskWriteFails(t *testing.T) {
	fixture := newAttemptFixture()
	fixture.tasks.err = errors.New("mysql is down")
	fixture.attempt.stalledSideEffects(context.Background(), crawlqueue.QueueHot, "job-1", JobData{
		TaskID:   "task-1",
		OrgID:    "org-1",
		SourceID: stringPointer("source-1"),
	})
	if len(fixture.snapshots.calls) != 0 {
		t.Errorf("snapshot calls = %v, want none after a failed task write", fixture.snapshots.calls)
	}
}

func stringPointer(value string) *string { return &value }
