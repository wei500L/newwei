//go:build integration

package pipelineenqueue

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func integrationRedis(t *testing.T) *redis.Client {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: address, Protocol: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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

func TestPipelineEnqueueRedisIntegration(t *testing.T) {
	client := integrationRedis(t)
	producer := New(Options{Redis: client})
	ctx := context.Background()
	orgID := "org-integration"

	// Standard job: the official addStandardJob script must create the job hash,
	// push wait, write marker 0, emit added+waiting and record org counters.
	jobID, err := producer.EnqueueItem(ctx, orgID, "item-1", "raw-1", EnqueueOptions{TraceID: "trace-1"})
	if err != nil {
		t.Fatalf("standard enqueue: %v", err)
	}
	if want := "item-1-raw-1"; jobID != want {
		t.Fatalf("job id = %q, want %q", jobID, want)
	}
	wait, err := client.LRange(ctx, QueuePrefixKey+"wait", 0, -1).Result()
	if err != nil {
		t.Fatalf("read wait: %v", err)
	}
	if len(wait) != 1 || wait[0] != jobID {
		t.Fatalf("wait list = %v, want [%s]", wait, jobID)
	}
	marker, err := client.ZRange(ctx, QueuePrefixKey+"marker", 0, -1).Result()
	if err != nil {
		t.Fatalf("read marker: %v", err)
	}
	if len(marker) != 1 || marker[0] != "0" {
		t.Fatalf("marker = %v, want [0]", marker)
	}

	jobKey := QueuePrefixKey + jobID
	hash, err := client.HGetAll(ctx, jobKey).Result()
	if err != nil {
		t.Fatalf("read job hash: %v", err)
	}
	if hash["name"] != "process-item" {
		t.Fatalf("job name = %q", hash["name"])
	}
	var data jobData
	if err := json.Unmarshal([]byte(hash["data"]), &data); err != nil {
		t.Fatalf("job data is not JSON: %v", err)
	}
	if data.ItemMetaID != "item-1" || data.RawItemID != "raw-1" || data.OrgID != orgID || data.TraceID != "trace-1" {
		t.Fatalf("job data = %+v", data)
	}
	var storedOpts struct {
		JobID            string `json:"jobId"`
		RemoveOnComplete bool   `json:"removeOnComplete"`
		RemoveOnFail     struct {
			Age   int64 `json:"age"`
			Count int64 `json:"count"`
		} `json:"removeOnFail"`
		Attempts int64 `json:"attempts"`
		Backoff  struct {
			Type  string `json:"type"`
			Delay int64  `json:"delay"`
		} `json:"backoff"`
	}
	if err := json.Unmarshal([]byte(hash["opts"]), &storedOpts); err != nil {
		t.Fatalf("job opts is not JSON: %v", err)
	}
	if storedOpts.JobID != jobID || !storedOpts.RemoveOnComplete || storedOpts.Attempts != 5 {
		t.Fatalf("stored opts = %+v", storedOpts)
	}
	if storedOpts.RemoveOnFail.Age != 604800 || storedOpts.RemoveOnFail.Count != 10000 {
		t.Fatalf("retention opts = %+v", storedOpts.RemoveOnFail)
	}
	if storedOpts.Backoff.Type != "exponential" || storedOpts.Backoff.Delay != 2000 {
		t.Fatalf("backoff opts = %+v", storedOpts.Backoff)
	}

	events, err := client.XRange(ctx, QueuePrefixKey+"events", "-", "+").Result()
	if err != nil {
		t.Fatalf("read events: %v", err)
	}
	eventNames := map[string]bool{}
	for _, message := range events {
		eventNames[message.Values["event"].(string)] = true
	}
	if !eventNames["added"] || !eventNames["waiting"] {
		t.Fatalf("events = %v, want added and waiting", eventNames)
	}

	metaKey := orgMetaKey(jobID)
	countsKey := orgCountsKey(orgID)
	if status, _ := client.HGet(ctx, metaKey, "status").Result(); status != "waiting" {
		t.Fatalf("org meta status = %q, want waiting", status)
	}
	if waiting, _ := client.HGet(ctx, countsKey, "waiting").Result(); waiting != "1" {
		t.Fatalf("org waiting count = %q, want 1", waiting)
	}
	if ttl, _ := client.TTL(ctx, metaKey).Result(); ttl <= 0 {
		t.Fatalf("org meta TTL = %v", ttl)
	}
	if ttl, _ := client.TTL(ctx, countsKey).Result(); ttl <= 0 {
		t.Fatalf("org counts TTL = %v", ttl)
	}

	// Duplicate add follows handleDuplicatedJob: no second wait entry, no
	// second waiting event, no double count.
	beforeEvents := len(events)
	if _, err := producer.EnqueueItem(ctx, orgID, "item-1", "raw-1", EnqueueOptions{TraceID: "trace-1"}); err != nil {
		t.Fatalf("duplicate enqueue: %v", err)
	}
	wait, _ = client.LRange(ctx, QueuePrefixKey+"wait", 0, -1).Result()
	if len(wait) != 1 {
		t.Fatalf("duplicate wait length = %d, want 1", len(wait))
	}
	if waiting, _ := client.HGet(ctx, countsKey, "waiting").Result(); waiting != "1" {
		t.Fatalf("duplicate waiting count = %q, want 1", waiting)
	}
	events, _ = client.XRange(ctx, QueuePrefixKey+"events", "-", "+").Result()
	duplicated := false
	for _, message := range events[beforeEvents:] {
		if message.Values["event"] == "duplicated" {
			duplicated = true
		}
	}
	if !duplicated {
		t.Fatalf("duplicate add did not emit a duplicated event")
	}

	// Prioritized job: the official addPrioritizedJob script writes the
	// prioritized zset, pc counter and marker, not the wait list.
	priority := int64(5)
	priorityJobID, err := producer.EnqueueItem(ctx, orgID, "item-2", "raw-2", EnqueueOptions{
		Priority: &priority,
		TraceID:  "trace-2",
	})
	if err != nil {
		t.Fatalf("priority enqueue: %v", err)
	}
	prioritized, err := client.ZRange(ctx, QueuePrefixKey+"prioritized", 0, -1).Result()
	if err != nil {
		t.Fatalf("read prioritized: %v", err)
	}
	if len(prioritized) != 1 || prioritized[0] != priorityJobID {
		t.Fatalf("prioritized = %v, want [%s]", prioritized, priorityJobID)
	}
	wait, _ = client.LRange(ctx, QueuePrefixKey+"wait", 0, -1).Result()
	if len(wait) != 1 {
		t.Fatalf("priority job leaked into wait: %v", wait)
	}
	if counter, _ := client.Get(ctx, QueuePrefixKey+"pc").Result(); counter == "" {
		t.Fatalf("priority counter missing")
	}
	hash, _ = client.HGetAll(ctx, QueuePrefixKey+priorityJobID).Result()
	if !strings.Contains(hash["opts"], `"priority":5`) {
		t.Fatalf("priority opts = %s", hash["opts"])
	}
	// Duplicate priority add must not insert a second zset member.
	if _, err := producer.EnqueueItem(ctx, orgID, "item-2", "raw-2", EnqueueOptions{Priority: &priority}); err != nil {
		t.Fatalf("duplicate priority enqueue: %v", err)
	}
	prioritized, _ = client.ZRange(ctx, QueuePrefixKey+"prioritized", 0, -1).Result()
	if len(prioritized) != 1 {
		t.Fatalf("duplicate prioritized length = %d, want 1", len(prioritized))
	}
	if waiting, _ := client.HGet(ctx, countsKey, "waiting").Result(); waiting != "2" {
		t.Fatalf("org waiting count after priority = %q, want 2", waiting)
	}

	// Paused queue: getTargetQueueList routes the job to the paused list and
	// suppresses the base marker.
	if err := client.HSet(ctx, QueuePrefixKey+"meta", "paused", "1").Err(); err != nil {
		t.Fatalf("pause queue: %v", err)
	}
	pausedJobID, err := producer.EnqueueItem(ctx, orgID, "item-3", "raw-3", EnqueueOptions{})
	if err != nil {
		t.Fatalf("paused enqueue: %v", err)
	}
	paused, _ := client.LRange(ctx, QueuePrefixKey+"paused", 0, -1).Result()
	if len(paused) != 1 || paused[0] != pausedJobID {
		t.Fatalf("paused list = %v, want [%s]", paused, pausedJobID)
	}
	wait, _ = client.LRange(ctx, QueuePrefixKey+"wait", 0, -1).Result()
	if len(wait) != 1 {
		t.Fatalf("paused job leaked into wait: %v", wait)
	}
	marker, _ = client.ZRange(ctx, QueuePrefixKey+"marker", 0, -1).Result()
	if len(marker) != 1 || marker[0] != "0" {
		t.Fatalf("marker changed while paused: %v", marker)
	}

	// Illegal priority keeps the BullMQ validation error and writes nothing.
	tooHigh := int64(priorityLimit + 1)
	if _, err := producer.EnqueueItem(ctx, orgID, "item-4", "raw-4", EnqueueOptions{Priority: &tooHigh}); err == nil {
		t.Fatalf("priority above limit was accepted")
	} else if !strings.Contains(err.Error(), "Priority should be between 0 and") {
		t.Fatalf("priority error = %v", err)
	}
	if exists, _ := client.Exists(ctx, QueuePrefixKey+"item-4-raw-4").Result(); exists != 0 {
		t.Fatalf("rejected priority job wrote a hash")
	}
}
