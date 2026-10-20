package crawltaskwrite

import (
	"testing"
)

func TestCreateInputFromGraphQL(t *testing.T) {
	args := map[string]any{
		"input": map[string]any{
			"url":           "https://example.com",
			"displayName":   "Graph task",
			"ingestToItems": true,
			"timeRange":     map[string]any{"from": "2026-01-01", "to": "2026-02-01"},
			"concurrency":   4,
			"keywords":      []any{" Climate ", "policy"},
			"options": map[string]any{
				"scanFullPage": true,
				"markdownFilter": map[string]any{
					"type":          "bm25",
					"userQuery":     " climate ",
					"language":      "en",
					"bm25Threshold": float64(1.25),
				},
				"multiUrlConfigs": []any{
					map[string]any{
						"name": "section",
						"urls": []any{"https://example.com/a"},
						"options": map[string]any{
							"jsOnly": true,
						},
					},
				},
				"virtualScroll": map[string]any{
					"scrollBy":    "viewport",
					"scrollCount": 3,
				},
			},
		},
	}
	input, err := createInputFromGraphQL(args)
	if err != nil {
		t.Fatalf("createInputFromGraphQL: %v", err)
	}
	if input.URL != "https://example.com" || input.DisplayName == nil || *input.DisplayName != "Graph task" {
		t.Fatalf("input = %#v", input)
	}
	if input.IngestToItems == nil || !*input.IngestToItems || input.Concurrency == nil || *input.Concurrency != 4 {
		t.Fatalf("input flags = %#v", input)
	}
	if input.TimeRangeFrom == nil || *input.TimeRangeFrom != "2026-01-01" ||
		input.TimeRangeTo == nil || *input.TimeRangeTo != "2026-02-01" {
		t.Fatalf("time range = %#v", input)
	}
	if len(input.Keywords) != 2 || input.Keywords[0] != " Climate " {
		t.Fatalf("keywords = %#v", input.Keywords)
	}
	if input.Options == nil || input.Options.MarkdownFilter == nil {
		t.Fatalf("options = %#v", input.Options)
	}
	if input.Options.MarkdownFilter.Type != "bm25" ||
		input.Options.MarkdownFilter.UserQuery == nil || *input.Options.MarkdownFilter.UserQuery != " climate " {
		t.Fatalf("filter = %#v", input.Options.MarkdownFilter)
	}
	if len(input.Options.MultiURLConfigs) != 1 ||
		input.Options.MultiURLConfigs[0].Options == nil ||
		input.Options.MultiURLConfigs[0].Options.JSOnly == nil ||
		!*input.Options.MultiURLConfigs[0].Options.JSOnly {
		t.Fatalf("multiUrlConfigs = %#v", input.Options.MultiURLConfigs)
	}
	if input.Options.VirtualScroll == nil || input.Options.VirtualScroll.ScrollCount == nil ||
		*input.Options.VirtualScroll.ScrollCount != 3 {
		t.Fatalf("virtualScroll = %#v", input.Options.VirtualScroll)
	}
	if len(input.RawOptions) == 0 {
		t.Fatal("RawOptions must be populated for the proxy policy")
	}
}

func TestCreateInputFromGraphQLRejectsConcurrencyBelowOne(t *testing.T) {
	_, err := createInputFromGraphQL(map[string]any{
		"input": map[string]any{"url": "https://example.com", "concurrency": 0},
	})
	if err == nil {
		t.Fatal("concurrency 0 must be rejected")
	}
	failure, ok := err.(*inputFailure)
	if !ok || failure.Error() != "concurrency must not be less than 1" {
		t.Fatalf("err = %v", err)
	}
}
