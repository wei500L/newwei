package newspipeline

// Tests for the settings readers and prompt configuration: NestJS defaults,
// clamp normalization, scoped threshold resolution and the byte-exact default
// prompt templates. No database or Redis is required: normalization and the
// no-DB degradation path are the graded behaviour.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"testing"
)

func settingsDocumentFromJSON(t *testing.T, raw string) map[string]json.RawMessage {
	t.Helper()
	document, ok := decodeSettingDocument([]byte(raw))
	if !ok {
		t.Fatalf("invalid settings JSON: %s", raw)
	}
	return document
}

func templateSHA256(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func TestDefaultNewsPromptConfigByteExact(t *testing.T) {
	tests := []struct {
		name  string
		value string
		hash  string
	}{
		{"system", DefaultNewsPromptConfig.SystemPromptTemplate, "0655a7585d86ca0e1b62baabaf0307746655ee36ff62123399304226677087ed"},
		{"denoise", DefaultNewsPromptConfig.DenoisePromptTemplate, "1718b049a9673726c92665e3709a7c7be6bd05913b8286d43da9e47446c21947"},
		{"user", DefaultNewsPromptConfig.UserPromptTemplate, "abde5cbf8a77a362283996a8d8bd796e9b0b3371a33ea994a9801309ef969560"},
		{"entitySystem", DefaultNewsPromptConfig.EntitySystemPromptTemplate, "62d7ed49b0d81947bf4345556bc5c0beec66209845025bee25e8f9ebb1d769d7"},
		{"entityUser", DefaultNewsPromptConfig.EntityUserPromptTemplate, "76288eb25287d216a39a728b4d714e37bc4235b4d1d9c7813555478f12f75d15"},
		{"sentimentSystem", DefaultNewsPromptConfig.SentimentSystemPromptTemplate, "0f74fc9f2b7192e2fcd26775f0762fc739631e1b3f0310340b12017f2149d437"},
		{"sentimentUser", DefaultNewsPromptConfig.SentimentUserPromptTemplate, "ae760156588444a4c7e762c31d763d94d4e4c3db0e7af06ff82ef1260f34c081"},
		{"kgSystem", DefaultNewsPromptConfig.KGSystemPromptTemplate, "f74b9de2cbd94321f02651b3c78224eccf5a1617e951b5fda7339d0650ae8514"},
		{"kgUser", DefaultNewsPromptConfig.KGUserPromptTemplate, "dd57a3600364f7628ed288fb0ccaa328884552fc351f228f8b6324d2bf2798d2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := templateSHA256(test.value); got != test.hash {
				t.Fatalf("%s template differs from news-prompt-config.service.ts (hash %s, want %s)", test.name, got, test.hash)
			}
		})
	}
	if DefaultNewsPromptConfig.Version != "news-clean-v5" {
		t.Fatalf("version = %q", DefaultNewsPromptConfig.Version)
	}
}

func TestFallbackExtractionSettings(t *testing.T) {
	settings := fallbackExtractionSettings()
	if settings.PipelineMode != PipelineModeStaged {
		t.Fatalf("pipeline mode = %q", settings.PipelineMode)
	}
	if !settings.PreflightGate.Enabled || settings.PreflightGate.MinWordCount != 120 ||
		settings.PreflightGate.MinQualityScore != 0.35 || !settings.PreflightGate.RejectBotChallenge ||
		!settings.PreflightGate.RejectListLike {
		t.Fatalf("preflight gate = %#v", settings.PreflightGate)
	}
	if !settings.PostCleanGate.Enabled || settings.PostCleanGate.MinQualityScore != 0.35 ||
		settings.PostCleanGate.MinCleanedChars != 400 || !settings.PostCleanGate.RequireSummary {
		t.Fatalf("post clean gate = %#v", settings.PostCleanGate)
	}
	if !settings.Capabilities.Entities || !settings.Capabilities.Sentiment || !settings.Capabilities.KG {
		t.Fatalf("capabilities = %#v", settings.Capabilities)
	}
	if settings.Providers.Clean != "llm" || settings.Providers.Entities != "llm" ||
		settings.Providers.Sentiment != "llm" || settings.Providers.KG != "llm" {
		t.Fatalf("providers = %#v", settings.Providers)
	}
}

