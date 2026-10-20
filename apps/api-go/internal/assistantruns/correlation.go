package assistantruns

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// correlationInput is the typed runCorrelationQuery input.
type correlationInput struct {
	SeriesA      string
	SeriesB      string
	LookbackDays *int
	Transform    *string
}

// resolvedCorrelationSeries is one resolved series and how it was found.
type resolvedCorrelationSeries struct {
	Item         *history.EconomicSeries
	ResolvedFrom ResolvedFrom
}

// runCorrelationQuery ports runCorrelationQuery.
func (s *Service) runCorrelationQuery(
	ctx context.Context,
	record *runRecord,
	createdAt time.Time,
	question string,
	input correlationInput,
	historyMessages []publicportal.AssistantMessage,
	guardrails []string,
	assistantModel string,
) (bson.Raw, string, error) {
	lookbackDays := 365
	if input.LookbackDays != nil {
		lookbackDays = *input.LookbackDays
	}
	lookbackDays = clampInt(lookbackDays, 7, 3650)
	transform := "return"
	if input.Transform != nil && *input.Transform == "level" {
		transform = "level"
	}
	end := time.Now().UTC()
	start := end.Add(-time.Duration(lookbackDays) * 24 * time.Hour)
	specA := parseSeriesSpecifier(input.SeriesA)
	specB := parseSeriesSpecifier(input.SeriesB)
	resolvedA, resolvedB, err := s.resolveCorrelationSeries(ctx, record.OrgID, question, specA, specB, guardrails, assistantModel)
	if err != nil {
		return nil, "", err
	}
	itemA, itemB := resolvedA.Item, resolvedB.Item
	fieldsA, err := s.series.FieldCounts(ctx, itemA.ID, start, end)
	if err != nil {
		return nil, "", err
	}
	fieldsB, err := s.series.FieldCounts(ctx, itemB.ID, start, end)
	if err != nil {
		return nil, "", err
	}
	fallbackA, fallbackB := "", ""
	if len(fieldsA) > 0 {
		fallbackA = fieldsA[0].Name
	}
	if len(fieldsB) > 0 {
		fallbackB = fieldsB[0].Name
	}
	userFieldA := specA.Field
	userFieldB := specB.Field
	shouldSelect := !containsField(fieldsA, userFieldA) || !containsField(fieldsB, userFieldB)
	var selectionA, selectionB string
	if shouldSelect {
		selectionA, selectionB, err = s.pickCorrelationFields(ctx, record.OrgID, itemA, itemB, fieldsA, fieldsB, guardrails, assistantModel)
		if err != nil {
			return nil, "", err
		}
	}
	fieldA := pickPreferredField(firstNonEmpty(userFieldA, selectionA), fieldsA, fallbackA)
	fieldB := pickPreferredField(firstNonEmpty(userFieldB, selectionB), fieldsB, fallbackB)
	seriesReferences := []SeriesReference{
		{
			Slug:         itemA.Slug,
			DisplayName:  itemA.DisplayName,
			DocURL:       itemA.DocURL,
			SourceField:  fieldA,
			ResolvedFrom: resolvedA.ResolvedFrom,
		},
		{
			Slug:         itemB.Slug,
			DisplayName:  itemB.DisplayName,
			DocURL:       itemB.DocURL,
			SourceField:  fieldB,
			ResolvedFrom: resolvedB.ResolvedFrom,
		},
	}
	pointsA, err := s.series.Points(ctx, itemA.ID, fieldA, start, end)
	if err != nil {
		return nil, "", err
	}
	pointsB, err := s.series.Points(ctx, itemB.ID, fieldB, start, end)
	if err != nil {
		return nil, "", err
	}
	mapA := make(map[string]float64, len(pointsA))
	for _, point := range pointsA {
		mapA[point.RecordedAt.UTC().Format("2006-01-02")] = point.Value
	}
	mapB := make(map[string]float64, len(pointsB))
	for _, point := range pointsB {
		mapB[point.RecordedAt.UTC().Format("2006-01-02")] = point.Value
	}
	commonDates := make([]string, 0, len(mapA))
	for key := range mapA {
		if _, ok := mapB[key]; ok {
			commonDates = append(commonDates, key)
		}
	}
	sort.Strings(commonDates)
	levelsA := make([]float64, 0, len(commonDates))
	levelsB := make([]float64, 0, len(commonDates))
	for _, key := range commonDates {
		levelsA = append(levelsA, mapA[key])
		levelsB = append(levelsB, mapB[key])
	}
	x, y := transformAlignedSeries(levelsA, levelsB, transform)
	pearson := pearsonCorrelation(x, y)
	stats := CorrelationStats{N: len(x), Pearson: pearson}
	references := []LabeledReference{
		{Label: "seriesA", Value: fmt.Sprintf("%s (%s) field=%s", itemA.DisplayName, itemA.Slug, fieldA)},
		{Label: "seriesB", Value: fmt.Sprintf("%s (%s) field=%s", itemB.DisplayName, itemB.Slug, fieldB)},
	}
	if itemA.DocURL != nil {
		references = append(references, LabeledReference{Label: "seriesA_doc", Value: *itemA.DocURL})
	}
	if itemB.DocURL != nil {
		references = append(references, LabeledReference{Label: "seriesB_doc", Value: *itemB.DocURL})
	}
	renderer := buildCorrelationRendererMessages(correlationRendererInput{
		Question:  question,
		StartDate: start.Format("2006-01-02"),
		EndDate:   end.Format("2006-01-02"),
		SeriesA: correlationRendererSeries{
			Slug:        itemA.Slug,
			DisplayName: &itemA.DisplayName,
			Field:       fieldA,
			DocURL:      itemA.DocURL,
		},
		SeriesB: correlationRendererSeries{
			Slug:        itemB.Slug,
			DisplayName: &itemB.DisplayName,
			Field:       fieldB,
			DocURL:      itemB.DocURL,
		},
		Stats: stats,
		Refs:  references,
	})
	messages := injectQueryHistory(renderer, historyMessages)
	summary, raw, err := s.streamMessages(ctx, record, createdAt, RunTypeQuery, messages, streamOptions{
		Guardrails:     guardrails,
		AssistantModel: assistantModel,
	})
	if err != nil {
		return nil, "", err
	}
	plan := CorrelationQueryPlan{
		Kind:         "correlation_two_series",
		Transform:    transform,
		LookbackDays: lookbackDays,
		SeriesA:      CorrelationPlanSeries{Input: specA.Input, Slug: itemA.Slug, Field: fieldA},
		SeriesB:      CorrelationPlanSeries{Input: specB.Input, Slug: itemB.Slug, Field: fieldB},
	}
	marshaled, err := bson.Marshal(QueryCorrelationOutput{
		Plan:       plan,
		References: seriesReferences,
		Stats:      stats,
		Summary:    summary,
		Raw:        raw,
	})
	return bson.Raw(marshaled), summary, err
}

