//go:build integration

package queueops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/bullmqwire"
	"github.com/wei500L/newwei/apps/api-go/internal/pipelineenqueue"
)

// integrationDelay is how long the integration helpers wait for one Redis call.
const integrationDelay = 5 * time.Second

// integrationClient connects to the shared test Redis and flushes it.
func integrationClient(t *testing.T) *redis.Client {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	ctx, cancel := context.WithTimeout(context.Background(), integrationDelay)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("redis flush: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// integrationService builds a service over the flushed Redis. MySQL is nil, so
// the audit write is a no-op: these tests cover the BullMQ protocol, not the
// audit table.
func integrationService(t *testing.T) (*Service, *redis.Client) {
	t.Helper()
	client := integrationClient(t)
	service := NewService(Options{
		Redis: client,
		Producer: pipelineenqueue.New(pipelineenqueue.Options{
			Redis: client,
		}),
	})
	return service, client
}

// seedJobHash writes a BullMQ-shaped job hash.
func seedJobHash(t *testing.T, client *redis.Client, key string, pairs ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationDelay)
	defer cancel()
	if err := client.HSet(ctx, key, pairs...).Err(); err != nil {
		t.Fatalf("seed hash %s: %v", key, err)
	}
}

// eventsFor returns the event rows of one queue's event stream.
func eventsFor(t *testing.T, client *redis.Client, queue string) []redis.XMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), integrationDelay)
	defer cancel()
	keys := bullmqwire.NewKeys(bullmqwire.Prefix, queue)
	messages, err := client.XRange(ctx, keys.Events, "-", "+").Result()
	if err != nil {
		t.Fatalf("read events %s: %v", queue, err)
	}
	return messages
}

// hasEvent reports whether the stream holds one event row with the given
// event name and job id.
func hasEvent(messages []redis.XMessage, event, jobID string) bool {
	for _, message := range messages {
		if message.Values["event"] == event && message.Values["jobId"] == jobID {
			return true
		}
	}
	return false
}

// TestQueueOpsIntegrationRetryFailedJob proves the console runs the same
// reprocessJob script Job.retry runs: the failed-set entry is removed, the job
// hash loses its failure fields and the id is back on the wait list.
func TestQueueOpsIntegrationRetryFailedJob(t *testing.T) {
	service, client := integrationService(t)
	ctx := context.Background()
	keys := bullmqwire.NewKeys(bullmqwire.Prefix, pipelineenqueue.QueueName)
	jobID := "item-retry-raw-1"

	seedJobHash(t, client, keys.Job(jobID),
		"name", "process-item",
		"data", `{"orgId":"org-a"}`,
		"opts", `{}`,
		"timestamp", "1700000000000",
		"finishedOn", "1700000005000",
		"attemptsMade", "3",
		"failedReason", "boom",
	)
	if err := client.ZAdd(ctx, keys.Failed, redis.Z{Score: 1700000005000, Member: jobID}).Err(); err != nil {
		t.Fatalf("seed failed set: %v", err)
	}

	result, err := service.Retry(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, pipelineenqueue.QueueName, jobID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if result.State != string(StateWaiting) || result.JobID != jobID {
		t.Fatalf("result = %+v", result)
	}
	if failed, err := client.ZCard(ctx, keys.Failed).Result(); err != nil || failed != 0 {
		t.Fatalf("failed set = %d/%v", failed, err)
	}
	wait, err := client.LRange(ctx, keys.Wait, 0, -1).Result()
	if err != nil {
		t.Fatalf("read wait: %v", err)
	}
	if len(wait) != 1 || wait[0] != jobID {
		t.Fatalf("wait = %v", wait)
	}
	reason, err := client.HGet(ctx, keys.Job(jobID), "failedReason").Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		t.Fatalf("read failedReason: %v", err)
	}
	if reason != "" {
		t.Fatalf("failedReason after retry = %q", reason)
	}
	if !hasEvent(eventsFor(t, client, pipelineenqueue.QueueName), "waiting", jobID) {
		t.Fatalf("retry did not publish the waiting event")
	}
	// A second retry finds the job outside the failed set and must not move it.
	if _, err := service.Retry(ctx, Actor{OrgID: "org-a"}, pipelineenqueue.QueueName, jobID); err == nil {
		t.Fatalf("second retry of a waiting job succeeded")
	}
}