func TestNormalizeExtractionSettings(t *testing.T) {
	document := settingsDocumentFromJSON(t, `{
		"pipelineMode": "legacy",
		"preflightGate": {"enabled": false, "minWordCount": 99999, "minQualityScore": 2},
		"postCleanGate": {"minCleanedChars": -5, "requireSummary": false},
		"capabilities": {"kg": false},
		"providers": {"clean": "other", "entities": "llm"}
	}`)
	settings := normalizeExtractionSettings(document)
	if settings.PipelineMode != PipelineModeLegacy {
		t.Fatalf("pipeline mode = %q", settings.PipelineMode)
	}
	if settings.PreflightGate.Enabled {
		t.Fatalf("enabled should be false")
	}
	if settings.PreflightGate.MinWordCount != 10_000 {
		t.Fatalf("minWordCount = %d, want clamp 10000", settings.PreflightGate.MinWordCount)
	}
	if settings.PreflightGate.MinQualityScore != 1 {
		t.Fatalf("minQualityScore = %v, want clamp 1", settings.PreflightGate.MinQualityScore)
	}
	if settings.PreflightGate.RejectBotChallenge != true || settings.PreflightGate.RejectListLike != true {
		t.Fatalf("unspecified booleans must keep defaults")
	}
	if settings.PostCleanGate.MinCleanedChars != 0 {
		t.Fatalf("minCleanedChars = %d, want clamp 0", settings.PostCleanGate.MinCleanedChars)
	}
	if settings.PostCleanGate.RequireSummary {
		t.Fatalf("requireSummary should be false")
	}
	if settings.PostCleanGate.MinQualityScore != 0.35 || !settings.PostCleanGate.Enabled {
		t.Fatalf("post clean defaults = %#v", settings.PostCleanGate)
	}
	if settings.Capabilities.KG || !settings.Capabilities.Entities || !settings.Capabilities.Sentiment {
		t.Fatalf("capabilities = %#v", settings.Capabilities)
	}
	if settings.Providers.Clean != "llm" || settings.Providers.Entities != "llm" {
		t.Fatalf("providers = %#v", settings.Providers)
	}

	invalid := normalizeExtractionSettings(settingsDocumentFromJSON(t, `{
		"pipelineMode": "unknown",
		"preflightGate": {"enabled": "yes", "minWordCount": "10", "minQualityScore": null}
	}`))
	if invalid.PipelineMode != PipelineModeStaged || !invalid.PreflightGate.Enabled ||
		invalid.PreflightGate.MinWordCount != 120 || invalid.PreflightGate.MinQualityScore != 0.35 {
		t.Fatalf("invalid values must fall back to defaults: %#v", invalid)
	}

	if defaults := normalizeExtractionSettings(nil); !reflect.DeepEqual(defaults, fallbackExtractionSettings()) {
		t.Fatalf("nil document must produce defaults")
	}
}

func newTestSettingsReader(defaultThreshold float64) *SettingsReader {
	return NewSettingsReader(nil, nil, NewsPipelineConfig{
		Pipeline: RuntimeConfig{SummaryDedupThreshold: defaultThreshold},
	})
}

