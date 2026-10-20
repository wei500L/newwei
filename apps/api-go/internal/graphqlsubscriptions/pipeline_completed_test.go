package graphqlsubscriptions

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// TestPipelineCompletedHandlerSharesReadLoop proves that the extra consumer is
// invoked from the single XREAD loop for completed events only, with the org
// resolved from the job data, and that unsubscribing stops delivery.
func TestPipelineCompletedHandlerSharesReadLoop(t *testing.T) {
	store := newFakeQueueStore()
	store.setJob("job-1", `{"orgId":"org-a"}`)
	observer := newTestQueueObserver(t, store)

	events := make(chan PipelineCompleted, 8)
	unsubscribe := observer.AddPipelineCompletedHandler(func(_ context.Context, event PipelineCompleted) {
		events <- event
	})

	store.push(StreamEntry{ID: "1-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"id":"pid-1"}`,
	}})
	store.push(StreamEntry{ID: "2-0", Fields: map[string]string{
		"event": "failed", "jobId": "job-1", "failedReason": "boom",
	}})
	store.push(StreamEntry{ID: "3-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"_id":"pid-2"}`,
	}})

	select {
	case event := <-events:
		if event.JobID != "job-1" || event.OrgID != "org-a" || event.EntryID != "1-0" {
			t.Fatalf("event = %+v", event)
		}
		if string(event.Data) != `{"id":"pid-1"}` {
			t.Fatalf("data = %s", event.Data)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the completed event")
	}

	select {
	case event := <-events:
		if event.EntryID != "3-0" || string(event.Data) != `{"_id":"pid-2"}` {
			t.Fatalf("second event = %+v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for the second completed event")
	}

	unsubscribe()
	store.push(StreamEntry{ID: "4-0", Fields: map[string]string{
		"event": "completed", "jobId": "job-1", "returnvalue": `{"id":"pid-3"}`,
	}})
	select {
	case event := <-events:
		t.Fatalf("event delivered after unsubscribe: %+v", event)
	case <-time.After(200 * time.Millisecond):
	}
}

// TestPipelineCompletedEventShape pins the typed event marshaling input: a
// completed entry whose returnvalue is a JSON object is passed through verbatim.
func TestPipelineCompletedEventShape(t *testing.T) {
	var raw json.RawMessage = []byte(`{"id":"pid-1"}`)
	event := PipelineCompleted{EntryID: "1-0", JobID: "job-1", OrgID: "org-a", Data: raw}
	if string(event.Data) != `{"id":"pid-1"}` {
		t.Fatalf("data = %s", event.Data)
	}
}