// resolveCorrelationSeries ports resolveCorrelationSeries. When more than one
// candidate exists on either side the series selector chooses; an invalid or
// failed selection keeps the first candidate.
func (s *Service) resolveCorrelationSeries(
	ctx context.Context,
	orgID string,
	question string,
	specA, specB parsedSeriesSpecifier,
	guardrails []string,
	assistantModel string,
) (resolvedCorrelationSeries, resolvedCorrelationSeries, error) {
	explicitA, err := s.findSeriesIfSlug(ctx, specA)
	if err != nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
	}
	explicitB, err := s.findSeriesIfSlug(ctx, specB)
	if err != nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
	}
	candidatesA, err := s.seriesCandidates(ctx, specA, explicitA, 8)
	if err != nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
	}
	candidatesB, err := s.seriesCandidates(ctx, specB, explicitB, 8)
	if err != nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
	}
	if len(candidatesA) == 0 {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, fmt.Errorf("Unable to resolve economic series for '%s'", specA.Input)
	}
	if len(candidatesB) == 0 {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, fmt.Errorf("Unable to resolve economic series for '%s'", specB.Input)
	}
	slugSetA := make(map[string]bool, len(candidatesA))
	for _, candidate := range candidatesA {
		slugSetA[candidate.Slug] = true
	}
	slugSetB := make(map[string]bool, len(candidatesB))
	for _, candidate := range candidatesB {
		slugSetB[candidate.Slug] = true
	}
	chosenA, chosenB := candidatesA[0].Slug, candidatesB[0].Slug
	if len(candidatesA) > 1 || len(candidatesB) > 1 {
		selector := correlationSeriesSelectorInput{Question: question}
		selector.SeriesA.Query = specA.Query
		selector.SeriesA.Candidates = candidatePayloads(candidatesA)
		selector.SeriesB.Query = specB.Query
		selector.SeriesB.Candidates = candidatePayloads(candidatesB)
		messages, responseFormat := buildCorrelationSeriesSelectorRequest(selector)
		response, err := s.llm.Complete(ctx, publicportal.AssistantCompletionRequest{
			OrgID:          orgID,
			Model:          assistantModel,
			Messages:       messages,
			ResponseFormat: responseFormat,
			Guardrails:     guardrails,
			Timeout:        minDuration(assistantPlannerTimeout, s.env.LLMTimeout),
			Metadata:       publicportal.AssistantRequestMetadata{OrgID: orgID, Source: "assistant-series-selector", Feature: "assistant"},
			Observer:       s.llmObserver("assistant-series-selector"),
		})
		if err != nil {
			return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
		}
		if slugA, slugB, ok := parseCorrelationSeriesSelection(response.Content); ok {
			if slugSetA[slugA] {
				chosenA = slugA
			}
			if slugSetB[slugB] {
				chosenB = slugB
			}
		}
	}
	itemA, err := s.economicSeriesBySlug(ctx, chosenA)
	if err != nil || itemA == nil {
		itemA, err = s.economicSeriesBySlug(ctx, candidatesA[0].Slug)
		if err != nil {
			return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
		}
	}
	if itemA == nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, fmt.Errorf("Unable to resolve economic series for '%s'", specA.Input)
	}
	itemB, err := s.economicSeriesBySlug(ctx, chosenB)
	if err != nil || itemB == nil {
		itemB, err = s.economicSeriesBySlug(ctx, candidatesB[0].Slug)
		if err != nil {
			return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, err
		}
	}
	if itemB == nil {
		return resolvedCorrelationSeries{}, resolvedCorrelationSeries{}, fmt.Errorf("Unable to resolve economic series for '%s'", specB.Input)
	}
	resolvedA := resolvedCorrelationSeries{Item: itemA}
	switch {
	case explicitA != nil:
		resolvedA.ResolvedFrom = ResolvedFrom{Input: specA.Input, Method: explicitMethod(specA)}
	case len(candidatesA) == 1:
		resolvedA.ResolvedFrom = ResolvedFrom{Input: specA.Input, Method: "display_name_search"}
	default:
		resolvedA.ResolvedFrom = ResolvedFrom{Input: specA.Input, Method: "llm_selection"}
	}
	resolvedB := resolvedCorrelationSeries{Item: itemB}
	switch {
	case explicitB != nil:
		resolvedB.ResolvedFrom = ResolvedFrom{Input: specB.Input, Method: explicitMethod(specB)}
	case len(candidatesB) == 1:
		resolvedB.ResolvedFrom = ResolvedFrom{Input: specB.Input, Method: "display_name_search"}
	default:
		resolvedB.ResolvedFrom = ResolvedFrom{Input: specB.Input, Method: "llm_selection"}
	}
	return resolvedA, resolvedB, nil
}

