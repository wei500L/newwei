package newspipeline

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

func TestProcessStagedOrderAndStageMeta(t *testing.T) {
	service, recorder, capture := newPipelineTestService(t)
	job := pipelineTestJob()
	cleaned := pipelineTestCleaned()
	cleanResult := CleanResult{
		Cleaned:     cleaned,
		LLM:         pipelineTestLLM(),
		ContentHash: "content-hash-1",
	}
	service.settings = &pipelineFakeSettings{
		extraction: pipelineTestStagedSettings(),
		prompt:     PromptConfig{Version: "prompt-v1"},
	}
	service.cleaner = &pipelineFakeCleaner{recorder: recorder, article: pipelineTestArticle(), cleanResult: cleanResult}
	extractor := &pipelineFakeExtractor{
		recorder:  recorder,
		entities:  []Entity{{Name: "ACME", Type: "org", Confidence: 0.9}},
		sentiment: "positive",
		relations: []KGRelation{{
			Subject:    KGEntityRef{Name: "ACME", Type: "org"},
			Predicate:  "acquires",
			Object:     KGEntityRef{Name: "Beta", Type: "org"},
			Confidence: 0.8,
		}},
		llm: &LLMMetadata{
			Model:         stringPointer("model-x"),
			PromptVersion: stringPointer("prompt-v1"),
			PromptTokens:  floatPointer(10),
		},
	}
	service.extractor = extractor
	service.classifier = &pipelineFakeClassifier{
		recorder: recorder,
		result:   newsclassifierResultForTest(),
	}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	result, err := service.Process(context.Background(), job, pipelineTestRaw())
	if err != nil {
		t.Fatalf("process failed: %v", err)
	}
	expectedCalls := []string{
		"crawl", "clean:llm", "extract_entities", "extract_sentiment", "extract_kg", "classify", "dedupe", "persist",
	}
	if got := recorder.list(); !pipelineTestEqualStrings(got, expectedCalls) {
		t.Fatalf("unexpected staged stage order: got %v want %v", got, expectedCalls)
	}
	expectedStages := []string{
		"preflight", "clean", "quality_gate", "extract_entities", "extract_sentiment", "extract_kg", "classify", "dedupe",
	}
	if got := capture.stageList(); !pipelineTestEqualStrings(got, expectedStages) {
		t.Fatalf("unexpected PipelineJob metadata stage order: got %v want %v", got, expectedStages)
	}

	meta := store.input.Cleaned.StageMeta
	if meta == nil {
		t.Fatal("staged cleaned news must carry stage_meta")
	}
	for name, entry := range map[string]*StageMetaEntry{
		"preflight":    meta.Preflight,
		"clean":        meta.Clean,
		"quality_gate": meta.QualityGate,
		"entities":     meta.Entities,
		"sentiment":    meta.Sentiment,
		"kg":           meta.KG,
		"classify":     meta.Classify,
		"dedupe":       meta.Dedupe,
	} {
		if entry == nil {
			t.Fatalf("stage_meta.%s is missing", name)
		}
		if entry.Status != "completed" {
			t.Fatalf("stage_meta.%s status = %q, want completed", name, entry.Status)
		}
	}
	if meta.Classify.Reason == nil || *meta.Classify.Reason != "llm" {
		t.Fatalf("classify reason = %v", meta.Classify.Reason)
	}
	if store.input.Cleaned.Sentiment == nil || *store.input.Cleaned.Sentiment != "positive" {
		t.Fatalf("sentiment = %v", store.input.Cleaned.Sentiment)
	}
	if len(store.input.Cleaned.Entities) != 1 || store.input.Cleaned.Entities[0].Name != "ACME" {
		t.Fatalf("entities = %#v", store.input.Cleaned.Entities)
	}
	if len(store.input.Cleaned.KGRelations) != 1 {
		t.Fatalf("kg_relations = %#v", store.input.Cleaned.KGRelations)
	}
	if result.ProcessedItemID != job.ProcessedItemID {
		t.Fatalf("processed item id = %q", result.ProcessedItemID)
	}
}

