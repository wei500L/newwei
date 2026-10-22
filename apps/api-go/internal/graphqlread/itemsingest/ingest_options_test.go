package itemsingestgraphql

import (
	"encoding/json"
	"testing"
)

// TestParseIngestBatchOptionsReadsAllCoercedIntShapes pins the root-argument
// parsing of ingestCrawlTaskResultsToItems. The executor passes coerced GraphQL
// values, so an Int argument is int64 for an inline literal and for a JSON
// request variable (the HTTP decoder keeps json.Number and gqlparser narrows it
// to int64), but float64 for a variable in a GET query string. Every numeric
// shape the executor can produce must reach IngestBatchOptions.Limit; a missing
// or explicitly null argument must leave it unset so the service keeps its
// default page size.
func TestParseIngestBatchOptionsReadsAllCoercedIntShapes(t *testing.T) {
	cases := []struct {
		name      string
		args      map[string]any
		wantLimit *float64
	}{
		{
			name:      "inline int literal is int64",
			args:      map[string]any{"limit": int64(37)},
			wantLimit: floatPtr(37),
		},
		{
			name:      "json number variable before coercion",
			args:      map[string]any{"limit": json.Number("12")},
			wantLimit: floatPtr(12),
		},
		{
			name:      "get query string variable is float64",
			args:      map[string]any{"limit": float64(7)},
			wantLimit: floatPtr(7),
		},
		{
			name:      "int value",
			args:      map[string]any{"limit": 200},
			wantLimit: floatPtr(200),
		},
		{
			name:      "missing limit keeps the service default",
			args:      map[string]any{"taskId": "task-1"},
			wantLimit: nil,
		},
		{
			name:      "explicit null limit keeps the service default",
			args:      map[string]any{"limit": nil},
			wantLimit: nil,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			options := parseIngestBatchOptions(testCase.args)
			if testCase.wantLimit == nil {
				if options.Limit != nil {
					t.Fatalf("limit = %v, want unset", *options.Limit)
				}
				return
			}
			if options.Limit == nil {
				t.Fatalf("limit was not set")
			}
			if *options.Limit != *testCase.wantLimit {
				t.Fatalf("limit = %v, want %v", *options.Limit, *testCase.wantLimit)
			}
		})
	}
}

// TestParseIngestBatchOptionsKeepsAfterAndOnlyMissing checks the two
// non-numeric arguments stay wired: a present string and a present false
// boolean must both be forwarded, because onlyMissing defaults to true in the
// service.
func TestParseIngestBatchOptionsKeepsAfterAndOnlyMissing(t *testing.T) {
	options := parseIngestBatchOptions(map[string]any{
		"after":       "cursor-1",
		"onlyMissing": false,
	})
	if options.After == nil || *options.After != "cursor-1" {
		t.Fatalf("after = %v", options.After)
	}
	if options.OnlyMissing == nil || *options.OnlyMissing {
		t.Fatalf("onlyMissing = %v, want false", options.OnlyMissing)
	}

	empty := parseIngestBatchOptions(map[string]any{})
	if empty.After != nil || empty.OnlyMissing != nil {
		t.Fatalf("absent arguments must stay unset: %+v", empty)
	}
}

func floatPtr(value float64) *float64 {
	return &value
}
