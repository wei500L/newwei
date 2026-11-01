//go:build integration

package economicqueue

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// These tests need a real Redis because the point is the BullMQ wire protocol:
// the vendored Lua scripts, the lock/stalled bookkeeping and the pause lists
// cannot be exercised with a fake. They run in the existing
// api-go-user-settings-integration CI job (which already provides Redis 7.2).
//
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

// queueFixture is one isolated scratch queue. It never touches the production
// bull:akshare-data:* key space.
type queueFixture struct {
	client   *redis.Client
	name     string
	keys     keySpace
	producer *Producer
}

func newQueueFixture(t *testing.T) *queueFixture {
	t.Helper()
	client := integrationRedis(t)
	name := fmt.Sprintf("economicqueue-test-%d-%d", time.Now().UnixNano(), os.Getpid())
	fixture := &queueFixture{client: client, name: name, keys: newKeySpace(Prefix, name), producer: newProducerWithName(client, name)}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		keys, err := client.Keys(ctx, "bull:"+name+":*").Result()
		if err == nil && len(keys) > 0 {
			_ = client.Del(ctx, keys...).Err()
		}
	})
	return fixture
}

func (f *queueFixture) worker(t *testing.T, handler Handler, opts WorkerOptions) *Worker {
	t.Helper()
	return newWorkerWithName(f.client, handler, opts, f.name)
}

// drainStalledPass deletes the stalled-check guard and runs the checker twice,
// which is the two-pass sequence BullMQ needs to mark then recover a job.
func (f *queueFixture) drainStalledPass(t *testing.T, worker *Worker) {
	t.Helper()
	ctx := context.Background()
	for pass := 0; pass < 2; pass++ {
		if err := f.client.Del(ctx, f.keys.stalledCheck()).Err(); err != nil {
			t.Fatalf("delete stalled-check: %v", err)
		}
		worker.checkStalled(ctx)
	}
}

