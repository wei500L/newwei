package crawlfrontierruns

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRawJSONHelpers(t *testing.T) {
	if got := objectJSONOrNull([]byte(`[1]`)); got != nil {
		t.Fatalf("array must map to nil, got %s", got)
	}
	if got := objectJSONOrNull([]byte(`{"a":1}`)); string(got) != `{"a":1}` {
		t.Fatalf("object = %s", got)
	}
	if got := objectJSONOrEmpty(nil); string(got) != `{}` {
		t.Fatalf("missing object = %s", got)
	}
	if got := arrayJSONOrEmpty([]byte(`"x"`)); string(got) != `[]` {
		t.Fatalf("non-array = %s", got)
	}
	if got := arrayJSONOrNil([]byte(`[]`)); string(got) != `[]` {
		t.Fatalf("array = %s", got)
	}
	if got := arrayJSONOrNil([]byte(`{}`)); got != nil {
		t.Fatalf("non-array must map to nil, got %s", got)
	}
	encoded, err := json.Marshal(RawJSON(nil))
	if err != nil || string(encoded) != "null" {
		t.Fatalf("nil RawJSON = %s (%v)", encoded, err)
	}
	if !RawJSON(`{"a":1}`).IsObject() || RawJSON(`[1]`).IsObject() {
		t.Fatal("IsObject is wrong")
	}
	if !RawJSON(`[1]`).IsArray() || RawJSON(`{"a":1}`).IsArray() {
		t.Fatal("IsArray is wrong")
	}
}

func TestNestTimeMarshalsMillisecondUTC(t *testing.T) {
	value := time.Date(2026, 1, 2, 3, 4, 5, 6000000, time.UTC)
	encoded, err := json.Marshal(nestFromTime(value))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != `"2026-01-02T03:04:05.006Z"` {
		t.Fatalf("encoded = %s", encoded)
	}
	encoded, err = json.Marshal((*nestTime)(nil))
	if err != nil || string(encoded) != "null" {
		t.Fatalf("nil time = %s (%v)", encoded, err)
	}
}

func TestRunListItemKeyOrder(t *testing.T) {
	item := runListItem{runFields: runFields{
		ID:            "run-1",
		OrgID:         "org-1",
		ExecutionMode: ExecutionModeLayered,
		Status:        RunStatusRunning,
		CreatedAt:     nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		UpdatedAt:     nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}}
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	text := string(encoded)
	if !strings.HasPrefix(text, `{"id":"run-1","orgId":"org-1","profileId":null,"workflowRunId":null,"seedUrl":""`) {
		t.Fatalf("unexpected prefix: %s", text)
	}
	if !strings.HasSuffix(text, `,"updatedAt":"2026-01-01T00:00:00.000Z","profile":null}`) {
		t.Fatalf("unexpected suffix: %s", text)
	}
}

func TestWorkflowRunDocumentKeyOrder(t *testing.T) {
	document := workflowRunDocument{
		ID:               "w",
		OrgID:            "o",
		WorkflowOrigin:   "bound",
		Workflow:         &workflowRef{ID: "wf", Name: "N"},
		WorkflowVersion:  &workflowVersionRef{ID: "v", Version: 2, Name: "V"},
		Status:           "running",
		RunKind:          "frontier",
		StepResults:      []stepDocument{},
		Candidates:       []candidateDocument{},
		ParameterSources: RawJSON("[]"),
		SystemEvents:     []eventDocument{},
		CreatedAt:        nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
		UpdatedAt:        nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"id":"w","orgId":"o","workflowOrigin":"bound","workflow":{"id":"wf","name":"N"},` +
		`"workflowVersion":{"id":"v","version":2,"name":"V"},"frontierRunId":null,"status":"running",` +
		`"runKind":"frontier","input":null,"output":null,"graphSnapshot":null,"stepResults":[],` +
		`"candidates":[],"parameterSources":[],"systemEvents":[],"stepCount":0,"candidateCount":0,` +
		`"selectedCount":0,"error":null,"startedAt":null,"finishedAt":null,` +
		`"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s\nwant    = %s", encoded, want)
	}
}

func TestEventDocumentOmitsNonObjectDetails(t *testing.T) {
	event := eventDocument{
		ID:        "e",
		Sequence:  1,
		Level:     "warn",
		EventType: "frontier_run_canceled",
		Message:   "Frontier run was canceled",
		Details:   objectJSONOrNull([]byte(`[1]`)),
		Timestamp: nestFromTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)),
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"id":"e","sequence":1,"level":"warn","eventType":"frontier_run_canceled","nodeId":null,` +
		`"nodeType":null,"message":"Frontier run was canceled","triggerReason":null,"beforeCount":null,` +
		`"afterCount":null,"rescuedCount":null,"timestamp":"2026-01-01T00:00:00.000Z"}`
	if string(encoded) != want {
		t.Fatalf("encoded = %s\nwant    = %s", encoded, want)
	}
}

func TestPermissionList(t *testing.T) {
	got := permissionList([]byte(`["a",1,"b",null]`))
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("permissions = %v", got)
	}
	if permissionList([]byte(`{"a":1}`)) != nil {
		t.Fatal("non-array permissions must map to nil")
	}
}
