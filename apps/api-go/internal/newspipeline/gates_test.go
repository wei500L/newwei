package newspipeline

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestStageMetaEntryAlwaysWritesAllTenKeys(t *testing.T) {
	encoded, err := json.Marshal(NewStageMetaEntry("rejected", stringPointer("rules")))
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	want := `{"status":"rejected","provider":"rules","reason":null,"model":null,"prompt_version":null,"prompt_tokens":null,"completion_tokens":null,"total_tokens":null,"cost_usd":null,"latency_ms":null}`
	if string(encoded) != want {
		t.Fatalf("unexpected stage meta entry JSON\n got: %s\nwant: %s", encoded, want)
	}
}

func TestStageMetaSerializesInSchemaOrder(t *testing.T) {
	meta := &StageMeta{
		Preflight:   NewStageMetaEntry("completed", stringPointer("rules")),
		Clean:       NewStageMetaEntry("completed", stringPointer("llm")),
		QualityGate: NewStageMetaEntry("completed", stringPointer("rules")),
		Entities:    NewStageMetaEntry("completed", stringPointer("llm")),
		Sentiment:   NewStageMetaEntry("completed", stringPointer("llm")),
		KG:          NewStageMetaEntry("completed", stringPointer("llm")),
		Classify:    NewStageMetaEntry("completed", stringPointer("classifier")),
		Dedupe:      NewStageMetaEntry("completed", stringPointer("dedupe")),
	}
	encoded, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	keys := []string{"preflight", "clean", "quality_gate", "entities", "sentiment", "kg", "classify", "dedupe"}
	previous := -1
	for _, key := range keys {
		index := strings.Index(string(encoded), `"`+key+`"`)
		if index < 0 {
			t.Fatalf("stage_meta is missing %q: %s", key, encoded)
		}
		if index < previous {
			t.Fatalf("stage_meta key order is wrong at %q: %s", key, encoded)
		}
		previous = index
	}
}

func TestComputePreflightQualityScore(t *testing.T) {
	challenge := pipelineMarkdownQuality{words: 400, isChallenge: true}
	if score := pipelineComputePreflightQualityScore(challenge); score != 0 {
		t.Fatalf("challenge score = %v, want 0", score)
	}
	if score := pipelineComputePreflightQualityScore(pipelineMarkdownQuality{}); score != 0 {
		t.Fatalf("empty score = %v, want 0", score)
	}

	rich := pipelineMarkdownQuality{words: 400, paragraphs: 6, headingCount: 4}
	score := pipelineComputePreflightQualityScore(rich)
	// 0.15 + 0.45*1 + 0.25*1 + 0.1*1 = 0.95
	if math.Abs(score-0.95) > 1e-9 {
		t.Fatalf("rich score = %v, want 0.95", score)
	}

	listLike := pipelineMarkdownQuality{words: 100, paragraphs: 3, headingCount: 2, linkCount: 20, isListLike: true}
	if capped := pipelineComputePreflightQualityScore(listLike); capped > 0.3+1e-9 {
		t.Fatalf("list-like score must be capped at 0.3, got %v", capped)
	}
}

