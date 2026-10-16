package adminlogs

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func marshalObject(t *testing.T, object jsonObject) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestTaskLogJSONRedactsAndOmits(t *testing.T) {
	document := bson.M{
		"_id":       "log-1",
		"queue":     "q",
		"jobId":     "j",
		"orgId":     "org-1",
		"stage":     "s",
		"status":    "failed",
		"message":   "Bearer secret.jwt.token password=plain123",
		"data":      bson.M{"authorization": "Bearer raw.token", "nested": bson.M{"api_key": "plain"}},
		"createdAt": time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC),
	}
	decoded := marshalObject(t, taskLogJSON(document))
	if decoded["id"] != "log-1" || decoded["queue"] != "q" || decoded["status"] != "failed" {
		t.Fatalf("scalars = %#v", decoded)
	}
	if decoded["message"] != "Bearer [REDACTED] password=[REDACTED]" {
		t.Fatalf("message = %v", decoded["message"])
	}
	data, ok := decoded["data"].(map[string]any)
	if !ok {
		t.Fatalf("data = %#v", decoded["data"])
	}
	if data["authorization"] != "[REDACTED]" {
		t.Fatalf("data.authorization = %v", data["authorization"])
	}
	nested, ok := data["nested"].(map[string]any)
	if !ok || nested["api_key"] != "[REDACTED]" {
		t.Fatalf("data.nested = %#v", data["nested"])
	}
	if decoded["createdAt"] != "2026-10-10T00:00:00.000Z" {
		t.Fatalf("createdAt = %v", decoded["createdAt"])
	}
	if _, present := decoded["error"]; present {
		t.Fatal("absent error field should be omitted")
	}
	if decoded["updatedAt"] != nil {
		t.Fatalf("updatedAt = %v", decoded["updatedAt"])
	}
}

func TestTaskLogJSONKeepsNullFields(t *testing.T) {
	decoded := marshalObject(t, taskLogJSON(bson.M{
		"_id":    "log-2",
		"data":   nil,
		"error":  nil,
		"status": nil,
	}))
	value, present := decoded["data"]
	if !present || value != nil {
		t.Fatalf("data = %#v (present=%v)", value, present)
	}
	value, present = decoded["error"]
	if !present || value != nil {
		t.Fatalf("error = %#v (present=%v)", value, present)
	}
	if decoded["status"] != "pending" {
		t.Fatalf("status = %v", decoded["status"])
	}
	if decoded["id"] != "log-2" {
		t.Fatalf("id = %v", decoded["id"])
	}
	if _, present := decoded["message"]; present {
		t.Fatal("absent message field should be omitted")
	}
}

func TestExceptionEventJSONRedactsMessageAndStack(t *testing.T) {
	decoded := marshalObject(t, exceptionEventJSON(bson.M{
		"id":        "evt-1",
		"kind":      "http",
		"traceId":   "trace-1",
		"timestamp": time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC),
		"message":   "Bearer secret.jwt.token",
		"stack":     "Error: password=plain123",
		"path":      "/api/x",
	}))
	if decoded["message"] != "Bearer [REDACTED]" {
		t.Fatalf("message = %v", decoded["message"])
	}
	if decoded["stack"] != "Error: password=[REDACTED]" {
		t.Fatalf("stack = %v", decoded["stack"])
	}
	if decoded["timestamp"] != "2026-10-10T12:00:00.000Z" {
		t.Fatalf("timestamp = %v", decoded["timestamp"])
	}
	for _, absent := range []string{"statusCode", "method", "operation", "operationName", "errorName"} {
		if _, present := decoded[absent]; present {
			t.Fatalf("%s should be omitted", absent)
		}
	}
}

func TestExceptionEventJSONOmitsEmptyStack(t *testing.T) {
	decoded := marshalObject(t, exceptionEventJSON(bson.M{
		"id":      "evt-2",
		"kind":    "unknown",
		"stack":   "",
		"message": nil,
	}))
	if _, present := decoded["stack"]; present {
		t.Fatal("empty stack should be omitted")
	}
	if decoded["message"] != "Unknown error" {
		t.Fatalf("message = %v", decoded["message"])
	}
	if decoded["traceId"] != "" {
		t.Fatalf("traceId = %v", decoded["traceId"])
	}
	if decoded["kind"] != "unknown" {
		t.Fatalf("kind = %v", decoded["kind"])
	}
}

func TestSummaryEmitsEmptyArrays(t *testing.T) {
	_, summary := summarizeTaskLogAggregate(facetResult{}, false)
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, want := range []string{
		`"totals":{"total":0,"pending":0,"processing":0,"completed":0,"failed":0}`,
		`"byStage":[]`,
		`"topErrors":[]`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("summary %s missing %s", text, want)
		}
	}
}

func TestSummaryTotalsAndTopErrors(t *testing.T) {
	result := facetResult{
		StatusAgg: []statusBucket{
			{ID: "completed", Count: 2},
			{ID: "failed", Count: 1},
		},
		StageAgg: []statusBucket{{ID: nil, Count: 3}},
		ErrorAgg: []errorBucket{{
			SampleMessage: "password=plain123",
			Count:         1,
		}},
	}
	_, summary := summarizeTaskLogAggregate(result, false)
	if summary.Totals.Total != 3 || summary.Totals.Completed != 2 || summary.Totals.Failed != 1 {
		t.Fatalf("totals = %#v", summary.Totals)
	}
	if len(summary.ByStage) != 1 || summary.ByStage[0].Stage != "unknown" {
		t.Fatalf("byStage = %#v", summary.ByStage)
	}
	if len(summary.TopErrors) != 1 {
		t.Fatalf("topErrors = %#v", summary.TopErrors)
	}
	if summary.TopErrors[0].SampleMessage != "password=[REDACTED]" {
		t.Fatalf("sampleMessage = %v", summary.TopErrors[0].SampleMessage)
	}
	if summary.TopErrors[0].ErrorName != "unknown" {
		t.Fatalf("errorName = %v", summary.TopErrors[0].ErrorName)
	}
}
