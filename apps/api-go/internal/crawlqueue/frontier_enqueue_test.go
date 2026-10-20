package crawlqueue

import (
	"encoding/json"
	"testing"
	"time"
)

func TestFrontierJobIDs(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_123)
	if got := FrontierNodeJobID("node-1", PriorityClassHot, now); got != "node-1-1700000000123-hot" {
		t.Fatalf("node job id = %q", got)
	}
	if got := FrontierLlmJudgeJobID("node-1", "seed", now); got != "llm-judge:node-1:seed:1700000000123" {
		t.Fatalf("judge job id = %q", got)
	}
	if got := FrontierLlmLearnJobID("run-1", now); got != "llm-learn:run-1:1700000000123" {
		t.Fatalf("learn job id = %q", got)
	}
}

func TestFrontierNodeJobDataShape(t *testing.T) {
	priority := 120
	data := FrontierNodeJobData{
		TaskID: "task-1", OrgID: "org-1", TraceID: "trace-1", MemoryPressureRequeues: 0,
		PriorityClass: "hot", SourcePriority: &priority, JobKind: "frontier_node",
		FrontierRunID: "run-1", FrontierNodeID: "node-1",
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"taskId":"task-1","orgId":"org-1","traceId":"trace-1","memoryPressureRequeues":0,"priorityClass":"hot","sourcePriority":120,"jobKind":"frontier_node","frontierRunId":"run-1","frontierNodeId":"node-1"}`
	if string(encoded) != want {
		t.Fatalf("data = %s\nwant = %s", encoded, want)
	}
}

func TestFrontierLlmJobDataShape(t *testing.T) {
	judge := FrontierLlmJudgeJobData{
		TaskID: "task-1", OrgID: "org-1", TraceID: "trace-1", JobKind: "frontier_llm_judge",
		FrontierRunID: "run-1", FrontierNodeID: "node-1", FrontierLlmJudge: json.RawMessage(`{"mode":"seed"}`),
	}
	encoded, err := json.Marshal(judge)
	if err != nil {
		t.Fatalf("marshal judge: %v", err)
	}
	want := `{"taskId":"task-1","orgId":"org-1","traceId":"trace-1","jobKind":"frontier_llm_judge","frontierRunId":"run-1","frontierNodeId":"node-1","frontierLlmJudge":{"mode":"seed"}}`
	if string(encoded) != want {
		t.Fatalf("judge data = %s\nwant = %s", encoded, want)
	}
	learn := FrontierLlmLearnJobData{
		TaskID: "task-1", OrgID: "org-1", TraceID: "trace-1", JobKind: "frontier_llm_learn",
		FrontierRunID: "run-1", FrontierLlmLearn: FrontierLlmLearnBody{RunID: "run-1"},
	}
	encoded, err = json.Marshal(learn)
	if err != nil {
		t.Fatalf("marshal learn: %v", err)
	}
	want = `{"taskId":"task-1","orgId":"org-1","traceId":"trace-1","jobKind":"frontier_llm_learn","frontierRunId":"run-1","frontierLlmLearn":{"runId":"run-1"}}`
	if string(encoded) != want {
		t.Fatalf("learn data = %s\nwant = %s", encoded, want)
	}
}

func TestFrontierLlmQueueNames(t *testing.T) {
	if FrontierLlmJudgeQueue != "frontier-llm-judge" || FrontierLlmLearnQueue != "frontier-llm-learn" {
		t.Fatalf("queue names = %q, %q", FrontierLlmJudgeQueue, FrontierLlmLearnQueue)
	}
}
