package kgingestion

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// Quality prepares one article's relations: normalization, the dynamic
// confidence threshold and the optional multi-model validation.
type Quality struct {
	completer publicportal.KGCompleter
	observer  publicportal.KGCompletionObserver
	now       func() time.Time
	logger    *log.Logger
}

// NewQuality builds the relation preparation step.
func NewQuality(
	completer publicportal.KGCompleter,
	observer publicportal.KGCompletionObserver,
	now func() time.Time,
	logger *log.Logger,
) *Quality {
	if now == nil {
		now = time.Now
	}
	return &Quality{completer: completer, observer: observer, now: now, logger: logger}
}

// PrepareInput is one article's relation preparation input.
type PrepareInput struct {
	OrgID       string
	ArticleID   string
	Title       *string
	Summary     *string
	Language    *string
	KGRelations json.RawMessage
	Settings    Settings
}

// PreparedRelations is the result handed to the transactional write.
type PreparedRelations struct {
	Relations            []Relation
	MinConfidenceApplied float64
	ValidatedRelations   int
	FilteredRelations    int
}

const (
	relationValidationTask      = "kg_relation_validation"
	relationValidationSchema    = "kg_relation_validation"
	relationValidationMaxTokens = 120
	relationValidationTimeout   = 45 * time.Second
	relationValidationRetries   = 1
)

// Prepare reproduces KnowledgeGraphQualityService.prepareRelationsForIngestion.
func (q *Quality) Prepare(ctx context.Context, input PrepareInput) PreparedRelations {
	normalized := normalizeRelations(input.KGRelations)
	if len(normalized) == 0 {
		return PreparedRelations{Relations: []Relation{}, MinConfidenceApplied: input.Settings.MinEdgeConfidence}
	}

	confidences := make([]float64, 0, len(normalized))
	for _, relation := range normalized {
		confidences = append(confidences, relation.Confidence)
	}
	minConfidenceApplied := computeMinConfidenceThreshold(confidences, input.Settings)

	enriched := normalized
	validatedRelations := 0

	if input.Settings.MultiModelValidationEnabled {
		models := q.resolveValidationModels(ctx, input.Settings)
		modelCount := clampInt(input.Settings.MultiModelValidationModelCount, 2, 3, 3)
		selectedModels := models
		if len(selectedModels) > modelCount {
			selectedModels = selectedModels[:modelCount]
		}

		maxRelations := input.Settings.MultiModelValidationMaxRelationsPerArticle
		if len(selectedModels) >= 2 && maxRelations > 0 {
			candidates := make([]int, 0, len(enriched))
			floor := math.Max(0, minConfidenceApplied-0.1)
			for index, relation := range enriched {
				if relation.Confidence >= floor {
					candidates = append(candidates, index)
				}
			}
			sort.SliceStable(candidates, func(left, right int) bool {
				return enriched[candidates[left]].Confidence < enriched[candidates[right]].Confidence
			})
			if len(candidates) > maxRelations {
				candidates = candidates[:maxRelations]
			}

			for _, index := range candidates {
				validated := q.validateRelation(ctx, input, enriched[index], selectedModels)
				enriched[index].Confidence = validated.AdjustedConfidence
				enriched[index].Validation = validated.Document
				validatedRelations++
			}
		}
	}

	filtered := make([]Relation, 0, len(enriched))
	for _, relation := range enriched {
		if relation.Confidence >= minConfidenceApplied {
			filtered = append(filtered, relation)
		}
	}
	sort.SliceStable(filtered, func(left, right int) bool {
		return filtered[left].Confidence > filtered[right].Confidence
	})
	limit := input.Settings.MaxRelationsPerArticle
	if limit < 0 {
		limit = 0
	}
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}

	filteredCount := len(enriched) - len(filtered)
	if filteredCount < 0 {
		filteredCount = 0
	}
	return PreparedRelations{
		Relations:            filtered,
		MinConfidenceApplied: minConfidenceApplied,
		ValidatedRelations:   validatedRelations,
		FilteredRelations:    filteredCount,
	}
}

