package newspipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
	"github.com/wei500L/newwei/apps/api-go/internal/vectorclient"
)

// --- fakes ---

// fakeDedupeStore records the candidate queries and returns canned documents.
type fakeDedupeStore struct {
	exists            bool
	existsErr         error
	existsCall        bool
	existsOrgID       string
	existsItemMetaID  string
	existsProcessedID string

	llmCandidates []dedupeLLMCandidate
	llmErr        error
	llmOrgID      string
	llmExclude    string
	llmCutoff     time.Time
	llmLimit      int
	llmCalls      int

	allowed      map[string]struct{}
	allowedErr   error
	allowedOrgID string
	allowedModel string
	allowedIDs   []bson.ObjectID
	allowedCalls int

	semanticCandidates []dedupeSemanticCandidate
	semanticErr        error
	semanticOrgID      string
	semanticModel      string
	semanticExclude    string
	semanticCalls      int
}

func (f *fakeDedupeStore) ProcessedItemExists(_ context.Context, orgID, itemMetaID, processedItemID string) (bool, error) {
	f.existsCall = true
	f.existsOrgID = orgID
	f.existsItemMetaID = itemMetaID
	f.existsProcessedID = processedItemID
	return f.exists, f.existsErr
}

func (f *fakeDedupeStore) LLMCandidates(_ context.Context, orgID, excludeItemMetaID string, cutoff time.Time, limit int) ([]dedupeLLMCandidate, error) {
	f.llmCalls++
	f.llmOrgID = orgID
	f.llmExclude = excludeItemMetaID
	f.llmCutoff = cutoff
	f.llmLimit = limit
	return f.llmCandidates, f.llmErr
}

func (f *fakeDedupeStore) AllowedVectorIDs(_ context.Context, orgID, embeddingModel, excludeItemMetaID string, _ time.Time, ids []bson.ObjectID) (map[string]struct{}, error) {
	f.allowedCalls++
	f.allowedOrgID = orgID
	f.allowedModel = embeddingModel
	f.allowedIDs = ids
	return f.allowed, f.allowedErr
}

func (f *fakeDedupeStore) SemanticCandidates(_ context.Context, orgID, embeddingModel, excludeItemMetaID string, _ time.Time, _ int) ([]dedupeSemanticCandidate, error) {
	f.semanticCalls++
	f.semanticOrgID = orgID
	f.semanticModel = embeddingModel
	f.semanticExclude = excludeItemMetaID
	return f.semanticCandidates, f.semanticErr
}

// dedupeFakeSQL records the duplicate-mark statements.
type dedupeFakeSQL struct {
	queries []string
	args    [][]any
	err     error
}

func (f *dedupeFakeSQL) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	f.queries = append(f.queries, query)
	f.args = append(f.args, args)
	if f.err != nil {
		return nil, f.err
	}
	return dedupeFakeSQLResult(0), nil
}

type dedupeFakeSQLResult int64

func (r dedupeFakeSQLResult) LastInsertId() (int64, error) { return 0, nil }
func (r dedupeFakeSQLResult) RowsAffected() (int64, error) { return int64(r), nil }

// dedupeFakeModels is the LiteLLM fake.
type dedupeFakeModels struct {
	mu sync.Mutex

	completionCalls int
	completion      func(ctx context.Context, request litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error)

	embeddingCalls int
	embeddingResp  litellmcompat.EmbeddingResponse
	embeddingErr   error

	runtimeEmbedding    litellmcompat.RuntimeModel
	runtimeEmbeddingErr error
}

func (f *dedupeFakeModels) Completion(ctx context.Context, request litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
	f.mu.Lock()
	f.completionCalls++
	handler := f.completion
	f.mu.Unlock()
	if handler == nil {
		return litellmcompat.CompletionResponse{}, errors.New("no completion handler")
	}
	return handler(ctx, request)
}

func (f *dedupeFakeModels) Embedding(context.Context, litellmcompat.EmbeddingRequest) (litellmcompat.EmbeddingResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.embeddingCalls++
	return f.embeddingResp, f.embeddingErr
}

func (f *dedupeFakeModels) Rerank(context.Context, litellmcompat.RerankRequest) (litellmcompat.RerankResponse, error) {
	return litellmcompat.RerankResponse{}, errors.New("unused")
}

func (f *dedupeFakeModels) RuntimeEmbeddingModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return f.runtimeEmbedding, f.runtimeEmbeddingErr
}

func (f *dedupeFakeModels) RuntimeRerankModel(context.Context) (litellmcompat.RuntimeModel, error) {
	return litellmcompat.RuntimeModel{}, errors.New("unused")
}

func (f *dedupeFakeModels) CompletionTimeoutMS(context.Context) (int, error) {
	return 0, errors.New("unused")
}

func (f *dedupeFakeModels) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.completionCalls
}

// dedupeFakeSearcher is a vectorclient.Searcher without the fallback extension, so the
// default (enabled) fallback rule applies.
type dedupeFakeSearcher struct {
	matches  []vectorclient.SearchMatch
	err      error
	requests []vectorclient.SearchRequest
}

func (f *dedupeFakeSearcher) SearchBestEffort(_ context.Context, request vectorclient.SearchRequest) ([]vectorclient.SearchMatch, error) {
	// The dedupe stage calls the searcher from the stage goroutine only, so the
	// fake needs no locking (kept copyable for the fallback variant's literal).
	f.requests = append(f.requests, request)
	return f.matches, f.err
}

func (f *dedupeFakeSearcher) lastRequest() (vectorclient.SearchRequest, bool) {
	if len(f.requests) == 0 {
		return vectorclient.SearchRequest{}, false
	}
	return f.requests[len(f.requests)-1], true
}

// dedupeFakeSearcherWithFallback exposes the fallbackToMongo override, like the
// concrete vectorclient search client does.
type dedupeFakeSearcherWithFallback struct {
	dedupeFakeSearcher
	fallbackToMongo bool
}

func (f *dedupeFakeSearcherWithFallback) FallbackToMongoEnabled(context.Context) bool {
	return f.fallbackToMongo
}

