//go:build integration

package assistantqueue

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	addr := os.Getenv("API_GO_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

func resetAssistantQueue(t *testing.T, client *redis.Client) {
	t.Helper()
	keys, err := client.Keys(context.Background(), "bull:assistant:*").Result()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) > 0 {
		if err := client.Del(context.Background(), keys...).Err(); err != nil {
			t.Fatal(err)
		}
	}
}

// TestProducerWorkerRetryAndRemove exercises the BullMQ contract against real
// Redis: the job is produced with the NestJS options, consumed by moveToActive,
// failed once (retryJob/moveToDelayed with exponential backoff), then completed
// and removed by removeOnComplete. Job.remove() is also covered.
func TestProducerWorkerRetryAndRemove(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	resetAssistantQueue(t, client)
	defer resetAssistantQueue(t, client)

	producer := NewProducer(client)
	data := JobData{Type: JobTypeQuery, RunID: "run-retry", OrgID: "org-1", TraceID: "trace-1"}
	if _, err := producer.Add(context.Background(), string(JobTypeQuery), data, AddOptions{
		JobID:    "assistant:query:run-retry",
		Attempts: 2,
		Backoff:  Backoff{Type: "exponential", Delay: 200},
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	attempts := make(chan int, 4)
	done := make(chan struct{})
	worker := NewWorker(client, WorkerConfig{
		Concurrency:     1,
		LockDuration:    2 * time.Second,
		StalledInterval: time.Second,
		MaxStalledCount: 1,
		PollInterval:    30 * time.Millisecond,
	}, func(_ context.Context, job ClaimedJob) error {
		attempts <- job.AttemptsMade + 1
		if job.AttemptsMade == 0 {
			return errors.New("first attempt fails")
		}
		close(done)
		return nil
	})
	worker.Start(ctx)
	defer func() { _ = worker.Close(context.Background()) }()

	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("job was not completed")
	}
	first := <-attempts
	second := <-attempts
	if first != 1 || second != 2 {
		t.Fatalf("attempts = %d,%d", first, second)
	}
	// removeOnComplete=true removes the job hash and returns the waiting state.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if exists, _ := client.Exists(context.Background(), jobKey("assistant:query:run-retry")).Result(); exists == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if exists, _ := client.Exists(context.Background(), jobKey("assistant:query:run-retry")).Result(); exists != 0 {
		t.Fatal("completed job was not removed")
	}

	// Remove deletes a pending job exactly like Job.remove().
	pendingID := "assistant:query:run-remove"
	if _, err := producer.Add(context.Background(), string(JobTypeQuery), JobData{
		Type: JobTypeQuery, RunID: "run-remove", OrgID: "org-1",
	}, AddOptions{JobID: pendingID, Attempts: 3, Backoff: Backoff{Type: "exponential", Delay: 200}}); err != nil {
		t.Fatal(err)
	}
	removed, err := producer.Remove(context.Background(), pendingID)
	if err != nil || !removed {
		t.Fatalf("remove = %v %v", removed, err)
	}
	if exists, _ := client.Exists(context.Background(), jobKey(pendingID)).Result(); exists != 0 {
		t.Fatal("removed job still exists")
	}
	if removed, err := producer.Remove(context.Background(), "assistant:query:missing"); err != nil || removed {
		t.Fatalf("missing remove = %v %v", removed, err)
	}
}

// TestStalledJobReturnsWithCounter covers A2's Redis half: the exact
// moveStalledJobsToWait script increments the job hash field "stc" and puts the
// job back on the wait list. The next claim therefore reports a stalled
// re-execution.
func TestStalledJobReturnsWithCounter(t *testing.T) {
	client := integrationRedis(t)
	defer client.Close()
	resetAssistantQueue(t, client)
	defer resetAssistantQueue(t, client)

	producer := NewProducer(client)
	jobID := "assistant:query:run-stalled"
	if _, err := producer.Add(context.Background(), string(JobTypeQuery), JobData{
		Type: JobTypeQuery, RunID: "run-stalled", OrgID: "org-1",
	}, AddOptions{JobID: jobID, Attempts: 3, Backoff: Backoff{Type: "exponential", Delay: 200}}); err != nil {
		t.Fatal(err)
	}
	// Simulate a worker that crashed while holding the job: the id sits on the
	// active list, processedOn is set, and the lock key is gone.
	ctx := context.Background()
	if err := client.RPopLPush(ctx, key("wait"), key("active")).Err(); err != nil {
		t.Fatal(err)
	}
	if err := client.HSet(ctx, jobKey(jobID), "processedOn", time.Now().UnixMilli()).Err(); err != nil {
		t.Fatal(err)
	}
	worker := NewWorker(client, WorkerConfig{
		Concurrency:     1,
		LockDuration:    2 * time.Second,
		StalledInterval: 20 * time.Millisecond,
		MaxStalledCount: 1,
		PollInterval:    20 * time.Millisecond,
	}, func(context.Context, ClaimedJob) error { return nil })
	// The first check only marks the active job as a stall candidate; the
	// stalled-check marker then gates the second check until its TTL expires.
	worker.checkStalled(ctx)
	time.Sleep(40 * time.Millisecond)
	worker.checkStalled(ctx)
	stalled, err := client.HGet(ctx, jobKey(jobID), "stc").Int()
	if err != nil || stalled != 1 {
		t.Fatalf("stc = %d %v", stalled, err)
	}
	if position, err := client.LPos(ctx, key("wait"), jobID, redis.LPosArgs{}).Result(); err != nil || position < 0 {
		t.Fatalf("job is not back on the wait list: %d %v", position, err)
	}

	claimed, err := worker.claim(ctx)
	if err != nil || claimed == nil {
		t.Fatalf("claim = %+v %v", claimed, err)
	}
	if claimed.StalledCounter != 1 || claimed.Data.RunID != "run-stalled" {
		t.Fatalf("claimed = %+v", claimed)
	}
	if err := worker.complete(ctx, *claimed, claimed.Token); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if exists, _ := client.Exists(ctx, jobKey(jobID)).Result(); exists != 0 {
		t.Fatal("completed stalled job was not removed")
	}
}
