//go:build integration

// Integration tests of the news_event_clustering_recovery BullMQ runner. They
// run against the MySQL/Redis services of the existing api-go integration job;
// a missing Redis endpoint skips them. The assertions read the raw Redis
// structures, so a change that still "works" but writes a different job shape
// fails here.
package clusteringrecoveryqueue

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func integrationRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	addr := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR not set — integration test requires a Redis service")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	return client
}

func uniqueJobID(t *testing.T) string {
	t.Helper()
	return "integration-llm-backfill:" + t.Name() + ":" + time.Now().Format("150405.000000000")
}

func cleanupJob(t *testing.T, client *redis.Client, keys keys, jobID string) {
	t.Helper()
	ctx := context.Background()
	client.Del(ctx, keys.Job(jobID))
	client.LRem(ctx, keys.Wait, 0, jobID)
	client.LRem(ctx, keys.Active, 0, jobID)
	client.LRem(ctx, keys.Paused, 0, jobID)
	for _, sorted := range []string{keys.Delayed, keys.Prioritized, keys.Completed, keys.Failed, keys.WaitingChildren} {
		client.ZRem(ctx, sorted, jobID)
	}
}

func TestIntegrationProducerWritesTheNestJSJobShape(t *testing.T) {
	client := integrationRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	producer, err := NewProducer(client, "")
	if err != nil {
		t.Fatal(err)
	}
	jobID := uniqueJobID(t)
	keys := newKeys("", QueueName)
	defer cleanupJob(t, client, keys, jobID)

	payload := Payload{
		JobType: JobTypeLlmBackfill,
		OrgID:   "org-integration",
		ActorID: "user-integration",
		GroupID: "group-integration",
		TraceID: "trace-integration",
		Trigger: "manual",
	}
	if err := producer.Add(ctx, jobID, payload); err != nil {
		t.Fatalf("Add: %v", err)
	}

	fields, err := client.HGetAll(ctx, keys.Job(jobID)).Result()
	if err != nil {
		t.Fatal(err)
	}
	if fields["name"] != JobTypeLlmBackfill {
		t.Fatalf("name = %q", fields["name"])
	}
	var decoded Payload
	if err := json.Unmarshal([]byte(fields["data"]), &decoded); err != nil {
		t.Fatalf("data is not JSON: %v (%s)", err, fields["data"])
	}
	if decoded != payload {
		t.Fatalf("data = %+v", decoded)
	}
	if !strings.Contains(fields["opts"], `"attempts":1`) || !strings.Contains(fields["opts"], `"removeOnComplete":true`) {
		t.Fatalf("opts = %s", fields["opts"])
	}
	position, err := client.LPos(ctx, keys.Wait, jobID, redis.LPosArgs{}).Result()
	if err != nil {
		t.Fatalf("wait position: %v", err)
	}
	if position < 0 {
		t.Fatalf("job is not in the wait list")
	}
	if ts := fields["timestamp"]; ts == "" {
		t.Fatal("timestamp is missing")
	}
}

