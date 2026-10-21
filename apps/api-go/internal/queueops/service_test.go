package queueops

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestNewServiceInventory(t *testing.T) {
	service := NewService(Options{})
	names := service.Inventory()
	if len(names) != 15 {
		t.Fatalf("inventory has %d queues, want 15", len(names))
	}
	present := make(map[string]bool, len(names))
	for _, name := range names {
		present[name] = true
	}
	for _, want := range []string{"itemPipeline", "itemPipelineDlq", "crawl4ai", "crawl4ai-hot", "crawl4ai-normal"} {
		if !present[want] {
			t.Fatalf("inventory misses %q: %v", want, names)
		}
	}
}

func TestValidateQueue(t *testing.T) {
	service := NewService(Options{})
	queue, err := service.validateQueue("itemPipelineDlq")
	if err != nil || queue != "itemPipelineDlq" {
		t.Fatalf("known queue = %q/%v", queue, err)
	}
	if _, err := service.validateQueue("  "); !isValidationError(err) {
		t.Fatalf("blank queue error = %v, want validation", err)
	}
	_, err = service.validateQueue("not-a-queue")
	if err == nil {
		t.Fatalf("unknown queue accepted")
	}
	var typed *statusError
	if !errors.As(err, &typed) || typed.status != http.StatusNotFound {
		t.Fatalf("unknown queue error = %v, want 404", err)
	}
}

func TestCountsFromStateValues(t *testing.T) {
	counts := countsFromStateValues([]any{int64(1), int64(2), int64(3), int64(4), int64(5), int64(6)})
	want := QueueCounts{Waiting: 1, Active: 2, Delayed: 3, Completed: 4, Failed: 5, Paused: 6}
	if counts != want {
		t.Fatalf("counts = %+v, want %+v", counts, want)
	}
	// A short reply fills the missing states with zero instead of panicking.
	short := countsFromStateValues([]any{int64(1)})
	if short.Waiting != 1 || short.Paused != 0 {
		t.Fatalf("short counts = %+v", short)
	}
	if empty := countsFromStateValues(nil); empty != (QueueCounts{}) {
		t.Fatalf("nil counts = %+v", empty)
	}
}

func TestFirstRangeIDs(t *testing.T) {
	ids := firstRangeIDs([]any{[]any{"a", "b"}})
	if len(ids) != 2 || ids[0] != "a" || ids[1] != "b" {
		t.Fatalf("ids = %v", ids)
	}
	if got := firstRangeIDs([]any{}); got != nil {
		t.Fatalf("empty reply = %v", got)
	}
	if got := firstRangeIDs([]any{"not-a-list"}); got != nil {
		t.Fatalf("malformed reply = %v", got)
	}
}

func TestJobSummaryFromHash(t *testing.T) {
	values := []any{
		"process-item",
		"1700000000000",
		nil,
		"1700000005000",
		"3",
		"boom",
		`{"orgId":"org-a"}`,
	}
	summary := jobSummaryFromHash("job-1", values)
	if summary.ID != "job-1" || summary.Name != "process-item" {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.Timestamp != 1700000000000 || summary.AttemptsMade != 3 {
		t.Fatalf("summary = %+v", summary)
	}
	if summary.ProcessedOn != nil {
		t.Fatalf("processedOn = %v, want nil", summary.ProcessedOn)
	}
	if summary.FinishedOn == nil || *summary.FinishedOn != 1700000005000 {
		t.Fatalf("finishedOn = %v", summary.FinishedOn)
	}
	if summary.FailedReason != "boom" {
		t.Fatalf("failedReason = %q", summary.FailedReason)
	}
	if summary.DataPreview != `{"orgId":"org-a"}` {
		t.Fatalf("dataPreview = %q", summary.DataPreview)
	}
}

func TestHashValuesPresent(t *testing.T) {
	if hashValuesPresent([]any{nil, nil}) {
		t.Fatalf("all-nil reply reported as present")
	}
	if !hashValuesPresent([]any{nil, "x"}) {
		t.Fatalf("partially present reply reported as missing")
	}
}

func TestStringSliceAlwaysNonNil(t *testing.T) {
	empty := stringSlice(nil)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("stringSlice(nil) = %#v", empty)
	}
	copied := stringSlice([]string{"a"})
	copied[0] = "b"
	if copied[0] != "b" {
		t.Fatalf("copy = %v", copied)
	}
}

func TestPushCommandsAndLifo(t *testing.T) {
	if pushCommand(true) != "RPUSH" || pushCommand(false) != "LPUSH" {
		t.Fatalf("push command mapping is wrong")
	}
	if !optionsLifo(`{"attempts":5,"lifo":true}`) {
		t.Fatalf("lifo option not detected")
	}
	if optionsLifo(`{"attempts":5}`) || optionsLifo("") || optionsLifo("not json") {
		t.Fatalf("lifo option reported for a non-lifo document")
	}
}

func TestStringList(t *testing.T) {
	values := stringList([]any{"a", int64(2), "b"})
	if len(values) != 2 || values[0] != "a" || values[1] != "b" {
		t.Fatalf("stringList = %v", values)
	}
	if got := stringList(nil); got != nil {
		t.Fatalf("stringList(nil) = %v", got)
	}
}

func TestInventorySnapshotIsStable(t *testing.T) {
	service := NewService(Options{})
	first := service.Inventory()
	first[0] = "mutated"
	second := service.Inventory()
	if second[0] == "mutated" {
		t.Fatalf("Inventory exposes the internal slice")
	}
}

func TestDataPreviewHandlesInvalidBytes(t *testing.T) {
	preview := dataPreview(json.RawMessage([]byte{'a', 0xff}))
	if strings.ContainsRune(preview, '\uFFFD') == false {
		t.Fatalf("invalid byte was not replaced: %q", preview)
	}
}
