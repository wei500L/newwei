package crawlqueue

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/vmihailenco/msgpack/v5"
)

func TestToBullmqPriority(t *testing.T) {
	cases := []struct {
		name  string
		input *int
		want  *int
	}{
		{name: "absent", input: nil, want: nil},
		{name: "zero", input: intPtr(0), want: intPtr(101)},
		{name: "threshold", input: intPtr(50), want: intPtr(51)},
		{name: "max", input: intPtr(100), want: intPtr(1)},
		{name: "min", input: intPtr(-100), want: intPtr(201)},
		{name: "clamped high", input: intPtr(1000), want: intPtr(1)},
		{name: "clamped low", input: intPtr(-1000), want: intPtr(201)},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := ToBullmqPriority(test.input)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("priority = %v, want %v", valueOf(got), valueOf(test.want))
			}
		})
	}
}

func valueOf(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func intPtr(value int) *int { return &value }

func TestTaskJobDataJSONOrdering(t *testing.T) {
	sourceID := "source-1"
	triggeredBy := "user-1"
	priority := 60
	data := TaskJobData{
		TaskID:                 "task-1",
		OrgID:                  "org-1",
		SourceID:               &sourceID,
		TriggeredByID:          &triggeredBy,
		TraceID:                "trace-1",
		MemoryPressureRequeues: 0,
		PriorityClass:          "hot",
		SourcePriority:         &priority,
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"taskId":"task-1","orgId":"org-1","sourceId":"source-1","triggeredById":"user-1",` +
		`"traceId":"trace-1","memoryPressureRequeues":0,"priorityClass":"hot","sourcePriority":60}`
	if string(encoded) != want {
		t.Fatalf("data = %s\nwant %s", encoded, want)
	}

	minimal, err := json.Marshal(TaskJobData{TaskID: "t", OrgID: "o", TraceID: "x", PriorityClass: "normal"})
	if err != nil {
		t.Fatal(err)
	}
	wantMinimal := `{"taskId":"t","orgId":"o","traceId":"x","memoryPressureRequeues":0,"priorityClass":"normal"}`
	if string(minimal) != wantMinimal {
		t.Fatalf("minimal = %s\nwant %s", minimal, wantMinimal)
	}
}

func TestJobOptionsMsgpack(t *testing.T) {
	priority := 51
	options := jobOptions{
		Attempts:         3,
		RemoveOnComplete: true,
		RemoveOnFail:     failedRetention{Age: 604800, Count: 10000},
		Backoff:          &backoffOptions{Type: "exponential", Delay: 5000},
		JobID:            "task-1-1700000000000-hot",
		Deduplication:    &deduplicationOptions{ID: "crawl-task:task-1"},
		Priority:         &priority,
	}
	encoded, err := msgpack.Marshal(options)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if numberAsInt64(decoded["attempts"]) != 3 || decoded["removeOnComplete"] != true {
		t.Fatalf("decoded = %#v", decoded)
	}
	retention, ok := decoded["removeOnFail"].(map[string]any)
	if !ok || numberAsInt64(retention["age"]) != 604800 || numberAsInt64(retention["count"]) != 10000 {
		t.Fatalf("removeOnFail = %#v", decoded["removeOnFail"])
	}
	backoff, ok := decoded["backoff"].(map[string]any)
	if !ok || backoff["type"] != "exponential" || numberAsInt64(backoff["delay"]) != 5000 {
		t.Fatalf("backoff = %#v", decoded["backoff"])
	}
	dedup, ok := decoded["de"].(map[string]any)
	if !ok || dedup["id"] != "crawl-task:task-1" {
		t.Fatalf("de = %#v", decoded["de"])
	}
	if decoded["jobId"] != "task-1-1700000000000-hot" || numberAsInt64(decoded["priority"]) != 51 {
		t.Fatalf("jobId/priority = %#v", decoded)
	}
	if _, present := decoded["delay"]; present {
		t.Fatal("delay must not be encoded when undefined")
	}
}

// numberAsInt64 accepts every integer representation msgpack may decode into
// interface values.
func numberAsInt64(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int8:
		return int64(typed)
	case int16:
		return int64(typed)
	case int32:
		return int64(typed)
	case int64:
		return typed
	case uint:
		return int64(typed)
	case uint8:
		return int64(typed)
	case uint16:
		return int64(typed)
	case uint32:
		return int64(typed)
	case uint64:
		return int64(typed)
	default:
		return -1
	}
}

func TestJobOptionsOmitBackoffWhenZero(t *testing.T) {
	encoded, err := msgpack.Marshal(jobOptions{Attempts: 1, RemoveOnComplete: true, JobID: "j"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := msgpack.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, present := decoded["backoff"]; present {
		t.Fatalf("backoff must be omitted: %#v", decoded)
	}
	if _, present := decoded["priority"]; present {
		t.Fatalf("priority must be omitted: %#v", decoded)
	}
}

func TestQueueKeys(t *testing.T) {
	keys := keysFor(QueueHot)
	if keys.wait != "bull:crawl4ai-hot:wait" || keys.dedup != "bull:crawl4ai-hot:de:" {
		t.Fatalf("keys = %#v", keys)
	}
	if got := keys.jobKey("abc"); got != "bull:crawl4ai-hot:abc" {
		t.Fatalf("jobKey = %s", got)
	}
	if got := keys.queuePrefix(); got != "bull:crawl4ai-hot:" {
		t.Fatalf("queuePrefix = %s", got)
	}
}

func TestQueueCounts(t *testing.T) {
	hot := QueueCounts{Waiting: 2, Active: 1, Delayed: 3, Failed: 4, Paused: 5}
	normal := QueueCounts{Waiting: 10, Active: 20, Delayed: 30, Failed: 40, Paused: 50}
	merged := hot.Add(normal)
	if merged.Waiting != 12 || merged.Active != 21 || merged.Delayed != 33 || merged.Failed != 44 || merged.Paused != 55 {
		t.Fatalf("merged = %#v", merged)
	}
	if merged.Pending() != 66 {
		t.Fatalf("pending = %d", merged.Pending())
	}
}

func TestNormalizePriorityClass(t *testing.T) {
	if NormalizePriorityClass("hot") != PriorityClassHot {
		t.Fatal("hot must stay hot")
	}
	if NormalizePriorityClass("normal") != PriorityClassNormal || NormalizePriorityClass("") != PriorityClassNormal {
		t.Fatal("unknown classes normalize to normal")
	}
}
