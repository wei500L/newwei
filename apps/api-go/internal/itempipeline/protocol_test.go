package itempipeline

import (
	"encoding/json"
	"testing"
)

func TestPayloadDecodeMatchesTypeofStringChecks(t *testing.T) {
	raw := []byte(`{"rawItemId":"r1","itemMetaId":"m1","orgId":"o1","traceId":42,"processedItemId":"","pipelineJobId":null,"sourceId":"s1"}`)
	var payload Payload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.RawItemID != "r1" || payload.ItemMetaID != "m1" || payload.OrgID != "o1" {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.TraceID != "" {
		t.Fatalf("non-string traceId must read as missing, got %q", payload.TraceID)
	}
	if payload.ProcessedItemID != "" {
		t.Fatalf("empty processedItemId must read as empty")
	}
	if payload.PipelineJobID != nil || payload.SourceID == nil || *payload.SourceID != "s1" {
		t.Fatalf("optional ids = %+v", payload)
	}
}

func TestPayloadDecodeIgnoresUnknownMembers(t *testing.T) {
	var payload Payload
	if err := json.Unmarshal([]byte(`{"rawItemId":"r1","itemMetaId":"m1","orgId":"o1","extra":{"nested":true}}`), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestJobFromFlatReadsCompressedFields(t *testing.T) {
	flat := []any{
		"id", "job-1",
		"name", "process-item",
		"data", `{"rawItemId":"r1","itemMetaId":"m1","orgId":"o1"}`,
		"opts", `{"attempts":5,"backoff":{"type":"exponential","delay":2000}}`,
		"atm", int64(2),
		"stc", int64(1),
	}
	job, err := jobFromFlat(flat, "token-1", "")
	if err != nil {
		t.Fatalf("jobFromFlat: %v", err)
	}
	if job.ID != "job-1" || job.Token != "token-1" {
		t.Fatalf("job identity = %+v", job)
	}
	if job.Payload.RawItemID != "r1" || job.Payload.OrgID != "o1" {
		t.Fatalf("job payload = %+v", job.Payload)
	}
	if job.Attempts() != 5 || job.AttemptsMade != 2 || job.StalledCounter != 1 {
		t.Fatalf("job attempts = %+v", job)
	}
	if got := retryDelayMS(job.Opts.Backoff, job.AttemptsMade+1); got != 8_000 {
		t.Fatalf("retry delay = %d, want 8000 (attempt 3)", got)
	}
	if string(job.Data) != `{"rawItemId":"r1","itemMetaId":"m1","orgId":"o1"}` {
		t.Fatalf("raw data = %s", string(job.Data))
	}
}

// A job the stalled checker already failed must be terminal on its next claim:
// the worker fails it without running the processor even though attempts remain.
func TestDeferredFailureIsTerminalWithoutRunningTheProcessor(t *testing.T) {
	job := Job{
		ID:              "job-1",
		DeferredFailure: "job stalled more than allowable limit",
		AttemptsMade:    0,
	}
	job.Opts.Attempts = 5

	stalledErr := job.DeferredFailureError()
	if stalledErr == nil {
		t.Fatal("a job with a deferred failure must be terminal")
	}

	classified := ClassifyQueueError(stalledErr)
	if classified.Kind != ErrorKindPermanent {
		t.Fatalf("kind = %q, want permanent", classified.Kind)
	}
	if classified.Reason != "unrecoverable" {
		t.Fatalf("reason = %q, want unrecoverable", classified.Reason)
	}
	if classified.Error.Name != "UnrecoverableError" {
		t.Fatalf("serialized name = %q, want UnrecoverableError", classified.Error.Name)
	}
	if classified.Error.Message != "job stalled more than allowable limit" {
		t.Fatalf("serialized message = %q", classified.Error.Message)
	}

	failure := DecodeFailure(job, stalledErr)
	if !failure.Permanent || !failure.FinalFailure {
		t.Fatalf("failure = %+v, want permanent final failure", failure)
	}
	if failure.AttemptsMade != 1 || failure.RemainingAttempts != 4 {
		t.Fatalf("failure attempts = %+v, want attemptsMade 1 and 4 remaining", failure)
	}

	// A healthy job has no terminal failure: the processor must run.
	if err := (Job{Opts: JobOptions{Attempts: 5}}).DeferredFailureError(); err != nil {
		t.Fatalf("healthy job reported terminal failure: %v", err)
	}
}