// TestQueueOpsIntegrationDeleteDelayedJob proves Job.remove works on a delayed
// job and publishes the removed event the org tracker consumes.
func TestQueueOpsIntegrationDeleteDelayedJob(t *testing.T) {
	service, client := integrationService(t)
	ctx := context.Background()
	keys := bullmqwire.NewKeys(bullmqwire.Prefix, pipelineenqueue.QueueName)
	jobID := "item-delayed-raw-1"

	seedJobHash(t, client, keys.Job(jobID),
		"name", "process-item",
		"data", `{"orgId":"org-a"}`,
		"opts", `{}`,
		"timestamp", "1700000000000",
		"delay", "60000",
	)
	if err := client.ZAdd(ctx, keys.Delayed, redis.Z{Score: 1700000060000, Member: jobID}).Err(); err != nil {
		t.Fatalf("seed delayed set: %v", err)
	}

	result, err := service.Delete(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, pipelineenqueue.QueueName, jobID)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	if !result.Deleted || result.JobID != jobID {
		t.Fatalf("result = %+v", result)
	}
	if exists, err := client.Exists(ctx, keys.Job(jobID)).Result(); err != nil || exists != 0 {
		t.Fatalf("job hash still present: %d/%v", exists, err)
	}
	if delayed, err := client.ZCard(ctx, keys.Delayed).Result(); err != nil || delayed != 0 {
		t.Fatalf("delayed set = %d/%v", delayed, err)
	}
	if !hasEvent(eventsFor(t, client, pipelineenqueue.QueueName), "removed", jobID) {
		t.Fatalf("delete did not publish the removed event")
	}
	// Deleting it again is a 404, not a silent success.
	if _, err := service.Delete(ctx, Actor{OrgID: "org-a"}, pipelineenqueue.QueueName, jobID); err == nil {
		t.Fatalf("second delete succeeded")
	}
}

