package kgingestion

import (
	"encoding/json"
	"testing"
)

func TestNormalizeRelations(t *testing.T) {
	raw := json.RawMessage(`[
		{"subject":{"name":" Acme Corp ","type":"company"},
		 "predicate":" supplies ",
		 "object":{"name":"Beta","type":"company"},
		 "confidence":0.8,
		 "properties":{"region":"EU"},
		 "evidence":"  quote text  "},
		{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":-0.4},
		{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":7},
		{"subject":{"name":"A"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":0.9},
		{"subject":{"name":"A","type":"company"},"predicate":"","object":{"name":"B","type":"company"},"confidence":0.9},
		{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":"0.9"},
		{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":0.9,"properties":[1,2]},
		{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":0.9,"evidence":"   "}
	]`)

	relations := normalizeRelations(raw)
	if len(relations) != 5 {
		t.Fatalf("relations = %d, want 5", len(relations))
	}
	first := relations[0]
	if first.Subject.Name != "Acme Corp" || first.Predicate != "supplies" {
		t.Fatalf("first relation = %+v", first)
	}
	if first.Evidence == nil || *first.Evidence != "quote text" {
		t.Fatalf("evidence = %v", first.Evidence)
	}
	if string(first.Properties) != `{"region":"EU"}` {
		t.Fatalf("properties = %s", first.Properties)
	}
	if relations[1].Confidence != 0 || relations[2].Confidence != 1 {
		t.Fatalf("confidence clamp = %v, %v", relations[1].Confidence, relations[2].Confidence)
	}
	// The array-shaped properties leaf is dropped, not kept.
	if relations[3].Properties != nil {
		t.Fatalf("array properties = %s", relations[3].Properties)
	}
	if relations[4].Evidence != nil {
		t.Fatalf("blank evidence = %v", relations[4].Evidence)
	}
}

func TestNormalizeRelationsParsesStoredJSONString(t *testing.T) {
	inner := `[{"subject":{"name":"A","type":"company"},"predicate":"supplies","object":{"name":"B","type":"company"},"confidence":0.5}]`
	encoded, err := json.Marshal(inner)
	if err != nil {
		t.Fatal(err)
	}
	relations := normalizeRelations(encoded)
	if len(relations) != 1 {
		t.Fatalf("relations = %d, want 1", len(relations))
	}
}

func TestNormalizeRelationsRejectsGarbage(t *testing.T) {
	for _, raw := range []string{"", "null", `"not json"`, `{"a":1}`, `[1,2,3]`} {
		if relations := normalizeRelations(json.RawMessage(raw)); len(relations) != 0 {
			t.Fatalf("raw %q produced %d relations", raw, len(relations))
		}
	}
}

func TestComputeMinConfidenceThreshold(t *testing.T) {
	base := Settings{MinEdgeConfidence: 0.55, DynamicEdgeConfidenceEnabled: false}
	if got := computeMinConfidenceThreshold([]float64{0.1, 0.9}, base); got != 0.55 {
		t.Fatalf("static threshold = %v", got)
	}

	dynamic := Settings{
		MinEdgeConfidence:             0.55,
		DynamicEdgeConfidenceEnabled:  true,
		DynamicEdgeConfidenceQuantile: 0.25,
	}
	confidences := []float64{0.9, 0.3, 0.5, 0.1}
	// floor((4-1)*0.25) = 0 -> 0.1, below the 0.55 base.
	if got := computeMinConfidenceThreshold(confidences, dynamic); got != 0.55 {
		t.Fatalf("dynamic threshold = %v", got)
	}

	highQuantile := dynamic
	highQuantile.DynamicEdgeConfidenceQuantile = 1
	// (4-1)*1 = 3 -> 0.9.
	if got := computeMinConfidenceThreshold(confidences, highQuantile); got != 0.9 {
		t.Fatalf("quantile threshold = %v", got)
	}

	empty := dynamic
	if got := computeMinConfidenceThreshold(nil, empty); got != 0.55 {
		t.Fatalf("empty threshold = %v", got)
	}
}
