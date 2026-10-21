package newspipeline

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

// Shared fakes and fixtures for the news-core unit tests. Everything is
// pipeline*-prefixed so the parallel news-config / news-content / news-dedupe
// test files in the same package cannot collide.

var pipelineTestNow = time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)

// pipelineTestRecorder records the order in which the pipeline calls its ports.
var pipelineStagePathPattern = regexp.MustCompile(`\$\.([a-zA-Z_][a-zA-Z0-9_]*)`)

type pipelineTestRecorder struct {
	mu    sync.Mutex
	calls []string
}

func (r *pipelineTestRecorder) add(call string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, call)
}

func (r *pipelineTestRecorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

// pipelineMetadataCapture captures the O1 PipelineJob.metadata statements.
type pipelineMetadataCapture struct {
	mu       sync.Mutex
	stages   []string
	queries  []string
	errors   []error
	failWith error
}

func (c *pipelineMetadataCapture) exec(_ context.Context, query string, args ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.queries = append(c.queries, query)
	for _, match := range pipelineStagePathPattern.FindAllStringSubmatch(query, -1) {
		if len(match) != 2 {
			continue
		}
		switch match[1] {
		case "extraction", "stages", "updatedAt":
			continue
		}
		c.stages = append(c.stages, match[1])
		break
	}
	return c.failWith
}

func (c *pipelineMetadataCapture) stageList() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.stages...)
}

type pipelineFakeSettings struct {
	extraction ExtractionSettings
	dedupe     DedupeSettings
	prompt     PromptConfig
}

func (f *pipelineFakeSettings) Extraction(context.Context, string) ExtractionSettings {
	return f.extraction
}

func (f *pipelineFakeSettings) Dedupe(context.Context, string) DedupeSettings {
	return f.dedupe
}

func (f *pipelineFakeSettings) PromptConfig(context.Context) PromptConfig {
	return f.prompt
}

type pipelineFakeCleaner struct {
	recorder      *pipelineTestRecorder
	article       ArticleWithCache
	fetchErr      error
	cleanResult   CleanResult
	cleanErr      error
	cleanProvider string
}

func (f *pipelineFakeCleaner) FetchArticle(context.Context, Job, NormalizedPayload) (ArticleWithCache, error) {
	f.recorder.add("crawl")
	if f.fetchErr != nil {
		return ArticleWithCache{}, f.fetchErr
	}
	return f.article, nil
}

func (f *pipelineFakeCleaner) CleanArticle(_ context.Context, _ NormalizedPayload, _ CrawledArticle, _ Job, provider string) (CleanResult, error) {
	f.cleanProvider = provider
	f.recorder.add("clean:" + provider)
	if f.cleanErr != nil {
		return CleanResult{}, f.cleanErr
	}
	return f.cleanResult, nil
}

type pipelineFakeExtractor struct {
	recorder     *pipelineTestRecorder
	entities     []Entity
	entitiesErr  error
	sentiment    string
	sentimentErr error
	relations    []KGRelation
	kgErr        error
	llm          *LLMMetadata
}

func (f *pipelineFakeExtractor) ExtractEntities(context.Context, StageContext, PromptConfig, string, EnrichmentInput) ([]Entity, *LLMMetadata, error) {
	f.recorder.add("extract_entities")
	if f.entitiesErr != nil {
		return nil, nil, f.entitiesErr
	}
	return f.entities, f.llm, nil
}

func (f *pipelineFakeExtractor) AnalyzeSentiment(context.Context, StageContext, PromptConfig, string, EnrichmentInput) (string, *LLMMetadata, error) {
	f.recorder.add("extract_sentiment")
	if f.sentimentErr != nil {
		return "", nil, f.sentimentErr
	}
	return f.sentiment, f.llm, nil
}

func (f *pipelineFakeExtractor) ExtractKGRelations(context.Context, StageContext, PromptConfig, string, EnrichmentInput) ([]KGRelation, *LLMMetadata, error) {
	f.recorder.add("extract_kg")
	if f.kgErr != nil {
		return nil, nil, f.kgErr
	}
	return f.relations, f.llm, nil
}

type pipelineFakeDeduper struct {
	recorder        *pipelineTestRecorder
	result          DedupeResult
	evaluateErr     error
	revertErr       error
	input           DedupeInput
	reverted        bool
	revertedWith    *string
	revertCallCount int
}

func (f *pipelineFakeDeduper) EvaluateSummaryDedupe(_ context.Context, input DedupeInput) (DedupeResult, error) {
	f.recorder.add("dedupe")
	f.input = input
	if f.evaluateErr != nil {
		return DedupeResult{}, f.evaluateErr
	}
	return f.result, nil
}