// TestQueueOpsIntegrationDLQReplay proves the replay adds the original payload to
// itemPipeline, removes the dead-letter job, and that a repeated replay of the
// same dead-letter job cannot create a second itemPipeline job.
func TestQueueOpsIntegrationDLQReplay(t *testing.T) {
	service, client := integrationService(t)
	ctx := context.Background()
	dlqKeys := bullmqwire.NewKeys(bullmqwire.Prefix, dlqQueue)
	pipelineKeys := bullmqwire.NewKeys(bullmqwire.Prefix, pipelineenqueue.QueueName)
	dlqJobID := "dlq-itemPipeline-job-1-3"

	seedDLQJob := func() {
		seedJobHash(t, client, dlqKeys.Job(dlqJobID),
			"name", "dlq",
			"data", dlqPayload,
			"opts", `{"attempts":1}`,
			"timestamp", "1700000000000",
		)
		if err := client.RPush(ctx, dlqKeys.Wait, dlqJobID).Err(); err != nil {
			t.Fatalf("seed dlq wait: %v", err)
		}
	}
	seedDLQJob()

	result, err := service.ReplayDLQ(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, dlqJobID, false)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !result.Replayed || !result.DlqRemoved {
		t.Fatalf("result = %+v", result)
	}
	wantJobID := replayJobID(dlqJobID)
	if result.NewJobID != wantJobID {
		t.Fatalf("new job id = %q, want %q", result.NewJobID, wantJobID)
	}
	if result.OriginalJobID != "job-1" || result.OriginalQueue != pipelineenqueue.QueueName || result.OrgID != "org-a" {
		t.Fatalf("result = %+v", result)
	}
	if exists, err := client.Exists(ctx, pipelineKeys.Job(wantJobID)).Result(); err != nil || exists != 1 {
		t.Fatalf("replayed job hash = %d/%v", exists, err)
	}
	stored, err := client.HGet(ctx, pipelineKeys.Job(wantJobID), "data").Result()
	if err != nil {
		t.Fatalf("read replayed data: %v", err)
	}
	var decoded struct {
		OrgID         string `json:"orgId"`
		ItemMetaID    string `json:"itemMetaId"`
		RawItemID     string `json:"rawItemId"`
		OriginalQueue string `json:"originalQueue"`
	}
	if err := json.Unmarshal([]byte(stored), &decoded); err != nil {
		t.Fatalf("decode replayed data: %v", err)
	}
	if decoded.OrgID != "org-a" || decoded.ItemMetaID != "m1" || decoded.RawItemID != "r1" {
		t.Fatalf("replayed data = %s", stored)
	}
	if decoded.OriginalQueue != "" {
		t.Fatalf("replayed data still carries the envelope: %s", stored)
	}
	if exists, err := client.Exists(ctx, dlqKeys.Job(dlqJobID)).Result(); err != nil || exists != 0 {
		t.Fatalf("dead-letter hash still present: %d/%v", exists, err)
	}
	if wait, err := client.LRange(ctx, dlqKeys.Wait, 0, -1).Result(); err != nil || len(wait) != 0 {
		t.Fatalf("dead-letter wait = %v/%v", wait, err)
	}
	if !hasEvent(eventsFor(t, client, pipelineenqueue.QueueName), "waiting", wantJobID) {
		t.Fatalf("replay did not publish the waiting event")
	}

	// A repeated replay of the (re-seeded) dead-letter job must return the
	// existing itemPipeline job instead of adding a second one.
	seedDLQJob()
	again, err := service.ReplayDLQ(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, dlqJobID, false)
	if err != nil {
		t.Fatalf("second replay: %v", err)
	}
	if !again.Replayed || !again.DlqRemoved || again.NewJobID != wantJobID {
		t.Fatalf("second replay = %+v", again)
	}
	wait, err := client.LRange(ctx, pipelineKeys.Wait, 0, -1).Result()
	if err != nil {
		t.Fatalf("read wait: %v", err)
	}
	matches := 0
	for _, id := range wait {
		if id == wantJobID {
			matches++
		}
	}
	if matches != 1 {
		t.Fatalf("itemPipeline wait has %d entries of %s, want 1 (%v)", matches, wantJobID, wait)
	}
}

