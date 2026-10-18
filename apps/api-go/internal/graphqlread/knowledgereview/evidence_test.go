package knowledgereview

import (
	"encoding/json"
	"testing"
)

func TestWithReviewPreservesUnknownSiblings(t *testing.T) {
	previous := []byte(`{"extractor":"v3","kept":{"nested":true},"review":{"status":"approved"}}`)
	merged := withReview(previous, json.RawMessage(`{"status":"rejected","note":null}`))

	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(merged, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["extractor"]) != `"v3"` {
		t.Fatalf("extractor = %s", fields["extractor"])
	}
	if string(fields["kept"]) != `{"nested":true}` {
		t.Fatalf("kept = %s", fields["kept"])
	}
	if string(fields["review"]) != `{"status":"rejected","note":null}` {
		t.Fatalf("review = %s", fields["review"])
	}
}

func TestWithReviewOnMissingEvidenceStartsFromEmptyObject(t *testing.T) {
	merged := withReview(nil, json.RawMessage(`{"status":"approved"}`))
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(merged, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || string(fields["review"]) != `{"status":"approved"}` {
		t.Fatalf("merged = %s", merged)
	}
}

func TestMergeDuplicateEvidenceUsesDuplicateLeavesThenReview(t *testing.T) {
	previous := []byte(`{"title":"original","shared":"original","review":{"status":"approved"}}`)
	duplicate := []byte(`{"shared":"duplicate","extra":7,"review":{"status":"rejected"}}`)
	merged := mergeDuplicateEvidence(previous, duplicate, json.RawMessage(`{"status":"corrected"}`))

	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(merged, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["title"]) != `"original"` {
		t.Fatalf("title = %s", fields["title"])
	}
	if string(fields["shared"]) != `"duplicate"` {
		t.Fatalf("shared = %s", fields["shared"])
	}
	if string(fields["extra"]) != `7` {
		t.Fatalf("extra = %s", fields["extra"])
	}
	if string(fields["review"]) != `{"status":"corrected"}` {
		t.Fatalf("review = %s", fields["review"])
	}
}

func TestIsRejectedEvidenceRequiresTrimmedLiteral(t *testing.T) {
	cases := map[string]bool{
		`{"review":{"status":"rejected"}}`:   true,
		`{"review":{"status":" rejected "}}`: true,
		`{"review":{"status":"approved"}}`:   false,
		`{"review":{"status":"unknown"}}`:    false,
		`{"review":{"status":null}}`:         false,
		`{"review":"rejected"}`:              false,
		`{"review":["rejected"]}`:            false,
		`{}`:                                 false,
		`{"other":1}`:                        false,
		`[]`:                                 false,
		`null`:                               false,
		`not json`:                           false,
	}
	for raw, want := range cases {
		if got := isRejectedEvidence([]byte(raw)); got != want {
			t.Fatalf("isRejectedEvidence(%s) = %v want %v", raw, got, want)
		}
	}
}

func TestDurableRecordSource(t *testing.T) {
	cases := map[string]bool{
		`{"recordSource":"seed"}`:    true,
		`{"recordSource":"user"}`:    true,
		`{"recordSource":"derived"}`: true,
		`{"recordSource":"llm"}`:     false,
		`{"recordSource":"seed "}`:   false,
		`{"recordSource":null}`:      false,
		`{}`:                         false,
		`null`:                       false,
	}
	for raw, want := range cases {
		if got := durableRecordSource([]byte(raw)); got != want {
			t.Fatalf("durableRecordSource(%s) = %v want %v", raw, got, want)
		}
	}
}

func TestEdgePropertiesWithRecordSource(t *testing.T) {
	none := edgePropertiesWithRecordSource(nil)
	fields := map[string]any{}
	if err := json.Unmarshal(none, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields["recordSource"] != "user" {
		t.Fatalf("empty relation properties = %s", none)
	}

	withProps := edgePropertiesWithRecordSource(json.RawMessage(`{"weightHint":3,"recordSource":"llm"}`))
	if err := json.Unmarshal(withProps, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["weightHint"] != float64(3) {
		t.Fatalf("weightHint = %v", fields["weightHint"])
	}
	if fields["recordSource"] != "user" {
		t.Fatalf("recordSource = %v", fields["recordSource"])
	}
}
