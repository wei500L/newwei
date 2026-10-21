package newspipeline

// Table-driven equivalence tests for NormalizedNewsPayloadSchema and
// CleanedNewsSchema. They pin the Zod semantics the pipeline depends on: trim
// rules, preprocessing, defaults, null/optional handling, min/max constraints,
// enum normalization and the permanent "ZodError" classification.

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeTestJSON(t *testing.T, raw string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(raw)) {
		t.Fatalf("invalid test JSON: %s", raw)
	}
	return json.RawMessage(raw)
}

func TestNormalizePayloadURL(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantURL string
		wantErr string
	}{
		{name: "missing url", raw: `{}`, wantErr: "Required"},
		{name: "null url", raw: `{"url":null}`, wantErr: "Expected string, received null"},
		{name: "number url", raw: `{"url":42}`, wantErr: "Expected string, received number"},
		{name: "empty url", raw: `{"url":""}`, wantErr: "url is required"},
		{name: "whitespace url", raw: `{"url":"   "}`, wantErr: "url is required"},
		{name: "trimmed url", raw: `{"url":"  https://example.com/a  "}`, wantURL: "https://example.com/a"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := NormalizePayload(decodeTestJSON(t, test.raw))
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("want error containing %q, got %v", test.wantErr, err)
				}
				if !isParseError(err) {
					t.Fatalf("want *ParseError, got %T", err)
				}
				if name := err.(*ParseError).Name(); name != "ZodError" {
					t.Fatalf("want Name() ZodError, got %q", name)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if payload.URL != test.wantURL {
				t.Fatalf("url = %q, want %q", payload.URL, test.wantURL)
			}
		})
	}
}

