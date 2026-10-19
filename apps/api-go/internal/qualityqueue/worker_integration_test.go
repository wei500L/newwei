//go:build integration

package qualityqueue

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

// These tests need a real Redis because the whole point is the BullMQ wire
// protocol: the Lua scripts, the key layout and the lock/stalled bookkeeping
// cannot be exercised with a fake. They run in the existing
// api-go-user-settings-integration CI job (which already provides Redis).
//
//	API_GO_TEST_REDIS_ADDR=127.0.0.1:6379

func newIntegrationQueue(t *testing.T) (*Queue, *redis.Client) {
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
	name := fmt.Sprintf("qualityqueue-test-%d-%d", time.Now().UnixNano(), os.Getpid())
	queue := newQueue(client, name)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		keys, _ := client.Keys(ctx, "bull:"+name+":*").Result()
		if len(keys) > 0 {
			_ = client.Del(ctx, keys...).Err()
		}
	})
	return queue, client
}

// TestBullMQJobRoundTrip produces a job the way T1 does and consumes it, then
// verifies the completed job was removed (removeOnComplete=true) and no state is
// left in wait/active.
func TestBullMQJobRoundTrip(t *testing.T) {
	queue, client := newIntegrationQueue(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	payload, err := json.Marshal(map[string]string{"jobType": "report", "orgId": "org-1", "reportJobId": "abc"})
	if err != nil {
		t.Fatal(err)
	}
	jobID, err := queue.Add(ctx, "classification-quality-report:abc", payload, AddOptions{
		JobID:            "classification-quality-report:abc",
		Attempts:         3,
		Backoff:          Backoff{Type: "exponential", Delay: 2000},
		RemoveOnComplete: RemoveImmediately(),
		RemoveOnFail:     Retention(604800, 10000),
	})
	if err != nil {
		t.Fatal(err)
	}
	if jobID != "classification-quality-report:abc" {
		t.Fatalf("jobId = %q", jobID)
	}
	if length := client.LLen(ctx, queue.keys.wait()).Val(); length != 1 {
		t.Fatalf("wait length = %d, want 1", length)
	}
	// The hash must carry the fields a NestJS worker reads.
	hash := client.HGetAll(ctx, queue.keys.job(jobID)).Val()
	if hash["name"] != "classification-quality-report:abc" {
		t.Fatalf("name = %q", hash["name"])
	}
	if hash["data"] != string(payload) {
		t.Fatalf("data = %q", hash["data"])
	}
	if !strings.Contains(hash["opts"], `"attempts":3`) {
		t.Fatalf("opts = %q", hash["opts"])
	}

	processed := make(chan string, 1)
	worker := NewWorker(queue, func(_ context.Context, job Job) error {
		processed <- job.ID
		if job.Options.Attempts != 3 {
			return fmt.Errorf("attempts = %d, want 3", job.Options.Attempts)
		}
		return nil
	}, WorkerOptions{Concurrency: 1, PollInterval: 20 * time.Millisecond})
	worker.Start(ctx)
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer stopCancel()
		if err := worker.Stop(stopCtx); err != nil {
			t.Fatalf("worker stop: %v", err)
		}
	}()

	select {
	case got := <-processed:
		if got != jobID {
			t.Fatalf("processed %q, want %q", got, jobID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("job was never processed")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		exists := client.Exists(ctx, queue.keys.job(jobID)).Val()
		if exists == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("removeOnComplete=true did not delete the job hash")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if length := client.LLen(ctx, queue.keys.active()).Val(); length != 0 {
		t.Fatalf("active length = %d, want 0", length)
	}
}

// TestBullMQFailureRetryAndRetention verifies the retry/backoff path and the
// failed retention: two attempts with a 0 ms backoff end in the failed set with
// the last failure reason, and the hash survives.
func TestBullMQFailureRetryAndRetention(t *testing.T) {
	queue, client := newIntegrationQueue(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	payload := json.RawMessage(`{"jobType":"report","orgId":"org-1","reportJobId":"retry"}`)
	if _, err := queue.Add(ctx, "classification-quality-report:retry", payload, AddOptions{
		JobID:            "classification-quality-report:retry",
		Attempts:         2,
		Backoff:          Backoff{Type: "fixed", Delay: 1},
		RemoveOnComplete: RemoveImmediately(),
		RemoveOnFail:     Retention(604800, 10000),
	}); err != nil {
		t.Fatal(err)
	}

	var runs atomic.Int64
	worker := NewWorker(queue, func(context.Context, Job) error {
		runs.Add(1)
		return errors.New("boom")
	}, WorkerOptions{Concurrency: 1, PollInterval: 20 * time.Millisecond})
	worker.Start(ctx)

	deadline := time.Now().Add(10 * time.Second)
	for {
		failed := client.ZCard(ctx, queue.keys.failed()).Val()
		if failed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job never reached the failed set (runs=%d)", runs.Load())
		}
		time.Sleep(20 * time.Millisecond)
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopCancel()
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatalf("worker stop: %v", err)
	}
	if got := runs.Load(); got != 2 {
		t.Fatalf("attempts = %d, want 2", got)
	}
	jobID := "classification-quality-report:retry"
	hash := client.HGetAll(ctx, queue.keys.job(jobID)).Val()
	if hash["failedReason"] != "boom" {
		t.Fatalf("failedReason = %q", hash["failedReason"])
	}
	if hash["atm"] != "2" {
		t.Fatalf("attempts made = %q, want 2", hash["atm"])
	}
	if hash["finishedOn"] == "" {
		t.Fatal("finishedOn must be set when the job finally fails")
	}
}

// TestBullMQStalledJobIsRecovered verifies the stalled detector: a job whose lock
// expired without being renewed goes back to wait, appears in the stalled list
// and can be consumed again.
func TestBullMQStalledJobIsRecovered(t *testing.T) {
	queue, client := newIntegrationQueue(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	payload := json.RawMessage(`{"jobType":"report","orgId":"org-1","reportJobId":"stalled"}`)
	if _, err := queue.Add(ctx, "classification-quality-report:stalled", payload, AddOptions{
		JobID:            "classification-quality-report:stalled",
		Attempts:         1,
		Backoff:          Backoff{Type: "fixed", Delay: 1},
		RemoveOnComplete: RemoveImmediately(),
		RemoveOnFail:     Retention(604800, 10000),
	}); err != nil {
		t.Fatal(err)
	}

	// Claim the job directly with a 50 ms lock and never finish it, simulating a
	// worker that died.
	token := "dead-worker-token"
	encodedOpts, err := pack(activeOptions{Token: token, LockDuration: 50, Name: "dead-worker"})
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{
		queue.keys.wait(), queue.keys.active(), queue.keys.prioritized(), queue.keys.events(),
		queue.keys.stalled(), queue.keys.limiter(), queue.keys.delayed(), queue.keys.paused(),
		queue.keys.meta(), queue.keys.priorityCounter(), queue.keys.marker(),
	}
	result, err := scriptMoveToActive.Run(ctx, client, keys, queue.keys.base, time.Now().UnixMilli(), string(encodedOpts)).Result()
	if err != nil {
		t.Fatal(err)
	}
	items, ok := result.([]any)
	if !ok || len(items) < 2 || items[1] != "classification-quality-report:stalled" {
		t.Fatalf("moveToActive = %#v", result)
	}
	time.Sleep(120 * time.Millisecond)
	if exists := client.Exists(ctx, queue.keys.lock("classification-quality-report:stalled")).Val(); exists != 0 {
		t.Fatal("lock did not expire")
	}

	stalledKeys := []string{
		queue.keys.stalled(), queue.keys.wait(), queue.keys.active(), queue.keys.stalledCheck(),
		queue.keys.meta(), queue.keys.paused(), queue.keys.marker(), queue.keys.events(),
	}
	// BullMQ's checker first adds every active job to the stalled set and only
	// recovers on the next run, so the test simulates two intervals.
	if _, err := scriptMoveStalledJobsToWait.Run(ctx, client, stalledKeys,
		1, queue.keys.base, time.Now().UnixMilli(), 30000).Result(); err != nil {
		t.Fatal(err)
	}
	if err := client.Del(ctx, queue.keys.stalledCheck()).Err(); err != nil {
		t.Fatal(err)
	}
	recovered, err := scriptMoveStalledJobsToWait.Run(ctx, client, stalledKeys,
		1, queue.keys.base, time.Now().UnixMilli(), 30000).Result()
	if err != nil {
		t.Fatal(err)
	}
	recoveredJobs, _ := recovered.([]any)
	if len(recoveredJobs) != 1 || recoveredJobs[0] != "classification-quality-report:stalled" {
		t.Fatalf("recovered = %#v, want the stalled job", recovered)
	}
	if length := client.LLen(ctx, queue.keys.wait()).Val(); length != 1 {
		t.Fatalf("wait length = %d, want 1", length)
	}

	// A live worker now consumes the recovered job.
	processed := make(chan struct{}, 1)
	worker := NewWorker(queue, func(context.Context, Job) error {
		processed <- struct{}{}
		return nil
	}, WorkerOptions{Concurrency: 1, PollInterval: 20 * time.Millisecond})
	worker.Start(ctx)
	select {
	case <-processed:
	case <-time.After(10 * time.Second):
		t.Fatal("recovered job was never processed")
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer stopCancel()
	if err := worker.Stop(stopCtx); err != nil {
		t.Fatalf("worker stop: %v", err)
	}
}
