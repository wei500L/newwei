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
