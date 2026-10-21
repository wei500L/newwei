package queueops

import (
	"encoding/json"
	"testing"
)

// jobDetailShape is the wire shape of GET /jobs/detail.
type jobDetailShape struct {
	Job struct {
		ID            string          `json:"id"`
		Name          string          `json:"name"`
		Timestamp     int64           `json:"timestamp"`
		ProcessedOn   *int64          `json:"processedOn"`
		FinishedOn    *int64          `json:"finishedOn"`
		AttemptsMade  int64           `json:"attemptsMade"`
		FailedReason  string          `json:"failedReason"`
		DataPreview   string          `json:"dataPreview"`
		Data          json.RawMessage `json:"data"`
		Opts          json.RawMessage `json:"opts"`
		ReturnValue   json.RawMessage `json:"returnvalue"`
		Stacktrace    []string        `json:"stacktrace"`
		Logs          []string        `json:"logs"`
		DataTruncated bool            `json:"dataTruncated"`
		OrgID         *string         `json:"orgId"`
	} `json:"job"`
}

func TestJobDetailResponseShape(t *testing.T) {
	finishedOn := int64(1700000005000)
	payload := JobDetailResponse{Job: JobDetail{
		JobSummary: JobSummary{
			ID:           "job-1",
			Name:         "process-item",
			Timestamp:    1700000000000,
			FinishedOn:   &finishedOn,
			AttemptsMade: 2,
			FailedReason: "boom",
			DataPreview:  `{"orgId":"org-a"}`,
		},
		Data:       json.RawMessage(`{"orgId":"org-a"}`),
		Opts:       json.RawMessage(`{"attempts":5}`),
		Stacktrace: []string{},
		Logs:       []string{"line-1"},
	}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded jobDetailShape
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	job := decoded.Job
	if job.ID != "job-1" || job.Name != "process-item" || job.Timestamp != 1700000000000 {
		t.Fatalf("summary fields = %+v", job)
	}
	if job.ProcessedOn != nil {
		t.Fatalf("processedOn = %v, want null", job.ProcessedOn)
	}
	if job.FinishedOn == nil || *job.FinishedOn != finishedOn {
		t.Fatalf("finishedOn = %v", job.FinishedOn)
	}
	if job.AttemptsMade != 2 || job.FailedReason != "boom" || job.DataPreview != `{"orgId":"org-a"}` {
		t.Fatalf("summary fields = %+v", job)
	}
	if string(job.Data) != `{"orgId":"org-a"}` {
		t.Fatalf("data = %s", job.Data)
	}
	if string(job.Opts) != `{"attempts":5}` {
		t.Fatalf("opts = %s", job.Opts)
	}
	if string(job.ReturnValue) != "null" {
		t.Fatalf("returnvalue = %s, want null", job.ReturnValue)
	}
	if len(job.Stacktrace) != 0 || len(job.Logs) != 1 || job.Logs[0] != "line-1" {
		t.Fatalf("stacktrace/logs = %v/%v", job.Stacktrace, job.Logs)
	}
	if job.DataTruncated {
		t.Fatalf("dataTruncated = true")
	}
	if job.OrgID != nil {
		t.Fatalf("orgId = %v, want null", job.OrgID)
	}
}

// queueListShape is the wire shape of GET /queues.
type queueListShape struct {
	Queues []struct {
		Name   string `json:"name"`
		Counts struct {
			Waiting   int64 `json:"waiting"`
			Active    int64 `json:"active"`
			Delayed   int64 `json:"delayed"`
			Completed int64 `json:"completed"`
			Failed    int64 `json:"failed"`
			Paused    int64 `json:"paused"`
		} `json:"counts"`
		Paused      bool   `json:"paused"`
		Concurrency *int64 `json:"concurrency"`
		IsDLQ       bool   `json:"isDLQ"`
	} `json:"queues"`
}

func TestQueueListResponseShape(t *testing.T) {
	concurrency := int64(4)
	payload := QueueList{Queues: []QueueSummary{{
		Name:        "itemPipeline",
		Counts:      QueueCounts{Waiting: 1, Active: 2, Delayed: 3, Completed: 4, Failed: 5, Paused: 6},
		Paused:      true,
		Concurrency: &concurrency,
		IsDLQ:       false,
	}, {
		Name: "itemPipelineDlq",
	}}}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded queueListShape
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(decoded.Queues) != 2 {
		t.Fatalf("queues = %d", len(decoded.Queues))
	}
	first := decoded.Queues[0]
	if first.Name != "itemPipeline" || !first.Paused || first.IsDLQ {
		t.Fatalf("first queue = %+v", first)
	}
	counts := first.Counts
	if counts.Waiting != 1 || counts.Active != 2 || counts.Delayed != 3 ||
		counts.Completed != 4 || counts.Failed != 5 || counts.Paused != 6 {
		t.Fatalf("counts = %+v", counts)
	}
	if first.Concurrency == nil || *first.Concurrency != 4 {
		t.Fatalf("concurrency = %v", first.Concurrency)
	}
	second := decoded.Queues[1]
	if second.IsDLQ != true || second.Concurrency != nil || second.Paused {
		t.Fatalf("second queue = %+v", second)
	}
}

func TestJobsPageResponseShape(t *testing.T) {
	next := "100"
	payload := JobsPage{
		Queue:      "itemPipeline",
		State:      StateFailed,
		Jobs:       []JobSummary{{ID: "job-1", DataPreview: "{}"}},
		NextCursor: &next,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded struct {
		Queue string `json:"queue"`
		State string `json:"state"`
		Jobs  []struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			Timestamp    int64  `json:"timestamp"`
			ProcessedOn  *int64 `json:"processedOn"`
			FinishedOn   *int64 `json:"finishedOn"`
			AttemptsMade int64  `json:"attemptsMade"`
			FailedReason string `json:"failedReason"`
			DataPreview  string `json:"dataPreview"`
		} `json:"jobs"`
		NextCursor *string `json:"nextCursor"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.Queue != "itemPipeline" || decoded.State != "failed" {
		t.Fatalf("page = %+v", decoded)
	}
	if len(decoded.Jobs) != 1 || decoded.Jobs[0].ID != "job-1" {
		t.Fatalf("jobs = %+v", decoded.Jobs)
	}
	if decoded.NextCursor == nil || *decoded.NextCursor != "100" {
		t.Fatalf("nextCursor = %v", decoded.NextCursor)
	}
}

func TestMutationResponseShapes(t *testing.T) {
	retry, err := json.Marshal(RetryResult{Queue: "itemPipeline", JobID: "job-1", State: "waiting"})
	if err != nil {
		t.Fatalf("retry marshal: %v", err)
	}
	if string(retry) != `{"queue":"itemPipeline","jobId":"job-1","state":"waiting"}` {
		t.Fatalf("retry = %s", retry)
	}
	deleted, err := json.Marshal(DeleteResult{Queue: "itemPipeline", JobID: "job-1", Deleted: true})
	if err != nil {
		t.Fatalf("delete marshal: %v", err)
	}
	if string(deleted) != `{"queue":"itemPipeline","jobId":"job-1","deleted":true}` {
		t.Fatalf("delete = %s", deleted)
	}
	promote, err := json.Marshal(PromoteResult{Queue: "itemPipeline", JobID: "job-1"})
	if err != nil {
		t.Fatalf("promote marshal: %v", err)
	}
	if string(promote) != `{"queue":"itemPipeline","jobId":"job-1"}` {
		t.Fatalf("promote = %s", promote)
	}
	paused, err := json.Marshal(PauseResult{Queue: "itemPipeline", Paused: true})
	if err != nil {
		t.Fatalf("pause marshal: %v", err)
	}
	if string(paused) != `{"queue":"itemPipeline","paused":true}` {
		t.Fatalf("pause = %s", paused)
	}
}

func TestDLQResponseShapes(t *testing.T) {
	warning := "the itemPipeline job was added but the dead-letter job was not removed"
	replay, err := json.Marshal(DLQReplayResult{
		DlqJobID:      "dlq-itemPipeline-job-1-3",
		OriginalJobID: "job-1",
		OriginalQueue: "itemPipeline",
		OrgID:         "org-a",
		NewJobID:      "replay-dlq-itemPipeline-job-1-3",
		Replayed:      true,
		Warning:       &warning,
	})
	if err != nil {
		t.Fatalf("replay marshal: %v", err)
	}
	var decoded struct {
		DlqJobID      string  `json:"dlqJobId"`
		OriginalJobID string  `json:"originalJobId"`
		OriginalQueue string  `json:"originalQueue"`
		OrgID         string  `json:"orgId"`
		NewJobID      string  `json:"newJobId"`
		Replayed      bool    `json:"replayed"`
		DlqRemoved    bool    `json:"dlqRemoved"`
		Warning       *string `json:"warning"`
	}
	if err := json.Unmarshal(replay, &decoded); err != nil {
		t.Fatalf("replay unmarshal: %v", err)
	}
	if decoded.DlqJobID != "dlq-itemPipeline-job-1-3" || decoded.OriginalJobID != "job-1" ||
		decoded.OriginalQueue != "itemPipeline" || decoded.OrgID != "org-a" ||
		decoded.NewJobID != "replay-dlq-itemPipeline-job-1-3" {
		t.Fatalf("replay = %+v", decoded)
	}
	if !decoded.Replayed || decoded.DlqRemoved {
		t.Fatalf("replay flags = %+v", decoded)
	}
	if decoded.Warning == nil || *decoded.Warning != warning {
		t.Fatalf("warning = %v", decoded.Warning)
	}
	deleteResult, err := json.Marshal(DLQDeleteResult{DlqJobID: "dlq-1", Deleted: true})
	if err != nil {
		t.Fatalf("delete marshal: %v", err)
	}
	if string(deleteResult) != `{"dlqJobId":"dlq-1","deleted":true}` {
		t.Fatalf("delete = %s", deleteResult)
	}
}
