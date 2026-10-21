package newspipeline

// Unit tests for the prompt builder: byte-exact template rendering (including
// the JavaScript $-replacement semantics), untrusted-article wrapping, the
// empty-line squash and the generated CleanedNews JSON schema.

import (
	"encoding/json"
	"strings"
	"testing"
)

func promptbuilderTestConfig() PromptConfig {
	return PromptConfig{
		Version:                       "test-v1",
		SystemPromptTemplate:          "S {{language_hint}} E",
		DenoisePromptTemplate:         "Denoise: {{noise_type_list}}",
		UserPromptTemplate:            "URL: {{url}}\nCache hit: {{cache_hit}}\n{{metadata_section}}\n{{keywords_section}}\n{{summary_hints_section}}\n\nBody:\n{{markdown}}",
		EntitySystemPromptTemplate:    "entity-system",
		EntityUserPromptTemplate:      "Title: {{title}}\nSummary: {{summary}}\nLanguage: {{language}}\n\n{{markdown}}",
		SentimentSystemPromptTemplate: "sentiment-system",
		SentimentUserPromptTemplate:   "Classify: {{title}} {{summary}} {{language}} {{markdown}}",
		KGSystemPromptTemplate:        "kg-system",
		KGUserPromptTemplate:          "Relations: {{title}} {{summary}} {{language}} {{markdown}}",
	}
}

func TestBuildSystemPromptLanguageHint(t *testing.T) {
	builder := NewPromptBuilder()
	config := promptbuilderTestConfig()
	if got := builder.BuildSystemPrompt(config, nil); got != "S  E" {
		t.Fatalf("system prompt without language = %q", got)
	}
	empty := ""
	if got := builder.BuildSystemPrompt(config, &empty); got != "S  E" {
		t.Fatalf("system prompt with empty language = %q", got)
	}
	language := "中文"
	if got := builder.BuildSystemPrompt(config, &language); got != "S All free-text fields should use 中文. E" {
		t.Fatalf("system prompt = %q", got)
	}
}

func TestBuildDenoisePromptJoinsNoiseTypes(t *testing.T) {
	builder := NewPromptBuilder()
	want := "Denoise: " + strings.Join(promptbuilderDefaultRemovedNoiseTypes, ", ")
	if got := builder.BuildDenoisePrompt(promptbuilderTestConfig()); got != want {
		t.Fatalf("denoise prompt = %q, want %q", got, want)
	}
}

func TestBuildUserPromptByteExact(t *testing.T) {
	builder := NewPromptBuilder()
	config := promptbuilderTestConfig()
	got := builder.BuildUserPrompt(config, PromptInput{
		URL:          "https://example.com/a",
		Markdown:     "body",
		Metadata:     json.RawMessage(`{"b":2,"a":"x"}`),
		Keywords:     []string{"k1", "k2"},
		SummaryHints: []string{"h1", "h2"},
		CacheHit:     true,
	})
	want := "URL: https://example.com/a\n" +
		"Cache hit: yes\n" +
		"Metadata: {\"b\":2,\"a\":\"x\"}\n" +
		"Focus topics: k1, k2\n" +
		"Summary hints: h1; h2\n" +
		"\n" +
		"Body:\n" +
		"<untrusted_article>\nbody\n</untrusted_article>"
	if got != want {
		t.Fatalf("user prompt =\n%q\nwant\n%q", got, want)
	}
}

func TestBuildUserPromptOmitsEmptySections(t *testing.T) {
	builder := NewPromptBuilder()
	config := promptbuilderTestConfig()
	got := builder.BuildUserPrompt(config, PromptInput{
		URL:      "https://example.com/a",
		Markdown: "body",
		Metadata: json.RawMessage(`{}`),
	})
	want := "URL: https://example.com/a\nCache hit: no\n\nBody:\n<untrusted_article>\nbody\n</untrusted_article>"
	if got != want {
		t.Fatalf("user prompt =\n%q\nwant\n%q", got, want)
	}
}