func (f *pipelineFakeDeduper) RevertDuplicateMarkOnPersistFailure(_ context.Context, _ Job, duplicateOf *string) error {
	f.reverted = true
	f.revertCallCount++
	f.revertedWith = duplicateOf
	return f.revertErr
}

type pipelineFakeClassifier struct {
	recorder *pipelineTestRecorder
	result   newsclassifier.Result
	err      error
	input    newsclassifier.CleanedNews
	options  newsclassifier.Options
}

func (f *pipelineFakeClassifier) Classify(_ context.Context, _ string, cleaned newsclassifier.CleanedNews, options newsclassifier.Options) (newsclassifier.Result, error) {
	f.recorder.add("classify")
	f.input = cleaned
	f.options = options
	if f.err != nil {
		return newsclassifier.Result{}, f.err
	}
	return f.result, nil
}

type pipelineFakeStore struct {
	recorder *pipelineTestRecorder
	input    pipelineStoreInput
	err      error
	result   PersistResult
}

func (f *pipelineFakeStore) persist(_ context.Context, input pipelineStoreInput) (PersistResult, error) {
	f.recorder.add("persist")
	f.input = input
	if f.err != nil {
		return PersistResult{}, f.err
	}
	if f.result.OutboxID == "" {
		f.result.OutboxID = "outbox-1"
	}
	return f.result, nil
}

type pipelineFakeOutbox struct {
	mu         sync.Mutex
	delivered  []string
	deliveries chan string
	result     bool
}

func (f *pipelineFakeOutbox) DeliverNow(_ context.Context, outboxID string) bool {
	f.mu.Lock()
	f.delivered = append(f.delivered, outboxID)
	f.mu.Unlock()
	if f.deliveries != nil {
		f.deliveries <- outboxID
	}
	return f.result
}

type pipelineFakeSnapshots struct {
	mu      sync.Mutex
	orgIDs  []string
	sources []string
}

func (f *pipelineFakeSnapshots) RefreshNewsSourceSnapshot(_ context.Context, orgID, sourceID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.orgIDs = append(f.orgIDs, orgID)
	f.sources = append(f.sources, sourceID)
	return nil
}

// newPipelineTestService builds a Service without touching any constructor that
// needs a database, so the stage orchestration can be tested with fakes.
func newPipelineTestService(t *testing.T) (*Service, *pipelineTestRecorder, *pipelineMetadataCapture) {
	t.Helper()
	recorder := &pipelineTestRecorder{}
	capture := &pipelineMetadataCapture{}
	service := &Service{
		config:        RuntimeConfig{MaxInputChars: 8_000, OutboxDeliveryConcurrency: 2},
		now:           func() time.Time { return pipelineTestNow },
		logf:          func(string, ...any) {},
		deliverySlots: make(chan struct{}, 2),
		metadataExec:  capture.exec,
	}
	return service, recorder, capture
}

func pipelineTestJob() Job {
	return Job{
		Queue:           "news_pipeline",
		JobID:           "job-1",
		ItemMetaID:      "meta-1",
		RawItemID:       "raw-1",
		OrgID:           "org-1",
		ProcessedItemID: "507f1f77bcf86cd799439011",
		PipelineJobID:   stringPointer("pipeline-1"),
	}
}

func pipelineTestRaw() RawItem {
	return RawItem{
		ID:         "raw-1",
		ItemMetaID: "meta-1",
		Payload:    json.RawMessage(`{"url":"https://example.com/a","sourceName":"Example","tags":["news"]}`),
	}
}

func pipelineTestArticle() ArticleWithCache {
	return ArticleWithCache{
		CrawledArticle: CrawledArticle{
			SourceURL:   "https://example.com/a?id=5&utm_source=x",
			Markdown:    strings.Repeat("news article sentence ", 60),
			Metadata:    json.RawMessage(`{"title":"Example article"}`),
			PublishedAt: stringPointer("2026-01-01T00:00:00.000Z"),
			FetchedAt:   "2026-01-01T00:00:00.000Z",
			ContentHash: "content-hash-1",
		},
	}
}

func pipelineTestCleaned() CleanedNews {
	return CleanedNews{
		Title:              stringPointer("Title"),
		Source:             stringPointer("Example"),
		PublishedAt:        stringPointer("2026-01-01T00:00:00.000Z"),
		Language:           stringPointer("en"),
		CategoryLabels:     []string{},
		CategoryCandidates: []ClassificationCandidate{},
		Topics:             []string{"markets"},
		Summary:            stringPointer("summary"),
		KeyPoints:          []string{},
		Entities:           []Entity{},
		KGRelations:        []KGRelation{},
		RemovedNoiseTypes:  []string{},
		CleanedMarkdown:    strings.Repeat("clean article body ", 40),
		CategoryPath:       stringPointer("news/markets"),
		CategoryMethod:     stringPointer("rule"),
		CategoryConfidence: floatPointer(0.9),
		QualityScore:       floatPointer(0.8),
		LLMModel:           stringPointer("model-x"),
		LLMPromptVersion:   stringPointer("prompt-v1"),
	}
}

