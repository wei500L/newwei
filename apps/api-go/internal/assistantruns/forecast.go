package assistantruns

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// parsedSeriesSpecifier is the parseSeriesSpecifier result.
type parsedSeriesSpecifier struct {
	Input string
	Slug  string
	Field string
	Query string
}

var seriesSlugFieldPattern = regexp.MustCompile(`^([a-zA-Z0-9_-]+)[.:](.+)$`)
var seriesSlugPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// parseSeriesSpecifier ports parseSeriesSpecifier.
func parseSeriesSpecifier(input string) parsedSeriesSpecifier {
	trimmed := strings.TrimSpace(input)
	normalized := strings.TrimPrefix(trimmed, "economic:")
	if match := seriesSlugFieldPattern.FindStringSubmatch(normalized); match != nil {
		return parsedSeriesSpecifier{Input: trimmed, Slug: match[1], Field: strings.TrimSpace(match[2]), Query: match[1]}
	}
	if normalized != "" && seriesSlugPattern.MatchString(normalized) {
		return parsedSeriesSpecifier{Input: trimmed, Slug: normalized, Query: normalized}
	}
	return parsedSeriesSpecifier{Input: trimmed, Query: normalized}
}

// forecastPromptSeries is the output.series shape sent to the renderer prompt.
type forecastPromptSeries struct {
	Slug        string  `json:"slug"`
	DisplayName string  `json:"displayName"`
	Field       string  `json:"field"`
	DocURL      *string `json:"docUrl"`
}

// runForecast ports runForecast: resolve the series and field, load at least
// twelve points, call the external holdout-last service and stream the
// explanation.
func (s *Service) runForecast(ctx context.Context, record *runRecord, createdAt time.Time, input ForecastInput, guardrails []string, assistantModel string) (bson.Raw, string, error) {
	seriesInput := strings.TrimSpace(input.Series)
	if seriesInput == "" {
		return nil, "", errors.New("Forecast series is required")
	}
	spec := parseSeriesSpecifier(seriesInput)
	lookbackDays := 365
	if input.LookbackDays != nil {
		lookbackDays = *input.LookbackDays
	}
	lookbackDays = clampInt(lookbackDays, 7, 3650)
	end := time.Now().UTC()
	start := end.Add(-time.Duration(lookbackDays) * 24 * time.Hour)

	item, err := s.resolveEconomicSeries(ctx, spec)
	if err != nil {
		return nil, "", err
	}
	fields, err := s.series.FieldCounts(ctx, item.ID, start, end)
	if err != nil {
		return nil, "", err
	}
	fallbackField := ""
	if len(fields) > 0 {
		fallbackField = fields[0].Name
	}
	preferred := ""
	if input.SourceField != nil {
		preferred = strings.TrimSpace(*input.SourceField)
	} else if spec.Field != "" {
		preferred = spec.Field
	}
	sourceField := pickPreferredField(preferred, fields, fallbackField)
	if sourceField == "" {
		return nil, "", errors.New("No usable sourceField found for forecast series")
	}
	rawPoints, err := s.series.Points(ctx, item.ID, sourceField, start, end)
	if err != nil {
		return nil, "", err
	}
	points := make([]SeriesPoint, 0, len(rawPoints))
	for _, point := range rawPoints {
		if math.IsNaN(point.Value) || math.IsInf(point.Value, 0) {
			continue
		}
		points = append(points, SeriesPoint{Timestamp: point.RecordedAt.UTC().Format("2006-01-02T15:04:05.000Z"), Value: point.Value})
	}
	if len(points) < 12 {
		return nil, "", errors.New("Not enough data points for forecast")
	}
	modelKind := "ets"
	if input.ModelKind != nil && *input.ModelKind == "arima" {
		modelKind = "arima"
	}
	var seasonalPeriod *int
	if input.SeasonalPeriod != nil {
		value := *input.SeasonalPeriod
		if value < 0 {
			value = 0
		}
		seasonalPeriod = &value
	}
	confidenceLevel := 0.95
	if input.ConfidenceLevel != nil {
		confidenceLevel = math.Max(0.5, math.Min(0.999, *input.ConfidenceLevel))
	}
	modelResponse, err := s.forecaster.ForecastHoldoutLast(ctx, ModelServiceForecastRequest{
		Series:          points,
		ConfidenceLevel: confidenceLevel,
		Model:           ModelServiceModelSpec{Kind: modelKind, SeasonalPeriod: seasonalPeriod},
		RequestID:       record.ID.Hex(),
	})
	if err != nil {
		return nil, "", err
	}
	actual := points[len(points)-1]
	forecast := modelResponse.Forecast
	rawError := actual.Value - forecast.Expected
	absError := math.Abs(rawError)
	var pctError *float64
	if actual.Value != 0 {
		value := rawError / actual.Value
		pctError = &value
	}
	references := []SeriesReference{{
		Slug:        item.Slug,
		DisplayName: item.DisplayName,
		DocURL:      item.DocURL,
		SourceField: sourceField,
		ResolvedFrom: ResolvedFrom{
			Input:  spec.Input,
			Method: resolvedMethod(spec),
		},
	}}
	errorsPayload := ForecastErrors{Error: rawError, AbsError: absError, PctError: pctError}
	seriesPayload := forecastPromptSeries{Slug: item.Slug, DisplayName: item.DisplayName, Field: sourceField, DocURL: item.DocURL}
	promptPayload := struct {
		TimeWindow       TimeWindow           `json:"timeWindow"`
		Series           forecastPromptSeries `json:"series"`
		ModelServiceUsed bool                 `json:"modelServiceUsed"`
		Model            json.RawMessage      `json:"model"`
		Actual           SeriesPoint          `json:"actual"`
		Forecast         ForecastPoint        `json:"forecast"`
		Errors           ForecastErrors       `json:"errors"`
		References       []SeriesReference    `json:"references"`
	}{
		TimeWindow:       TimeWindow{StartDate: start.Format("2006-01-02"), EndDate: end.Format("2006-01-02")},
		Series:           seriesPayload,
		ModelServiceUsed: true,
		Model:            JSONValue(modelResponse.Model),
		Actual:           actual,
		Forecast:         forecast,
		Errors:           errorsPayload,
		References:       references,
	}
	payloadJSON, err := json.Marshal(promptPayload)
	if err != nil {
		return nil, "", err
	}
	messages := []publicportal.AssistantMessage{
		{Role: "system", Content: joinLines(
			"You are a quantitative finance analyst.",
			"Write the response in Simplified Chinese.",
			"Explain the holdout-last forecast result and key caveats.",
			"Only use the provided numbers and metadata; do not invent values.",
		)},
		{Role: "user", Content: "Input (JSON):\n" + string(payloadJSON)},
	}
	summary, raw, err := s.streamMessages(ctx, record, createdAt, RunTypeForecast, messages, streamOptions{
		Guardrails:     guardrails,
		AssistantModel: assistantModel,
	})
	if err != nil {
		return nil, "", err
	}
	marshaled, err := bson.Marshal(ForecastOutput{
		Series:           ForecastSeries{Slug: item.Slug, DisplayName: item.DisplayName, Field: sourceField, DocURL: item.DocURL},
		TimeWindow:       TimeWindow{StartDate: start.Format("2006-01-02"), EndDate: end.Format("2006-01-02")},
		ModelServiceUsed: true,
		Model:            JSONValue(modelResponse.Model),
		Forecast:         forecast,
		Actual:           actual,
		Errors:           errorsPayload,
		Diagnostics:      JSONValue(modelResponse.Diagnostics),
		References:       references,
		Summary:          summary,
		Raw:              raw,
	})
	return bson.Raw(marshaled), summary, err
}