func TestEvaluatePreflightGate(t *testing.T) {
	settings := pipelineTestStagedSettings()

	disabled := settings
	disabled.PreflightGate.Enabled = false
	if result := evaluatePreflightGate(pipelineTestArticle().CrawledArticle, disabled); result.rejected || result.qualityScore != nil {
		t.Fatalf("disabled gate must accept without scores, got %+v", result)
	}

	goodArticle := pipelineTestArticle().CrawledArticle
	result := evaluatePreflightGate(goodArticle, settings)
	if result.rejected {
		t.Fatalf("expected the good article to pass, reason=%v", result.reason)
	}
	if result.qualityScore == nil || result.qualityThreshold == nil {
		t.Fatal("accepted gate must report the score and threshold")
	}

	challengeArticle := CrawledArticle{Markdown: strings.Repeat("please enable javascript to continue ", 40)}
	challenge := evaluatePreflightGate(challengeArticle, settings)
	if !challenge.rejected || challenge.reason == nil || *challenge.reason != "bot_challenge_markdown" {
		t.Fatalf("expected bot_challenge_markdown, got %+v", challenge)
	}

	listArticle := CrawledArticle{Markdown: strings.Repeat("[link](https://example.com/x) ", 20)}
	list := evaluatePreflightGate(listArticle, settings)
	if !list.rejected || list.reason == nil || *list.reason != "list_like_markdown" {
		t.Fatalf("expected list_like_markdown, got %+v", list)
	}

	shortArticle := CrawledArticle{Markdown: "short text"}
	short := evaluatePreflightGate(shortArticle, settings)
	if !short.rejected || short.reason == nil || *short.reason != "insufficient_word_count" {
		t.Fatalf("expected insufficient_word_count, got %+v", short)
	}

	strict := settings
	strict.PreflightGate.MinQualityScore = 0.99
	low := evaluatePreflightGate(goodArticle, strict)
	if !low.rejected || low.reason == nil || *low.reason != "preflight_quality_score_below_threshold" {
		t.Fatalf("expected preflight_quality_score_below_threshold, got %+v", low)
	}
}

func TestEvaluatePostCleanGate(t *testing.T) {
	settings := pipelineTestStagedSettings()
	cleaned := pipelineTestCleaned()

	if result := evaluatePostCleanGate(cleaned, pipelineTestLegacySettings()); result.rejected {
		t.Fatal("a disabled post-clean gate must accept")
	}
	if result := evaluatePostCleanGate(cleaned, settings); result.rejected {
		t.Fatalf("expected the cleaned news to pass, reason=%v", result.reason)
	}

	short := cleaned
	short.CleanedMarkdown = "tiny"
	if result := evaluatePostCleanGate(short, settings); !result.rejected || *result.reason != "cleaned_markdown_too_short" {
		t.Fatalf("expected cleaned_markdown_too_short, got %+v", result)
	}

	noSummary := cleaned
	noSummary.Summary = nil
	if result := evaluatePostCleanGate(noSummary, settings); !result.rejected || *result.reason != "missing_summary" {
		t.Fatalf("expected missing_summary, got %+v", result)
	}

	lowScore := cleaned
	lowScore.QualityScore = floatPointer(0.1)
	if result := evaluatePostCleanGate(lowScore, settings); !result.rejected || *result.reason != "quality_score_below_threshold" {
		t.Fatalf("expected quality_score_below_threshold, got %+v", result)
	}
}

func TestBuildGateRejectedCleanedNews(t *testing.T) {
	article := CrawledArticle{
		SourceURL: "https://example.com/a",
		Markdown:  "First paragraph about the event.\n\nSecond paragraph with details.\n\nThird paragraph ignored.",
	}
	payload := NormalizedPayload{
		URL:        "https://example.com/a",
		SourceName: stringPointer("Example"),
		Language:   stringPointer("en"),
	}
	stageMeta := &StageMeta{
		Preflight: NewStageMetaEntryWithReason("rejected", stringPointer("rules"), "preflight_rejected"),
	}
	cleaned := buildGateRejectedCleanedNews(article, payload, "preflight_rejected", stageMeta, 8_000)

	if cleaned.Title == nil || *cleaned.Title != "Example" {
		t.Fatalf("title fallback = %v", cleaned.Title)
	}
	if cleaned.Source == nil || *cleaned.Source != "Example" {
		t.Fatalf("source fallback = %v", cleaned.Source)
	}
	if cleaned.Summary == nil || *cleaned.Summary != "First paragraph about the event. Second paragraph with details." {
		t.Fatalf("summary = %v", cleaned.Summary)
	}
	if cleaned.CleanedMarkdownSource == nil || *cleaned.CleanedMarkdownSource != "crawl_fallback" {
		t.Fatalf("cleaned_markdown_source = %v", cleaned.CleanedMarkdownSource)
	}
	if len(cleaned.RemovedNoiseTypes) != 1 || cleaned.RemovedNoiseTypes[0] != "preflight_rejected" {
		t.Fatalf("removedNoiseTypes = %v", cleaned.RemovedNoiseTypes)
	}
	if len(cleaned.CategoryLabels) != 0 || len(cleaned.CategoryCandidates) != 0 || len(cleaned.Topics) != 0 ||
		len(cleaned.KeyPoints) != 0 || len(cleaned.Entities) != 0 || len(cleaned.KGRelations) != 0 {
		t.Fatalf("gate rejected arrays must be empty: %#v", cleaned)
	}
	if cleaned.StageMeta != stageMeta {
		t.Fatal("gate rejected cleaned news must carry the provided stage_meta")
	}
	if cleaned.QualityScore != nil || cleaned.LLMModel != nil || cleaned.LLMPromptVersion != nil {
		t.Fatal("gate rejected cleaned news must have null llm/quality fields")
	}
}

