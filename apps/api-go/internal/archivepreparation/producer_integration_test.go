//go:build integration

package archivepreparation

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// TestArchivePreparationRedisIntegration locks the BullMQ 5.63.2 wire used by
// the archive preparation producer. It requires a real Redis (the existing CI
// integration job) and only proves the Redis protocol; it does not run the
// NestJS worker.
func TestArchivePreparationRedisIntegration(t *testing.T) {
	addr := os.Getenv("API_GO_TEST_REDIS_ADDR")
	if addr == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	client := redis.NewClient(&redis.Options{Addr: addr, Protocol: 2})
	t.Cleanup(func() { _ = client.Close() })
	ctx := context.Background()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	prefix := "archive-itest:" + strconv.FormatInt(time.Now().UnixNano(), 10)
	producer := NewProducer(client).WithPrefix(prefix)
	_ = client.Del(ctx, StatusIndexKey).Err()

	jobID := "digest:org-1:2026-02-03"
	if err := producer.EnsureDigestCoverage(ctx, "org-1", "2026-02-03"); err != nil {
		t.Fatalf("ensure digest: %v", err)
	}
	jobKey := prefix + ":" + QueueName + ":" + jobID
	hash, err := client.HGetAll(ctx, jobKey).Result()
	if err != nil {
		t.Fatal(err)
	}
	if hash["name"] != QueueName {
		t.Fatalf("job name = %q", hash["name"])
	}
	var payload Payload
	if err := json.Unmarshal([]byte(hash["data"]), &payload); err != nil {
		t.Fatalf("job payload: %v", err)
	}
	if payload.Scope != ScopeDigest || payload.OrgID != "org-1" || payload.AnchorDate != "2026-02-03" || payload.TraceID == "" {
		t.Fatalf("payload = %+v", payload)
	}
	var opts struct {
		Attempts int `json:"attempts"`
		Backoff  struct {
			Type  string `json:"type"`
			Delay int64  `json:"delay"`
		} `json:"backoff"`
		RemoveOnComplete struct {
			Age   int64 `json:"age"`
			Count int64 `json:"count"`
		} `json:"removeOnComplete"`
		RemoveOnFail struct {
			Age   int64 `json:"age"`
			Count int64 `json:"count"`
		} `json:"removeOnFail"`
		JobID string `json:"jobId"`
	}
	if err := json.Unmarshal([]byte(hash["opts"]), &opts); err != nil {
		t.Fatalf("job opts: %v", err)
	}
	if opts.Attempts != 5 || opts.Backoff.Type != "exponential" || opts.Backoff.Delay != 15000 ||
		opts.RemoveOnComplete.Age != 3600 || opts.RemoveOnComplete.Count != 1000 ||
		opts.RemoveOnFail.Age != 604800 || opts.RemoveOnFail.Count != 10000 || opts.JobID != jobID {
		t.Fatalf("opts = %+v", opts)
	}
	if state, _ := producer.jobState(ctx, jobID); state != "waiting" {
		t.Fatalf("state = %s", state)
	}
	wait, _ := client.LRange(ctx, prefix+":"+QueueName+":wait", 0, -1).Result()
	if len(wait) != 1 || wait[0] != jobID {
		t.Fatalf("wait = %v", wait)
	}
	if score, err := client.ZScore(ctx, prefix+":"+QueueName+":marker", "0").Result(); err != nil || score != 0 {
		t.Fatalf("marker = %v,%v", score, err)
	}
	if length, err := client.XLen(ctx, prefix+":"+QueueName+":events").Result(); err != nil || length < 2 {
		t.Fatalf("events = %d,%v", length, err)
	}

	// Duplicate waiting job: no re-add and no status TTL reset.
	ttlBefore, _ := client.TTL(ctx, "archive:preparation:status:digest:org-1:2026-02-03").Result()
	time.Sleep(1100 * time.Millisecond)
	if err := producer.EnsureDigestCoverage(ctx, "org-1", "2026-02-03"); err != nil {
		t.Fatal(err)
	}
	wait, _ = client.LRange(ctx, prefix+":"+QueueName+":wait", 0, -1).Result()
	if len(wait) != 1 {
		t.Fatalf("duplicate added a job: %v", wait)
	}
	ttlAfter, _ := client.TTL(ctx, "archive:preparation:status:digest:org-1:2026-02-03").Result()
	if ttlBefore <= 0 || ttlAfter <= 0 || ttlAfter > ttlBefore {
		t.Fatalf("duplicate reset status TTL: %v -> %v", ttlBefore, ttlAfter)
	}

	// Active job: returned without removal.
	_ = client.LRem(ctx, prefix+":"+QueueName+":wait", 0, jobID).Err()
	_ = client.LPush(ctx, prefix+":"+QueueName+":active", jobID).Err()
	if err := producer.EnsureDigestCoverage(ctx, "org-1", "2026-02-03"); err != nil {
		t.Fatal(err)
	}
	if active, _ := client.LRange(ctx, prefix+":"+QueueName+":active", 0, -1).Result(); len(active) != 1 || active[0] != jobID {
		t.Fatalf("active job was touched: %v", active)
	}

	// Completed job: locked remove then re-add.
	_ = client.LRem(ctx, prefix+":"+QueueName+":active", 0, jobID).Err()
	_ = client.ZAdd(ctx, prefix+":"+QueueName+":completed", redis.Z{Score: 1, Member: jobID}).Err()
	if err := producer.EnsureDigestCoverage(ctx, "org-1", "2026-02-03"); err != nil {
		t.Fatal(err)
	}
	if score, _ := client.ZScore(ctx, prefix+":"+QueueName+":completed", jobID).Result(); score != 0 {
		t.Fatalf("completed entry survived: %v", score)
	}
	wait, _ = client.LRange(ctx, prefix+":"+QueueName+":wait", 0, -1).Result()
	if len(wait) != 1 || wait[0] != jobID {
		t.Fatalf("completed rebuild wait = %v", wait)
	}

	// Failed job: same locked remove then re-add.
	_ = client.LRem(ctx, prefix+":"+QueueName+":wait", 0, jobID).Err()
	_ = client.ZAdd(ctx, prefix+":"+QueueName+":failed", redis.Z{Score: 1, Member: jobID}).Err()
	if err := producer.EnsureDigestCoverage(ctx, "org-1", "2026-02-03"); err != nil {
		t.Fatal(err)
	}
	if score, _ := client.ZScore(ctx, prefix+":"+QueueName+":failed", jobID).Result(); score != 0 {
		t.Fatalf("failed entry survived: %v", score)
	}

	// Derived status shape, TTL and index member.
	statusKey := "archive:preparation:status:digest:org-1:2026-02-03"
	raw, err := client.Get(ctx, statusKey).Bytes()
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		OrgID        string `json:"orgId"`
		Scope        string `json:"scope"`
		ScopeValue   string `json:"scopeValue"`
		State        string `json:"state"`
		UpdatedAt    string `json:"updatedAt"`
		ErrorMessage string `json:"errorMessage"`
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatal(err)
	}
	if status.OrgID != "org-1" || status.Scope != "digest" || status.ScopeValue != "2026-02-03" || status.State != "QUEUED" || status.UpdatedAt == "" {
		t.Fatalf("status = %+v", status)
	}
	if ttl, _ := client.TTL(ctx, statusKey).Result(); ttl <= 0 || ttl > StatusTTLSeconds*time.Second {
		t.Fatalf("status ttl = %v", ttl)
	}
	if _, err := client.ZScore(ctx, StatusIndexKey, statusKey).Result(); err != nil {
		t.Fatalf("status index missing: %v", err)
	}

	// Global index trim to 200 entries, deleting the oldest status keys.
	_ = client.Del(ctx, StatusIndexKey).Err()
	for index := 0; index < 205; index++ {
		key := fmt.Sprintf("archive:preparation:status:digest:org-%03d:2026-01-01", index)
		_ = client.Set(ctx, key, []byte(`{"orgId":"x","scope":"digest","scopeValue":"2026-01-01","state":"QUEUED","updatedAt":"2026-01-01T00:00:00.000Z"}`), time.Hour).Err()
		_ = client.ZAdd(ctx, StatusIndexKey, redis.Z{Score: float64(index + 1), Member: key}).Err()
	}
	if err := producer.writeStatus(ctx, Payload{Scope: ScopeDigest, OrgID: "org-new", AnchorDate: "2026-02-04"}, "QUEUED", ""); err != nil {
		t.Fatal(err)
	}
	if size, _ := client.ZCard(ctx, StatusIndexKey).Result(); size != StatusIndexMaxEntries {
		t.Fatalf("status index size = %d, want %d", size, StatusIndexMaxEntries)
	}
	if exists, _ := client.Exists(ctx, "archive:preparation:status:digest:org-000:2026-01-01").Result(); exists != 0 {
		t.Fatal("oldest status key was not deleted")
	}
}