func TestFallbackDedupeSettings(t *testing.T) {
	reader := newTestSettingsReader(0.85)
	settings := reader.Dedupe(context.Background(), "org-1")
	if settings.DefaultThreshold != 0.85 {
		t.Fatalf("default threshold = %v, want pipeline threshold 0.85", settings.DefaultThreshold)
	}
	if settings.ScopedThresholds == nil || len(settings.ScopedThresholds) != 0 {
		t.Fatalf("scoped thresholds = %v", settings.ScopedThresholds)
	}
	if !settings.UseEmbeddings {
		t.Fatalf("useEmbeddings default = false")
	}
	if settings.LLMJudgeInstructions != nil || settings.LLMJudgeModel != nil {
		t.Fatalf("judge instructions/model defaults must be nil")
	}
	if settings.LLMJudgeConcurrency != 4 || settings.LLMJudgeMaxComparisons != 12 || settings.LLMJudgeCandidateChars != 1200 {
		t.Fatalf("judge defaults = %#v", settings)
	}
	if settings.LLMJudgePromptVersion != DefaultNewsDedupePromptVersion {
		t.Fatalf("prompt version = %q", settings.LLMJudgePromptVersion)
	}
	if settings.LLMJudgeSystemPrompt != DefaultNewsDedupeSystemPromptTemplate ||
		settings.LLMJudgeUserPrompt != DefaultNewsDedupeUserPromptTemplate {
		t.Fatalf("judge templates must default to the byte-exact templates")
	}
}

func TestNormalizeDedupeSettings(t *testing.T) {
	defaults := newTestSettingsReader(0.9).fallbackDedupeSettings()
	document := settingsDocumentFromJSON(t, `{
		"defaultThreshold": 0.75,
		"useEmbeddings": false,
		"llmJudgeInstructions": "  be strict  ",
		"llmJudgeModel": "  judge-model  ",
		"llmJudgeConcurrency": 99,
		"llmJudgeMaxComparisons": 0,
		"llmJudgeCandidateChars": "250",
		"llmJudgePromptVersion": " v9 ",
		"llmJudgeSystemPromptTemplate": " system ",
		"llmJudgeUserPromptTemplate": " user ",
		"scopedThresholds": [
			{"sourceId": " S1 ", "language": "EN", "categoryPath": "A//B", "threshold": 0.5},
			{"sourceId": "", "language": "", "categoryPath": "", "threshold": 0.1},
			{"sourceId": "s1", "language": "en", "categoryPath": "a//b", "threshold": "0.8"}
		],
		"categoryThresholds": [
			{"category": " Finance ", "threshold": 0.6},
			{"category": "", "threshold": 0.2}
		]
	}`)
	settings := normalizeDedupeSettings(document, defaults)
	if settings.DefaultThreshold != 0.75 {
		t.Fatalf("default threshold = %v", settings.DefaultThreshold)
	}
	if settings.UseEmbeddings {
		t.Fatalf("useEmbeddings should be false")
	}
	if settings.LLMJudgeInstructions == nil || *settings.LLMJudgeInstructions != "be strict" {
		t.Fatalf("instructions = %v", derefOrNil(settings.LLMJudgeInstructions))
	}
	if settings.LLMJudgeModel == nil || *settings.LLMJudgeModel != "judge-model" {
		t.Fatalf("model = %v", derefOrNil(settings.LLMJudgeModel))
	}
	if settings.LLMJudgeConcurrency != 8 {
		t.Fatalf("concurrency = %d, want clamp 8", settings.LLMJudgeConcurrency)
	}
	if settings.LLMJudgeMaxComparisons != 1 {
		t.Fatalf("maxComparisons = %d, want clamp 1", settings.LLMJudgeMaxComparisons)
	}
	if settings.LLMJudgeCandidateChars != 250 {
		t.Fatalf("candidateChars = %d, want numeric-string 250", settings.LLMJudgeCandidateChars)
	}
	if settings.LLMJudgePromptVersion != "v9" || settings.LLMJudgeSystemPrompt != "system" ||
		settings.LLMJudgeUserPrompt != "user" {
		t.Fatalf("prompt overrides = %#v", settings)
	}
	if len(settings.ScopedThresholds) != 2 {
		t.Fatalf("scoped thresholds = %#v", settings.ScopedThresholds)
	}
	// Sorted by the raw scope sort key: category-only scope ("Finance") sorts
	// before the source scope ("s1"), and the duplicate source scope keeps the
	// last normalized value.
	category := settings.ScopedThresholds[0]
	if category.SourceID != nil || category.Language != nil || category.CategoryPath == nil ||
		*category.CategoryPath != "Finance" || category.Threshold != 0.6 {
		t.Fatalf("category scoped threshold = %#v", category)
	}
	source := settings.ScopedThresholds[1]
	if source.SourceID == nil || *source.SourceID != "s1" || source.Language == nil ||
		*source.Language != "en" || source.CategoryPath == nil || *source.CategoryPath != "a//b" ||
		source.Threshold != 0.8 {
		t.Fatalf("source scoped threshold = %#v", source)
	}

	if unchanged := normalizeDedupeSettings(nil, defaults); !reflect.DeepEqual(unchanged, defaults) {
		t.Fatalf("nil document must return defaults")
	}
}