// TestQueueOpsIntegrationQueueList proves the counts, paused flag and global
// concurrency of the inventory read come from the same keys BullMQ writes.
func TestQueueOpsIntegrationQueueList(t *testing.T) {
	service, client := integrationService(t)
	ctx := context.Background()
	keys := bullmqwire.NewKeys(bullmqwire.Prefix, pipelineenqueue.QueueName)

	for _, jobID := range []string{"failed-1", "failed-2"} {
		seedJobHash(t, client, keys.Job(jobID), "name", "process-item", "data", `{"orgId":"org-a"}`)
		if err := client.ZAdd(ctx, keys.Failed, redis.Z{Score: 1, Member: jobID}).Err(); err != nil {
			t.Fatalf("seed failed: %v", err)
		}
	}
	seedJobHash(t, client, keys.Job("delayed-1"), "name", "process-item", "data", `{"orgId":"org-a"}`)
	if err := client.ZAdd(ctx, keys.Delayed, redis.Z{Score: 1, Member: "delayed-1"}).Err(); err != nil {
		t.Fatalf("seed delayed: %v", err)
	}
	if err := client.LPush(ctx, keys.Wait, "wait-1").Err(); err != nil {
		t.Fatalf("seed wait: %v", err)
	}
	if err := client.HSet(ctx, keys.Meta, "concurrency", "4").Err(); err != nil {
		t.Fatalf("seed meta concurrency: %v", err)
	}

	listed, err := service.ListQueues(ctx)
	if err != nil {
		t.Fatalf("list queues: %v", err)
	}
	summary := findQueue(t, listed, pipelineenqueue.QueueName)
	if summary.Counts.Failed != 2 || summary.Counts.Delayed != 1 || summary.Counts.Waiting != 1 {
		t.Fatalf("counts = %+v", summary.Counts)
	}
	if summary.Paused {
		t.Fatalf("queue reported as paused before pause")
	}
	if summary.Concurrency == nil || *summary.Concurrency != 4 {
		t.Fatalf("concurrency = %v", summary.Concurrency)
	}
	if summary.IsDLQ {
		t.Fatalf("itemPipeline reported as a DLQ")
	}
	if !findQueue(t, listed, dlqQueue).IsDLQ {
		t.Fatalf("itemPipelineDlq is not marked as a DLQ")
	}

	if _, err := service.Pause(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, pipelineenqueue.QueueName); err != nil {
		t.Fatalf("pause: %v", err)
	}
	paused, err := service.ListQueues(ctx)
	if err != nil {
		t.Fatalf("list paused: %v", err)
	}
	pausedSummary := findQueue(t, paused, pipelineenqueue.QueueName)
	if !pausedSummary.Paused || pausedSummary.Counts.Paused != 1 || pausedSummary.Counts.Waiting != 0 {
		t.Fatalf("paused counts = %+v", pausedSummary)
	}
	if _, err := service.Resume(ctx, Actor{OrgID: "org-a", UserID: "user-1"}, pipelineenqueue.QueueName); err != nil {
		t.Fatalf("resume: %v", err)
	}
	resumed, err := service.ListQueues(ctx)
	if err != nil {
		t.Fatalf("list resumed: %v", err)
	}
	resumedSummary := findQueue(t, resumed, pipelineenqueue.QueueName)
	if resumedSummary.Paused || resumedSummary.Counts.Waiting != 1 {
		t.Fatalf("resumed counts = %+v", resumedSummary)
	}
}

// TestQueueOpsIntegrationCleanFailedJobs proves the clean route removes the
// matched failed jobs and reports the count the script deleted.
func TestQueueOpsIntegrationCleanFailedJobs(t *testing.T) {
	service, client := integrationService(t)
	ctx := context.Background()
	keys := bullmqwire.NewKeys(bullmqwire.Prefix, pipelineenqueue.QueueName)
	for _, jobID := range []string{"failed-1", "failed-2", "failed-3"} {
		seedJobHash(t, client, keys.Job(jobID), "name", "process-item", "data", `{"orgId":"org-a"}`,
			"finishedOn", "1700000000000")
		if err := client.ZAdd(ctx, keys.Failed, redis.Z{Score: 1700000000000, Member: jobID}).Err(); err != nil {
			t.Fatalf("seed failed: %v", err)
		}
	}
	result, err := service.Clean(ctx, Actor{OrgID: "org-a", UserID: "user-1"},
		pipelineenqueue.QueueName, CleanStateFailed, 0, 2)
	if err != nil {
		t.Fatalf("clean: %v", err)
	}
	if result.Removed != 2 || result.State != string(CleanStateFailed) {
		t.Fatalf("result = %+v", result)
	}
	if failed, err := client.ZCard(ctx, keys.Failed).Result(); err != nil || failed != 1 {
		t.Fatalf("failed set = %d/%v", failed, err)
	}
}

// findQueue returns one queue summary from an inventory reply.
func findQueue(t *testing.T, list QueueList, name string) QueueSummary {
	t.Helper()
	for _, summary := range list.Queues {
		if summary.Name == name {
			return summary
		}
	}
	t.Fatalf("queue %q is missing from the inventory", name)
	return QueueSummary{}
}