// dedupeFakeSettings is the org settings provider fake.
type dedupeFakeSettings struct {
	settings DedupeSettings
}

func (f dedupeFakeSettings) Dedupe(context.Context, string) DedupeSettings { return f.settings }

// --- helpers ---

func dedupeTestRuntime() RuntimeConfig {
	return RuntimeConfig{
		SummaryDedupEnabled:       true,
		SummaryDedupThreshold:     0.88,
		SummaryDedupLookbackHours: 24,
		SummaryDedupMaxCandidates: 50,
		SummaryDedupMinChars:      10,
	}
}

func dedupeTestSettings() DedupeSettings {
	return DedupeSettings{
		DefaultThreshold:       0.88,
		UseEmbeddings:          false,
		LLMJudgeConcurrency:    4,
		LLMJudgeMaxComparisons: 12,
		LLMJudgeCandidateChars: 1_200,
		LLMJudgePromptVersion:  "news-dedupe-judge-v1",
	}
}

// testDeduper builds a Deduper with the fakes injected over the constructor.
type dedupeHarness struct {
	deduper  *Deduper
	store    *fakeDedupeStore
	sql      *dedupeFakeSQL
	models   *dedupeFakeModels
	searcher vectorclient.Searcher
	now      time.Time
}

func newDedupeHarness(options func(*dedupeHarness)) *dedupeHarness {
	harness := &dedupeHarness{
		store: &fakeDedupeStore{},
		sql:   &dedupeFakeSQL{},
		models: &dedupeFakeModels{
			runtimeEmbedding: litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true},
		},
		now: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC),
	}
	if options != nil {
		options(harness)
	}
	deduper := NewDeduper(DeduperDeps{
		Runtime: dedupeTestRuntime(),
		Models:  harness.models,
		Vector:  harness.searcher,
		Now:     func() time.Time { return harness.now },
	})
	deduper.store = harness.store
	deduper.sql = harness.sql
	harness.deduper = deduper
	return harness
}

// withSettings attaches the org settings fake.
func (h *dedupeHarness) withSettings(settings DedupeSettings) *dedupeHarness {
	h.deduper.settings = dedupeFakeSettings{settings: settings}
	return h
}

// withRuntime overrides the runtime config.
func (h *dedupeHarness) withRuntime(runtime RuntimeConfig) *dedupeHarness {
	h.deduper.runtime = runtime
	return h
}

func dedupeStringPtr(value string) *string {
	copy := value
	return &copy
}

func dedupeObjectIDHex(seed int) string {
	// A deterministic 24 hex character id.
	return fmt.Sprintf("5f1f8a7c2b3c4d5e6f7081%02x", seed%256)
}

func dedupeSummaryInput(summary string) DedupeInput {
	return DedupeInput{
		Job:     Job{OrgID: "org-1", ItemMetaID: "meta-1", JobID: "job-1"},
		Payload: NormalizedPayload{},
		Cleaned: CleanedNews{Summary: dedupeStringPtr(summary)},
	}
}

func dedupeBSONLookup(t *testing.T, filter bson.D, key string) (any, bool) {
	t.Helper()
	for _, element := range filter {
		if element.Key == key {
			return element.Value, true
		}
	}
	return nil, false
}

// dedupeMustRawBSON decodes an extended JSON fragment into a bson.RawValue.
func dedupeMustRawBSON(t *testing.T, fragment string) bson.RawValue {
	t.Helper()
	var holder struct {
		Value bson.RawValue `bson:"value"`
	}
	if err := bson.UnmarshalExtJSON([]byte(`{"value":`+fragment+`}`), false, &holder); err != nil {
		t.Fatalf("decode %q: %v", fragment, err)
	}
	return holder.Value
}

// --- content duplicate short circuit ---

func TestDedupeEvaluateContentDuplicateSelfReferenceIsSkipped(t *testing.T) {
	harness := newDedupeHarness(nil)
	harness.store.exists = true
	ref := dedupeObjectIDHex(1)

	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), DedupeInput{
		Job:                Job{OrgID: "org-1", ItemMetaID: "meta-1"},
		Cleaned:            CleanedNews{Summary: dedupeStringPtr("a long enough summary")},
		ContentDuplicateOf: &ref,
	})
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf != nil || result.DuplicateSimilarity != nil || result.ThresholdUsed != nil {
		t.Fatalf("result = %+v, want the zero result", result)
	}
	if !harness.store.existsCall || harness.store.existsOrgID != "org-1" ||
		harness.store.existsItemMetaID != "meta-1" || harness.store.existsProcessedID != ref {
		t.Errorf("self-reference query = %+v", harness.store)
	}
	if len(harness.sql.queries) != 0 {
		t.Errorf("no duplicate mark expected, got %v", harness.sql.queries)
	}
}

func TestDedupeEvaluateContentDuplicateMarksItemMeta(t *testing.T) {
	harness := newDedupeHarness(nil)
	harness.store.exists = false
	ref := dedupeObjectIDHex(2)

	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), DedupeInput{
		Job:                Job{OrgID: "org-1", ItemMetaID: "meta-1"},
		Cleaned:            CleanedNews{Summary: dedupeStringPtr("a long enough summary")},
		ContentDuplicateOf: &ref,
	})
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != ref {
		t.Errorf("DuplicateOf = %v", result.DuplicateOf)
	}
	if result.DuplicateSimilarity == nil || *result.DuplicateSimilarity != 1 {
		t.Errorf("DuplicateSimilarity = %v", result.DuplicateSimilarity)
	}
	if result.ThresholdUsed != nil {
		t.Errorf("ThresholdUsed = %v, want nil", result.ThresholdUsed)
	}
	if len(harness.sql.queries) != 1 || len(harness.sql.args) != 1 {
		t.Fatalf("mark queries = %v args = %v", harness.sql.queries, harness.sql.args)
	}
	args := harness.sql.args[0]
	if len(args) != 4 {
		t.Fatalf("mark args = %v", args)
	}
	if args[0] != itemsreading.ItemStatusDuplicate {
		t.Errorf("status arg = %v", args[0])
	}
	if args[2] != "meta-1" || args[3] != "org-1" {
		t.Errorf("itemMetaId/orgId args = %v/%v", args[2], args[3])
	}
}

