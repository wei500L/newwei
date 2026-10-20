package pipelinerecovery

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// rawValue encodes one BSON value so the tests exercise the real decoder paths.
func rawValue(t *testing.T, value any) bson.RawValue {
	t.Helper()
	raw, err := bson.Marshal(bson.D{{Key: "value", Value: value}})
	if err != nil {
		t.Fatal(err)
	}
	return bson.Raw(raw).Lookup("value")
}

// TestBuildStagesTakesLastLogPerStage locks the assembly contract: the latest log
// wins per stage, stages are sorted by name, and the defaults match the NestJS
// service.
func TestBuildStagesTakesLastLogPerStage(t *testing.T) {
	logs := []taskLogRow{
		{JobID: rawValue(t, "job-1"), Stage: rawValue(t, "classify"), Status: rawValue(t, "processing"), CreatedAt: rawValue(t, bson.DateTime(1000))},
		{JobID: rawValue(t, "job-1"), Stage: rawValue(t, "classify"), Status: rawValue(t, "completed"), CreatedAt: rawValue(t, bson.DateTime(2000))},
		{JobID: rawValue(t, "job-1"), Stage: rawValue(t, "fetch"), Status: rawValue(t, "completed"), CreatedAt: rawValue(t, bson.DateTime(500))},
		{JobID: rawValue(t, "job-1"), Stage: rawValue(t, "enrich"), Status: rawValue(t, "failed"), CreatedAt: rawValue(t, bson.DateTime(1500)),
			Error: rawValue(t, bson.D{{Key: "name", Value: "Error"}, {Key: "message", Value: "boom"}})},
	}
	stages := buildStages(logs)
	if len(stages) != 3 {
		t.Fatalf("stages = %+v, want 3", stages)
	}
	if stages[0].Stage != "classify" || stages[0].Status != "completed" {
		t.Fatalf("classify stage = %+v, want the last log (completed)", stages[0])
	}
	if stages[1].Stage != "enrich" || stages[2].Stage != "fetch" {
		t.Fatalf("stage order = %s,%s,%s, want classify,enrich,fetch",
			stages[0].Stage, stages[1].Stage, stages[2].Stage)
	}
	if stages[1].Error == nil || stages[1].Error.Name == nil || *stages[1].Error.Name != "Error" ||
		stages[1].Error.Message == nil || *stages[1].Error.Message != "boom" {
		t.Fatalf("enrich error = %+v", stages[1].Error)
	}
	if stages[2].Error != nil {
		t.Fatalf("fetch error = %+v, want nil", stages[2].Error)
	}
	if stages[0].At != "1970-01-01T00:00:02.000Z" {
		t.Fatalf("at = %q", stages[0].At)
	}
}

// TestBuildStagesDefaults locks the fallbacks for a log row missing stage,
// status and createdAt.
func TestBuildStagesDefaults(t *testing.T) {
	stages := buildStages([]taskLogRow{{}})
	if len(stages) != 1 {
		t.Fatalf("stages = %+v", stages)
	}
	if stages[0].Stage != "unknown" || stages[0].Status != "pending" {
		t.Fatalf("stage = %+v, want unknown/pending", stages[0])
	}
	if stages[0].At == "" {
		t.Fatal("at must fall back to the current time")
	}
	if stages[0].Error != nil {
		t.Fatalf("error = %+v, want nil", stages[0].Error)
	}
}

// TestStageErrorFromRaw covers the stored shapes: absent/null, an object with
// only a message, and a non-document truthy value.
func TestStageErrorFromRaw(t *testing.T) {
	if value := stageErrorFromRaw(bson.RawValue{}); value != nil {
		t.Fatalf("absent error = %+v", value)
	}
	if value := stageErrorFromRaw(bson.RawValue{Type: bson.TypeNull}); value != nil {
		t.Fatalf("null error = %+v", value)
	}

	withMessage := stageErrorFromRaw(rawValue(t, bson.D{{Key: "message", Value: "boom"}}))
	if withMessage == nil || withMessage.Message == nil || *withMessage.Message != "boom" {
		t.Fatalf("message = %+v", withMessage)
	}
	if withMessage.Name != nil {
		t.Fatalf("name = %v, want nil", *withMessage.Name)
	}
	// A truthy non-document value becomes the empty object NestJS serializes.
	if value := stageErrorFromRaw(rawValue(t, "boom")); value == nil || value.Name != nil || value.Message != nil {
		t.Fatalf("string error = %+v", value)
	}
}

// TestParseRunsQuery locks the parameter validation and its message.
func TestParseRunsQuery(t *testing.T) {
	request := func(query string) *http.Request {
		return httptest.NewRequest(http.MethodGet, "/api/admin/quality/pipeline/runs"+query, nil)
	}

	itemMetaID, limit, err := parseRunsQuery(request("?itemMetaId=%20item-1%20&limit=3.9"))
	if err != nil {
		t.Fatal(err)
	}
	if itemMetaID != "item-1" {
		t.Fatalf("itemMetaId = %q", itemMetaID)
	}
	if limit == nil || *limit != 3.9 {
		t.Fatalf("limit = %v", limit)
	}

	if _, _, err := parseRunsQuery(request("?itemMetaId=%20%20")); err == nil {
		t.Fatal("blank itemMetaId must be a 400")
	} else if status, message, ok := statusOf(err); !ok || status != 400 || message != "itemMetaId is required" {
		t.Fatalf("blank itemMetaId error = %v", err)
	}

	for _, query := range []string{
		"?itemMetaId=item-1",
		"?itemMetaId=item-1&limit=",
		"?itemMetaId=item-1&limit=abc",
		"?itemMetaId=item-1&limit=0x10",
	} {
		if _, limit, err := parseRunsQuery(request(query)); err != nil || limit != nil {
			t.Fatalf("%s limit = %v, err = %v; want nil error and no limit", query, limit, err)
		}
	}
}
