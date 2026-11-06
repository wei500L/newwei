package bullmq

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func gateInFlight(g *concurrencyGate) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inFlight
}

// TestSetConcurrencyGrowsImmediately proves that growing the concurrency lets a
// fetch loop blocked on the full gate claim again without waiting for a release.
func TestSetConcurrencyGrowsImmediately(t *testing.T) {
	worker := &Worker{gate: newConcurrencyGate(1)}
	if !worker.gate.acquire(context.Background()) {
		t.Fatal("the first acquire must succeed")
	}
	acquired := make(chan struct{})
	go func() {
		if worker.gate.acquire(context.Background()) {
			close(acquired)
		}
	}()
	select {
	case <-acquired:
		t.Fatal("a second acquire must block while the limit is one")
	case <-time.After(50 * time.Millisecond):
	}

	worker.SetConcurrency(2)
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("SetConcurrency(2) did not wake the blocked acquire")
	}
	if inFlight := gateInFlight(worker.gate); inFlight != 2 {
		t.Fatalf("in-flight = %d, want 2", inFlight)
	}
	worker.gate.release()
	worker.gate.release()
}

// TestSetConcurrencyShrinksWithoutInterruptingInFlight proves that shrinking the
// concurrency leaves the in-flight attempts untouched (they keep their slots) and
// only stops new claims until the count drops below the new limit.
func TestSetConcurrencyShrinksWithoutInterruptingInFlight(t *testing.T) {
	worker := &Worker{gate: newConcurrencyGate(2)}
	ctx := context.Background()
	if !worker.gate.acquire(ctx) || !worker.gate.acquire(ctx) {
		t.Fatal("both initial acquires must succeed")
	}

	worker.SetConcurrency(1)
	if inFlight := gateInFlight(worker.gate); inFlight != 2 {
		t.Fatalf("in-flight = %d after shrink, want the two running attempts untouched", inFlight)
	}

	acquired := make(chan struct{})
	go func() {
		if worker.gate.acquire(ctx) {
			close(acquired)
		}
	}()
	select {
	case <-acquired:
		t.Fatal("a new acquire must block while in-flight exceeds the shrunk limit")
	case <-time.After(50 * time.Millisecond):
	}

	// Releasing one slot still leaves in-flight (1) at the limit, so the new
	// acquire keeps blocking.
	worker.gate.release()
	select {
	case <-acquired:
		t.Fatal("the new acquire must still block while in-flight equals the limit")
	case <-time.After(50 * time.Millisecond):
	}

	// Dropping below the limit lets the blocked acquire through.
	worker.gate.release()
	select {
	case <-acquired:
	case <-time.After(2 * time.Second):
		t.Fatal("the blocked acquire did not run after in-flight dropped below the limit")
	}
	worker.gate.release()
}

// TestOnStalledCallbackReceivesJobIDs proves one stalled-recovery reply is
// forwarded to the OnStalled hook verbatim, in script order, and that an empty
// reply does not invoke it.
func TestOnStalledCallbackReceivesJobIDs(t *testing.T) {
	var got []string
	worker := &Worker{opts: WorkerOptions{
		Logger:    func(string, ...any) {},
		OnStalled: func(_ context.Context, jobIDs []string) { got = jobIDs },
	}}
	worker.handleStalledResult(context.Background(), []any{"job-1", "job-2"})
	if len(got) != 2 || got[0] != "job-1" || got[1] != "job-2" {
		t.Fatalf("OnStalled job ids = %v, want [job-1 job-2]", got)
	}

	got = nil
	worker.handleStalledResult(context.Background(), []any{})
	if got != nil {
		t.Fatalf("OnStalled must not run for an empty recovery, got %v", got)
	}
}

// recordingCmdable records the script invocations of a worker so a test can prove
// a path never acknowledges a job. Only EvalSha/Eval are implemented; the worker
// code under test never calls another command.
type recordingCmdable struct {
	redis.Cmdable
	evalCalls int
}

func (c *recordingCmdable) EvalSha(context.Context, string, []string, ...any) *redis.Cmd {
	c.evalCalls++
	return redis.NewCmdResult(int64(0), nil)
}

func (c *recordingCmdable) Eval(context.Context, string, []string, ...any) *redis.Cmd {
	c.evalCalls++
	return redis.NewCmdResult(int64(0), nil)
}

// newProcessOneWorker builds a worker whose lock renewal never ticks during the
// test (a one hour interval) so ProcessOne only exercises the processor/finish
// decision against the script recorder.
func newProcessOneWorker(processor Processor, recorder *recordingCmdable) *Worker {
	return &Worker{
		commands:  recorder,
		keys:      NewKeys("", "test-queue"),
		opts:      WorkerOptions{LockDuration: time.Hour, LockRenewTime: time.Hour, Logger: func(string, ...any) {}}.normalized(),
		processor: processor,
		gate:      newConcurrencyGate(1),
		jobCtx:    context.Background(),
	}
}

// TestHandledProcessorSkipsFinish is the slot-acquisition-failure equivalent of
// the retired worker: when a processor has already settled (or deliberately left)
// the job and returns Handled, the shared worker must not run any finish script.
func TestHandledProcessorSkipsFinish(t *testing.T) {
	recorder := &recordingCmdable{}
	worker := newProcessOneWorker(func(context.Context, *Job) (json.RawMessage, error) {
		return nil, Handled(nil)
	}, recorder)
	job := &Job{ID: "job-1", Token: "token-1", Opts: json.RawMessage(`{"attempts":1}`)}

	worker.ProcessOne(context.Background(), job)
	if recorder.evalCalls != 0 {
		t.Fatalf("a Handled processor triggered %d script call(s), want 0 (no finish)", recorder.evalCalls)
	}
}

// TestNilProcessorResultFinishes is the contrast case: a processor that returns
// no error is acknowledged by the worker, so the finish script does run.
func TestNilProcessorResultFinishes(t *testing.T) {
	recorder := &recordingCmdable{}
	worker := newProcessOneWorker(func(context.Context, *Job) (json.RawMessage, error) {
		return nil, nil
	}, recorder)
	job := &Job{ID: "job-1", Token: "token-1", Opts: json.RawMessage(`{"attempts":1}`)}

	worker.ProcessOne(context.Background(), job)
	if recorder.evalCalls == 0 {
		t.Fatal("a successful processor must run the finish script")
	}
}
