package queueops

import (
	"errors"
	"net/http/httptest"
	"testing"
)

func TestParseJobsQueryDefaults(t *testing.T) {
	request := httptest.NewRequest("GET", "/api/admin/queue-ops/jobs?queue=itemPipeline", nil)
	query, err := parseJobsQuery(request)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if query.Queue != "itemPipeline" {
		t.Fatalf("queue = %q", query.Queue)
	}
	if query.State != StateWaiting {
		t.Fatalf("state = %q, want waiting", query.State)
	}
	if query.Offset != 0 || query.Limit != jobsDefaultLimit {
		t.Fatalf("offset/limit = %d/%d", query.Offset, query.Limit)
	}
}

func TestParseJobsQueryCursorAndLimit(t *testing.T) {
	request := httptest.NewRequest("GET",
		"/api/admin/queue-ops/jobs?queue=itemPipelineDlq&state=failed&cursor=100&limit=10", nil)
	query, err := parseJobsQuery(request)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if query.State != StateFailed {
		t.Fatalf("state = %q, want failed", query.State)
	}
	if query.Offset != 100 || query.Limit != 10 {
		t.Fatalf("offset/limit = %d/%d", query.Offset, query.Limit)
	}
}

func TestParseJobsQueryRejects(t *testing.T) {
	cases := []struct {
		name   string
		target string
	}{
		{"missing queue", "/api/admin/queue-ops/jobs"},
		{"blank queue", "/api/admin/queue-ops/jobs?queue=%20"},
		{"unknown state", "/api/admin/queue-ops/jobs?queue=itemPipeline&state=bogus"},
		{"negative cursor", "/api/admin/queue-ops/jobs?queue=itemPipeline&cursor=-1"},
		{"text cursor", "/api/admin/queue-ops/jobs?queue=itemPipeline&cursor=abc"},
		{"zero limit", "/api/admin/queue-ops/jobs?queue=itemPipeline&limit=0"},
		{"limit above cap", "/api/admin/queue-ops/jobs?queue=itemPipeline&limit=201"},
		{"text limit", "/api/admin/queue-ops/jobs?queue=itemPipeline&limit=abc"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", testCase.target, nil)
			if _, err := parseJobsQuery(request); err == nil {
				t.Fatalf("parse accepted %s", testCase.target)
			} else if !isValidationError(err) {
				t.Fatalf("error type = %T, want *validationError", err)
			}
		})
	}
}

func TestParseJobDetailQuery(t *testing.T) {
	request := httptest.NewRequest("GET",
		"/api/admin/queue-ops/jobs/detail?queue=itemPipeline&jobId=item-1-raw-1", nil)
	query, err := parseJobDetailQuery(request)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if query.Queue != "itemPipeline" || query.JobID != "item-1-raw-1" {
		t.Fatalf("query = %+v", query)
	}
	for _, target := range []string{
		"/api/admin/queue-ops/jobs/detail?jobId=item-1-raw-1",
		"/api/admin/queue-ops/jobs/detail?queue=itemPipeline",
	} {
		request := httptest.NewRequest("GET", target, nil)
		if _, err := parseJobDetailQuery(request); !isValidationError(err) {
			t.Fatalf("%s: error = %v, want validation", target, err)
		}
	}
}

func TestParseJobState(t *testing.T) {
	states := map[string]JobState{
		"":          StateWaiting,
		"waiting":   StateWaiting,
		"active":    StateActive,
		"delayed":   StateDelayed,
		"completed": StateCompleted,
		"failed":    StateFailed,
	}
	for raw, want := range states {
		state, err := parseJobState(raw)
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if state != want {
			t.Fatalf("state %q = %q, want %q", raw, state, want)
		}
	}
	if _, err := parseJobState("paused"); !isValidationError(err) {
		t.Fatalf("paused accepted as a job state")
	}
	if StateWaiting.bullmqKey() != "wait" {
		t.Fatalf("waiting key = %q", StateWaiting.bullmqKey())
	}
	if StateFailed.bullmqKey() != "failed" {
		t.Fatalf("failed key = %q", StateFailed.bullmqKey())
	}
}

func TestParseCleanState(t *testing.T) {
	for _, raw := range []string{"completed", "failed", "wait", "active", "delayed", "paused"} {
		if _, err := parseCleanState(raw); err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
	}
	for _, raw := range []string{"", "waiting", "bogus"} {
		if _, err := parseCleanState(raw); !isValidationError(err) {
			t.Fatalf("parse %q error = %v, want validation", raw, err)
		}
	}
}

func TestValidateBatchLimit(t *testing.T) {
	limitOf := func(value int) *int { return &value }
	cases := []struct {
		raw     *int
		want    int
		wantErr bool
	}{
		{nil, batchDefaultLimit, false},
		{limitOf(1), 1, false},
		{limitOf(batchMaxLimit), batchMaxLimit, false},
		{limitOf(0), 0, true},
		{limitOf(batchMaxLimit + 1), 0, true},
	}
	for _, testCase := range cases {
		got, err := validateBatchLimit(testCase.raw, batchDefaultLimit, batchMaxLimit)
		if testCase.wantErr {
			if !isValidationError(err) {
				t.Fatalf("limit %v: error = %v, want validation", testCase.raw, err)
			}
			continue
		}
		if err != nil || got != testCase.want {
			t.Fatalf("limit %v = %d/%v, want %d", testCase.raw, got, err, testCase.want)
		}
	}
}