// pipelineTestUnclassifiedCleaned is the clean-stage output before the classifier
// ran: every classification member is absent.
func pipelineTestUnclassifiedCleaned() CleanedNews {
	cleaned := pipelineTestCleaned()
	cleaned.Category = nil
	cleaned.CategoryPath = nil
	cleaned.CategoryLabels = []string{}
	cleaned.CategoryConfidence = nil
	cleaned.CategoryReason = nil
	cleaned.CategoryMethod = nil
	cleaned.CategoryCandidates = []ClassificationCandidate{}
	return cleaned
}

func pipelineTestLLM() LLMMetadata {
	return LLMMetadata{
		Model:            stringPointer("model-x"),
		PromptVersion:    stringPointer("prompt-v1"),
		PromptTokens:     floatPointer(100),
		CompletionTokens: floatPointer(50),
		TotalTokens:      floatPointer(150),
		CostUSD:          floatPointer(0.01),
		LatencyMS:        floatPointer(250),
	}
}

func pipelineTestLegacySettings() ExtractionSettings {
	return ExtractionSettings{
		PipelineMode:  PipelineModeLegacy,
		PreflightGate: PreflightGate{},
		PostCleanGate: PostCleanGate{},
		Capabilities:  ExtractionCapabilities{},
		Providers:     ExtractionProviders{Clean: "llm", Entities: "llm", Sentiment: "llm", KG: "llm"},
	}
}

func pipelineTestStagedSettings() ExtractionSettings {
	return ExtractionSettings{
		PipelineMode: PipelineModeStaged,
		PreflightGate: PreflightGate{
			Enabled:            true,
			MinWordCount:       10,
			MinQualityScore:    0.4,
			RejectBotChallenge: true,
			RejectListLike:     true,
		},
		PostCleanGate: PostCleanGate{
			Enabled:         true,
			MinQualityScore: 0.3,
			MinCleanedChars: 10,
			RequireSummary:  true,
		},
		Capabilities: ExtractionCapabilities{Entities: true, Sentiment: true, KG: true},
		Providers:    ExtractionProviders{Clean: "llm", Entities: "llm", Sentiment: "llm", KG: "llm"},
	}
}

func TestProcessNormalizeFailureDoesNotCrawl(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	cleaner := &pipelineFakeCleaner{recorder: recorder}
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = cleaner
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	service.store = &pipelineFakeStore{recorder: recorder}

	raw := pipelineTestRaw()
	raw.Payload = json.RawMessage(`{"language":"en"}`)
	if _, err := service.Process(context.Background(), pipelineTestJob(), raw); err == nil {
		t.Fatal("expected the normalize stage to fail")
	}
	for _, call := range recorder.list() {
		if call == "crawl" {
			t.Fatal("crawl must not run after a normalize failure")
		}
	}
}

func TestProcessCrawlFailureStopsPipeline(t *testing.T) {
	service, recorder, capture := newPipelineTestService(t)
	cleaner := &pipelineFakeCleaner{recorder: recorder, fetchErr: errors.New("crawl failed")}
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = cleaner
	service.store = &pipelineFakeStore{recorder: recorder}

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err == nil {
		t.Fatal("expected the crawl stage to fail")
	}
	if calls := recorder.list(); len(calls) != 1 || calls[0] != "crawl" {
		t.Fatalf("unexpected calls after crawl failure: %v", calls)
	}
	if stages := capture.stageList(); len(stages) != 0 {
		t.Fatalf("no pipeline job metadata should be written before the staged gates: %v", stages)
	}
}

