//go:build integration

package classificationreviewseed

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
	"github.com/wei500L/newwei/apps/api-go/internal/qualityqueue"
)

const (
	integrationPipelineQueue = "itemPipeline"
	integrationReviewQueue   = "classification_quality"
)

func integrationRedis(t *testing.T) (*redis.Client, *redis.Options) {
	t.Helper()
	address := strings.TrimSpace(os.Getenv("API_GO_TEST_REDIS_ADDR"))
	if address == "" {
		t.Skip("API_GO_TEST_REDIS_ADDR is not set")
	}
	options := &redis.Options{Addr: address, Protocol: 2}
	client := redis.NewClient(options)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}
	if err := client.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("redis flush: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, options
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// startReviewSeedObserver attaches the seed consumer to a real itemPipeline
// events reader and starts it. The caller closes it.
func startReviewSeedObserver(t *testing.T, client *redis.Client, options *redis.Options, seed *Service, handled *atomic.Int64) *graphqlsubscriptions.QueueObserver {
	t.Helper()
	observer := graphqlsubscriptions.NewRedisQueueObserver(options, client)
	observer.AddPipelineCompletedHandler(func(ctx context.Context, event graphqlsubscriptions.PipelineCompleted) {
		handled.Add(1)
		seed.HandleCompleted(ctx, event.JobID, event.OrgID, event.Data)
	})
	observer.Start(context.Background())
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = observer.Close(closeCtx)
	})
	// Give the read loop time to issue its first XREAD before the event is
	// appended: XREAD "$" only sees entries added after the call.
	time.Sleep(150 * time.Millisecond)
	return observer
}

// publishCompleted appends one completed event and returns its stream id.
func publishCompleted(t *testing.T, client *redis.Client, pipelineJobID, returnValue string) {
	t.Helper()
	if err := client.XAdd(context.Background(), &redis.XAddArgs{
		Stream: "bull:" + integrationPipelineQueue + ":events",
		Values: map[string]any{
			"event":       "completed",
			"jobId":       pipelineJobID,
			"returnvalue": returnValue,
		},
	}).Err(); err != nil {
		t.Fatalf("xadd completed: %v", err)
	}
}

// publishUntilCompleted re-appends the event until the readers have observed it.
// XREAD "$" only sees entries appended after the call starts blocking, so one
// append is not guaranteed to land between two blocking reads; duplicate appends
// are harmless because the review-seed job id is stable.
func publishUntilCompleted(t *testing.T, client *redis.Client, pipelineJobID, returnValue string, observed func() bool) {
	t.Helper()
	for attempt := 0; attempt < 40; attempt++ {
		publishCompleted(t, client, pipelineJobID, returnValue)
		time.Sleep(100 * time.Millisecond)
		if observed() {
			return
		}
	}
	t.Fatal("timed out publishing the completed event")
}

func reviewJobKey(jobID string) string {
	return "bull:" + integrationReviewQueue + ":" + jobID
}

// TestClassificationReviewSeedIntegration proves that a completed event on the
// real itemPipeline stream enqueues exactly one review-seed job with the NestJS
// payload shape, and that re-enqueueing the same id stays idempotent.
func TestClassificationReviewSeedIntegration(t *testing.T) {
	client, options := integrationRedis(t)
	ctx := context.Background()
	seed := New(qualityqueue.NewQueue(client))

	pipelineJobID := "pipeline-job-1"
	if err := client.HSet(ctx, "bull:"+integrationPipelineQueue+":"+pipelineJobID,
		"data", `{"orgId":"org-1","itemMetaId":"item-1"}`).Err(); err != nil {
		t.Fatalf("seed pipeline job: %v", err)
	}

	var handled atomic.Int64
	startReviewSeedObserver(t, client, options, seed, &handled)
	publishUntilCompleted(t, client, pipelineJobID, `{"id":"pid-1"}`, func() bool {
		return handled.Load() > 0
	})

	jobID := ReviewSeedJobID("org-1", "pid-1")
	waitFor(t, "review seed job", func() bool {
		return client.Exists(ctx, reviewJobKey(jobID)).Val() == 1
	})
	waitFor(t, "review seed wait entry", func() bool {
		return client.LLen(ctx, "bull:"+integrationReviewQueue+":wait").Val() == 1
	})

	hash, err := client.HGetAll(ctx, reviewJobKey(jobID)).Result()
	if err != nil {
		t.Fatalf("read job hash: %v", err)
	}
	if hash["name"] != jobID {
		t.Fatalf("job name = %q, want %q", hash["name"], jobID)
	}
	var payload reviewSeedPayload
	if err := json.Unmarshal([]byte(hash["data"]), &payload); err != nil {
		t.Fatalf("job data is not JSON: %v", err)
	}
	if payload.JobType != JobType || payload.OrgID != "org-1" || payload.ProcessedItemID != "pid-1" {
		t.Fatalf("job data = %+v", payload)
	}
	if len(payload.TraceID) != 32 {
		t.Fatalf("traceId = %q, want 32 hex characters", payload.TraceID)
	}
	if hash["opts"] == "" {
		t.Fatal("job opts are missing")
	}

	// Idempotency: the same id returns the existing job and adds nothing.
	returned, err := seed.Enqueue(ctx, "org-1", "pid-1")
	if err != nil {
		t.Fatalf("duplicate enqueue: %v", err)
	}
	if returned != jobID {
		t.Fatalf("duplicate enqueue id = %q, want %q", returned, jobID)
	}
	if length := client.LLen(ctx, "bull:"+integrationReviewQueue+":wait").Val(); length != 1 {
		t.Fatalf("wait length after duplicate = %d, want 1", length)
	}
}

// TestClassificationReviewSeedTwoReaders proves the multi-instance case: two
// readers observe the same event, both enqueue, and the stable job id keeps one
// job.
func TestClassificationReviewSeedTwoReaders(t *testing.T) {
	client, options := integrationRedis(t)
	ctx := context.Background()

	pipelineJobID := "pipeline-job-2"
	if err := client.HSet(ctx, "bull:"+integrationPipelineQueue+":"+pipelineJobID,
		"data", `{"orgId":"org-2"}`).Err(); err != nil {
		t.Fatalf("seed pipeline job: %v", err)
	}

	var firstHandled, secondHandled atomic.Int64
	startReviewSeedObserver(t, client, options, New(qualityqueue.NewQueue(client)), &firstHandled)
	startReviewSeedObserver(t, client, options, New(qualityqueue.NewQueue(client)), &secondHandled)
	publishUntilCompleted(t, client, pipelineJobID, `{"_id":"pid-2"}`, func() bool {
		return firstHandled.Load() > 0 && secondHandled.Load() > 0
	})

	jobID := ReviewSeedJobID("org-2", "pid-2")
	waitFor(t, "the single review seed job", func() bool {
		return client.Exists(ctx, reviewJobKey(jobID)).Val() == 1
	})
	if length := client.LLen(ctx, "bull:"+integrationReviewQueue+":wait").Val(); length != 1 {
		t.Fatalf("wait length = %d, want 1 (duplicate ids are ignored)", length)
	}
}