func TestEconomicQueueIntegrationPauseAndResume(t *testing.T) {
	ctx := context.Background()

	t.Run("manual enqueue while paused lands in the paused list", func(t *testing.T) {
		fixture := newQueueFixture(t)
		if err := fixture.client.HSet(ctx, fixture.keys.meta(), "paused", 1).Err(); err != nil {
			t.Fatalf("pause: %v", err)
		}
		id, err := fixture.producer.AddManual(ctx, JobData{DataItemID: "slug-paused"})
		if err != nil {
			t.Fatalf("add manual: %v", err)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.paused()).Val(); got != 1 {
			t.Fatalf("paused list = %d, want 1", got)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 0 {
			t.Fatalf("wait list = %d, want 0 while paused", got)
		}
		if fixture.client.Exists(ctx, fixture.keys.job(id)).Val() != 1 {
			t.Fatal("job hash must exist while paused")
		}
	})

	t.Run("worker does not claim while paused and resumes afterwards", func(t *testing.T) {
		fixture := newQueueFixture(t)
		if _, err := fixture.producer.AddManual(ctx, JobData{DataItemID: "slug-1"}); err != nil {
			t.Fatalf("add manual: %v", err)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 1 {
			t.Fatalf("wait list = %d, want 1", got)
		}
		if err := fixture.client.HSet(ctx, fixture.keys.meta(), "paused", 1).Err(); err != nil {
			t.Fatalf("pause: %v", err)
		}
		var processed atomic.Int64
		worker := fixture.worker(t, func(context.Context, Job) error {
			processed.Add(1)
			return nil
		}, WorkerOptions{Concurrency: 1, LockDuration: 2 * time.Second, PollInterval: 10 * time.Millisecond})
		runCtx, cancelRun := context.WithCancel(context.Background())
		go worker.Run(runCtx)

		time.Sleep(300 * time.Millisecond)
		if got := processed.Load(); got != 0 {
			t.Fatalf("worker processed %d jobs while paused, want 0", got)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 1 {
			t.Fatalf("wait list = %d while paused, want 1", got)
		}

		if err := fixture.client.HDel(ctx, fixture.keys.meta(), "paused").Err(); err != nil {
			t.Fatalf("resume: %v", err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for processed.Load() == 0 {
			if time.Now().After(deadline) {
				t.Fatal("worker did not process the job after resume")
			}
			time.Sleep(20 * time.Millisecond)
		}
		cancelRun()
		closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelClose()
		if err := worker.Close(closeCtx); err != nil {
			t.Fatalf("worker close: %v", err)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.active()).Val(); got != 0 {
			t.Fatalf("active list = %d after resume, want 0", got)
		}
	})
}

func TestEconomicQueueIntegrationLockOwnership(t *testing.T) {
	ctx := context.Background()

	t.Run("live lock is never recovered", func(t *testing.T) {
		fixture := newQueueFixture(t)
		if _, err := fixture.producer.AddManual(ctx, JobData{DataItemID: "slug-live-lock"}); err != nil {
			t.Fatalf("add manual: %v", err)
		}
		worker := fixture.worker(t, func(context.Context, Job) error { return nil }, WorkerOptions{
			Concurrency: 1, LockDuration: 5 * time.Second, StalledInterval: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
		})
		claimed, err := worker.moveToActive(ctx)
		if err != nil || claimed == nil {
			t.Fatalf("moveToActive: job=%v err=%v", claimed, err)
		}
		fixture.drainStalledPass(t, worker)
		if got := fixture.client.LLen(ctx, fixture.keys.active()).Val(); got != 1 {
			t.Fatalf("active = %d after stalled pass with a live lock, want 1 (must not be reclaimed)", got)
		}
		if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 0 {
			t.Fatalf("wait = %d, want 0 for a live locked job", got)
		}
	})

	t.Run("expired active is recovered and a stale token cannot finish", func(t *testing.T) {
		fixture := newQueueFixture(t)
		if _, err := fixture.producer.AddManual(ctx, JobData{DataItemID: "slug-lock"}); err != nil {
			t.Fatalf("add manual: %v", err)
		}
		// Claim with a short lock and let it expire.
		short := fixture.worker(t, func(context.Context, Job) error { return nil }, WorkerOptions{
			Concurrency: 1, LockDuration: 150 * time.Millisecond, StalledInterval: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
		})
		stale, err := short.moveToActive(ctx)
		if err != nil || stale == nil {
			t.Fatalf("short moveToActive: job=%v err=%v", stale, err)
		}
		time.Sleep(250 * time.Millisecond)
		fixture.drainStalledPass(t, short)
		if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 1 {
			t.Fatalf("wait = %d after lock expiry, want 1 (expired active must be recovered)", got)
		}

		// A second executor reclaims it; the stale token must not finish it.
		owner := fixture.worker(t, func(context.Context, Job) error { return nil }, WorkerOptions{
			Concurrency: 1, LockDuration: 5 * time.Second, StalledInterval: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
		})
		current, err := owner.moveToActive(ctx)
		if err != nil || current == nil {
			t.Fatalf("owner moveToActive: job=%v err=%v", current, err)
		}
		owner.finish(ctx, Job{ID: current.ID, Token: stale.Token, Opts: current.Opts}, "completed", nil)
		if got := fixture.client.LLen(ctx, fixture.keys.active()).Val(); got != 1 {
			t.Fatalf("active = %d after stale finish, want 1 (stale token must be ignored)", got)
		}
		if fixture.client.ZCard(ctx, fixture.keys.completed()).Val() != 0 {
			t.Fatal("stale token must not write a completed terminal state")
		}
		owner.finish(ctx, *current, "completed", nil)
		if got := fixture.client.LLen(ctx, fixture.keys.active()).Val(); got != 0 {
			t.Fatalf("active = %d after owner finish, want 0", got)
		}
		if fixture.client.Exists(ctx, fixture.keys.job(current.ID)).Val() != 0 {
			t.Fatal("removeOnComplete=true must delete the completed job hash")
		}
	})
}

func TestEconomicQueueIntegrationStalledExceededFails(t *testing.T) {
	ctx := context.Background()
	fixture := newQueueFixture(t)
	if _, err := fixture.producer.AddManual(ctx, JobData{DataItemID: "slug-stalled"}); err != nil {
		t.Fatalf("add manual: %v", err)
	}
	var handlerCalls atomic.Int64
	worker := fixture.worker(t, func(context.Context, Job) error {
		handlerCalls.Add(1)
		return nil
	}, WorkerOptions{
		Concurrency: 1, LockDuration: 120 * time.Millisecond, MaxStalledCount: 1,
		StalledInterval: 50 * time.Millisecond, PollInterval: 10 * time.Millisecond,
	})

	for cycle := 1; cycle <= 2; cycle++ {
		job, err := worker.moveToActive(ctx)
		if err != nil || job == nil {
			t.Fatalf("cycle %d moveToActive: job=%v err=%v", cycle, job, err)
		}
		time.Sleep(180 * time.Millisecond)
		fixture.drainStalledPass(t, worker)
	}
	if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 1 {
		t.Fatalf("wait = %d after exceeding stalled limit, want 1", got)
	}

	job, err := worker.moveToActive(ctx)
	if err != nil || job == nil {
		t.Fatalf("final moveToActive: job=%v err=%v", job, err)
	}
	if job.DeferredFailure == "" {
		t.Fatal("job exceeding MaxStalledCount must carry the defa marker")
	}
	worker.process(ctx, *job)
	if got := handlerCalls.Load(); got != 0 {
		t.Fatalf("handler ran %d times for a terminally stalled job, want 0", got)
	}
	if got := fixture.client.ZCard(ctx, fixture.keys.failed()).Val(); got != 1 {
		t.Fatalf("failed set = %d, want 1", got)
	}
	if reason := fixture.client.HGet(ctx, fixture.keys.job(job.ID), "failedReason").Val(); reason != "job stalled more than allowable limit" {
		t.Fatalf("failedReason = %q", reason)
	}
}

func TestEconomicQueueIntegrationRepeatGuard(t *testing.T) {
	ctx := context.Background()
	fixture := newQueueFixture(t)
	repeat := RepeatOptions{Every: 60_000}
	entry, err := fixture.producer.AddRepeat(ctx, "fetch:slug-repeat", JobData{DataItemID: "slug-repeat"}, repeat)
	if err != nil {
		t.Fatalf("add repeat: %v", err)
	}
	next1 := entry.Next
	iteration := Job{
		ID:           repeatIterationJobID(entry.Key, next1),
		Name:         "fetch:slug-repeat",
		Data:         json.RawMessage(`{"dataItemId":"slug-repeat"}`),
		RepeatJobKey: entry.Key,
		Timestamp:    time.Now().UnixMilli(),
		Opts:         buildRepeatIterationOptions(repeat, entry.Key, repeatIterationJobID(entry.Key, next1), next1, time.Now().UnixMilli()),
	}
	if err := fixture.producer.ScheduleNextRepeat(ctx, iteration); err != nil {
		t.Fatalf("schedule next: %v", err)
	}
	score, err := fixture.client.ZScore(ctx, fixture.keys.repeat(), entry.Key).Result()
	if err != nil {
		t.Fatalf("repeat score: %v", err)
	}
	next2 := int64(score)
	if next2 <= next1 {
		t.Fatalf("next iteration %d did not advance beyond %d", next2, next1)
	}
	if fixture.client.Exists(ctx, fixture.keys.job(repeatIterationJobID(entry.Key, next2))).Val() != 1 {
		t.Fatal("the next iteration job hash must be scheduled")
	}

	// A duplicate claim of the same iteration must not advance again.
	if err := fixture.producer.ScheduleNextRepeat(ctx, iteration); err != nil {
		t.Fatalf("duplicate schedule next: %v", err)
	}
	again, _ := fixture.client.ZScore(ctx, fixture.keys.repeat(), entry.Key).Result()
	if int64(again) != next2 {
		t.Fatalf("duplicate claim advanced the repeat to %d, want %d", int64(again), next2)
	}
	if fixture.client.Exists(ctx, fixture.keys.job(repeatIterationJobID(entry.Key, next2+60000))).Val() != 0 {
		t.Fatal("duplicate claim must not schedule an extra iteration")
	}

	// Deleting the scheduler must not be resurrected by an in-flight iteration.
	if err := fixture.producer.RemoveRepeatable(ctx, entry.Key); err != nil {
		t.Fatalf("remove repeatable: %v", err)
	}
	inFlight := iteration
	inFlight.ID = repeatIterationJobID(entry.Key, next2)
	inFlight.Opts = buildRepeatIterationOptions(repeat, entry.Key, inFlight.ID, next2, time.Now().UnixMilli())
	if err := fixture.producer.ScheduleNextRepeat(ctx, inFlight); err != nil {
		t.Fatalf("schedule after delete: %v", err)
	}
	if _, err := fixture.client.ZScore(ctx, fixture.keys.repeat(), entry.Key).Result(); !errors.Is(err, redis.Nil) {
		t.Fatalf("deleted scheduler was resurrected (err=%v)", err)
	}
}

func TestEconomicQueueIntegrationRepeatFailureKeepsSchedule(t *testing.T) {
	ctx := context.Background()
	fixture := newQueueFixture(t)
	repeat := RepeatOptions{Every: 300}
	entry, err := fixture.producer.AddRepeat(ctx, "fetch:slug-live", JobData{DataItemID: "slug-live"}, repeat)
	if err != nil {
		t.Fatalf("add repeat: %v", err)
	}
	var calls atomic.Int64
	worker := fixture.worker(t, func(context.Context, Job) error {
		calls.Add(1)
		return errors.New("provider boom")
	}, WorkerOptions{Concurrency: 1, LockDuration: 5 * time.Second, PollInterval: 10 * time.Millisecond})
	runCtx, cancelRun := context.WithCancel(context.Background())
	go worker.Run(runCtx)

	deadline := time.Now().Add(10 * time.Second)
	for calls.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("repeat iteration was never processed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancelRun()
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelClose()
	if err := worker.Close(closeCtx); err != nil {
		t.Fatalf("worker close: %v", err)
	}
	// A failed fetch must still leave the schedule and a next iteration alive.
	if _, err := fixture.client.ZScore(ctx, fixture.keys.repeat(), entry.Key).Result(); err != nil {
		t.Fatalf("repeat schedule disappeared after a failed fetch: %v", err)
	}
	if got := fixture.client.ZCard(ctx, fixture.keys.failed()).Val(); got == 0 {
		t.Fatal("the failed fetch must be recorded in the failed set")
	}
}

func TestEconomicQueueIntegrationCancelAndDrain(t *testing.T) {
	ctx := context.Background()
	fixture := newQueueFixture(t)
	for index := 0; index < 2; index++ {
		if _, err := fixture.producer.AddManual(ctx, JobData{DataItemID: fmt.Sprintf("slug-%d", index)}); err != nil {
			t.Fatalf("add manual: %v", err)
		}
	}
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	var calls atomic.Int64
	worker := fixture.worker(t, func(handlerCtx context.Context, _ Job) error {
		calls.Add(1)
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return nil
		case <-handlerCtx.Done():
			return handlerCtx.Err()
		}
	}, WorkerOptions{Concurrency: 1, LockDuration: 5 * time.Second, PollInterval: 10 * time.Millisecond})
	runCtx, cancelRun := context.WithCancel(context.Background())
	go worker.Run(runCtx)

	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker never started the first job")
	}
	// Stop claiming new jobs, then let the in-flight job finish.
	cancelRun()
	time.Sleep(100 * time.Millisecond)
	if got := calls.Load(); got != 1 {
		t.Fatalf("calls = %d after cancel, want 1 (no new claim)", got)
	}
	close(release)
	closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelClose()
	if err := worker.Close(closeCtx); err != nil {
		t.Fatalf("worker close must not hang: %v", err)
	}
	// The second job must still be claimable after the drain.
	if got := fixture.client.LLen(ctx, fixture.keys.wait()).Val(); got != 1 {
		t.Fatalf("wait = %d after drain, want 1 unclaimed job preserved", got)
	}
}