// resolveEconomicSeries ports resolveEconomicSeriesOrThrow.
func (s *Service) resolveEconomicSeries(ctx context.Context, spec parsedSeriesSpecifier) (*history.EconomicSeries, error) {
	if spec.Slug != "" {
		item, err := s.series.FindBySlug(ctx, spec.Slug)
		if err != nil {
			return nil, err
		}
		if item != nil {
			return item, nil
		}
	}
	term := strings.TrimSpace(spec.Query)
	if term == "" {
		return nil, errors.New("Economic series slug is required")
	}
	candidates, err := s.series.SearchCandidates(ctx, term, 6)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("Unable to resolve economic series for '%s'", spec.Input)
	}
	if len(candidates) > 1 {
		labels := make([]string, 0, len(candidates))
		for _, candidate := range candidates {
			labels = append(labels, fmt.Sprintf("%s (%s)", candidate.DisplayName, candidate.Slug))
		}
		return nil, fmt.Errorf("Multiple economic series match '%s': %s. Please specify a slug.", spec.Input, strings.Join(labels, ", "))
	}
	candidate := candidates[0]
	item, err := s.series.FindBySlug(ctx, candidate.Slug)
	if err != nil {
		return nil, err
	}
	if item == nil {
		return nil, fmt.Errorf("Unable to resolve economic series for '%s'", spec.Input)
	}
	return item, nil
}

func resolvedMethod(spec parsedSeriesSpecifier) string {
	if spec.Slug != "" && spec.Field != "" {
		return "explicit_slug_field"
	}
	if spec.Slug != "" {
		return "explicit_slug"
	}
	return "display_name_search"
}

// pickPreferredField ports pickPreferredField: an exact candidate wins, then a
// known level-series needle, then the fallback, then the first field.
func pickPreferredField(candidate string, fields []history.SeriesFieldCount, fallback string) string {
	names := make(map[string]bool, len(fields))
	for _, field := range fields {
		names[field.Name] = true
	}
	if candidate != "" && names[candidate] {
		return candidate
	}
	needles := []string{"最新价", "收盘", "close", "last", "value", "settle", "结算", "price"}
	for _, needle := range needles {
		for _, field := range fields {
			if strings.Contains(strings.ToLower(field.Name), strings.ToLower(needle)) {
				return field.Name
			}
		}
	}
	if fallback != "" && names[fallback] {
		return fallback
	}
	if len(fields) == 0 {
		return ""
	}
	return fields[0].Name
}
