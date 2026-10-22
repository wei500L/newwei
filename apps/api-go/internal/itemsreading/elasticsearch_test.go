package itemsreading

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestExtractHighlightsPreservesResponseOrder pins the highlight contract of the
// items connection: the field order is the order of the Elasticsearch response
// object, because NestJS renders Object.entries(hit.highlight) directly as the
// ordered GraphQL searchHighlights list. The previous map-based port reordered
// the same hit on every request.
func TestExtractHighlightsPreservesResponseOrder(t *testing.T) {
	raw := json.RawMessage(`{
		"searchText": ["s-1", "s-2", "s-3", "s-4"],
		"title": ["t-1"],
		"entities": ["e-1"]
	}`)
	got := extractHighlights(raw)
	want := []ItemSearchHighlight{
		{Field: "searchText", Snippets: []string{"s-1", "s-2", "s-3"}},
		{Field: "title", Snippets: []string{"t-1"}},
		{Field: "entities", Snippets: []string{"e-1"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("extractHighlights() = %+v, want %+v", got, want)
	}
	// A second call of the same input must return the identical order: the
	// response contract cannot depend on map iteration order.
	if again := extractHighlights(raw); !reflect.DeepEqual(again, want) {
		t.Fatalf("extractHighlights() is not deterministic: %+v", again)
	}
}

// TestExtractHighlightsSkipsUnusableFields documents the NestJS guards: a
// non-object block is empty, a non-array field is skipped, non-string snippets
// are dropped before the three-snippet cut, and empty fields never appear.
func TestExtractHighlightsSkipsUnusableFields(t *testing.T) {
	if got := extractHighlights(nil); got != nil {
		t.Fatalf("empty block = %+v, want nil", got)
	}
	if got := extractHighlights(json.RawMessage(`[]`)); got != nil {
		t.Fatalf("array block = %+v, want nil", got)
	}
	got := extractHighlights(json.RawMessage(`{
		"title": "not-an-array",
		"summary": [1, "kept", 2, "second", "third", "fourth"],
		"topics": [7]
	}`))
	want := []ItemSearchHighlight{
		{Field: "summary", Snippets: []string{"kept", "second", "third"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("extractHighlights() = %+v, want %+v", got, want)
	}
}