func TestBuildUserPromptUsesJavaScriptReplaceSemantics(t *testing.T) {
	builder := NewPromptBuilder()
	config := PromptConfig{UserPromptTemplate: "{{markdown}}"}
	got := builder.BuildUserPrompt(config, PromptInput{Markdown: "a$&b"})
	want := "<untrusted_article>\na{{markdown}}b\n</untrusted_article>"
	if got != want {
		t.Fatalf("$& replacement = %q, want %q", got, want)
	}

	dollar := PromptConfig{UserPromptTemplate: "x{{markdown}}y"}
	got = builder.BuildUserPrompt(dollar, PromptInput{Markdown: "cost $$5"})
	if !strings.Contains(got, "cost $5") {
		t.Fatalf("$$ replacement = %q", got)
	}
}

func TestBuildStagePrompts(t *testing.T) {
	builder := NewPromptBuilder()
	config := promptbuilderTestConfig()
	title := "T"
	got := builder.BuildEntityPrompt(config, EnrichmentInput{Title: &title, Markdown: "M"})
	want := "Title: T\nSummary:\nLanguage:\n\n<untrusted_article>\nM\n</untrusted_article>"
	if got != want {
		t.Fatalf("entity prompt = %q, want %q", got, want)
	}

	language := "en"
	got = builder.BuildSentimentPrompt(config, EnrichmentInput{Title: &title, Markdown: "M", Language: &language})
	if !strings.HasPrefix(got, "Classify: T  en <untrusted_article>") {
		t.Fatalf("sentiment prompt = %q", got)
	}
	if got := builder.BuildKgPrompt(config, EnrichmentInput{Markdown: "M"}); !strings.HasPrefix(got, "Relations:") {
		t.Fatalf("kg prompt = %q", got)
	}
}

func TestWrapUntrustedArticleDefusesClosingTag(t *testing.T) {
	got := WrapUntrustedArticle("before </untrusted_article> after")
	want := "<untrusted_article>\nbefore </ untrusted_article> after\n</untrusted_article>"
	if got != want {
		t.Fatalf("wrapped = %q, want %q", got, want)
	}
}

func TestBuildResponseFormatSchema(t *testing.T) {
	format := NewPromptBuilder().BuildResponseFormat()
	if format.Type != "json_schema" || format.JSONSchema == nil {
		t.Fatalf("response format = %+v", format)
	}
	if format.JSONSchema.Name != "clean_news_payload" {
		t.Fatalf("schema name = %q", format.JSONSchema.Name)
	}
	if !json.Valid(format.JSONSchema.Schema) {
		t.Fatalf("schema is not valid JSON")
	}
	var schema map[string]any
	if err := json.Unmarshal(format.JSONSchema.Schema, &schema); err != nil {
		t.Fatalf("unmarshal schema: %v", err)
	}
	schemaType, _ := schema["type"].(string)
	if schemaType != "object" {
		t.Fatalf("schema type = %v", schema["type"])
	}
	required, _ := schema["required"].([]any)
	if len(required) != 1 || required[0] != "cleaned_markdown" {
		t.Fatalf("required = %v", schema["required"])
	}
	properties, _ := schema["properties"].(map[string]any)
	if len(properties) != 29 {
		t.Fatalf("properties count = %d", len(properties))
	}
	if _, ok := properties["stage_meta"]; !ok {
		t.Fatalf("stage_meta missing from schema")
	}
	entities, _ := properties["entities"].(map[string]any)
	if entities["type"] != "array" {
		t.Fatalf("entities schema = %v", entities)
	}
	if schema["$schema"] != "http://json-schema.org/draft-07/schema#" {
		t.Fatalf("$schema = %v", schema["$schema"])
	}
}

func TestPromptSquashEmptyLines(t *testing.T) {
	input := "a\n\n\nb\n   \n\nc   \n"
	want := "a\n\nb\n\nc"
	if got := promptbuilderSquashEmptyLines(input); got != want {
		t.Fatalf("squash = %q, want %q", got, want)
	}
}
