//go:build integration

package realtimeintegration

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimeevents"
	"github.com/wei500L/newwei/apps/api-go/internal/realtimesocket"
)

const (
	itemPipelineQueueName     = "itemPipeline"
	itemPipelineEventsStream  = "bull:itemPipeline:events"
	itemPipelineJobContextKey = "queue:pipeline:jobctx:"
)

// queueEventPayload is the client payload of queue:event:
// {orgId, event, jobId, data?, timestamp, ...context ids}.
type queueEventPayload struct {
	OrgID     string          `json:"orgId"`
	Event     string          `json:"event"`
	JobID     string          `json:"jobId"`
	Data      json.RawMessage `json:"data"`
	Timestamp string          `json:"timestamp"`
}

// opsEventPayload is the client payload of ops:event for the pipeline source:
// {orgId, source:"pipeline", event, jobId, data?, timestamp}.
type opsEventPayload struct {
	OrgID     string          `json:"orgId"`
	Source    string          `json:"source"`
	Event     string          `json:"event"`
	JobID     string          `json:"jobId"`
	Data      json.RawMessage `json:"data"`
	Timestamp string          `json:"timestamp"`
}

// TestRealtimeBullMQDedupIntegration covers B1 for the BullMQ event streams:
//
// Two independent transport instances (each with its own realtimeevents.Sources)
// read the same Redis stream. Every BullMQ QueueEvents consumer uses XREAD from
// "$" without a consumer group, so both instances observe the same completed
// event; each instance must deliver it only to its own connections, exactly
// once. A duplicated publish (for example republishing to the Redis adapter)
// would make every client observe the event twice.
//
// A warm-up event is observed by both connections before the event under
// assertion: receiving it proves both instances' XREAD loops are live and
// delivering, which removes the start-offset race from the test.
func TestRealtimeBullMQDedupIntegration(t *testing.T) {
	h := newHarness(t)
	h.seedMember(t, "org-bull", "user-bull", "queue.manage", "crawl.read")
	token := h.accessToken(t, "user-bull", "org-bull")

	runtime1 := h.newRealtimeRuntime(t, h.realtimeOptions())
	runtime2 := h.newRealtimeRuntime(t, h.realtimeOptions())
	server1 := serveRealtime(t, runtime1)
	server2 := serveRealtime(t, runtime2)
	h.newRealtimeSources(t, realtimeevents.Options{}, runtime1)
	h.newRealtimeSources(t, realtimeevents.Options{}, runtime2)

	connect := func(serverURL string) *sioClient {
		client := dialSocketClient(t, serverURL, realtimesocket.Path)
		_ = client.connectNamespace(t, realtimesocket.NamespaceQueue, map[string]any{"token": token})
		client.waitEvent(t, realtimesocket.NamespaceQueue, "queue:connected", defaultFrameTimeout)
		_ = client.connectNamespace(t, realtimesocket.NamespaceOps, map[string]any{"token": token})
		client.waitEvent(t, realtimesocket.NamespaceOps, "ops:connected", defaultFrameTimeout)
		return client
	}
	client1 := connect(server1.URL)
	client2 := connect(server2.URL)

	// Sources.Start already blocks on the subscription handshakes; the client
	// connects above give the XREAD goroutines additional time to issue their
	// first blocking read from "$". A short pause keeps a slow CI scheduler
	// from making a loop start after the warm-up append.
	time.Sleep(300 * time.Millisecond)

	// Warm-up: both instances must observe this event before the real one. The
	// wait below blocks until each instance's XREAD loop has consumed the
	// stream entry, so the real event cannot fall into a "$" baseline gap.
	h.seedPipelineJobContext(t, "it-prewarm", "org-bull")
	h.appendPipelineCompleted(t, "it-prewarm", `{"prewarm":true}`)
	for name, client := range map[string]*sioClient{"instance-1": client1, "instance-2": client2} {
		warmup := client.waitEvent(t, realtimesocket.NamespaceQueue, "queue:event", defaultFrameTimeout)
		warmupPayload := decodePayload[queueEventPayload](t, warmup)
		if warmupPayload.JobID != "it-prewarm" {
			t.Fatalf("%s first queue:event is %q, want the it-prewarm warm-up event", name, warmupPayload.JobID)
		}
		client.waitEvent(t, realtimesocket.NamespaceOps, "ops:event", defaultFrameTimeout)
	}

	// Event under assertion.
	h.seedPipelineJobContext(t, "it-dedup-1", "org-bull")
	h.appendPipelineCompleted(t, "it-dedup-1", `{"ok":true}`)

	queue1 := client1.waitEvent(t, realtimesocket.NamespaceQueue, "queue:event", defaultFrameTimeout)
	queue2 := client2.waitEvent(t, realtimesocket.NamespaceQueue, "queue:event", defaultFrameTimeout)
	ops1 := client1.waitEvent(t, realtimesocket.NamespaceOps, "ops:event", defaultFrameTimeout)
	ops2 := client2.waitEvent(t, realtimesocket.NamespaceOps, "ops:event", defaultFrameTimeout)

	for name, event := range map[string]frame{"instance-1": queue1, "instance-2": queue2} {
		payload := decodePayload[queueEventPayload](t, event)
		if payload.OrgID != "org-bull" || payload.Event != "COMPLETED" || payload.JobID != "it-dedup-1" {
			t.Fatalf("%s queue:event payload = %+v, want org-bull/COMPLETED/it-dedup-1", name, payload)
		}
		if string(payload.Data) != `{"ok":true}` {
			t.Fatalf("%s queue:event data = %s, want the returnvalue object", name, payload.Data)
		}
		if payload.Timestamp == "" {
			t.Fatalf("%s queue:event payload has no timestamp: %+v", name, payload)
		}
	}
	for name, event := range map[string]frame{"instance-1": ops1, "instance-2": ops2} {
		payload := decodePayload[opsEventPayload](t, event)
		if payload.OrgID != "org-bull" || payload.Source != "pipeline" || payload.Event != "COMPLETED" || payload.JobID != "it-dedup-1" {
			t.Fatalf("%s ops:event payload = %+v, want org-bull/pipeline/COMPLETED/it-dedup-1", name, payload)
		}
		if string(payload.Data) != `{"ok":true}` {
			t.Fatalf("%s ops:event data = %s, want the returnvalue object", name, payload.Data)
		}
	}

	// Allow both XREAD loops one more read cycle: a duplicate delivery (the B1
	// regression) would arrive as a third event, so each client must have
	// observed exactly the warm-up plus the asserted event on both namespaces.
	time.Sleep(1200 * time.Millisecond)
	for name, client := range map[string]*sioClient{"instance-1": client1, "instance-2": client2} {
		if count := client.eventCount(realtimesocket.NamespaceQueue, "queue:event"); count != 2 {
			t.Fatalf("%s received %d queue:event deliveries, want exactly 2 (one warm-up + one asserted)", name, count)
		}
		if count := client.eventCount(realtimesocket.NamespaceOps, "ops:event"); count != 2 {
			t.Fatalf("%s received %d ops:event deliveries, want exactly 2 (one warm-up + one asserted)", name, count)
		}
	}
}

