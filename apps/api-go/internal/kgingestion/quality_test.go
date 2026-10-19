package kgingestion

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

type fakeCompleter struct {
	mu          sync.Mutex
	models      []string
	modelsErr   error
	modelsCalls int
	completeFn  func(publicportal.KGCompletionRequest) (publicportal.KGCompletionResult, error)
	requests    []publicportal.KGCompletionRequest
}

func (c *fakeCompleter) Models(context.Context) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.modelsCalls++
	if c.modelsErr != nil {
		return nil, c.modelsErr
	}
	return append([]string(nil), c.models...), nil
}

func (c *fakeCompleter) Complete(_ context.Context, req publicportal.KGCompletionRequest) (publicportal.KGCompletionResult, error) {
	c.mu.Lock()
	c.requests = append(c.requests, req)
	complete := c.completeFn
	c.mu.Unlock()
	if complete == nil {
		return publicportal.KGCompletionResult{Content: `{"verdict":"yes","confidence":0.9}`, Model: req.Model}, nil
	}
	return complete(req)
}

func (c *fakeCompleter) captured() []publicportal.KGCompletionRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]publicportal.KGCompletionRequest(nil), c.requests...)
}

func validationSettings() Settings {
	return Settings{
		Enabled:                                    true,
		IngestionEnabled:                           true,
		MaxBatchSize:                               50,
		MaxRelationsPerArticle:                     10,
		MinEdgeConfidence:                          0.5,
		MultiModelValidationEnabled:                true,
		MultiModelValidationModels:                 []string{"m1", "m2"},
		MultiModelValidationModelCount:             3,
		MultiModelValidationMaxRelationsPerArticle: 5,
		EntityDisambiguationMaxCandidates:          5,
	}
}

func relationsJSON(t *testing.T, confidences ...float64) json.RawMessage {
	t.Helper()
	entries := make([]map[string]any, 0, len(confidences))
	for index, confidence := range confidences {
		entries = append(entries, map[string]any{
			"subject":    map[string]any{"name": "Subject" + string(rune('A'+index)), "type": "company"},
			"predicate":  "supplies",
			"object":     map[string]any{"name": "Object" + string(rune('A'+index)), "type": "company"},
			"confidence": confidence,
			"evidence":   "quote " + string(rune('A'+index)),
		})
	}
	encoded, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestPrepareEmptyRelationsReturnsRawThreshold(t *testing.T) {
	completer := &fakeCompleter{models: []string{"m1", "m2"}}
	quality := NewQuality(completer, nil, nil, nil)
	settings := validationSettings()
	settings.MinEdgeConfidence = 0.42
	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:     "org",
		ArticleID: "a",
		Settings:  settings,
	})
	if prepared.MinConfidenceApplied != 0.42 {
		t.Fatalf("minConfidence = %v", prepared.MinConfidenceApplied)
	}
	if len(prepared.Relations) != 0 || len(completer.captured()) != 0 {
		t.Fatalf("relations = %v, requests = %v", prepared.Relations, completer.captured())
	}
}