func TestProcessLegacyOrderAndClassification(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	job := pipelineTestJob()
	raw := pipelineTestRaw()
	article := pipelineTestArticle()
	cleaned := pipelineTestUnclassifiedCleaned()
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     article,
		cleanResult: CleanResult{Cleaned: cleaned, LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.classifier = &pipelineFakeClassifier{
		recorder: recorder,
		result: newsclassifier.Result{
			LegacyCategory: "markets",
			CategoryPath:   stringPointer("news/markets"),
			Labels:         []string{"markets"},
			Confidence:     floatPointer(0.9),
			Method:         "llm",
		},
	}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	result, err := service.Process(context.Background(), job, raw)
	if err != nil {
		t.Fatalf("process failed: %v", err)
	}
	expectedCalls := []string{"crawl", "clean:llm", "classify", "dedupe", "persist"}
	if got := recorder.list(); !pipelineTestEqualStrings(got, expectedCalls) {
		t.Fatalf("unexpected stage order: got %v want %v", got, expectedCalls)
	}
	if store.input.Cleaned.CategoryPath == nil || *store.input.Cleaned.CategoryPath != "news/markets" {
		t.Fatalf("classified cleaned news was not persisted: %#v", store.input.Cleaned.CategoryPath)
	}
	if result.ProcessedItemID != job.ProcessedItemID {
		t.Fatalf("processed item id = %q, want %q", result.ProcessedItemID, job.ProcessedItemID)
	}
	if result.OutboxID != "outbox-1" {
		t.Fatalf("outbox id = %q", result.OutboxID)
	}
	var document map[string]any
	if err := json.Unmarshal(result.Document, &document); err != nil {
		t.Fatalf("document is not JSON: %v", err)
	}
	if document["_id"] != job.ProcessedItemID || document["id"] != job.ProcessedItemID {
		t.Fatalf("unexpected pending document: %s", result.Document)
	}
}

func TestProcessLegacyWithoutClassifierSkipsClassification(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	cleaned := pipelineTestUnclassifiedCleaned()
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: cleaned, LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	deduper := &pipelineFakeDeduper{recorder: recorder}
	service.deduper = deduper
	service.store = &pipelineFakeStore{recorder: recorder}

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	expectedCalls := []string{"crawl", "clean:llm", "dedupe", "persist"}
	if got := recorder.list(); !pipelineTestEqualStrings(got, expectedCalls) {
		t.Fatalf("unexpected stage order: got %v want %v", got, expectedCalls)
	}
	if deduper.input.Cleaned.CategoryPath != nil {
		t.Fatal("cleaned news must stay unclassified when no classifier is wired")
	}
}

func TestProcessLegacyClassificationFailurePropagates(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.classifier = &pipelineFakeClassifier{recorder: recorder, err: errors.New("classifier down")}
	deduper := &pipelineFakeDeduper{recorder: recorder}
	service.deduper = deduper
	store := &pipelineFakeStore{recorder: recorder}
	service.store = store

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err == nil {
		t.Fatal("expected the classify stage to fail")
	}
	for _, call := range recorder.list() {
		if call == "dedupe" || call == "persist" {
			t.Fatalf("classification failure must abort the legacy pipeline, calls: %v", recorder.list())
		}
	}
}

func TestProcessLegacyPersistFailureRevertsDuplicateMark(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	duplicateOf := "507f1f77bcf86cd799439012"
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	deduper := &pipelineFakeDeduper{
		recorder: recorder,
		result: DedupeResult{
			DuplicateOf:         &duplicateOf,
			DuplicateSimilarity: floatPointer(0.97),
		},
	}
	service.deduper = deduper
	service.store = &pipelineFakeStore{recorder: recorder, err: errors.New("persist failed")}

	if _, err := service.Process(context.Background(), pipelineTestJob(), pipelineTestRaw()); err == nil {
		t.Fatal("expected the persist stage to fail")
	}
	if !deduper.reverted {
		t.Fatal("the Duplicate mark must be reverted after a persist failure")
	}
	if deduper.revertedWith == nil || *deduper.revertedWith != duplicateOf {
		t.Fatalf("revert must receive the dedupe duplicateOf, got %v", deduper.revertedWith)
	}
}

func TestProcessAsyncDeliveryAndSnapshotAfterCommit(t *testing.T) {
	service, recorder, _ := newPipelineTestService(t)
	service.settings = &pipelineFakeSettings{extraction: pipelineTestLegacySettings()}
	service.cleaner = &pipelineFakeCleaner{
		recorder:    recorder,
		article:     pipelineTestArticle(),
		cleanResult: CleanResult{Cleaned: pipelineTestCleaned(), LLM: pipelineTestLLM(), ContentHash: "content-hash-1"},
	}
	service.deduper = &pipelineFakeDeduper{recorder: recorder}
	service.store = &pipelineFakeStore{recorder: recorder}
	outbox := &pipelineFakeOutbox{deliveries: make(chan string, 1), result: true}
	snapshots := &pipelineFakeSnapshots{}
	service.outbox = outbox
	service.snapshots = snapshots
	job := pipelineTestJob()
	job.SourceID = stringPointer("source-1")

	if _, err := service.Process(context.Background(), job, pipelineTestRaw()); err != nil {
		t.Fatalf("process failed: %v", err)
	}
	select {
	case outboxID := <-outbox.deliveries:
		if outboxID != "outbox-1" {
			t.Fatalf("delivered outbox id = %q", outboxID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("immediate delivery was not scheduled after commit")
	}
	service.waitAsync()
	if len(snapshots.sources) != 1 || snapshots.sources[0] != "source-1" {
		t.Fatalf("snapshot refresh was not scheduled: %#v", snapshots.sources)
	}
}

func pipelineTestEqualStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