// seedPipelineJobContext writes the two orgId sources the event reader may use:
// the BullMQ job hash (production: queue.getJob(jobId).data.orgId) and the shared
// job context cache written by the NestJS publisher (queue:pipeline:jobctx:<id>).
func (h *harness) seedPipelineJobContext(t *testing.T, jobID, orgID string) {
	t.Helper()
	jobData, err := json.Marshal(map[string]string{"orgId": orgID})
	if err != nil {
		t.Fatalf("marshal job data: %v", err)
	}
	if err := h.redis.HSet(h.ctx, "bull:"+itemPipelineQueueName+":"+jobID, "data", string(jobData)).Err(); err != nil {
		t.Fatalf("seed bull job data: %v", err)
	}
	if err := h.redis.Set(h.ctx, itemPipelineJobContextKey+jobID, string(jobData), 10*time.Minute).Err(); err != nil {
		t.Fatalf("seed shared pipeline job context: %v", err)
	}
}

// appendPipelineCompleted appends one BullMQ "completed" stream entry with the
// same fields moveToFinished-14.lua writes:
// XADD <stream> * event completed jobId <id> returnvalue <json> prev active.
func (h *harness) appendPipelineCompleted(t *testing.T, jobID, returnvalue string) {
	t.Helper()
	err := h.redis.XAdd(h.ctx, &redis.XAddArgs{
		Stream: itemPipelineEventsStream,
		Values: map[string]any{
			"event":       "completed",
			"jobId":       jobID,
			"returnvalue": returnvalue,
			"prev":        "active",
		},
	}).Err()
	if err != nil {
		t.Fatalf("append bullmq completed event: %v", err)
	}
}