// resolveValidationModels reproduces resolveValidationModels: an explicitly
// configured list wins, otherwise the gateway's primary-plus-fallback chain is
// used. A gateway configuration failure degrades to "no validation".
func (q *Quality) resolveValidationModels(ctx context.Context, settings Settings) []string {
	configured := make([]string, 0, len(settings.MultiModelValidationModels))
	seen := make(map[string]bool, len(settings.MultiModelValidationModels))
	for _, model := range settings.MultiModelValidationModels {
		trimmed := strings.TrimSpace(model)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		configured = append(configured, trimmed)
	}
	if len(configured) > 0 {
		return configured
	}
	if q.completer == nil {
		return nil
	}
	models, err := q.completer.KGModels(ctx)
	if err != nil {
		q.warn("failed to resolve validation models from LiteLLM config", err)
		return nil
	}
	return models
}

// validationResult is one model's settled verdict.
type validationResult struct {
	model      string
	verdict    string
	confidence float64
	err        error
}

type validationVoteCounts struct {
	Yes       int `json:"yes"`
	No        int `json:"no"`
	Uncertain int `json:"uncertain"`
}

type validationModelResult struct {
	Model      string   `json:"model"`
	Verdict    string   `json:"verdict,omitempty"`
	Confidence *float64 `json:"confidence,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type relationValidationDocument struct {
	ValidatedAt        string                  `json:"validatedAt"`
	Models             []string                `json:"models"`
	Results            []validationModelResult `json:"results"`
	Votes              validationVoteCounts    `json:"votes"`
	Decisive           int                     `json:"decisive"`
	Outcome            string                  `json:"outcome"`
	SupportScore       float64                 `json:"supportScore"`
	OriginalConfidence float64                 `json:"originalConfidence"`
	AdjustedConfidence float64                 `json:"adjustedConfidence"`
}

// validatedRelation is one validated relation plus its persisted document.
type validatedRelation struct {
	AdjustedConfidence float64
	Document           json.RawMessage
}

// validateRelation reproduces validateRelation: every selected model votes in
// parallel, failures are recorded instead of aborting, and the adjusted
// confidence is derived from the decisive votes.
func (q *Quality) validateRelation(
	ctx context.Context,
	input PrepareInput,
	relation Relation,
	models []string,
) validatedRelation {
	system := strings.Join([]string{
		"You are a strict fact-checker for an extracted knowledge graph relation.",
		"Decide whether the relation is supported by the provided context.",
		"Return verdict:",
		`- "yes" only if the relation is clearly supported by the text.`,
		`- "no" if the text contradicts the relation OR there is no support for it.`,
		`- "uncertain" if the text is ambiguous or insufficient.`,
		"Return a confidence between 0 and 1 for your verdict.",
	}, "\n")

	contextParts := make([]string, 0, 3)
	if input.Title != nil && *input.Title != "" {
		contextParts = append(contextParts, "Title: "+*input.Title)
	}
	if input.Summary != nil && *input.Summary != "" {
		contextParts = append(contextParts, "Summary: "+*input.Summary)
	}
	if relation.Evidence != nil && *relation.Evidence != "" {
		contextParts = append(contextParts, "Evidence quote: "+*relation.Evidence)
	}

	userParts := make([]string, 0, 8)
	if input.Language != nil && *input.Language != "" {
		userParts = append(userParts, "Language: "+*input.Language)
	}
	if len(contextParts) > 0 {
		userParts = append(userParts, strings.Join(contextParts, "\n"))
	} else {
		userParts = append(userParts, "Context: (none)")
	}
	userParts = append(userParts,
		"Relation:",
		"Subject: "+relation.Subject.Name+" ("+relation.Subject.Type+")",
		"Predicate: "+relation.Predicate,
		"Object: "+relation.Object.Name+" ("+relation.Object.Type+")",
	)
	user := strings.Join(userParts, "\n")

	results := make([]validationResult, len(models))
	var wait sync.WaitGroup
	for index, model := range models {
		wait.Add(1)
		go func(index int, model string) {
			defer wait.Done()
			results[index] = q.callValidationModel(ctx, input, relation, system, user, model)
		}(index, model)
	}
	wait.Wait()

	votes := validationVoteCounts{}
	decisive := 0
	documentResults := make([]validationModelResult, 0, len(results))
	for _, result := range results {
		if result.err != nil {
			documentResults = append(documentResults, validationModelResult{
				Model: result.model,
				Error: validationErrorMessage(result.err),
			})
			continue
		}
		confidence := result.confidence
		documentResults = append(documentResults, validationModelResult{
			Model:      result.model,
			Verdict:    result.verdict,
			Confidence: &confidence,
		})
		switch result.verdict {
		case "yes":
			votes.Yes++
			decisive++
		case "no":
			votes.No++
			decisive++
		default:
			votes.Uncertain++
		}
	}

	supportScore := 0.5
	if decisive > 0 {
		supportScore = float64(votes.Yes) / float64(decisive)
	}
	outcome := "uncertain"
	if decisive >= 2 && votes.Yes > votes.No {
		outcome = "accept"
	} else if decisive >= 2 && votes.No > votes.Yes {
		outcome = "reject"
	}

	originalConfidence := relation.Confidence
	adjustedConfidence := originalConfidence * supportScore
	if outcome == "accept" {
		adjustedConfidence = (originalConfidence + supportScore) / 2
	}
	adjustedConfidence = clampNumber(adjustedConfidence, 0, 1, originalConfidence)

	document := relationValidationDocument{
		ValidatedAt:        formatISO8601Millis(q.clock()),
		Models:             append([]string(nil), models...),
		Results:            documentResults,
		Votes:              votes,
		Decisive:           decisive,
		Outcome:            outcome,
		SupportScore:       supportScore,
		OriginalConfidence: originalConfidence,
		AdjustedConfidence: adjustedConfidence,
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		encoded = nil
	}
	return validatedRelation{AdjustedConfidence: adjustedConfidence, Document: encoded}
}

// callValidationModel performs one model vote. The model is passed explicitly;
// publicportal still appends the profile fallback chain, matching
// LiteLlmService.acompletion.
func (q *Quality) callValidationModel(
	ctx context.Context,
	input PrepareInput,
	relation Relation,
	system, user, model string,
) validationResult {
	result := validationResult{model: model}
	if q.completer == nil {
		result.err = errCompleterUnavailable
		return result
	}
	response, err := q.completer.KGComplete(ctx, publicportal.KGCompletionRequest{
		OrgID:      input.OrgID,
		Model:      model,
		System:     system,
		User:       user,
		SchemaName: relationValidationSchema,
		Schema:     json.RawMessage(publicportal.KGRelationValidationSchema),
		MaxTokens:  relationValidationMaxTokens,
		TimeoutMS:  int(relationValidationTimeout / time.Millisecond),
		MaxRetries: relationValidationRetries,
		Metadata: publicportal.KGCompletionMetadata{
			Task:      relationValidationTask,
			OrgID:     input.OrgID,
			ArticleID: input.ArticleID,
		},
		Observer: q.observer,
	})
	if err != nil {
		result.err = err
		return result
	}
	verdict, confidence, ok := parseValidationContent(response.Content)
	if !ok {
		result.err = errInvalidValidationResponse
		return result
	}
	result.model = response.Model
	result.verdict = verdict
	result.confidence = confidence
	return result
}

// parseValidationContent extracts the verdict and confidence from a model
// response, rejecting anything outside the schema bounds.
func parseValidationContent(content string) (string, float64, bool) {
	jsonText, ok := extractJSONObject(content)
	if !ok {
		return "", 0, false
	}
	var document struct {
		Verdict    json.RawMessage `json:"verdict"`
		Confidence json.RawMessage `json:"confidence"`
	}
	if err := json.Unmarshal([]byte(jsonText), &document); err != nil {
		return "", 0, false
	}
	verdict, ok := decodeJSONString(document.Verdict)
	if !ok || (verdict != "yes" && verdict != "no" && verdict != "uncertain") {
		return "", 0, false
	}
	confidence, ok := decodeConfidence(document.Confidence)
	if !ok {
		return "", 0, false
	}
	return verdict, confidence, true
}

// extractJSONObject reproduces the first "{" to last "}" slice. Both braces are
// required and must be ordered.
func extractJSONObject(text string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", false
	}
	start := strings.Index(trimmed, "{")
	end := strings.LastIndex(trimmed, "}")
	if start == -1 || end == -1 || end <= start {
		return "", false
	}
	return trimmed[start : end+1], true
}

func validationErrorMessage(err error) string {
	if err == nil {
		return "unknown error"
	}
	if message := strings.TrimSpace(err.Error()); message != "" {
		return message
	}
	return "unknown error"
}

func (q *Quality) clock() time.Time {
	if q != nil && q.now != nil {
		return q.now()
	}
	return time.Now()
}

func (q *Quality) warn(message string, err error) {
	if q == nil || q.logger == nil {
		return
	}
	q.logger.Printf("kgingestion: %s err=%v", message, err)
}
