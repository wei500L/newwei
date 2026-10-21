package queueops

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// dlqPayload is one dead-letter payload built exactly like the processor builds
// it: the original process-item document plus the envelope fields in order.
const dlqPayload = `{"itemMetaId":"m1","rawItemId":"r1","orgId":"org-a","traceId":"trace-1","processedItemId":"p1",` +
	`"originalQueue":"itemPipeline","originalJobId":"job-1","failedAt":"2026-10-20T00:00:00.000Z",` +
	`"attempts":5,"attemptsMade":3,"errorKind":"permanent","error":{"name":"QueuePermanentError","message":"boom"}}`

func TestStripDLQEnvelopeRemovesEnvelopeInOrder(t *testing.T) {
	envelope, err := stripDLQEnvelope(json.RawMessage(dlqPayload))
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	if envelope.Queue != "itemPipeline" {
		t.Fatalf("queue = %q", envelope.Queue)
	}
	if envelope.JobID != "job-1" {
		t.Fatalf("original job id = %q", envelope.JobID)
	}
	if envelope.OrgID != "org-a" {
		t.Fatalf("org id = %q", envelope.OrgID)
	}
	want := `{"itemMetaId":"m1","rawItemId":"r1","orgId":"org-a","traceId":"trace-1","processedItemId":"p1"}`
	if string(envelope.Data) != want {
		t.Fatalf("data = %s\nwant  %s", envelope.Data, want)
	}
}

func TestStripDLQEnvelopeAcceptsNullOriginalJobID(t *testing.T) {
	payload := `{"orgId":"org-a","rawItemId":"r1","originalQueue":"itemPipeline",` +
		`"originalJobId":null,"failedAt":"2026-10-20T00:00:00.000Z","attempts":5,"attemptsMade":5,` +
		`"errorKind":"transient","error":{"name":"QueueTransientError","message":"boom"}}`
	envelope, err := stripDLQEnvelope(json.RawMessage(payload))
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	if envelope.JobID != "" {
		t.Fatalf("original job id = %q, want empty", envelope.JobID)
	}
	if string(envelope.Data) != `{"orgId":"org-a","rawItemId":"r1"}` {
		t.Fatalf("data = %s", envelope.Data)
	}
}

func TestStripDLQEnvelopeRefusesPollutedPayload(t *testing.T) {
	// attempts appears before originalQueue, so the envelope overwrote the
	// original value in place and the true value is gone.
	payload := `{"orgId":"org-a","attempts":9,"originalQueue":"itemPipeline","originalJobId":"job-1",` +
		`"failedAt":"2026-10-20T00:00:00.000Z","attemptsMade":3,"errorKind":"permanent","error":{"message":"boom"}}`
	_, err := stripDLQEnvelope(json.RawMessage(payload))
	if err == nil {
		t.Fatalf("polluted payload accepted")
	}
	if !isEnvelopeError(err) {
		t.Fatalf("error type = %T, want *envelopeError", err)
	}
	if !strings.Contains(err.Error(), `"attempts"`) {
		t.Fatalf("message does not name the conflict: %v", err)
	}
}

func TestStripDLQEnvelopeRefusesMultipleConflicts(t *testing.T) {
	payload := `{"orgId":"org-a","error":{"message":"old"},"errorKind":"old","originalQueue":"itemPipeline",` +
		`"originalJobId":"job-1","attempts":5,"attemptsMade":3}`
	_, err := stripDLQEnvelope(json.RawMessage(payload))
	if !isEnvelopeError(err) {
		t.Fatalf("error = %v, want envelope error", err)
	}
	for _, field := range []string{`"error"`, `"errorKind"`} {
		if !strings.Contains(err.Error(), field) {
			t.Fatalf("message does not name %s: %v", field, err)
		}
	}
}

func TestStripDLQEnvelopeRejectsMissingOriginalQueue(t *testing.T) {
	_, err := stripDLQEnvelope(json.RawMessage(`{"orgId":"org-a","itemMetaId":"m1"}`))
	if !isEnvelopeError(err) {
		t.Fatalf("error = %v, want envelope error", err)
	}
	if !strings.Contains(err.Error(), "originalQueue") {
		t.Fatalf("message = %v", err)
	}
}

func TestStripDLQEnvelopeRejectsOtherQueue(t *testing.T) {
	payload := `{"orgId":"org-a","originalQueue":"crawl4ai","originalJobId":"job-1"}`
	_, err := stripDLQEnvelope(json.RawMessage(payload))
	if !isEnvelopeError(err) {
		t.Fatalf("error = %v, want envelope error", err)
	}
	if !strings.Contains(err.Error(), "itemPipeline") {
		t.Fatalf("message = %v", err)
	}
}

func TestStripDLQEnvelopeRejectsNonStringOriginalQueue(t *testing.T) {
	payload := `{"orgId":"org-a","originalQueue":42,"originalJobId":"job-1"}`
	if _, err := stripDLQEnvelope(json.RawMessage(payload)); !isEnvelopeError(err) {
		t.Fatalf("error = %v, want envelope error", err)
	}
}

func TestStripDLQEnvelopeRejectsMissingOrgID(t *testing.T) {
	payload := `{"itemMetaId":"m1","originalQueue":"itemPipeline","originalJobId":"job-1",` +
		`"attempts":5,"attemptsMade":3}`
	_, err := stripDLQEnvelope(json.RawMessage(payload))
	if !isEnvelopeError(err) {
		t.Fatalf("error = %v, want envelope error", err)
	}
	if !strings.Contains(err.Error(), "orgId") {
		t.Fatalf("message = %v", err)
	}
	// An empty orgId is as unusable as a missing one.
	empty := `{"orgId":"","originalQueue":"itemPipeline","originalJobId":"job-1"}`
	if _, err := stripDLQEnvelope(json.RawMessage(empty)); !isEnvelopeError(err) {
		t.Fatalf("empty orgId accepted")
	}
}