func TestPrepareMultiModelValidationAdjustsConfidence(t *testing.T) {
	completer := &fakeCompleter{
		models: []string{"m1", "m2"},
		completeFn: func(req publicportal.KGCompletionRequest) (publicportal.KGCompletionResult, error) {
			if req.Model == "m1" {
				return publicportal.KGCompletionResult{Content: `{"verdict":"yes","confidence":0.9}`, Model: "m1"}, nil
			}
			return publicportal.KGCompletionResult{Content: "```json\n{\"verdict\":\"yes\",\"confidence\":0.8}\n```", Model: "m2"}, nil
		},
	}
	quality := NewQuality(completer, nil, func() time.Time {
		return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	}, nil)

	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:       "org",
		ArticleID:   "article",
		Title:       stringPointer("Acme supplies Beta"),
		KGRelations: relationsJSON(t, 0.6, 0.9),
		Settings:    validationSettings(),
	})
	if prepared.ValidatedRelations != 2 {
		t.Fatalf("validated = %d", prepared.ValidatedRelations)
	}
	if len(prepared.Relations) != 2 {
		t.Fatalf("relations = %d", len(prepared.Relations))
	}
	if prepared.Relations[0].Confidence <= prepared.Relations[1].Confidence {
		t.Fatalf("relations are not sorted descending: %+v", prepared.Relations)
	}
	// (0.9 + 1) / 2 = 0.95, (0.6 + 1) / 2 = 0.8.
	if mathAbs(prepared.Relations[0].Confidence-0.95) > 1e-9 || mathAbs(prepared.Relations[1].Confidence-0.8) > 1e-9 {
		t.Fatalf("adjusted confidences = %v, %v", prepared.Relations[0].Confidence, prepared.Relations[1].Confidence)
	}

	requests := completer.captured()
	if len(requests) != 4 {
		t.Fatalf("requests = %d, want 4", len(requests))
	}
	for _, request := range requests {
		if request.MaxTokens != 120 || request.TimeoutMS != 45_000 || request.MaxRetries != 1 {
			t.Fatalf("request timeout/tokens/retries = %+v", request)
		}
		if request.SchemaName != "kg_relation_validation" {
			t.Fatalf("schema = %q", request.SchemaName)
		}
		if request.Metadata.Task != "kg_relation_validation" || request.Metadata.ArticleID != "article" {
			t.Fatalf("metadata = %+v", request.Metadata)
		}
		if request.User == "" || request.System == "" {
			t.Fatalf("empty prompt")
		}
	}

	var document relationValidationDocument
	if err := json.Unmarshal(prepared.Relations[0].Validation, &document); err != nil {
		t.Fatal(err)
	}
	if document.Outcome != "accept" || document.Decisive != 2 || document.Votes.Yes != 2 {
		t.Fatalf("validation document = %+v", document)
	}
	if document.ValidatedAt != "2026-10-19T12:00:00.000Z" {
		t.Fatalf("validatedAt = %q", document.ValidatedAt)
	}
}

func TestPrepareModelFailureIsRecordedNotFatal(t *testing.T) {
	completer := &fakeCompleter{
		models: []string{"m1", "m2"},
		completeFn: func(req publicportal.KGCompletionRequest) (publicportal.KGCompletionResult, error) {
			if req.Model == "m1" {
				return publicportal.KGCompletionResult{}, errors.New("upstream down")
			}
			return publicportal.KGCompletionResult{Content: `{"verdict":"yes","confidence":0.9}`, Model: "m2"}, nil
		},
	}
	quality := NewQuality(completer, nil, nil, nil)
	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:       "org",
		ArticleID:   "article",
		KGRelations: relationsJSON(t, 0.8),
		Settings:    validationSettings(),
	})
	if len(prepared.Relations) != 1 {
		t.Fatalf("relations = %d", len(prepared.Relations))
	}
	var document relationValidationDocument
	if err := json.Unmarshal(prepared.Relations[0].Validation, &document); err != nil {
		t.Fatal(err)
	}
	if document.Outcome != "uncertain" || document.Decisive != 1 {
		t.Fatalf("document = %+v", document)
	}
	foundError := false
	for _, result := range document.Results {
		if result.Error != "" && result.Model == "m1" {
			foundError = true
		}
	}
	if !foundError {
		t.Fatalf("results = %+v", document.Results)
	}
	// One decisive yes -> support 1 -> adjusted equals the original confidence.
	if mathAbs(document.AdjustedConfidence-0.8) > 1e-9 {
		t.Fatalf("adjusted = %v", document.AdjustedConfidence)
	}
}

