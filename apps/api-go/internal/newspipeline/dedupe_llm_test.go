package newspipeline

// Tests for dedupe_llm.go: byte-exact dedupe judge prompt templates, template
// rendering/squashing and the judge response parser + response format.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDefaultDedupePromptTemplatesByteExact(t *testing.T) {
	if got := templateSHA256(DefaultNewsDedupeSystemPromptTemplate); got != "33b20c6fdc140e995216c985879b542dfd1aa8139f6f8e64b819d3c55c6cebd0" {
		t.Fatalf("dedupe system template hash = %s", got)
	}
	if got := templateSHA256(DefaultNewsDedupeUserPromptTemplate); got != "5e255be3cb9bf1b3dfd7050c235f0d81fbe823950a25002d7be196d7ad7ecc84" {
		t.Fatalf("dedupe user template hash = %s", got)
	}
	if DefaultNewsDedupePromptVersion != "news-dedupe-judge-v1" {
		t.Fatalf("prompt version = %q", DefaultNewsDedupePromptVersion)
	}
}

func TestBuildNewsDedupeSystemPrompt(t *testing.T) {
	rendered := buildNewsDedupeSystemPrompt(nil, nil, nil)
	if strings.Contains(rendered, "{{") {
		t.Fatalf("unrendered placeholder left in default system prompt: %q", rendered)
	}
	if !strings.Contains(rendered, "Output MUST be valid JSON matching the required schema.") {
		t.Fatalf("default system prompt lost its tail: %q", rendered)
	}
	if !strings.HasPrefix(rendered, "You are a strict news deduplication judge.") {
		t.Fatalf("default system prompt start = %q", rendered)
	}

	withLanguage := buildNewsDedupeSystemPrompt(stringPointer("zh-CN"), nil, nil)
	if !strings.Contains(withLanguage, "Rationale should be written in zh-CN.") {
		t.Fatalf("language hint missing: %q", withLanguage)
	}

	withInstructions := buildNewsDedupeSystemPrompt(nil, stringPointer("  be strict  "), nil)
	if !strings.Contains(withInstructions, "Additional admin instructions: be strict") {
		t.Fatalf("instructions hint missing: %q", withInstructions)
	}

	emptyLanguage := buildNewsDedupeSystemPrompt(stringPointer(""), stringPointer("   "), nil)
	if strings.Contains(emptyLanguage, "Rationale should be written in .") ||
		strings.Contains(emptyLanguage, "Additional admin instructions:") {
		t.Fatalf("blank language/instructions must be omitted: %q", emptyLanguage)
	}

	custom := buildNewsDedupeSystemPrompt(nil, nil, stringPointer("  A {{language_hint}} B  "))
	if custom != "A  B" {
		t.Fatalf("custom template = %q, want %q", custom, "A  B")
	}
}

func TestBuildNewsDedupeUserPrompt(t *testing.T) {
	withoutTitles := buildNewsDedupeUserPrompt(DedupeJudgePromptInput{
		Threshold: 0.9,
		SummaryA:  "Summary A text",
		SummaryB:  "Summary B text",
	}, nil)
	wantWithoutTitles := `Judge whether the following two summaries are duplicates.
Duplicate threshold: 0.90 (higher = stricter).

Summary A:
Summary A text

Summary B:
Summary B text

Return JSON only with:
- similarity: number in [0, 1] (1 = identical event, 0 = unrelated)
- is_duplicate: boolean (true if similarity >= threshold AND same event)
- rationale: short explanation (optional)`
	if withoutTitles != wantWithoutTitles {
		t.Fatalf("user prompt without titles:\n got %q\nwant %q", withoutTitles, wantWithoutTitles)
	}

	withTitles := buildNewsDedupeUserPrompt(DedupeJudgePromptInput{
		Threshold: 0.9,
		SummaryA:  "Summary A text",
		SummaryB:  "Summary B text",
		TitleA:    stringPointer("  ta  "),
		TitleB:    stringPointer("tb"),
	}, nil)
	wantWithTitles := `Judge whether the following two summaries are duplicates.
Duplicate threshold: 0.90 (higher = stricter).

Title A: ta
Summary A:
Summary A text

Title B: tb
Summary B:
Summary B text

Return JSON only with:
- similarity: number in [0, 1] (1 = identical event, 0 = unrelated)
- is_duplicate: boolean (true if similarity >= threshold AND same event)
- rationale: short explanation (optional)`
	if withTitles != wantWithTitles {
		t.Fatalf("user prompt with titles:\n got %q\nwant %q", withTitles, wantWithTitles)
	}

	custom := buildNewsDedupeUserPrompt(DedupeJudgePromptInput{
		Threshold: 0.5,
		SummaryA:  "A",
		SummaryB:  "B",
	}, stringPointer("T={{ threshold }}|{{summary_a}}|{{ summary_b }}"))
	if custom != "T=0.50|A|B" {
		t.Fatalf("custom user template = %q", custom)
	}
}