func TestValidateGrace(t *testing.T) {
	graceOf := func(value int64) *int64 { return &value }
	if _, err := validateGrace(nil); !isValidationError(err) {
		t.Fatalf("missing grace accepted")
	}
	if value, err := validateGrace(graceOf(0)); err != nil || value != 0 {
		t.Fatalf("grace 0 = %d/%v", value, err)
	}
	if value, err := validateGrace(graceOf(maxGraceMillis)); err != nil || value != maxGraceMillis {
		t.Fatalf("grace max = %d/%v", value, err)
	}
	if _, err := validateGrace(graceOf(maxGraceMillis + 1)); !isValidationError(err) {
		t.Fatalf("grace above the cap accepted")
	}
	if _, err := validateGrace(graceOf(-1)); !isValidationError(err) {
		t.Fatalf("negative grace accepted")
	}
}

func TestValidateJobRequest(t *testing.T) {
	if _, _, err := validateJobRequest(jobRequest{Queue: "itemPipeline"}); !isValidationError(err) {
		t.Fatalf("missing jobId accepted")
	}
	if _, _, err := validateJobRequest(jobRequest{JobID: "job-1"}); !isValidationError(err) {
		t.Fatalf("missing queue accepted")
	}
	queue, jobID, err := validateJobRequest(jobRequest{Queue: "itemPipeline", JobID: "job-1"})
	if err != nil || queue != "itemPipeline" || jobID != "job-1" {
		t.Fatalf("valid request = %q/%q/%v", queue, jobID, err)
	}
}

func TestValidateDLQReplayRequest(t *testing.T) {
	limitOf := func(value int) *int { return &value }

	if _, err := validateDLQReplayRequest(dlqReplayRequest{JobID: "a", JobIDs: []string{"b"}}); !isValidationError(err) {
		t.Fatalf("both addressing modes accepted")
	}
	if _, err := validateDLQReplayRequest(dlqReplayRequest{JobIDs: make([]string, dlqBatchMaxLimit+1)}); !isValidationError(err) {
		t.Fatalf("oversized jobIds accepted")
	}
	if _, err := validateDLQReplayRequest(dlqReplayRequest{JobIDs: []string{""}}); !isValidationError(err) {
		t.Fatalf("empty job id accepted")
	}
	if _, err := validateDLQReplayRequest(dlqReplayRequest{Limit: limitOf(dlqBatchMaxLimit + 1)}); !isValidationError(err) {
		t.Fatalf("limit above the DLQ cap accepted")
	}

	single, err := validateDLQReplayRequest(dlqReplayRequest{JobID: "dlq-1", DryRun: true})
	if err != nil {
		t.Fatalf("single: %v", err)
	}
	if !single.Single || !single.DryRun || len(single.JobIDs) != 1 || single.JobIDs[0] != "dlq-1" {
		t.Fatalf("single plan = %+v", single)
	}
	derived, err := validateDLQReplayRequest(dlqReplayRequest{})
	if err != nil {
		t.Fatalf("derived: %v", err)
	}
	if derived.Single || len(derived.JobIDs) != 0 || derived.Limit != dlqBatchDefaultLimit {
		t.Fatalf("derived plan = %+v", derived)
	}
	batch, err := validateDLQReplayRequest(dlqReplayRequest{JobIDs: []string{"a", "b"}, Limit: limitOf(2)})
	if err != nil {
		t.Fatalf("batch: %v", err)
	}
	if batch.Single || len(batch.JobIDs) != 2 || batch.Limit != 2 {
		t.Fatalf("batch plan = %+v", batch)
	}
}

func TestValidateDLQDeleteRequest(t *testing.T) {
	if _, _, err := validateDLQDeleteRequest(dlqDeleteRequest{}); !isValidationError(err) {
		t.Fatalf("empty request accepted")
	}
	if _, _, err := validateDLQDeleteRequest(dlqDeleteRequest{JobID: "a", JobIDs: []string{"b"}}); !isValidationError(err) {
		t.Fatalf("both addressing modes accepted")
	}
	if _, _, err := validateDLQDeleteRequest(dlqDeleteRequest{JobIDs: make([]string, dlqBatchMaxLimit+1)}); !isValidationError(err) {
		t.Fatalf("oversized jobIds accepted")
	}
	ids, single, err := validateDLQDeleteRequest(dlqDeleteRequest{JobID: "dlq-1"})
	if err != nil || !single || len(ids) != 1 || ids[0] != "dlq-1" {
		t.Fatalf("single delete = %v/%v/%v", ids, single, err)
	}
	ids, single, err = validateDLQDeleteRequest(dlqDeleteRequest{JobIDs: []string{"a", "b"}})
	if err != nil || single || len(ids) != 2 {
		t.Fatalf("batch delete = %v/%v/%v", ids, single, err)
	}
}

// isValidationError reports whether err is the 400 validation shape.
func isValidationError(err error) bool {
	var target *validationError
	return errors.As(err, &target)
}