func TestIntegrationWorkerCompletesJob(t *testing.T) {
	client := integrationRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	producer, err := NewProducer(client, "")
	if err != nil {
		t.Fatal(err)
	}
	jobID := uniqueJobID(t)
	keys := newKeys("", QueueName)
	defer cleanupJob(t, client, keys, jobID)

	payload := Payload{JobType: JobTypeLlmBackfill, OrgID: "org", ActorID: "actor", GroupID: "group", TraceID: "trace", Trigger: "auto"}
	if err := producer.Add(ctx, jobID, payload); err != nil {
		t.Fatal(err)
	}

	processed := make(chan Payload, 1)
	blocking := redis.NewClient(client.Options())
	defer blocking.Close()
	worker, err := NewWorker(client, blocking, WorkerOptions{
		Concurrency: 1,
		Processor: func(_ context.Context, job Job) error {
			processed <- job.Payload
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = worker.Close(closeCtx)
	}()

	select {
	case got := <-processed:
		if got.GroupID != "group" || got.Trigger != "auto" {
			t.Fatalf("payload = %+v", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not process the job")
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		score, err := client.ZScore(ctx, keys.Completed, jobID).Result()
		if err == nil {
			_ = score
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not reach completed: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if exists, err := client.Exists(ctx, keys.Job(jobID)).Result(); err != nil || exists != 0 {
		t.Fatalf("completed job hash still exists exists=%d err=%v", exists, err)
	}
}

func TestIntegrationWorkerFailsJobAfterOneAttempt(t *testing.T) {
	client := integrationRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	producer, err := NewProducer(client, "")
	if err != nil {
		t.Fatal(err)
	}
	jobID := uniqueJobID(t)
	keys := newKeys("", QueueName)
	defer cleanupJob(t, client, keys, jobID)

	payload := Payload{JobType: JobTypeLlmBackfill, OrgID: "org", ActorID: "actor", GroupID: "group", TraceID: "trace"}
	if err := producer.Add(ctx, jobID, payload); err != nil {
		t.Fatal(err)
	}

	blocking := redis.NewClient(client.Options())
	defer blocking.Close()
	worker, err := NewWorker(client, blocking, WorkerOptions{
		Concurrency: 1,
		Processor: func(context.Context, Job) error {
			return errors.New("integration failure")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = worker.Close(closeCtx)
	}()

	deadline := time.Now().Add(10 * time.Second)
	for {
		score, err := client.ZScore(ctx, keys.Failed, jobID).Result()
		if err == nil {
			_ = score
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job did not reach failed: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
	reason, err := client.HGet(ctx, keys.Job(jobID), "failedReason").Result()
	if err != nil {
		t.Fatal(err)
	}
	if reason != "integration failure" {
		t.Fatalf("failedReason = %q", reason)
	}
	if _, err := client.LPos(ctx, keys.Wait, jobID, redis.LPosArgs{}).Result(); !errors.Is(err, redis.Nil) {
		t.Fatalf("failed job is still in the wait list: err=%v", err)
	}
}

func TestIntegrationStalledJobIsRecovered(t *testing.T) {
	client := integrationRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	producer, err := NewProducer(client, "")
	if err != nil {
		t.Fatal(err)
	}
	jobID := uniqueJobID(t)
	keys := newKeys("", QueueName)
	defer cleanupJob(t, client, keys, jobID)

	payload := Payload{JobType: JobTypeLlmBackfill, OrgID: "org", ActorID: "actor", GroupID: "group", TraceID: "trace"}
	if err := producer.Add(ctx, jobID, payload); err != nil {
		t.Fatal(err)
	}
	// Simulate a consumer that claimed the job and died before creating a
	// lock: the job is active with no <job>:lock key.
	if err := client.LRem(ctx, keys.Wait, 1, jobID).Err(); err != nil {
		t.Fatal(err)
	}
	if err := client.LPush(ctx, keys.Active, jobID).Err(); err != nil {
		t.Fatal(err)
	}

	processed := make(chan string, 1)
	blocking := redis.NewClient(client.Options())
	defer blocking.Close()
	worker, err := NewWorker(client, blocking, WorkerOptions{
		Concurrency:     1,
		StalledInterval: 100 * time.Millisecond,
		Processor: func(_ context.Context, job Job) error {
			processed <- job.ID
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = worker.Close(closeCtx)
	}()

	select {
	case got := <-processed:
		if got != jobID {
			t.Fatalf("processed %q, want %q", got, jobID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("stalled job was not recovered and processed")
	}
}

func TestIntegrationJobIsActiveProbe(t *testing.T) {
	client := integrationRedisClient(t)
	defer client.Close()
	ctx := context.Background()
	producer, err := NewProducer(client, "")
	if err != nil {
		t.Fatal(err)
	}
	jobID := uniqueJobID(t)
	keys := newKeys("", QueueName)
	defer cleanupJob(t, client, keys, jobID)

	active, err := producer.JobIsActive(ctx, jobID)
	if err != nil || active {
		t.Fatalf("missing job active=%t err=%v", active, err)
	}
	payload := Payload{JobType: JobTypeLlmBackfill, OrgID: "org", ActorID: "actor", GroupID: "group", TraceID: "trace"}
	if err := producer.Add(ctx, jobID, payload); err != nil {
		t.Fatal(err)
	}
	active, err = producer.JobIsActive(ctx, jobID)
	if err != nil || !active {
		t.Fatalf("waiting job active=%t err=%v", active, err)
	}
	if err := client.LRem(ctx, keys.Wait, 1, jobID).Err(); err != nil {
		t.Fatal(err)
	}
	active, err = producer.JobIsActive(ctx, jobID)
	if err != nil || active {
		t.Fatalf("removed job active=%t err=%v", active, err)
	}
}