func explicitMethod(spec parsedSeriesSpecifier) string {
	if spec.Field != "" {
		return "explicit_slug_field"
	}
	return "explicit_slug"
}

func (s *Service) findSeriesIfSlug(ctx context.Context, spec parsedSeriesSpecifier) (*history.EconomicSeries, error) {
	if spec.Slug == "" {
		return nil, nil
	}
	return s.series.FindBySlug(ctx, spec.Slug)
}

func (s *Service) economicSeriesBySlug(ctx context.Context, slug string) (*history.EconomicSeries, error) {
	return s.series.FindBySlug(ctx, slug)
}

func (s *Service) seriesCandidates(ctx context.Context, spec parsedSeriesSpecifier, explicit *history.EconomicSeries, limit int) ([]history.EconomicSeriesSuggestion, error) {
	if explicit != nil {
		return []history.EconomicSeriesSuggestion{{
			Slug:        explicit.Slug,
			DisplayName: explicit.DisplayName,
			Description: explicit.Description,
			DocURL:      explicit.DocURL,
		}}, nil
	}
	return s.series.SearchCandidates(ctx, spec.Query, limit)
}

func candidatePayloads(candidates []history.EconomicSeriesSuggestion) []correlationSeriesCandidate {
	out := make([]correlationSeriesCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		out = append(out, correlationSeriesCandidate{
			Slug:        candidate.Slug,
			DisplayName: candidate.DisplayName,
			Description: candidate.Description,
		})
	}
	return out
}

