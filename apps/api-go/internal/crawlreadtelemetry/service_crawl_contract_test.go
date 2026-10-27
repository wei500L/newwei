package crawlreadtelemetry

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCrawlTaskDetailJSONCarriesRunKeys pins the REST detail contract.
//
// NestJS builds `{ task: { ...toView(task), results, memoryStats,
// lastRunSummary } }`. The spread already created both keys, so a task without a
// complete task log serializes "memoryStats": null and "lastRunSummary": null
// instead of omitting them. The list projection keeps toView's `undefined`
// values, which JSON.stringify drops.
func TestCrawlTaskDetailJSONCarriesRunKeys(t *testing.T) {
	view := CrawlTaskView{
		ID:        "task-1",
		TargetURL: "https://example.com/feed",
		Status:    CrawlTaskStatusPending,
	}

	detailBody, err := json.Marshal(CrawlTaskDetailResponse{
		Task: crawlTaskDetailTask{CrawlTaskView: view, Results: []CrawlTaskResult{}},
	})
	if err != nil {
		t.Fatalf("marshal detail: %v", err)
	}
	detail := string(detailBody)
	for _, key := range []string{`"memoryStats":null`, `"lastRunSummary":null`} {
		if !strings.Contains(detail, key) {
			t.Fatalf("detail body is missing %s: %s", key, detail)
		}
	}
	if strings.Count(detail, `"memoryStats"`) != 1 || strings.Count(detail, `"lastRunSummary"`) != 1 {
		t.Fatalf("detail body duplicates a run key: %s", detail)
	}
	if !strings.HasSuffix(detail, `"results":[]}}`) {
		t.Fatalf("results must be the last task key: %s", detail)
	}

	listBody, err := json.Marshal(CrawlTaskListResponse{Tasks: []CrawlTaskView{view}})
	if err != nil {
		t.Fatalf("marshal list: %v", err)
	}
	list := string(listBody)
	for _, key := range []string{"memoryStats", "lastRunSummary"} {
		if strings.Contains(list, key) {
			t.Fatalf("list body must omit %s: %s", key, list)
		}
	}
}

// TestCrawlTaskDetailJSONKeepsRunValues covers the populated branch: the two run
// keys carry the values read from the latest complete task log, and the view
// itself stays the single source they are copied from (the GraphQL crawlTask
// root reads the same fields).
func TestCrawlTaskDetailJSONKeepsRunValues(t *testing.T) {
	inserted := 3
	serverMemory := 512.5
	view := CrawlTaskView{
		ID:        "task-2",
		TargetURL: "https://example.com/feed",
		Status:    CrawlTaskStatusCompleted,
		MemoryStats: &CrawlMemoryStats{
			ServerMemoryMb: &serverMemory,
		},
		LastRunSummary: &CrawlExecutionSummary{Inserted: inserted, Skipped: 2},
	}
	body, err := json.Marshal(CrawlTaskDetailResponse{
		Task: crawlTaskDetailTask{CrawlTaskView: view, Results: []CrawlTaskResult{}},
	})
	if err != nil {
		t.Fatalf("marshal detail: %v", err)
	}
	detail := string(body)
	if !strings.Contains(detail, `"memoryStats":{"serverMemoryMb":512.5}`) {
		t.Fatalf("memoryStats = %s", detail)
	}
	if !strings.Contains(detail, `"lastRunSummary":{"inserted":3,"skipped":2}`) {
		t.Fatalf("lastRunSummary = %s", detail)
	}
	if strings.Count(detail, `"memoryStats"`) != 1 {
		t.Fatalf("memoryStats must appear once: %s", detail)
	}
}

// TestCrawlTaskViewJSONKeepsEmptyStrings pins the toView projection of a present
// empty column: NestJS copies the raw column value, so "" is serialized and only
// NULL becomes null.
func TestCrawlTaskViewJSONKeepsEmptyStrings(t *testing.T) {
	empty := ""
	view := CrawlTaskView{
		ID:          "task-3",
		TargetURL:   "https://example.com/feed",
		Status:      CrawlTaskStatusQueued,
		DisplayName: &empty,
		LastCursor:  nil,
		LastError:   &empty,
	}
	body, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal view: %v", err)
	}
	encoded := string(body)
	if !strings.Contains(encoded, `"displayName":""`) || !strings.Contains(encoded, `"lastError":""`) {
		t.Fatalf("empty strings must survive: %s", encoded)
	}
	if !strings.Contains(encoded, `"lastCursor":null`) {
		t.Fatalf("NULL must stay null: %s", encoded)
	}
}
