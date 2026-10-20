package itempipeline

import (
	"encoding/json"
	"testing"
)

func TestMergeOrderedJSONReproducesObjectSpread(t *testing.T) {
	base := json.RawMessage(`{"itemMetaId":"m1","rawItemId":"r1","orgId":"o1","traceId":"t1"}`)
	merged, err := mergeOrderedJSON(base, []orderedField{
		{Key: "originalQueue", Value: "itemPipeline"},
		{Key: "originalJobId", Value: "job-1"},
		{Key: "failedAt", Value: "2026-10-20T00:00:00.000Z"},
		{Key: "attempts", Value: 5},
		{Key: "attemptsMade", Value: 3},
		{Key: "errorKind", Value: "permanent"},
		{Key: "error", Value: SerializedQueueError{Name: "QueuePermanentError", Message: "missing orgId"}},
	})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(merged, &decoded); err != nil {
		t.Fatalf("decode merged: %v", err)
	}
	if string(decoded["originalQueue"]) != `"itemPipeline"` {
		t.Fatalf("originalQueue = %s", decoded["originalQueue"])
	}
	if string(decoded["attemptsMade"]) != "3" {
		t.Fatalf("attemptsMade = %s", decoded["attemptsMade"])
	}
	var serialized SerializedQueueError
	if err := json.Unmarshal(decoded["error"], &serialized); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if serialized.Name != "QueuePermanentError" || serialized.Message != "missing orgId" {
		t.Fatalf("serialized error = %+v", serialized)
	}
}

func TestMergeOrderedJSONKeepsOriginalKeyPosition(t *testing.T) {
	// Object spread keeps the first position when a later object overwrites a
	// key, so rawItemId stays second even though the field list renames it.
	base := json.RawMessage(`{"itemMetaId":"m1","rawItemId":"r1"}`)
	merged, err := mergeOrderedJSON(base, []orderedField{
		{Key: "originalJobId", Value: "job-1"},
		{Key: "rawItemId", Value: "r2"},
	})
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(merged, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(decoded["rawItemId"]) != `"r2"` {
		t.Fatalf("rawItemId = %s", decoded["rawItemId"])
	}
}

func TestMergeOrderedJSONRejectsNonObjectData(t *testing.T) {
	if _, err := mergeOrderedJSON(json.RawMessage(`"text"`), nil); err == nil {
		t.Fatal("non-object job data must fail")
	}
}