func TestResolveDedupeBaseThreshold(t *testing.T) {
	scoped := []ScopedThreshold{
		{SourceID: stringPointer("s"), Threshold: 0.7},
		{Language: stringPointer("en"), CategoryPath: stringPointer("a/b"), Threshold: 0.6},
		{CategoryPath: stringPointer("a/b"), Threshold: 0.5},
		{SourceID: stringPointer("s"), Language: stringPointer("en"), CategoryPath: stringPointer("a/b"), Threshold: 0.4},
	}
	settings := DedupeSettings{DefaultThreshold: 0.9, ScopedThresholds: scoped}

	threshold, matched := ResolveDedupeBaseThreshold(settings, stringPointer("s"), stringPointer("en"), stringPointer("a/b"))
	if threshold != 0.4 || matched == nil || matched.Threshold != 0.4 {
		t.Fatalf("exact scope = %v (%#v)", threshold, matched)
	}
	threshold, matched = ResolveDedupeBaseThreshold(settings, stringPointer("s"), stringPointer("en"), stringPointer("c/d"))
	if threshold != 0.7 || matched == nil || matched.SourceID == nil || *matched.SourceID != "s" {
		t.Fatalf("source scope = %v (%#v)", threshold, matched)
	}
	threshold, _ = ResolveDedupeBaseThreshold(settings, nil, stringPointer("en"), stringPointer("a/b"))
	if threshold != 0.6 {
		t.Fatalf("language+category scope = %v, want 0.6", threshold)
	}
	threshold, _ = ResolveDedupeBaseThreshold(settings, nil, nil, stringPointer("a/b"))
	if threshold != 0.5 {
		t.Fatalf("category scope = %v, want 0.5", threshold)
	}
	threshold, matched = ResolveDedupeBaseThreshold(settings, nil, nil, nil)
	if threshold != 0.9 || matched != nil {
		t.Fatalf("default threshold = %v (%#v)", threshold, matched)
	}
	// Options are cleaned exactly like stored scope tokens (trim + lowercase).
	threshold, _ = ResolveDedupeBaseThreshold(settings, stringPointer(" S "), stringPointer("EN"), nil)
	if threshold != 0.7 {
		t.Fatalf("cleaned source scope = %v, want 0.7", threshold)
	}
}

func TestSettingsCacheDocumentRoundTrip(t *testing.T) {
	reader := newTestSettingsReader(0.9)
	extraction := normalizeExtractionSettings(settingsDocumentFromJSON(t, `{
		"pipelineMode": "legacy",
		"preflightGate": {"enabled": false, "minWordCount": 250},
		"capabilities": {"sentiment": false},
		"providers": {"kg": "llm"}
	}`))
	encoded, err := json.Marshal(extractionSettingsCacheDocument(extraction))
	if err != nil {
		t.Fatalf("marshal extraction cache doc: %v", err)
	}
	roundTripped := normalizeExtractionSettings(mustDecodeSettings(t, encoded))
	if !reflect.DeepEqual(roundTripped, extraction) {
		t.Fatalf("extraction cache round trip mismatch:\n got %#v\nwant %#v", roundTripped, extraction)
	}

	dedupe := normalizeDedupeSettings(settingsDocumentFromJSON(t, `{
		"defaultThreshold": 0.7,
		"scopedThresholds": [{"sourceId": "s", "threshold": 0.8}]
	}`), reader.fallbackDedupeSettings())
	encoded, err = json.Marshal(dedupeSettingsCacheDocument(dedupe))
	if err != nil {
		t.Fatalf("marshal dedupe cache doc: %v", err)
	}
	roundTripped = normalizeDedupeSettings(mustDecodeSettings(t, encoded), reader.fallbackDedupeSettings())
	if !reflect.DeepEqual(roundTripped, dedupe) {
		t.Fatalf("dedupe cache round trip mismatch:\n got %#v\nwant %#v", roundTripped, dedupe)
	}
}