func TestProcessStagedPreflightRejectedNeverCleans(t *testing.T) {
	service, recorder, capture := newPipelineTestService(t)
	settings := pipelineTestStagedSettings()
	settings.PreflightGate.MinWordCount = 100_000
	service.settings = &pipelineFakeSettings{extraction: settings}
	service.cleaner = &pipelineFakeCleaner{recorder: recorder, article: pipelineTestArticle()}
	service.extractor = &pipelineFakeExtractor{recorder: recorder}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("a rejected gate must not throw: %v", err)
	}
	for _, call := range recorder.list() {
		if call == "clean:llm" {
			t.Fatal("the clean stage must be skipped on a preflight rejection")
		}
	}
	if got := capture.stageList(); !pipelineTestEqualStrings(got, []string{"preflight"}) {
		t.Fatalf("only the preflight stage is recorded, got %v", got)
	}
	meta := store.input.Cleaned.StageMeta
	if meta == nil || meta.Preflight == nil {
		t.Fatal("gate rejected cleaned news must carry stage_meta")
	}
	if meta.Preflight.Status != "rejected" || meta.Preflight.Reason == nil || *meta.Preflight.Reason != "insufficient_word_count" {
		t.Fatalf("preflight entry = %+v", meta.Preflight)
	}
	for name, entry := range map[string]*StageMetaEntry{
		"clean":        meta.Clean,
		"quality_gate": meta.QualityGate,
		"entities":     meta.Entities,
		"sentiment":    meta.Sentiment,
		"kg":           meta.KG,
		"classify":     meta.Classify,
		"dedupe":       meta.Dedupe,
	} {
		if entry == nil || entry.Status != "skipped" {
			t.Fatalf("stage_meta.%s must be skipped: %+v", name, entry)
		}
	}
	if store.input.LLM.Model != nil {
		t.Fatal("a gate-rejected result must persist empty llm metadata")
	}
	if store.input.ProcessedArticleID != nil {
		t.Fatal("a gate-rejected result must not reuse a processed article")
	}
	patch := pipelineTestDecodeJSONMap(t, store.input.ArticleMetadataPatch)
	extraction, ok := patch["extraction"].(map[string]any)
	if !ok {
		t.Fatalf("article metadata patch is missing the extraction block: %v", patch)
	}
	if extraction["mode"] != "staged" || extraction["gateRejected"] != true {
		t.Fatalf("unexpected extraction patch: %v", extraction)
	}
	if extraction["gateReason"] != "insufficient_word_count" {
		t.Fatalf("unexpected gate reason: %v", extraction["gateReason"])
	}
}

func TestProcessStagedPostCleanGateRejectedSkipsEnrichment(t *testing.T) {
	service, recorder, capture := newPipelineTestService(t)
	cleaned := pipelineTestCleaned()
	cleaned.CleanedMarkdown = "tiny"
	service.settings = &pipelineFakeSettings{extraction: pipelineTestStagedSettings(), prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: cleaned, LLM: pipelineTestLLM(), ContentHash: "content-hash-1", ProcessedArticleID: stringPointer("processed-article-1")},
	}
	extractor := &pipelineFakeExtractor{recorder: recorder}
	service.extractor = extractor
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("a rejected post-clean gate must not throw: %v", err)
	}
	for _, call := range recorder.list() {
		switch call {
		case "extract_entities", "extract_sentiment", "extract_kg", "classify", "dedupe":
			t.Fatalf("enrichment/classify/dedupe must be skipped after a quality gate rejection, calls: %v", recorder.list())
		}
	}
	if got := capture.stageList(); !pipelineTestEqualStrings(got, []string{
		"preflight", "clean", "quality_gate", "extract_entities", "extract_sentiment", "extract_kg", "classify", "dedupe",
	}) {
		// The rejected stages are still recorded (skipped) exactly like Nest.
		t.Fatalf("unexpected stage order: %v", got)
	}
	meta := store.input.Cleaned.StageMeta
	if meta.QualityGate == nil || meta.QualityGate.Status != "rejected" {
		t.Fatalf("quality_gate entry = %+v", meta.QualityGate)
	}
	if meta.Entities == nil || meta.Entities.Status != "skipped" || meta.Entities.Reason == nil || *meta.Entities.Reason != "cleaned_markdown_too_short" {
		t.Fatalf("entities entry = %+v", meta.Entities)
	}
	if store.input.ProcessedArticleID == nil || *store.input.ProcessedArticleID != "processed-article-1" {
		t.Fatal("the processed article from the clean stage must be reused")
	}
	patch := pipelineTestDecodeJSONMap(t, store.input.ArticleMetadataPatch)
	extraction := patch["extraction"].(map[string]any)
	if extraction["gateRejected"] != true || extraction["gateReason"] != "cleaned_markdown_too_short" {
		t.Fatalf("unexpected extraction patch: %v", extraction)
	}
}

func TestProcessStagedEnrichmentFailureIsContained(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	service.settings = &pipelineFakeSettings{extraction: pipelineTestStagedSettings(), prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.extractor = &pipelineFakeExtractor{
		recorder:    recorder,
		entitiesErr: errors.New("entity extraction exploded"),
		sentiment:   "neutral",
		relations:   []KGRelation{},
	}
	service.classifier = &pipelineFakeClassifier{recorder: recorder, result: newsclassifierResultForTest()}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("an enrichment failure must not abort the pipeline: %v", err)
	}
	meta := store.input.Cleaned.StageMeta
	if meta.Entities == nil || meta.Entities.Status != "failed" {
		t.Fatalf("entities entry = %+v", meta.Entities)
	}
	if meta.Entities.Reason == nil || *meta.Entities.Reason != "entity extraction exploded" {
		t.Fatalf("entities reason = %v", meta.Entities.Reason)
	}
	if store.input.Cleaned.Entities == nil || len(store.input.Cleaned.Entities) != 0 {
		t.Fatalf("entities must be []: %#v", store.input.Cleaned.Entities)
	}
	if meta.Sentiment == nil || meta.Sentiment.Status != "completed" {
		t.Fatalf("sentiment stage must still run: %+v", meta.Sentiment)
	}
	if meta.KG == nil || meta.KG.Status != "completed" {
		t.Fatalf("kg stage must still run: %+v", meta.KG)
	}
}