func TestDedupeEvaluateContentDuplicateSwallowsMarkFailure(t *testing.T) {
	harness := newDedupeHarness(nil)
	harness.store.exists = false
	harness.sql.err = errors.New("mysql down")
	ref := dedupeObjectIDHex(3)

	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), DedupeInput{
		Job:                Job{OrgID: "org-1", ItemMetaID: "meta-1"},
		ContentDuplicateOf: &ref,
	})
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v, want the mark failure swallowed", err)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != ref {
		t.Errorf("DuplicateOf = %v", result.DuplicateOf)
	}
}

// --- summary dedupe guards and thresholds ---

func TestDedupeEvaluateSummaryDedupeDisabledOrTooShort(t *testing.T) {
	disabled := dedupeTestRuntime()
	disabled.SummaryDedupEnabled = false
	harness := newDedupeHarness(nil).withRuntime(disabled)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput("a long enough summary"))
	if err != nil || result.ThresholdUsed != nil || harness.store.existsCall || harness.store.llmCalls != 0 {
		t.Fatalf("disabled result = %+v err = %v", result, err)
	}

	harness = newDedupeHarness(nil).withSettings(dedupeTestSettings())
	// The trimmed summary is shorter than SummaryDedupMinChars (10).
	short := DedupeInput{
		Job:     Job{OrgID: "org-1", ItemMetaID: "meta-1"},
		Cleaned: CleanedNews{Summary: dedupeStringPtr("   short   ")},
	}
	result, err = harness.deduper.EvaluateSummaryDedupe(context.Background(), short)
	if err != nil || result.ThresholdUsed != nil {
		t.Fatalf("short result = %+v err = %v", result, err)
	}
	if harness.store.llmCalls != 0 || harness.store.existsCall {
		t.Errorf("no candidate query expected")
	}
}

func TestDedupeEvaluateThresholdUsesSettingsAndScopes(t *testing.T) {
	// 150 characters: inside the base band, so the default threshold applies.
	summary := strings.Repeat("market analysts expect steady growth ", 4)
	settings := dedupeTestSettings()
	settings.DefaultThreshold = 0.9

	harness := newDedupeHarness(nil).withSettings(settings)
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.1,"is_duplicate":false}`}, nil
	}
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.ThresholdUsed == nil || *result.ThresholdUsed != 0.9 {
		t.Fatalf("ThresholdUsed = %v, want 0.9", result.ThresholdUsed)
	}

	// A scoped override wins over the default; the source id comes from the
	// payload metadata when the job has none.
	scoped := dedupeTestSettings()
	scoped.DefaultThreshold = 0.9
	scoped.ScopedThresholds = []ScopedThreshold{
		{SourceID: dedupeStringPtr("src-1"), Threshold: 0.7},
	}
	payload := NormalizedPayload{Metadata: json.RawMessage(`{"sourceId":"src-1"}`)}
	input := DedupeInput{
		Job:     Job{OrgID: "org-1", ItemMetaID: "meta-1"},
		Payload: payload,
		Cleaned: CleanedNews{Summary: dedupeStringPtr(summary)},
	}
	harness = newDedupeHarness(nil).withSettings(scoped)
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.1,"is_duplicate":false}`}, nil
	}
	result, err = harness.deduper.EvaluateSummaryDedupe(context.Background(), input)
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.ThresholdUsed == nil || *result.ThresholdUsed != 0.7 {
		t.Fatalf("scoped ThresholdUsed = %v, want 0.7", result.ThresholdUsed)
	}
}

func TestDedupeResolveSummaryDedupThreshold(t *testing.T) {
	cases := []struct {
		length int
		base   float64
		want   float64
	}{
		{length: 79, base: 0.88, want: 0.92},
		{length: 1, base: 0.95, want: 0.96},
		{length: 80, base: 0.88, want: 0.9},
		{length: 119, base: 0.93, want: 0.94},
		{length: 120, base: 0.88, want: 0.88},
		{length: 200, base: 0.88, want: 0.88},
		{length: 201, base: 0.88, want: 0.88},
		{length: 201, base: 0.8, want: 0.88},
		{length: 201, base: 0.87, want: 0.88},
		{length: 281, base: 0.88, want: 0.86},
		{length: 281, base: 0.9, want: 0.87},
	}
	for _, testCase := range cases {
		if got := resolveSummaryDedupThreshold(testCase.length, testCase.base); got != testCase.want {
			t.Errorf("resolveSummaryDedupThreshold(%d, %v) = %v, want %v", testCase.length, testCase.base, got, testCase.want)
		}
	}
}

// --- LLM judge path ---