func TestPrepareSkipsValidationWithFewerThanTwoModels(t *testing.T) {
	completer := &fakeCompleter{models: []string{"only"}}
	quality := NewQuality(completer, nil, nil, nil)
	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:       "org",
		ArticleID:   "article",
		KGRelations: relationsJSON(t, 0.9),
		Settings:    validationSettings(),
	})
	if prepared.ValidatedRelations != 0 {
		t.Fatalf("validated = %d", prepared.ValidatedRelations)
	}
	if len(completer.captured()) != 0 {
		t.Fatalf("requests = %d", len(completer.captured()))
	}
}

// TestPrepareConfiguredModelsWinOverGateway verifies resolveValidationModels.
func TestPrepareConfiguredModelsWinOverGateway(t *testing.T) {
	completer := &fakeCompleter{models: []string{"gateway"}}
	quality := NewQuality(completer, nil, nil, nil)
	settings := validationSettings()
	settings.MultiModelValidationModels = []string{" x ", "y", "x"}
	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:       "org",
		ArticleID:   "article",
		KGRelations: relationsJSON(t, 0.9),
		Settings:    settings,
	})
	if prepared.ValidatedRelations != 1 {
		t.Fatalf("validated = %d", prepared.ValidatedRelations)
	}
	if completer.modelsCalls != 0 {
		t.Fatalf("gateway models resolved despite configured list")
	}
	models := map[string]bool{}
	for _, request := range completer.captured() {
		models[request.Model] = true
	}
	if !models["x"] || !models["y"] || len(models) != 2 {
		t.Fatalf("models = %v", models)
	}
}

// TestPrepareCandidateWindow verifies the candidates are the relations at or
// above threshold-0.1, in ascending confidence order, capped.
func TestPrepareCandidateWindow(t *testing.T) {
	completer := &fakeCompleter{models: []string{"m1", "m2"}}
	quality := NewQuality(completer, nil, nil, nil)
	settings := validationSettings()
	settings.MultiModelValidationMaxRelationsPerArticle = 2
	prepared := quality.Prepare(context.Background(), PrepareInput{
		OrgID:       "org",
		ArticleID:   "article",
		KGRelations: relationsJSON(t, 0.1, 0.4, 0.6, 0.7, 0.9),
		Settings:    settings,
	})
	if prepared.ValidatedRelations != 2 {
		t.Fatalf("validated = %d", prepared.ValidatedRelations)
	}
	subjects := map[string]bool{}
	for _, request := range completer.captured() {
		for _, subject := range []string{"SubjectB", "SubjectC"} {
			if strings.Contains(request.User, "Subject: "+subject+" ") {
				subjects[subject] = true
			}
		}
	}
	if !subjects["SubjectB"] || !subjects["SubjectC"] || len(subjects) != 2 {
		t.Fatalf("validated subjects = %v", subjects)
	}
}

func TestParseValidationContent(t *testing.T) {
	cases := []struct {
		content    string
		verdict    string
		confidence float64
		ok         bool
	}{
		{`{"verdict":"yes","confidence":0.9}`, "yes", 0.9, true},
		{"prefix {\"verdict\":\"no\",\"confidence\":0} suffix", "no", 0, true},
		{`{"verdict":"uncertain","confidence":1}`, "uncertain", 1, true},
		{`{"verdict":"maybe","confidence":0.5}`, "", 0, false},
		{`{"verdict":"yes","confidence":1.2}`, "", 0, false},
		{`{"verdict":"yes"}`, "", 0, false},
		{"", "", 0, false},
	}
	for _, test := range cases {
		verdict, confidence, ok := parseValidationContent(test.content)
		if ok != test.ok || verdict != test.verdict || mathAbs(confidence-test.confidence) > 1e-9 {
			t.Fatalf("content %q -> %q %v %v", test.content, verdict, confidence, ok)
		}
	}
}

func stringPointer(value string) *string { return &value }

func mathAbs(value float64) float64 {
	if value < 0 {
		return -value
	}
	return value
}