func TestBuildGateRejectedCleanedNewsFallsBackToArticleMarkdown(t *testing.T) {
	article := CrawledArticle{Markdown: strings.Repeat("long article text ", 200)}
	cleaned := buildGateRejectedCleanedNews(article, NormalizedPayload{URL: "https://example.com/a"}, "preflight_rejected", &StageMeta{}, 40)
	// maxInputChars 40 keeps the first 40 UTF-16 code units of the selected
	// markdown, not the whole article fallback.
	want := strings.Repeat("long article text ", 2) + "long"
	if cleaned.CleanedMarkdown != want {
		t.Fatalf("cleaned_markdown = %q, want %q", cleaned.CleanedMarkdown, want)
	}
	if cleaned.Summary == nil {
		t.Fatal("summary must be a non-nil pointer here")
	}
}

func TestStripEnrichmentFields(t *testing.T) {
	cleaned := pipelineTestCleaned()
	cleaned.Sentiment = stringPointer("positive")
	cleaned.SentimentLabel = stringPointer("positive")
	cleaned.Entities = []Entity{{Name: "Entity", Type: "org", Confidence: 1}}
	cleaned.KGRelations = []KGRelation{{Predicate: "mentions"}}
	cleaned.StageMeta = &StageMeta{Preflight: NewStageMetaEntry("completed", stringPointer("rules"))}

	stripped := stripEnrichmentFields(cleaned)
	if stripped.Sentiment != nil || stripped.SentimentLabel != nil {
		t.Fatal("sentiment must be cleared")
	}
	if stripped.Entities == nil || len(stripped.Entities) != 0 {
		t.Fatalf("entities = %#v, want []", stripped.Entities)
	}
	if stripped.KGRelations == nil || len(stripped.KGRelations) != 0 {
		t.Fatalf("kg_relations = %#v, want []", stripped.KGRelations)
	}
	if stripped.StageMeta == cleaned.StageMeta {
		t.Fatal("stage_meta must be copied, not aliased")
	}
	if stripped.Title == nil || *stripped.Title != "Title" {
		t.Fatal("non-enrichment fields must be preserved")
	}
}

func TestPipelineBuildMarkdownForLLMSelectsRicherNonChallengeCandidate(t *testing.T) {
	article := CrawledArticle{
		Markdown:    "please enable javascript",
		RawMarkdown: stringPointer(strings.Repeat("real article body ", 200)),
	}
	result := pipelineBuildMarkdownForLLM(article, 8_000)
	if result.Variant != "raw" {
		t.Fatalf("selected variant = %q, want raw", result.Variant)
	}
	if !strings.HasPrefix(result.Markdown, "real article body") {
		t.Fatalf("unexpected markdown: %q", result.Markdown)
	}
}

func TestPipelineJSHelpers(t *testing.T) {
	if got := pipelineJSStringLength("a😀b"); got != 4 {
		t.Fatalf("JS string length = %d, want 4", got)
	}
	if got := pipelineSliceJS("a😀b", 2); got != "a" {
		t.Fatalf("slice must not split a surrogate pair: %q", got)
	}
	if got := pipelineTrimJS("\u00a0 hi \ufeff"); got != "hi" {
		t.Fatalf("trim = %q", got)
	}
	if got := pipelineCountWords("one  two\nthree"); got != 3 {
		t.Fatalf("word count = %d", got)
	}
	if got := pipelineCountParagraphs("a\n\n b\n \nc"); got != 3 {
		t.Fatalf("paragraph count = %d", got)
	}
}