// pickCorrelationFields ports pickCorrelationFieldsWithLlm. A failed selection
// leaves both fields empty and pickPreferredField falls back to the heuristics.
func (s *Service) pickCorrelationFields(
	ctx context.Context,
	orgID string,
	itemA, itemB *history.EconomicSeries,
	fieldsA, fieldsB []history.SeriesFieldCount,
	guardrails []string,
	assistantModel string,
) (string, string, error) {
	messages, responseFormat := buildCorrelationFieldSelectorRequest(correlationFieldSelectorInput{
		SeriesA: correlationFieldSelectorSeries{Slug: itemA.Slug, DisplayName: &itemA.DisplayName, Fields: fieldCandidates(fieldsA)},
		SeriesB: correlationFieldSelectorSeries{Slug: itemB.Slug, DisplayName: &itemB.DisplayName, Fields: fieldCandidates(fieldsB)},
	})
	response, err := s.llm.Complete(ctx, publicportal.AssistantCompletionRequest{
		OrgID:          orgID,
		Model:          assistantModel,
		Messages:       messages,
		ResponseFormat: responseFormat,
		Guardrails:     guardrails,
		Timeout:        minDuration(assistantPlannerTimeout, s.env.LLMTimeout),
		Metadata:       publicportal.AssistantRequestMetadata{OrgID: orgID, Source: "assistant-field-selector", Feature: "assistant"},
		Observer:       s.llmObserver("assistant-field-selector"),
	})
	if err != nil {
		return "", "", err
	}
	fieldA, fieldB, ok := parseCorrelationFieldSelection(response.Content)
	if !ok {
		return "", "", nil
	}
	return fieldA, fieldB, nil
}

func fieldCandidates(fields []history.SeriesFieldCount) []correlationFieldCandidate {
	out := make([]correlationFieldCandidate, 0, len(fields))
	for _, field := range fields {
		out = append(out, correlationFieldCandidate{Name: field.Name, Count: field.Count})
	}
	return out
}

func containsField(fields []history.SeriesFieldCount, name string) bool {
	if name == "" {
		return false
	}
	for _, field := range fields {
		if field.Name == name {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// transformAlignedSeries ports transformAlignedSeries.
func transformAlignedSeries(levelsA, levelsB []float64, transform string) ([]float64, []float64) {
	x := make([]float64, 0, len(levelsA))
	y := make([]float64, 0, len(levelsB))
	if transform == "level" {
		for index := 0; index < len(levelsA); index++ {
			a, b := levelsA[index], levelsB[index]
			if !isFiniteNumber(a) || !isFiniteNumber(b) {
				continue
			}
			x = append(x, a)
			y = append(y, b)
		}
		return x, y
	}
	for index := 1; index < len(levelsA); index++ {
		prevA, nextA := levelsA[index-1], levelsA[index]
		prevB, nextB := levelsB[index-1], levelsB[index]
		if !isFiniteNumber(prevA) || !isFiniteNumber(nextA) || !isFiniteNumber(prevB) || !isFiniteNumber(nextB) {
			continue
		}
		if prevA == 0 || prevB == 0 {
			continue
		}
		ra := nextA/prevA - 1
		rb := nextB/prevB - 1
		if !isFiniteNumber(ra) || !isFiniteNumber(rb) {
			continue
		}
		x = append(x, ra)
		y = append(y, rb)
	}
	return x, y
}

// pearsonCorrelation ports pearsonCorrelation: fewer than three pairs or a
// zero-variance side is null.
func pearsonCorrelation(x, y []float64) *float64 {
	if len(x) != len(y) || len(x) < 3 {
		return nil
	}
	n := float64(len(x))
	var sumX, sumY float64
	for index := range x {
		sumX += x[index]
		sumY += y[index]
	}
	meanX := sumX / n
	meanY := sumY / n
	var cov, varX, varY float64
	for index := range x {
		dx := x[index] - meanX
		dy := y[index] - meanY
		cov += dx * dy
		varX += dx * dx
		varY += dy * dy
	}
	if varX <= 0 || varY <= 0 {
		return nil
	}
	value := cov / math.Sqrt(varX*varY)
	return &value
}

func isFiniteNumber(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