func TestDedupeEvaluateLlmJudgeFindsDuplicate(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank to raise rates ", 3)
	settings := dedupeTestSettings()
	settings.LLMJudgeMaxComparisons = 12

	candidateTextA := query + " A"
	candidateTextB := query + " BB"
	candidateTextC := "completely unrelated weather report about the northern coast"
	candidateID := dedupeObjectIDHex(4)
	harness := newDedupeHarness(nil).withSettings(settings)
	harness.store.llmCandidates = []dedupeLLMCandidate{
		{ID: dedupeObjectIDHex(5), Summary: dedupeStringPtr(candidateTextC), Title: dedupeStringPtr("weather")},
		{ID: candidateID, Summary: dedupeStringPtr(candidateTextA), Title: dedupeStringPtr("rates")},
		{ID: dedupeObjectIDHex(6), Summary: dedupeStringPtr(candidateTextB), Title: dedupeStringPtr("rates 2")},
	}
	harness.models.completion = func(_ context.Context, request litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		if request.Model != "" {
			t.Errorf("judge model = %q, want the default", request.Model)
		}
		if len(request.Messages) != 2 || request.Messages[0].Role != "system" || request.Messages[1].Role != "user" {
			t.Errorf("judge messages = %+v", request.Messages)
		}
		if request.Temperature == nil || *request.Temperature != 0 || request.TopP == nil || *request.TopP != 1 {
			t.Errorf("judge temperature/top_p = %v/%v", request.Temperature, request.TopP)
		}
		if request.MaxTokens == nil || *request.MaxTokens != 256 {
			t.Errorf("judge max_tokens = %v", request.MaxTokens)
		}
		if request.ResponseFormat == nil || request.ResponseFormat.Type != "json_schema" {
			t.Errorf("judge response format = %+v", request.ResponseFormat)
		}
		if request.Metadata == nil {
			t.Error("judge metadata must be set")
		}
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.95,"is_duplicate":true}`}, nil
	}

	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != candidateID {
		t.Fatalf("DuplicateOf = %v, want the highest quick-similarity candidate %s", result.DuplicateOf, candidateID)
	}
	if result.DuplicateSimilarity == nil || *result.DuplicateSimilarity != 0.95 {
		t.Errorf("DuplicateSimilarity = %v", result.DuplicateSimilarity)
	}
	if result.ThresholdUsed == nil {
		t.Error("ThresholdUsed must be set")
	}
	if harness.models.calls() != 3 {
		t.Errorf("judge calls = %d, want 3", harness.models.calls())
	}
	if len(harness.sql.queries) != 1 {
		t.Errorf("duplicate marks = %d, want 1", len(harness.sql.queries))
	}
}

func TestDedupeEvaluateLlmJudgeEarlyExitAt098(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank to raise rates ", 2)
	settings := dedupeTestSettings()
	settings.LLMJudgeMaxComparisons = 12
	harness := newDedupeHarness(nil).withSettings(settings)

	for index := 0; index < 12; index++ {
		suffix := strings.Repeat("x", index+1)
		harness.store.llmCandidates = append(harness.store.llmCandidates, dedupeLLMCandidate{
			ID:      dedupeObjectIDHex(index),
			Summary: dedupeStringPtr(query + " " + suffix),
		})
	}
	ready := make(chan struct{})
	var once sync.Once
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		harness.models.mu.Lock()
		if harness.models.completionCalls == 4 {
			once.Do(func() { close(ready) })
		}
		harness.models.mu.Unlock()
		<-ready
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.99,"is_duplicate":true}`}, nil
	}

	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if harness.models.calls() != 4 {
		t.Errorf("judge calls = %d, want 4 (early exit at 0.98)", harness.models.calls())
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != dedupeObjectIDHex(0) {
		t.Errorf("DuplicateOf = %v, want the top-ranked candidate", result.DuplicateOf)
	}
}

func TestDedupeEvaluateLlmJudgeInvalidOrFailedCallIsSkipped(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank ", 3)
	settings := dedupeTestSettings()
	harness := newDedupeHarness(nil).withSettings(settings)
	harness.store.llmCandidates = []dedupeLLMCandidate{
		{ID: dedupeObjectIDHex(7), Summary: dedupeStringPtr(query + " one")},
		{ID: dedupeObjectIDHex(8), Summary: dedupeStringPtr(query + " two")},
	}
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{Content: "not-json"}, nil
	}
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf != nil || result.DuplicateSimilarity != nil {
		t.Errorf("result = %+v, want no duplicate", result)
	}
	if result.ThresholdUsed == nil {
		t.Error("ThresholdUsed must be set")
	}
	if len(harness.sql.queries) != 0 {
		t.Errorf("duplicate marks = %d, want 0", len(harness.sql.queries))
	}

	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{}, errors.New("upstream down")
	}
	result, err = harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf != nil {
		t.Errorf("result = %+v, want no duplicate", result)
	}
}

func TestDedupeEvaluateLlmJudgeDuplicateVerdicts(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank ", 3)
	cases := []struct {
		name    string
		payload string
		wantDup bool
	}{
		{name: "is_duplicate true below threshold", payload: `{"similarity":0.8,"is_duplicate":true}`, wantDup: false},
		{name: "is_duplicate false above threshold", payload: `{"similarity":0.93,"is_duplicate":false}`, wantDup: true},
		{name: "invalid similarity", payload: `{"similarity":"high","is_duplicate":true}`, wantDup: false},
		{name: "missing is_duplicate", payload: `{"similarity":0.99}`, wantDup: false},
		// Out of schema: NewsDedupeJudgeSchema.safeParse rejects the verdict, so
		// no clamp may promote it into a Duplicate mark.
		{name: "similarity above one", payload: `{"similarity":1.4,"is_duplicate":true}`, wantDup: false},
		{name: "similarity below zero", payload: `{"similarity":-0.2,"is_duplicate":true}`, wantDup: false},
		{name: "malformed rationale", payload: `{"similarity":0.99,"is_duplicate":true,"rationale":7}`, wantDup: false},
		{name: "over-long rationale", payload: `{"similarity":0.99,"is_duplicate":true,"rationale":"` + strings.Repeat("r", 281) + `"}`, wantDup: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := newDedupeHarness(nil).withSettings(dedupeTestSettings())
			harness.store.llmCandidates = []dedupeLLMCandidate{
				{ID: dedupeObjectIDHex(9), Summary: dedupeStringPtr(query + " one")},
			}
			harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
				return litellmcompat.CompletionResponse{Content: testCase.payload}, nil
			}
			result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
			if err != nil {
				t.Fatalf("EvaluateSummaryDedupe error = %v", err)
			}
			if testCase.wantDup && result.DuplicateOf == nil {
				t.Errorf("want a duplicate, got %+v", result)
			}
			if !testCase.wantDup && result.DuplicateOf != nil {
				t.Errorf("want no duplicate, got %+v", result)
			}
		})
	}
}