func TestProcessStagedClassifierUnavailableRecordsSkipped(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	service.settings = &pipelineFakeSettings{extraction: pipelineTestStagedSettings(), prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.extractor = &pipelineFakeExtractor{recorder: recorder, sentiment: "neutral"}
	service.classifier = nil
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	meta := store.input.Cleaned.StageMeta
	if meta.Classify == nil || meta.Classify.Status != "skipped" || meta.Classify.Reason == nil || *meta.Classify.Reason != "classifier_unavailable" {
		t.Fatalf("classify entry = %+v", meta.Classify)
	}
	for _, call := range recorder.list() {
		if call == "classify" {
			t.Fatal("no classifier call is expected when the classifier is not wired")
		}
	}
}

func TestProcessStagedDedupeReasonAndRevert(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	duplicateOf := "507f1f77bcf86cd799439012"
	service.settings = &pipelineFakeSettings{extraction: pipelineTestStagedSettings(), prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.extractor = &pipelineFakeExtractor{recorder: recorder, sentiment: "neutral"}
	service.classifier = &pipelineFakeClassifier{recorder: recorder, result: newsclassifierResultForTest()}
	deduper := &pipelineFakeDeduper{
		recorder: recorder,
		result: DedupeResult{
			DuplicateOf:         &duplicateOf,
			DuplicateSimilarity: floatPointer(0.96),
		},
	}
	service.deduper = deduper
	store := &pipelineFakeStore{recorder: recorder, err: errors.New("persist failed")}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err == nil {
		t.Fatal("expected the persist stage to fail")
	}
	if !deduper.reverted {
		t.Fatal("the staged pipeline must revert the Duplicate mark on persist failure")
	}
	if deduper.revertedWith == nil || *deduper.revertedWith != duplicateOf {
		t.Fatalf("revert duplicateOf = %v", deduper.revertedWith)
	}
}

func TestProcessStagedDedupeReasonRecorded(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	duplicateOf := "507f1f77bcf86cd799439012"
	service.settings = &pipelineFakeSettings{extraction: pipelineTestStagedSettings(), prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.extractor = &pipelineFakeExtractor{recorder: recorder, sentiment: "neutral"}
	service.classifier = &pipelineFakeClassifier{recorder: recorder, result: newsclassifierResultForTest()}
	service.deduper = &pipelineFakeDeduper{
		recorder: recorder,
		result: DedupeResult{
			DuplicateOf:         &duplicateOf,
			DuplicateSimilarity: floatPointer(0.96),
		},
	}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	entry := store.input.Cleaned.StageMeta.Dedupe
	if entry == nil || entry.Reason == nil || *entry.Reason != "duplicate:"+duplicateOf {
		t.Fatalf("dedupe entry = %+v", entry)
	}
	if store.input.DuplicateOf == nil || *store.input.DuplicateOf != duplicateOf {
		t.Fatal("the duplicateOf must be passed to persist")
	}
	if store.input.SummaryEmbedding != nil {
		t.Fatal("no summary embedding is expected from the default dedupe result")
	}
}

func TestProcessStagedSkipsDisabledCapabilities(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	settings := pipelineTestStagedSettings()
	settings.Capabilities = ExtractionCapabilities{Entities: false, Sentiment: false, KG: false}
	service.settings = &pipelineFakeSettings{extraction: settings, prompt: PromptConfig{Version: "v1"}}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	extractor := &pipelineFakeExtractor{recorder: recorder}
	service.extractor = extractor
	service.classifier = &pipelineFakeClassifier{recorder: recorder, result: newsclassifierResultForTest()}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	if len(pipelineTestExtractorCalls(recorder.list())) != 0 {
		t.Fatalf("no extractor call is expected when every capability is disabled: %v", recorder.list())
	}
	meta := store.input.Cleaned.StageMeta
	for name, entry := range map[string]*StageMetaEntry{"entities": meta.Entities, "sentiment": meta.Sentiment, "kg": meta.KG} {
		if entry == nil || entry.Status != "skipped" || entry.Reason == nil || *entry.Reason != "capability_disabled" {
			t.Fatalf("stage_meta.%s = %+v", name, entry)
		}
	}
}

func newsclassifierResultForTest() newsclassifierResult {
	return newsclassifierResult{
		LegacyCategory: "markets",
		CategoryPath:   stringPointer("news/markets"),
		Labels:         []string{"markets"},
		Confidence:     floatPointer(0.9),
		Method:         "llm",
	}
}

func pipelineTestDecodeJSONMap(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("invalid JSON %s: %v", raw, err)
	}
	return value
}

func pipelineTestExtractorCalls(calls []string) []string {
	out := make([]string, 0, 3)
	for _, call := range calls {
		if strings.HasPrefix(call, "extract_") {
			out = append(out, call)
		}
	}
	return out
}

// newsclassifierResult aliases the classifier result so the fixtures read
// without importing the package in every test.
type newsclassifierResult = newsclassifier.Result