func mustDecodeSettings(t *testing.T, encoded []byte) map[string]json.RawMessage {
	t.Helper()
	document, ok := decodeSettingDocument(encoded)
	if !ok {
		t.Fatalf("cache document does not decode: %s", encoded)
	}
	return document
}

func TestSettingsReaderDegradesWithoutDatabase(t *testing.T) {
	reader := newTestSettingsReader(0.9)
	extraction := reader.Extraction(context.Background(), "org")
	if extraction.PipelineMode != PipelineModeStaged || extraction.PreflightGate.MinWordCount != 120 {
		t.Fatalf("extraction defaults = %#v", extraction)
	}
	if alias := reader.ExtractionSettings(context.Background(), "org"); !reflect.DeepEqual(alias, extraction) {
		t.Fatalf("ExtractionSettings alias differs from Extraction")
	}
	dedupe := reader.Dedupe(context.Background(), "org")
	if dedupe.DefaultThreshold != 0.9 || dedupe.LLMJudgeConcurrency != 4 {
		t.Fatalf("dedupe defaults = %#v", dedupe)
	}
	if alias := reader.DedupeSettings(context.Background(), "org"); !reflect.DeepEqual(alias, dedupe) {
		t.Fatalf("DedupeSettings alias differs from Dedupe")
	}
	if prompt := reader.PromptConfig(context.Background()); !reflect.DeepEqual(prompt, DefaultNewsPromptConfig) {
		t.Fatalf("prompt config must degrade to DefaultNewsPromptConfig")
	}
}

func TestNormalizePromptConfig(t *testing.T) {
	config := normalizePromptConfig(json.RawMessage(`{
		"version": " v2 ",
		"systemPromptTemplate": " system ",
		"sentimentUserPromptTemplate": "sentiment user",
		"kgSystemPromptTemplate": 42,
		"unknown": "ignored"
	}`))
	if config.Version != "v2" {
		t.Fatalf("version = %q", config.Version)
	}
	if config.SystemPromptTemplate != "system" {
		t.Fatalf("system = %q", config.SystemPromptTemplate)
	}
	if config.SentimentUserPromptTemplate != "sentiment user" {
		t.Fatalf("sentiment user = %q", config.SentimentUserPromptTemplate)
	}
	if config.KGSystemPromptTemplate != DefaultNewsPromptConfig.KGSystemPromptTemplate {
		t.Fatalf("non-string template must fall back to default")
	}
	if config.DenoisePromptTemplate != DefaultNewsPromptConfig.DenoisePromptTemplate {
		t.Fatalf("missing template must fall back to default")
	}
	if defaults := normalizePromptConfig(nil); !reflect.DeepEqual(defaults, DefaultNewsPromptConfig) {
		t.Fatalf("nil document must return DefaultNewsPromptConfig")
	}
	if empty := normalizePromptConfig(json.RawMessage(`{"version":"   "}`)); empty.Version != DefaultNewsPromptConfig.Version {
		t.Fatalf("blank version must fall back to default")
	}
}

func TestJsonObjectOrEmpty(t *testing.T) {
	if document := jsonObjectOrEmpty(nil); len(document) != 0 {
		t.Fatalf("nil document = %v", document)
	}
	if document := jsonObjectOrEmpty(json.RawMessage(`[]`)); len(document) != 0 {
		t.Fatalf("array document = %v", document)
	}
	document := jsonObjectOrEmpty(json.RawMessage(`{"a":1}`))
	if string(document["a"]) != "1" {
		t.Fatalf("object document = %v", document)
	}
}