func TestDedupeEvaluateLlmCandidateQueryIsOrgScoped(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank ", 3)
	harness := newDedupeHarness(nil).withSettings(dedupeTestSettings())
	harness.store.llmCandidates = nil
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.1,"is_duplicate":false}`}, nil
	}
	if _, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query)); err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if harness.store.llmCalls != 1 {
		t.Fatalf("llm candidate calls = %d", harness.store.llmCalls)
	}
	if harness.store.llmOrgID != "org-1" || harness.store.llmExclude != "meta-1" {
		t.Errorf("candidate query = org %q exclude %q", harness.store.llmOrgID, harness.store.llmExclude)
	}
	wantCutoff := harness.now.Add(-24 * time.Hour)
	if !harness.store.llmCutoff.Equal(wantCutoff) {
		t.Errorf("cutoff = %v, want %v", harness.store.llmCutoff, wantCutoff)
	}
	if harness.store.llmLimit != 50 {
		t.Errorf("limit = %d, want 50", harness.store.llmLimit)
	}
}

// --- embedding path ---

func TestDedupeEvaluateEmbeddingUnconfiguredModelSkipsSemanticDedupe(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	searcher := &dedupeFakeSearcher{}
	harness := newDedupeHarness(func(h *dedupeHarness) { h.searcher = searcher }).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{}

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.ThresholdUsed == nil || result.SummaryEmbedding != nil || result.SummaryEmbeddingModel != nil {
		t.Errorf("result = %+v", result)
	}
	if len(searcher.requests) != 0 {
		t.Errorf("vector requests = %d, want 0", len(searcher.requests))
	}
}

func TestDedupeEvaluateEmbeddingErrorSkipsSemanticDedupe(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	searcher := &dedupeFakeSearcher{}
	harness := newDedupeHarness(func(h *dedupeHarness) { h.searcher = searcher }).withSettings(settings)
	harness.models.embeddingErr = errors.New("embedding down")

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.ThresholdUsed == nil || result.SummaryEmbedding != nil {
		t.Errorf("result = %+v", result)
	}
	if len(searcher.requests) != 0 {
		t.Errorf("vector requests = %d, want 0", len(searcher.requests))
	}
}

func TestDedupeEvaluateEmbeddingPathUsesVectorOrder(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	searcher := &dedupeFakeSearcher{}
	harness := newDedupeHarness(func(h *dedupeHarness) { h.searcher = searcher }).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
	harness.models.embeddingResp = litellmcompat.EmbeddingResponse{
		Rows:  []litellmcompat.EmbeddingRow{{Index: 0, Embedding: []float64{0.6, 0.8}}},
		Model: "embed-v2",
	}
	selfID := dedupeObjectIDHex(0)
	firstAllowed := dedupeObjectIDHex(1)
	secondAllowed := dedupeObjectIDHex(2)
	searcher.matches = []vectorclient.SearchMatch{
		{ProcessedItemID: selfID, ItemMetaID: "meta-1", Score: 0.99},
		{ProcessedItemID: firstAllowed, ItemMetaID: "meta-2", Score: 0.97},
		{ProcessedItemID: secondAllowed, ItemMetaID: "meta-3", Score: 0.96},
	}
	harness.store.allowed = map[string]struct{}{firstAllowed: {}, secondAllowed: {}}

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	input := dedupeSummaryInput(summary)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), input)
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	request, ok := searcher.lastRequest()
	if !ok {
		t.Fatal("no vector search issued")
	}
	if request.OrgID != "org-1" || request.EmbeddingModel != "embed-v2" ||
		len(request.Vector) != 2 || request.Vector[0] != 0.6 || request.Vector[1] != 0.8 {
		t.Errorf("vector request = %+v", request)
	}
	if request.MinScore == nil || *request.MinScore != *result.ThresholdUsed {
		t.Errorf("minScore = %v, threshold = %v", request.MinScore, result.ThresholdUsed)
	}
	if request.LookbackMS == nil || *request.LookbackMS != int64(24*time.Hour/time.Millisecond) {
		t.Errorf("lookbackMs = %v", request.LookbackMS)
	}
	if result.SummaryEmbeddingModel == nil || *result.SummaryEmbeddingModel != "embed-v2" {
		t.Errorf("embedding model = %v", result.SummaryEmbeddingModel)
	}
	if len(result.SummaryEmbedding) != 2 || result.SummaryEmbedding[0] != 0.6 {
		t.Errorf("embedding = %v", result.SummaryEmbedding)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != firstAllowed {
		t.Errorf("DuplicateOf = %v, want the first allowed vector hit %s", result.DuplicateOf, firstAllowed)
	}
	if result.DuplicateSimilarity == nil || *result.DuplicateSimilarity != 0.97 {
		t.Errorf("DuplicateSimilarity = %v", result.DuplicateSimilarity)
	}
	if harness.store.allowedCalls != 1 || harness.store.allowedOrgID != "org-1" || harness.store.allowedModel != "embed-v2" {
		t.Errorf("allowed validation = %+v", harness.store)
	}
	if len(harness.store.allowedIDs) != 3 {
		t.Errorf("allowed ids = %d, want 3 (self id included in the query, then filtered)", len(harness.store.allowedIDs))
	}
}

func TestDedupeFindSemanticDuplicateFallbackRules(t *testing.T) {
	embedding := []float64{1, 0}
	summary := strings.Repeat("market analysts expect steady growth ", 4)
	candidateID := dedupeObjectIDHex(3)

	cases := []struct {
		name          string
		searcher      vectorclient.Searcher
		wantFallback  bool
		wantDuplicate bool
	}{
		{
			name:          "empty result with fallback disabled",
			searcher:      &dedupeFakeSearcherWithFallback{fallbackToMongo: false},
			wantDuplicate: false,
		},
		{
			name:          "empty result with fallback enabled",
			searcher:      &dedupeFakeSearcherWithFallback{fallbackToMongo: true},
			wantFallback:  true,
			wantDuplicate: true,
		},
		{
			name:          "unavailable with fallback disabled",
			searcher:      &dedupeFakeSearcherWithFallback{fallbackToMongo: false, dedupeFakeSearcher: dedupeFakeSearcher{err: errors.New("unavailable")}},
			wantDuplicate: false,
		},
		{
			name:          "unavailable with fallback enabled",
			searcher:      &dedupeFakeSearcherWithFallback{fallbackToMongo: true, dedupeFakeSearcher: dedupeFakeSearcher{err: errors.New("unavailable")}},
			wantFallback:  true,
			wantDuplicate: true,
		},
		{
			name:          "no searcher",
			searcher:      nil,
			wantFallback:  true,
			wantDuplicate: true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			settings := dedupeTestSettings()
			settings.UseEmbeddings = true
			harness := newDedupeHarness(func(h *dedupeHarness) { h.searcher = testCase.searcher }).withSettings(settings)
			harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
			harness.models.embeddingResp = litellmcompat.EmbeddingResponse{
				Rows: []litellmcompat.EmbeddingRow{{Embedding: embedding}},
			}
			harness.store.semanticCandidates = []dedupeSemanticCandidate{
				{ID: candidateID, SummaryEmbedding: []float64{1, 0}},
			}
			result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
			if err != nil {
				t.Fatalf("EvaluateSummaryDedupe error = %v", err)
			}
			if testCase.wantDuplicate {
				if result.DuplicateOf == nil || *result.DuplicateOf != candidateID {
					t.Errorf("DuplicateOf = %v, want %s", result.DuplicateOf, candidateID)
				}
			} else if result.DuplicateOf != nil {
				t.Errorf("DuplicateOf = %v, want none", result.DuplicateOf)
			}
			wantCalls := 0
			if testCase.wantFallback {
				wantCalls = 1
			}
			if harness.store.semanticCalls != wantCalls {
				t.Errorf("semantic scan calls = %d, want %d", harness.store.semanticCalls, wantCalls)
			}
		})
	}
}

func TestDedupeFindSemanticDuplicateFiltersVectorHits(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	invalidID := "not-an-object-id"
	allowedID := dedupeObjectIDHex(4)
	searcher := &dedupeFakeSearcher{
		matches: []vectorclient.SearchMatch{
			{ProcessedItemID: invalidID, Score: 0.99},
			{ProcessedItemID: allowedID, Score: 0.9},
		},
	}
	harness := newDedupeHarness(func(h *dedupeHarness) { h.searcher = searcher }).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
	harness.models.embeddingResp = litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{{Embedding: []float64{1, 0}}}}
	harness.store.allowed = map[string]struct{}{allowedID: {}}

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != allowedID {
		t.Fatalf("DuplicateOf = %v, want %s", result.DuplicateOf, allowedID)
	}
	if len(harness.store.allowedIDs) != 1 {
		t.Errorf("allowed ids = %d, want only the valid object id", len(harness.store.allowedIDs))
	}
}

func TestDedupeFindSemanticDuplicateMongoCosineScan(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	harness := newDedupeHarness(nil).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
	harness.models.embeddingResp = litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{{Embedding: []float64{1, 0}}}}
	highConfidenceID := dedupeObjectIDHex(5)
	higherID := dedupeObjectIDHex(6)
	harness.store.semanticCandidates = []dedupeSemanticCandidate{
		{ID: dedupeObjectIDHex(7), SummaryEmbedding: []float64{1, 0, 0}},   // dimension mismatch
		{ID: dedupeObjectIDHex(8), SummaryEmbedding: []float64{0.2, 0.98}}, // below threshold
		{ID: highConfidenceID, SummaryEmbedding: []float64{0.995, math.Sqrt(1 - 0.995*0.995)}},
		// Would win, but the >0.98 early break stops the scan.
		{ID: higherID, SummaryEmbedding: []float64{0.999, math.Sqrt(1 - 0.999*0.999)}},
	}

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.DuplicateOf == nil || *result.DuplicateOf != highConfidenceID {
		t.Fatalf("DuplicateOf = %v, want the first >0.98 match %s", result.DuplicateOf, highConfidenceID)
	}
	if result.DuplicateSimilarity == nil || math.Abs(*result.DuplicateSimilarity-0.995) > 1e-9 {
		t.Errorf("DuplicateSimilarity = %v", result.DuplicateSimilarity)
	}
	if harness.store.semanticExclude != "meta-1" || harness.store.semanticOrgID != "org-1" || harness.store.semanticModel != "embed-v1" {
		t.Errorf("semantic query = %+v", harness.store)
	}
}

func TestDedupeFindSemanticDuplicatePropagatesStoreErrors(t *testing.T) {
	settings := dedupeTestSettings()
	settings.UseEmbeddings = true
	harness := newDedupeHarness(nil).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
	harness.models.embeddingResp = litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{{Embedding: []float64{1, 0}}}}
	harness.store.semanticErr = errors.New("mongo down")

	summary := strings.Repeat("market analysts expect steady growth ", 4)
	if _, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary)); err == nil {
		t.Fatal("want the Mongo scan failure to propagate")
	}

	searcher := &dedupeFakeSearcher{matches: []vectorclient.SearchMatch{{ProcessedItemID: dedupeObjectIDHex(9), Score: 0.9}}}
	harness = newDedupeHarness(func(h *dedupeHarness) { h.searcher = searcher }).withSettings(settings)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{Model: "embed-v1", Configured: true}
	harness.models.embeddingResp = litellmcompat.EmbeddingResponse{Rows: []litellmcompat.EmbeddingRow{{Embedding: []float64{1, 0}}}}
	harness.store.allowedErr = errors.New("mongo down")
	if _, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary)); err == nil {
		t.Fatal("want the vector validation failure to propagate")
	}
}

// --- duplicate mark / revert SQL ---

func TestDedupeRevertDuplicateMarkOnPersistFailure(t *testing.T) {
	harness := newDedupeHarness(nil)
	job := Job{OrgID: "org-1", ItemMetaID: "meta-1"}

	if err := harness.deduper.RevertDuplicateMarkOnPersistFailure(context.Background(), job, nil); err != nil {
		t.Fatalf("nil duplicateOf error = %v", err)
	}
	if len(harness.sql.queries) != 0 {
		t.Fatalf("queries = %v, want none", harness.sql.queries)
	}

	ref := dedupeObjectIDHex(1)
	if err := harness.deduper.RevertDuplicateMarkOnPersistFailure(context.Background(), job, &ref); err != nil {
		t.Fatalf("revert error = %v", err)
	}
	if len(harness.sql.queries) != 1 {
		t.Fatalf("queries = %v", harness.sql.queries)
	}
	query := harness.sql.queries[0]
	if !strings.Contains(query, "SET `status` = ?") || !strings.Contains(query, "`status` = ?") {
		t.Errorf("revert query = %q", query)
	}
	args := harness.sql.args[0]
	if len(args) != 5 {
		t.Fatalf("revert args = %v", args)
	}
	if args[0] != itemsreading.ItemStatusPending || args[4] != itemsreading.ItemStatusDuplicate {
		t.Errorf("revert statuses = %v/%v", args[0], args[4])
	}
	if args[2] != "meta-1" || args[3] != "org-1" {
		t.Errorf("revert id/org args = %v/%v", args[2], args[3])
	}

	// A database failure is swallowed so the original persist error propagates.
	harness.sql.err = errors.New("mysql down")
	if err := harness.deduper.RevertDuplicateMarkOnPersistFailure(context.Background(), job, &ref); err != nil {
		t.Fatalf("revert failure error = %v, want nil", err)
	}
}

func TestDedupeMarkItemMetaDuplicateSwallowsFailure(t *testing.T) {
	query := strings.Repeat("market analysts expect the central bank ", 3)
	harness := newDedupeHarness(nil).withSettings(dedupeTestSettings())
	harness.store.llmCandidates = []dedupeLLMCandidate{
		{ID: dedupeObjectIDHex(1), Summary: dedupeStringPtr(query + " x")},
	}
	harness.models.completion = func(context.Context, litellmcompat.CompletionRequest) (litellmcompat.CompletionResponse, error) {
		return litellmcompat.CompletionResponse{Content: `{"similarity":0.99,"is_duplicate":true}`}, nil
	}
	harness.sql.err = errors.New("mysql down")
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(query))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v, want the mark failure swallowed", err)
	}
	if result.DuplicateOf == nil {
		t.Fatal("want the duplicate result even when the mark failed")
	}
}

// --- helpers ---

func TestDedupeNormalizeForQuickSimilarity(t *testing.T) {
	cases := []struct{ input, want string }{
		{input: "Hello, World!", want: "helloworld"},
		{input: "  A  B  ", want: "ab"},
		{input: "Café — test", want: "cafétest"},
		{input: "!!!", want: ""},
		{input: "中文 测试", want: "中文测试"},
	}
	for _, testCase := range cases {
		if got := normalizeForQuickSimilarity(testCase.input); got != testCase.want {
			t.Errorf("normalizeForQuickSimilarity(%q) = %q, want %q", testCase.input, got, testCase.want)
		}
	}
}

func TestDedupeQuickSimilarity(t *testing.T) {
	if got := quickSimilarity("", "abc"); got != 0 {
		t.Errorf("empty similarity = %v", got)
	}
	if got := quickSimilarity("abcdef", "abcdef"); got != 1 {
		t.Errorf("identical similarity = %v", got)
	}
	if got := quickSimilarity("abcdef", "abcdef"); got != 1 {
		t.Errorf("identical similarity = %v", got)
	}
	if got := quickSimilarity("abc", "xyz"); got != 0 {
		t.Errorf("disjoint similarity = %v", got)
	}
	if got := quickSimilarity("abcdef", "abcdeg"); got <= 0 || got >= 1 {
		t.Errorf("partial similarity = %v", got)
	}
	// Two similar long strings use 3-grams; the value must stay in [0, 1].
	long := strings.Repeat("abcdefghij", 10)
	if got := quickSimilarity(long, long+"k"); got <= 0 || got > 1 {
		t.Errorf("long similarity = %v", got)
	}
}

func TestDedupeNormalizeVectorAndCosineSimilarity(t *testing.T) {
	normalized := normalizeVector([]float64{3, 4})
	if normalized[0] != 0.6 || normalized[1] != 0.8 {
		t.Errorf("normalizeVector = %v", normalized)
	}
	zero := normalizeVector([]float64{0, 0})
	if zero[0] != 0 || zero[1] != 0 {
		t.Errorf("zero vector = %v", zero)
	}
	if got := cosineSimilarity([]float64{1, 0}, []float64{1, 0}); math.Abs(got-1) > 1e-12 {
		t.Errorf("identical cosine = %v", got)
	}
	if got := cosineSimilarity([]float64{1, 0}, []float64{0, 1}); got != 0 {
		t.Errorf("orthogonal cosine = %v", got)
	}
	if got := cosineSimilarity([]float64{1}, []float64{1, 0}); got != 0 {
		t.Errorf("mismatched cosine = %v", got)
	}
	if got := cosineSimilarity([]float64{0, 0}, []float64{1, 0}); got != 0 {
		t.Errorf("zero-norm cosine = %v", got)
	}
	if got := cosineSimilarity(nil, nil); got != 0 {
		t.Errorf("empty cosine = %v", got)
	}
}

func TestDedupeUTF16Helpers(t *testing.T) {
	if got := dedupeUTF16Length("abc"); got != 3 {
		t.Errorf("ascii length = %d", got)
	}
	if got := dedupeUTF16Length("中文"); got != 2 {
		t.Errorf("cjk length = %d", got)
	}
	if got := dedupeUTF16Length("😀"); got != 2 {
		t.Errorf("emoji length = %d", got)
	}
	if got := dedupeSliceUTF16("abcdef", 3); got != "abc" {
		t.Errorf("slice = %q", got)
	}
	if got := dedupeSliceUTF16("abcdef", 100); got != "abcdef" {
		t.Errorf("slice beyond length = %q", got)
	}
	if got := dedupeSliceUTF16("abcdef", 0); got != "" {
		t.Errorf("zero slice = %q", got)
	}
	if got := dedupeSliceUTF16("中文测试", 3); got != "中文测" {
		t.Errorf("cjk slice = %q", got)
	}
}

func TestDedupeObjectIDValidation(t *testing.T) {
	if !dedupeObjectIDIsValid("5f1f8a7c2b3c4d5e6f708192") {
		t.Error("valid id rejected")
	}
	if !dedupeObjectIDIsValid("5F1F8A7C2B3C4D5E6F708192") {
		t.Error("uppercase id rejected")
	}
	for _, invalid := range []string{"", "abc", "5f1f8a7c2b3c4d5e6f70819", "5f1f8a7c2b3c4d5e6f70819z", "5f1f8a7c2b3c4d5e6f7081921"} {
		if dedupeObjectIDIsValid(invalid) {
			t.Errorf("invalid id %q accepted", invalid)
		}
	}
}

func TestDedupeCandidateFiltersAreOrgScoped(t *testing.T) {
	cutoff := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)

	llmFilter := dedupeLLMCandidateFilter("org-1", "meta-1", cutoff)
	dedupeAssertFilterValue(t, llmFilter, "orgId", "org-1")
	dedupeAssertFilterValue(t, llmFilter, "status", "completed")
	dedupeAssertFilterValue(t, llmFilter, "duplicateOf", nil)
	dedupeAssertFilterValue(t, llmFilter, "createdAt", bson.D{{Key: "$gte", Value: cutoff}})
	dedupeAssertFilterValue(t, llmFilter, "result.summary", bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: nil}})
	itemMetaFilter, ok := dedupeBSONLookup(t, llmFilter, "itemMetaId")
	if !ok || !dedupeValuesEqual(itemMetaFilter, bson.D{{Key: "$ne", Value: "meta-1"}}) {
		t.Errorf("llm itemMetaId filter = %v", itemMetaFilter)
	}

	ids := []bson.ObjectID{bson.NewObjectID()}
	allowedFilter := dedupeVectorAllowedFilter("org-1", "embed-v1", "meta-1", cutoff, ids)
	dedupeAssertFilterValue(t, allowedFilter, "orgId", "org-1")
	dedupeAssertFilterValue(t, allowedFilter, "status", "completed")
	dedupeAssertFilterValue(t, allowedFilter, "summaryEmbeddingModel", "embed-v1")
	dedupeAssertFilterValue(t, allowedFilter, "duplicateOf", nil)
	dedupeAssertFilterValue(t, allowedFilter, "_id", bson.D{{Key: "$in", Value: ids}})
	if _, ok := dedupeBSONLookup(t, allowedFilter, "itemMetaId"); !ok {
		t.Error("allowed filter must exclude this item's own previous runs")
	}

	semanticFilter := dedupeSemanticCandidateFilter("org-1", "embed-v1", "meta-1", cutoff)
	dedupeAssertFilterValue(t, semanticFilter, "orgId", "org-1")
	dedupeAssertFilterValue(t, semanticFilter, "status", "completed")
	dedupeAssertFilterValue(t, semanticFilter, "summaryEmbeddingModel", "embed-v1")
	dedupeAssertFilterValue(t, semanticFilter, "summaryEmbedding", bson.D{{Key: "$exists", Value: true}, {Key: "$ne", Value: bson.A{}}})
	if _, ok := dedupeBSONLookup(t, semanticFilter, "itemMetaId"); !ok {
		t.Error("semantic filter must exclude this item's own previous runs")
	}

	// The itemMetaId exclusion is conditional in the semantic/vector queries,
	// exactly like the NestJS object spread.
	if _, ok := dedupeBSONLookup(t, dedupeSemanticCandidateFilter("org-1", "embed-v1", "", cutoff), "itemMetaId"); ok {
		t.Error("empty excludeItemMetaId must not add the $ne filter")
	}
	if _, ok := dedupeBSONLookup(t, dedupeVectorAllowedFilter("org-1", "embed-v1", "", cutoff, ids), "itemMetaId"); ok {
		t.Error("empty excludeItemMetaId must not add the $ne filter")
	}
}

func TestDedupeExtractCandidateValues(t *testing.T) {
	if value := dedupeExtractCandidateString(dedupeMustRawBSON(t, `"  hello  "`)); value == nil || *value != "hello" {
		t.Errorf("string extraction = %v", value)
	}
	if value := dedupeExtractCandidateString(dedupeMustRawBSON(t, `"   "`)); value != nil {
		t.Errorf("blank string = %v", value)
	}
	if value := dedupeExtractCandidateString(dedupeMustRawBSON(t, `42`)); value != nil {
		t.Errorf("number string = %v", value)
	}
	if value := dedupeExtractCandidateString(bson.RawValue{}); value != nil {
		t.Errorf("zero string = %v", value)
	}
	if vector := dedupeExtractEmbedding(dedupeMustRawBSON(t, `[1,2,3]`)); len(vector) != 3 || vector[2] != 3 {
		t.Errorf("embedding = %v", vector)
	}
	if vector := dedupeExtractEmbedding(dedupeMustRawBSON(t, `"text"`)); vector != nil {
		t.Errorf("non-array embedding = %v", vector)
	}
	if vector := dedupeExtractEmbedding(bson.RawValue{}); vector != nil {
		t.Errorf("zero embedding = %v", vector)
	}
}

func TestDedupeEvaluateWithoutSettingsReaderUsesRuntimeDefaults(t *testing.T) {
	harness := newDedupeHarness(nil)
	harness.models.runtimeEmbedding = litellmcompat.RuntimeModel{}
	summary := strings.Repeat("market analysts expect steady growth ", 4)
	result, err := harness.deduper.EvaluateSummaryDedupe(context.Background(), dedupeSummaryInput(summary))
	if err != nil {
		t.Fatalf("EvaluateSummaryDedupe error = %v", err)
	}
	if result.ThresholdUsed == nil || *result.ThresholdUsed != 0.88 {
		t.Errorf("ThresholdUsed = %v, want the runtime default", result.ThresholdUsed)
	}
}

// dedupeAssertFilterValue asserts one bson.D member.
func dedupeAssertFilterValue(t *testing.T, filter bson.D, key string, want any) {
	t.Helper()
	got, ok := dedupeBSONLookup(t, filter, key)
	if !ok {
		t.Errorf("missing filter member %q", key)
		return
	}
	if !dedupeValuesEqual(got, want) {
		t.Errorf("filter[%q] = %#v, want %#v", key, got, want)
	}
}

func dedupeValuesEqual(left, right any) bool {
	leftBytes, leftErr := bson.Marshal(bson.D{{Key: "value", Value: left}})
	rightBytes, rightErr := bson.Marshal(bson.D{{Key: "value", Value: right}})
	if leftErr != nil || rightErr != nil {
		return false
	}
	return string(leftBytes) == string(rightBytes)
}