func TestStripDLQEnvelopeRejectsNonObjectPayload(t *testing.T) {
	for _, payload := range []string{``, `null`, `[]`, `"text"`} {
		if _, err := stripDLQEnvelope(json.RawMessage(payload)); !isEnvelopeError(err) {
			t.Fatalf("payload %q: error = %v, want envelope error", payload, err)
		}
	}
}

func TestReplayJobIDIsDeterministic(t *testing.T) {
	first := replayJobID("dlq-itemPipeline-job-1-3")
	if first != "replay-dlq-itemPipeline-job-1-3" {
		t.Fatalf("replay id = %q", first)
	}
	if replayJobID("dlq-itemPipeline-job-1-3") != first {
		t.Fatalf("replay id is not deterministic")
	}
	if replayJobID("other") == first {
		t.Fatalf("different dead-letter ids share a replay id")
	}
}

// testEnvelope is one stripped payload shared by the applyReplay tests.
func testEnvelope() dlqEnvelope {
	return dlqEnvelope{
		Queue: "itemPipeline",
		JobID: "job-1",
		OrgID: "org-a",
		Data:  json.RawMessage(`{"orgId":"org-a","itemMetaId":"m1"}`),
	}
}

func TestApplyReplayAddsThenRemoves(t *testing.T) {
	service := NewService(Options{})
	removed := false
	result, err := service.applyReplay(context.Background(), "dlq-1", testEnvelope(), false,
		func(_ context.Context, jobID string, data json.RawMessage, orgID string) (string, error) {
			if jobID != "replay-dlq-1" {
				t.Fatalf("enqueue job id = %q", jobID)
			}
			if orgID != "org-a" {
				t.Fatalf("enqueue org id = %q", orgID)
			}
			if string(data) != `{"orgId":"org-a","itemMetaId":"m1"}` {
				t.Fatalf("enqueue data = %s", data)
			}
			return jobID, nil
		},
		func(_ context.Context, queue, jobID string) (bool, error) {
			if queue != dlqQueue || jobID != "dlq-1" {
				t.Fatalf("remove = %q/%q", queue, jobID)
			}
			removed = true
			return true, nil
		})
	if err != nil {
		t.Fatalf("applyReplay: %v", err)
	}
	if !removed {
		t.Fatalf("dead-letter job was not removed")
	}
	if !result.Replayed || !result.DlqRemoved || result.Warning != nil {
		t.Fatalf("result = %+v", result)
	}
	if result.DlqJobID != "dlq-1" || result.OriginalJobID != "job-1" ||
		result.OriginalQueue != "itemPipeline" || result.OrgID != "org-a" ||
		result.NewJobID != "replay-dlq-1" {
		t.Fatalf("result = %+v", result)
	}
}

func TestApplyReplayKeepsSuccessWhenRemovalFails(t *testing.T) {
	service := NewService(Options{})
	result, err := service.applyReplay(context.Background(), "dlq-1", testEnvelope(), false,
		func(_ context.Context, jobID string, _ json.RawMessage, _ string) (string, error) {
			return jobID, nil
		},
		func(context.Context, string, string) (bool, error) {
			return false, newConflict(codeJobActiveOrLocked, "job is active or locked", "detail")
		})
	if err != nil {
		t.Fatalf("applyReplay: %v", err)
	}
	if !result.Replayed {
		t.Fatalf("replay reported as failed: %+v", result)
	}
	if result.DlqRemoved {
		t.Fatalf("dlqRemoved = true after a failed removal")
	}
	if result.Warning == nil || !strings.Contains(*result.Warning, "not removed") {
		t.Fatalf("warning = %v", result.Warning)
	}
	if !strings.Contains(*result.Warning, "deterministic") {
		t.Fatalf("warning does not explain the idempotent retry: %v", result.Warning)
	}
}

func TestApplyReplayDoesNotRemoveWhenEnqueueFails(t *testing.T) {
	service := NewService(Options{})
	removeCalled := false
	result, err := service.applyReplay(context.Background(), "dlq-1", testEnvelope(), false,
		func(context.Context, string, json.RawMessage, string) (string, error) {
			return "", errors.New("redis is down")
		},
		func(context.Context, string, string) (bool, error) {
			removeCalled = true
			return true, nil
		})
	if removeCalled {
		t.Fatalf("dead-letter job removed after a failed add")
	}
	if err == nil || !strings.Contains(err.Error(), "redis is down") {
		t.Fatalf("error = %v, want the add failure", err)
	}
	if result.Replayed || result.DlqRemoved {
		t.Fatalf("result = %+v", result)
	}
}

func TestApplyReplayDryRunTouchesNothing(t *testing.T) {
	service := NewService(Options{})
	called := false
	result, err := service.applyReplay(context.Background(), "dlq-1", testEnvelope(), true,
		func(context.Context, string, json.RawMessage, string) (string, error) {
			called = true
			return "", nil
		},
		func(context.Context, string, string) (bool, error) {
			called = true
			return true, nil
		})
	if err != nil {
		t.Fatalf("applyReplay: %v", err)
	}
	if called {
		t.Fatalf("dry run called a side effect")
	}
	if result.Replayed || result.DlqRemoved {
		t.Fatalf("result = %+v", result)
	}
	if result.NewJobID != "replay-dlq-1" {
		t.Fatalf("new job id = %q", result.NewJobID)
	}
	if result.Warning == nil || !strings.Contains(*result.Warning, "dry run") {
		t.Fatalf("warning = %v", result.Warning)
	}
}