func TestParseNewsDedupeJudgeResponse(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		ok          bool
		similarity  float64
		isDuplicate bool
		rationale   *string
	}{
		{name: "valid", content: `{"similarity":0.93,"is_duplicate":true}`, ok: true, similarity: 0.93, isDuplicate: true},
		{name: "rationale", content: `{"similarity":0.5,"is_duplicate":false,"rationale":"same event"}`, ok: true, similarity: 0.5, rationale: stringPointer("same event")},
		{name: "null rationale", content: `{"similarity":0.5,"is_duplicate":false,"rationale":null}`, ok: true, similarity: 0.5},
		// NewsDedupeJudgeSchema.safeParse rejects the whole payload when a member
		// is out of schema; a clamped similarity must never reach the caller,
		// because any similarity at or above the threshold becomes a Duplicate
		// mark that permanently hides the item.
		{name: "non-string rationale", content: `{"similarity":0.5,"is_duplicate":false,"rationale":1}`},
		{name: "similarity above one", content: `{"similarity":1.4,"is_duplicate":false}`},
		{name: "similarity below zero", content: `{"similarity":-0.4,"is_duplicate":true}`},
		{name: "fenced", content: "```json\n{\"similarity\":0.8,\"is_duplicate\":true}\n```", ok: true, similarity: 0.8, isDuplicate: true},
		{name: "wrapped", content: `verdict: {"similarity":0.8,"is_duplicate":true} done`, ok: true, similarity: 0.8, isDuplicate: true},
		{name: "missing similarity", content: `{"is_duplicate":true}`},
		{name: "string similarity", content: `{"similarity":"0.9","is_duplicate":true}`},
		{name: "missing duplicate", content: `{"similarity":0.9}`},
		{name: "string duplicate", content: `{"similarity":0.9,"is_duplicate":"true"}`},
		{name: "not json", content: "not json at all"},
		{name: "not object", content: `[1,2]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			judge, ok := ParseNewsDedupeJudgeResponse(test.content)
			if ok != test.ok {
				t.Fatalf("ok = %v, want %v", ok, test.ok)
			}
			if !ok {
				return
			}
			if judge.Similarity != test.similarity {
				t.Fatalf("similarity = %v, want %v", judge.Similarity, test.similarity)
			}
			if judge.IsDuplicate != test.isDuplicate {
				t.Fatalf("isDuplicate = %v, want %v", judge.IsDuplicate, test.isDuplicate)
			}
			if (judge.Rationale == nil) != (test.rationale == nil) {
				t.Fatalf("rationale = %v, want %v", derefOrNil(judge.Rationale), derefOrNil(test.rationale))
			}
			if judge.Rationale != nil && *judge.Rationale != *test.rationale {
				t.Fatalf("rationale = %q, want %q", *judge.Rationale, *test.rationale)
			}
		})
	}

	long := strings.Repeat("r", 281)
	if _, ok := ParseNewsDedupeJudgeResponse(`{"similarity":0.9,"is_duplicate":false,"rationale":"` + long + `"}`); ok {
		t.Fatalf("over-long rationale must reject the whole verdict like NewsDedupeJudgeSchema")
	}
	// z.string().max(280) counts UTF-16 code units and 280 is still in schema.
	atLimit := strings.Repeat("r", 280)
	judge, ok := ParseNewsDedupeJudgeResponse(`{"similarity":0.9,"is_duplicate":false,"rationale":"` + atLimit + `"}`)
	if !ok || judge.Rationale == nil || len(*judge.Rationale) != 280 {
		t.Fatalf("280-unit rationale must be accepted")
	}
	// A surrogate pair counts as two units, so 141 astral characters exceed 280.
	astral := strings.Repeat("\U0001F600", 141)
	if _, ok := ParseNewsDedupeJudgeResponse(`{"similarity":0.9,"is_duplicate":false,"rationale":"` + astral + `"}`); ok {
		t.Fatalf("rationale length must be measured in UTF-16 code units")
	}
}

func TestNewsDedupeResponseFormat(t *testing.T) {
	if NewsDedupeResponseFormat == nil || NewsDedupeResponseFormat.Type != "json_schema" {
		t.Fatalf("response format = %#v", NewsDedupeResponseFormat)
	}
	if NewsDedupeResponseFormat.JSONSchema == nil || NewsDedupeResponseFormat.JSONSchema.Name != "news_dedupe_judge" {
		t.Fatalf("json schema = %#v", NewsDedupeResponseFormat.JSONSchema)
	}
	var schema map[string]any
	if err := json.Unmarshal(NewsDedupeJudgeJSONSchema, &schema); err != nil {
		t.Fatalf("schema is not JSON: %v", err)
	}
	properties, _ := schema["properties"].(map[string]any)
	similarity, _ := properties["similarity"].(map[string]any)
	if similarity["type"] != "number" || similarity["minimum"] != float64(0) || similarity["maximum"] != float64(1) {
		t.Fatalf("similarity schema = %#v", similarity)
	}
	duplicate, _ := properties["is_duplicate"].(map[string]any)
	if duplicate["type"] != "boolean" {
		t.Fatalf("is_duplicate schema = %#v", duplicate)
	}
	required, _ := schema["required"].([]any)
	if len(required) != 2 || required[0] != "similarity" || required[1] != "is_duplicate" {
		t.Fatalf("required = %#v", required)
	}
	if schema["additionalProperties"] != false {
		t.Fatalf("additionalProperties = %#v", schema["additionalProperties"])
	}
}