func TestNormalizePayloadDefaultsAndTrimming(t *testing.T) {
	raw := `{
		"url": "https://example.com/x",
		"language": "  zh  ",
		"sourceName": null,
		"keywords": ["  ai ", "", "chips"],
		"tags": "not-an-array",
		"summaryHints": ["  hint  ", ""],
		"unknownKey": true
	}`
	payload, err := NormalizePayload(decodeTestJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payload.Language == nil || *payload.Language != "zh" {
		t.Fatalf("language = %v, want zh", payload.Language)
	}
	if payload.SourceName != nil {
		t.Fatalf("sourceName = %v, want nil", *payload.SourceName)
	}
	if strings.Join(payload.Keywords, ",") != "ai,chips" {
		t.Fatalf("keywords = %v", payload.Keywords)
	}
	if payload.Tags == nil || len(payload.Tags) != 0 {
		t.Fatalf("tags = %v, want empty non-nil", payload.Tags)
	}
	if strings.Join(payload.SummaryHints, ",") != "hint" {
		t.Fatalf("summaryHints = %v", payload.SummaryHints)
	}
	if string(payload.Metadata) != "{}" {
		t.Fatalf("metadata = %s, want {}", payload.Metadata)
	}
	if payload.Prefetched != nil || payload.CrawlOptions != nil {
		t.Fatalf("optional members should stay nil")
	}
	if payload.ForceRefresh {
		t.Fatalf("forceRefresh default should be false")
	}
}

func TestNormalizePayloadStringListRejectsNonStrings(t *testing.T) {
	for _, raw := range []string{
		`{"url":"https://x","keywords":[1]}`,
		`{"url":"https://x","tags":[null]}`,
		`{"url":"https://x","summaryHints":[true]}`,
	} {
		if _, err := NormalizePayload(decodeTestJSON(t, raw)); err == nil || !strings.Contains(err.Error(), "Expected string") {
			t.Fatalf("%s: want string type error, got %v", raw, err)
		}
	}
}

func TestNormalizePayloadMetadataAndCrawlOptions(t *testing.T) {
	raw := `{
		"url": "https://example.com/x",
		"metadata": {"sourceId":"s","nested":{"a":1}},
		"crawlOptions": {"scanFullPage":false,"unknown":1}
	}`
	payload, err := NormalizePayload(decodeTestJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(payload.Metadata, &metadata); err != nil {
		t.Fatalf("metadata is not JSON: %v", err)
	}
	if metadata["sourceId"] != "s" {
		t.Fatalf("metadata lost unknown members: %v", metadata)
	}
	var crawlOptions map[string]any
	if err := json.Unmarshal(payload.CrawlOptions, &crawlOptions); err != nil {
		t.Fatalf("crawlOptions is not JSON: %v", err)
	}
	if crawlOptions["scanFullPage"] != false || crawlOptions["unknown"] != float64(1) {
		t.Fatalf("crawlOptions catchall members lost: %v", crawlOptions)
	}
}

func TestNormalizePayloadPrefetchedArticle(t *testing.T) {
	raw := `{
		"url": "https://example.com/x",
		"prefetchedArticle": {
			"title": "  Title  ",
			"markdown": "",
			"publishedAt": "2024-01-02T03:04:05",
			"metadata": {"k":"v"},
			"unknown": "stripped"
		}
	}`
	payload, err := NormalizePayload(decodeTestJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if payload.Prefetched == nil {
		t.Fatal("prefetchedArticle missing")
	}
	if payload.Prefetched.Title == nil || *payload.Prefetched.Title != "Title" {
		t.Fatalf("title = %v", payload.Prefetched.Title)
	}
	if payload.Prefetched.Markdown != nil {
		t.Fatalf("blank markdown should normalize to nil")
	}
	if payload.Prefetched.PublishedAt == nil || *payload.Prefetched.PublishedAt != "2024-01-02T03:04:05.000Z" {
		t.Fatalf("publishedAt = %v", payload.Prefetched.PublishedAt)
	}
	if string(payload.Prefetched.Metadata) != `{"k":"v"}` {
		t.Fatalf("metadata = %s", payload.Prefetched.Metadata)
	}

	if _, err := NormalizePayload(decodeTestJSON(t, `{"url":"https://x","prefetchedArticle":null}`)); err == nil {
		t.Fatal("null prefetchedArticle must fail the parse")
	}
}

func TestNormalizePayloadForceRefreshCoercion(t *testing.T) {
	tests := []struct {
		raw  string
		want bool
	}{
		{raw: `{"url":"https://x"}`, want: false},
		{raw: `{"url":"https://x","forceRefresh":true}`, want: true},
		{raw: `{"url":"https://x","forceRefresh":false}`, want: false},
		{raw: `{"url":"https://x","forceRefresh":"false"}`, want: true},
		{raw: `{"url":"https://x","forceRefresh":0}`, want: false},
		{raw: `{"url":"https://x","forceRefresh":2}`, want: true},
		{raw: `{"url":"https://x","forceRefresh":null}`, want: false},
		{raw: `{"url":"https://x","forceRefresh":[]}`, want: true},
		{raw: `{"url":"https://x","forceRefresh":{}}`, want: true},
	}
	for _, test := range tests {
		payload, err := NormalizePayload(decodeTestJSON(t, test.raw))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", test.raw, err)
		}
		if payload.ForceRefresh != test.want {
			t.Fatalf("%s: forceRefresh = %v, want %v", test.raw, payload.ForceRefresh, test.want)
		}
	}
}

func TestParseCleanedNewsDefaultsAndArrays(t *testing.T) {
	cleaned, err := ParseCleanedNews(decodeTestJSON(t, `{"cleaned_markdown":"body"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cleaned.CleanedMarkdown != "body" {
		t.Fatalf("cleaned_markdown = %q", cleaned.CleanedMarkdown)
	}
	for name, array := range map[string][]string{
		"category_labels":     cleaned.CategoryLabels,
		"topics":              cleaned.Topics,
		"key_points":          cleaned.KeyPoints,
		"removed_noise_types": cleaned.RemovedNoiseTypes,
	} {
		if array == nil || len(array) != 0 {
			t.Fatalf("%s = %v, want empty non-nil", name, array)
		}
	}
	if cleaned.CategoryCandidates == nil || cleaned.Entities == nil || cleaned.KGRelations == nil {
		t.Fatalf("array defaults must be non-nil: candidates=%v entities=%v kg=%v",
			cleaned.CategoryCandidates, cleaned.Entities, cleaned.KGRelations)
	}
	if cleaned.Title != nil || cleaned.StageMeta != nil || cleaned.CleanedMarkdownSource != nil {
		t.Fatalf("absent nullable members must stay nil")
	}
}

func TestParseCleanedNewsErrors(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "not an object", raw: `null`, want: "Expected object, received null"},
		{name: "missing markdown", raw: `{}`, want: "Required"},
		{name: "empty markdown", raw: `{"cleaned_markdown":""}`, want: "String must contain at least 1 character(s)"},
		{name: "non-string markdown", raw: `{"cleaned_markdown":1}`, want: "Expected string, received number"},
		{name: "topics with non-string", raw: `{"cleaned_markdown":"b","topics":[1]}`, want: "Expected string, received number"},
		{name: "topics with empty", raw: `{"cleaned_markdown":"b","topics":[""]}`, want: "String must contain at least 1 character(s)"},
		{name: "null array", raw: `{"cleaned_markdown":"b","topics":null}`, want: "Expected array, received null"},
		{name: "confidence out of range", raw: `{"cleaned_markdown":"b","quality_score":2}`, want: "Number must be less than or equal to 1"},
		{name: "confidence negative", raw: `{"cleaned_markdown":"b","category_confidence":-1}`, want: "Number must be greater than or equal to 0"},
		{name: "null stage meta", raw: `{"cleaned_markdown":"b","stage_meta":null}`, want: "Expected object, received null"},
		{name: "stage meta bad status", raw: `{"cleaned_markdown":"b","stage_meta":{"clean":{"status":"done"}}}`, want: "Invalid enum value"},
		{name: "stage meta missing status", raw: `{"cleaned_markdown":"b","stage_meta":{"clean":{}}}`, want: "Required"},
		{name: "entity confidence missing", raw: `{"cleaned_markdown":"b","entities":[{"name":"n","type":"t"}]}`, want: "Required"},
		{name: "kg bad confidence", raw: `{"cleaned_markdown":"b","kg_relations":[{"subject":{"name":"a","type":"t"},"predicate":"p","object":{"name":"b","type":"t"},"confidence":2}]}`, want: "Number must be less than or equal to 1"},
		{name: "title wrong type", raw: `{"cleaned_markdown":"b","title":1}`, want: "Expected string, received number"},
		{name: "sentiment wrong type", raw: `{"cleaned_markdown":"b","sentiment":1}`, want: "Invalid input"},
		{name: "published_at wrong type", raw: `{"cleaned_markdown":"b","published_at":1}`, want: "Invalid input"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseCleanedNews(decodeTestJSON(t, test.raw))
			if err == nil {
				t.Fatalf("want error containing %q", test.want)
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %q, want containing %q", err.Error(), test.want)
			}
			if !isParseError(err) {
				t.Fatalf("want *ParseError, got %T", err)
			}
		})
	}
}

func TestParseCleanedNewsSentimentNormalization(t *testing.T) {
	tests := []struct {
		raw  string
		want *string
	}{
		{raw: `"POSITIVE"`, want: stringPointer("positive")},
		{raw: `"pos"`, want: stringPointer("positive")},
		{raw: `"positive-ish"`, want: stringPointer("positive")},
		{raw: `"利好"`, want: stringPointer("positive")},
		{raw: `"负面消息"`, want: stringPointer("negative")},
		{raw: `"NEG"`, want: stringPointer("negative")},
		{raw: `"中立"`, want: stringPointer("neutral")},
		{raw: `"Neu"`, want: stringPointer("neutral")},
		{raw: `"Mixed"`, want: stringPointer("mixed")},
		{raw: `""`, want: nil},
		{raw: `"   "`, want: nil},
		{raw: `null`, want: nil},
	}
	for _, test := range tests {
		cleaned, err := ParseCleanedNews(decodeTestJSON(t, `{"cleaned_markdown":"b","sentiment":`+test.raw+`}`))
		if err != nil {
			t.Fatalf("%s: unexpected error %v", test.raw, err)
		}
		got := cleaned.Sentiment
		if (got == nil) != (test.want == nil) || (got != nil && *got != *test.want) {
			t.Fatalf("sentiment %s = %v, want %v", test.raw, derefOrNil(got), derefOrNil(test.want))
		}
	}
}

func derefOrNil(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func TestParseCleanedNewsContentTypeAndPublishedAt(t *testing.T) {
	cleaned, err := ParseCleanedNews(decodeTestJSON(t, `{
		"cleaned_markdown":"b",
		"content_type":" News-Fact ",
		"published_at":"2024-01-02",
		"cleaned_markdown_source":" llm "
	}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cleaned.ContentType == nil || *cleaned.ContentType != "news_fact" {
		t.Fatalf("content_type = %v", derefOrNil(cleaned.ContentType))
	}
	if cleaned.PublishedAt == nil || *cleaned.PublishedAt != "2024-01-02T00:00:00.000Z" {
		t.Fatalf("published_at = %v", derefOrNil(cleaned.PublishedAt))
	}
	if cleaned.CleanedMarkdownSource == nil || *cleaned.CleanedMarkdownSource != "llm" {
		t.Fatalf("cleaned_markdown_source = %v", derefOrNil(cleaned.CleanedMarkdownSource))
	}

	cleaned, err = ParseCleanedNews(decodeTestJSON(t, `{
		"cleaned_markdown":"b",
		"content_type":"something-else",
		"published_at":"not-a-date",
		"cleaned_markdown_source":"other"
	}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cleaned.ContentType != nil {
		t.Fatalf("unknown content type should be nil, got %q", *cleaned.ContentType)
	}
	if cleaned.PublishedAt != nil {
		t.Fatalf("unparseable published_at should be nil")
	}
	if cleaned.CleanedMarkdownSource != nil {
		t.Fatalf("unknown markdown source should be nil")
	}
}

func TestParseCleanedNewsStageMetaAndStripping(t *testing.T) {
	raw := `{
		"cleaned_markdown": "b",
		"unknown_member": true,
		"stage_meta": {
			"preflight": {"status":"completed","provider":"llm","unknown_entry_key":1},
			"clean": {"status":"skipped","reason":"too short","prompt_tokens":1.5},
			"unknown_stage": {"status":"completed"}
		},
		"entities": [{"name":"Acme","type":"company","confidence":0.9,"extra":1}]
	}`
	cleaned, err := ParseCleanedNews(decodeTestJSON(t, raw))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cleaned.StageMeta == nil || cleaned.StageMeta.Preflight == nil || cleaned.StageMeta.Clean == nil {
		t.Fatalf("stage_meta entries missing: %#v", cleaned.StageMeta)
	}
	if cleaned.StageMeta.Preflight.Status != "completed" {
		t.Fatalf("status = %q", cleaned.StageMeta.Preflight.Status)
	}
	if cleaned.StageMeta.Preflight.Provider == nil || *cleaned.StageMeta.Preflight.Provider != "llm" {
		t.Fatalf("provider = %v", derefOrNil(cleaned.StageMeta.Preflight.Provider))
	}
	if cleaned.StageMeta.Preflight.Reason != nil {
		t.Fatalf("reason should be null")
	}
	if cleaned.StageMeta.Clean.PromptTokens == nil || *cleaned.StageMeta.Clean.PromptTokens != 1.5 {
		t.Fatalf("prompt_tokens = %v", cleaned.StageMeta.Clean.PromptTokens)
	}
	if cleaned.StageMeta.Entities != nil {
		t.Fatalf("absent stage entries must stay nil")
	}

	encoded, err := json.Marshal(cleaned)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := document["unknown_member"]; present {
		t.Fatalf("unknown top-level member must be stripped: %s", encoded)
	}
	entities, _ := document["entities"].([]any)
	entity, _ := entities[0].(map[string]any)
	if _, present := entity["extra"]; present {
		t.Fatalf("unknown nested member must be stripped: %s", encoded)
	}
	stageMeta, _ := document["stage_meta"].(map[string]any)
	if _, present := stageMeta["unknown_stage"]; present {
		t.Fatalf("unknown stage key must be stripped: %s", encoded)
	}
	preflight, _ := stageMeta["preflight"].(map[string]any)
	if _, present := preflight["unknown_entry_key"]; present {
		t.Fatalf("unknown stage entry key must be stripped: %s", encoded)
	}
}

func TestParseCleanedNewsNullableMembersAndNulls(t *testing.T) {
	cleaned, err := ParseCleanedNews(decodeTestJSON(t, `{
		"cleaned_markdown":"b",
		"title":null,
		"author":"  spaced  ",
		"category_labels":["a"," "],
		"kg_relations":[{
			"subject":{"name":"a","type":"t"},
			"predicate":"p",
			"object":{"name":"b","type":"t"},
			"confidence":0,
			"properties":{"q":1},
			"evidence":null
		}]
	}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cleaned.Title != nil {
		t.Fatalf("title should be nil")
	}
	if cleaned.Author == nil || *cleaned.Author != "  spaced  " {
		t.Fatalf("plain nullable strings are not trimmed by the schema: %v", derefOrNil(cleaned.Author))
	}
	if len(cleaned.CategoryLabels) != 2 || cleaned.CategoryLabels[1] != " " {
		t.Fatalf("category_labels must keep a single-space entry: %v", cleaned.CategoryLabels)
	}
	if len(cleaned.KGRelations) != 1 {
		t.Fatalf("kg_relations = %v", cleaned.KGRelations)
	}
	relation := cleaned.KGRelations[0]
	if string(relation.Properties) != `{"q":1}` {
		t.Fatalf("properties = %s", relation.Properties)
	}
	if relation.Evidence != nil {
		t.Fatalf("evidence should be nil")
	}
}
