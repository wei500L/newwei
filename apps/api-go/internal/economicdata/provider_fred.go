package economicdata

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"time"
)

type fredProvider struct{ service *Service }

type fredObservation struct {
	Date  string `json:"date"`
	Value string `json:"value"`
}

type fredSeriesResponse struct {
	Observations []fredObservation `json:"observations"`
}

type fredRequest struct {
	SeriesID string `json:"series_id"`
	Metric   string `json:"metric"`
	Limit    int    `json:"limit"`
}

type fredLatestMeta struct {
	SeriesID      string   `json:"seriesId"`
	Previous      *float64 `json:"previous"`
	Delta         *float64 `json:"delta"`
	ChangePercent *float64 `json:"changePercent"`
}

type fredYoyMeta struct {
	SeriesID string   `json:"seriesId"`
	Previous *float64 `json:"previous"`
	Delta    *float64 `json:"delta"`
}

type fredDeltaMeta struct {
	SeriesID string   `json:"seriesId"`
	Current  *float64 `json:"current"`
	Previous *float64 `json:"previous"`
}

type fredPercentMeta struct {
	SeriesID string   `json:"seriesId"`
	Current  *float64 `json:"current"`
	Max      *float64 `json:"max"`
}

type fredSeriesOnlyMeta struct {
	SeriesID string `json:"seriesId"`
}

func (p *fredProvider) Kind() ProviderKind { return ProviderFred }

func (p *fredProvider) Configured(ctx context.Context) bool {
	key, err := p.service.keys.resolve(ctx, "fredApiKey")
	return err == nil && key != ""
}

func (p *fredProvider) Fetch(ctx context.Context, item ItemConfig) (ProviderFetchResult, error) {
	config := item.ProviderConfig
	if config.Kind != ProviderFred {
		return ProviderFetchResult{}, fmt.Errorf("Expected fred provider config for %s", item.Slug)
	}
	apiKey, err := p.service.keys.resolve(ctx, "fredApiKey")
	if err != nil {
		return ProviderFetchResult{}, err
	}
	if apiKey == "" {
		return ProviderFetchResult{}, &ProviderConfigurationError{Code: "missing_api_key", Message: "missing_api_key:fredApiKey"}
	}
	limit := fredLimit(config)
	parsed, err := url.Parse("https://api.stlouisfed.org/fred/series/observations")
	if err != nil {
		return ProviderFetchResult{}, err
	}
	query := parsed.Query()
	query.Set("series_id", config.SeriesID)
	query.Set("api_key", apiKey)
	query.Set("file_type", "json")
	query.Set("sort_order", "desc")
	query.Set("limit", strconv.Itoa(limit))
	parsed.RawQuery = query.Encode()
	result, err := fetchJSON(ctx, p.service.http, parsed.String(), nil, 12*time.Second)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	series, err := decodeJSON[fredSeriesResponse](result.Body)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	if len(series.Observations) == 0 {
		return ProviderFetchResult{}, fmt.Errorf("fred_observations_empty:%s", config.SeriesID)
	}
	latest := series.Observations[0]
	value, err := computeFredValue(series.Observations, config)
	if err != nil {
		return ProviderFetchResult{}, err
	}
	meta := buildFredMeta(series.Observations, config, value)
	metaRaw, _ := json.Marshal(meta)
	requestParams, _ := json.Marshal(fredRequest{SeriesID: config.SeriesID, Metric: config.Metric, Limit: limit})
	payload, _ := json.Marshal(fredSeriesResponse{Observations: series.Observations})
	return ProviderFetchResult{
		Payload:          payload,
		Points:           []ParsedDataPoint{{RecordedAt: fredRecordedAt(latest.Date), Value: value, Unit: optionalUnit(item.unitOr("")), DataType: item.ValueType, SourceField: fredSourceField(config), Meta: metaRaw}},
		RequestParams:    requestParams,
		Method:           "GET",
		ProviderIdentity: config.SeriesID,
	}, nil
}

func fredLimit(config ProviderConfig) int {
	switch config.Metric {
	case "yoy":
		return maxInt(14, config.Lookback)
	case "percentOfMax":
		return maxInt(52, nonZero(config.Lookback, 260))
	case "delta", "latest", "":
		return maxInt(2, config.Lookback)
	default:
		return maxInt(2, config.Lookback)
	}
}

func nonZero(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}

func computeFredValue(observations []fredObservation, config ProviderConfig) (float64, error) {
	precision := 2
	if config.Precision != 0 {
		precision = config.Precision
	}
	switch config.Metric {
	case "latest", "":
		current := transformFred(parseFredValue(observations[0].Value), config.Transform)
		if current == nil {
			return 0, fmt.Errorf("fred_latest_missing_value:%s", config.SeriesID)
		}
		return roundJS(*current, precision), nil
	case "delta":
		current := transformFred(parseFredValue(observations[0].Value), config.Transform)
		var previous *float64
		if len(observations) > 1 {
			previous = transformFred(parseFredValue(observations[1].Value), config.Transform)
		}
		if current == nil || previous == nil {
			return 0, fmt.Errorf("fred_delta_missing_value:%s", config.SeriesID)
		}
		return roundJS(*current-*previous, precision), nil
	case "yoy":
		if len(observations) < 13 {
			return 0, fmt.Errorf("fred_yoy_insufficient_history:%s", config.SeriesID)
		}
		current := parseFredValue(observations[0].Value)
		yearAgo := parseFredValue(observations[12].Value)
		if current == nil || yearAgo == nil || *yearAgo == 0 {
			return 0, fmt.Errorf("fred_yoy_invalid_series:%s", config.SeriesID)
		}
		return roundJS(((*current-*yearAgo) / *yearAgo)*100, precision), nil
	case "percentOfMax":
		values := make([]float64, 0)
		for _, observation := range observations {
			if value := parseFredValue(observation.Value); value != nil {
				values = append(values, *value)
			}
		}
		if len(values) == 0 {
			return 0, fmt.Errorf("fred_percent_of_max_invalid_series:%s", config.SeriesID)
		}
		current := values[0]
		maximum := values[0]
		for _, value := range values[1:] {
			if value > maximum {
				maximum = value
			}
		}
		if maximum == 0 {
			return 0, fmt.Errorf("fred_percent_of_max_invalid_series:%s", config.SeriesID)
		}
		return roundJS((current/maximum)*100, precision), nil
	default:
		return 0, fmt.Errorf("Unsupported fred metric: %s", config.Metric)
	}
}

func buildFredMeta(observations []fredObservation, config ProviderConfig, currentValue float64) any {
	precision := 2
	if config.Precision != 0 {
		precision = config.Precision
	}
	switch config.Metric {
	case "latest", "":
		current := transformFred(parseFredValue(observations[0].Value), config.Transform)
		var previous *float64
		if len(observations) > 1 {
			previous = transformFred(parseFredValue(observations[1].Value), config.Transform)
		}
		var delta, percent *float64
		if current != nil && previous != nil {
			value := roundJS(*current-*previous, precision)
			delta = &value
			if *previous != 0 {
				change := roundJS(((*current-*previous) / *previous)*100, precision)
				percent = &change
			}
		}
		return fredLatestMeta{SeriesID: config.SeriesID, Previous: previous, Delta: delta, ChangePercent: percent}
	case "yoy":
		if len(observations) < 14 {
			return fredSeriesOnlyMeta{SeriesID: config.SeriesID}
		}
		previousMonth := parseFredValue(observations[1].Value)
		previousYear := parseFredValue(observations[13].Value)
		var previousYoy *float64
		if previousMonth != nil && previousYear != nil && *previousYear != 0 {
			value := roundJS(((*previousMonth-*previousYear) / *previousYear)*100, precision)
			previousYoy = &value
		}
		var delta *float64
		if previousYoy != nil {
			value := roundJS(currentValue-*previousYoy, precision)
			delta = &value
		}
		return fredYoyMeta{SeriesID: config.SeriesID, Previous: previousYoy, Delta: delta}
	case "delta":
		current := transformFred(parseFredValue(observations[0].Value), config.Transform)
		var previous *float64
		if len(observations) > 1 {
			previous = transformFred(parseFredValue(observations[1].Value), config.Transform)
		}
		return fredDeltaMeta{SeriesID: config.SeriesID, Current: current, Previous: previous}
	case "percentOfMax":
		values := make([]float64, 0)
		for _, observation := range observations {
			if value := transformFred(parseFredValue(observation.Value), config.Transform); value != nil {
				values = append(values, *value)
			}
		}
		var current, maximum *float64
		if len(values) > 0 {
			current = &values[0]
			maxValue := values[0]
			for _, value := range values[1:] {
				if value > maxValue {
					maxValue = value
				}
			}
			maximum = &maxValue
		}
		return fredPercentMeta{SeriesID: config.SeriesID, Current: current, Max: maximum}
	default:
		return fredSeriesOnlyMeta{SeriesID: config.SeriesID}
	}
}

func parseFredValue(value string) *float64 {
	if value == "" || value == "." {
		return nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return nil
	}
	return &parsed
}

func transformFred(value *float64, transform string) *float64 {
	if value == nil {
		return nil
	}
	if transform == "millionsToTrillions" {
		converted := *value / 1_000_000
		return &converted
	}
	return value
}

func fredRecordedAt(date string) time.Time {
	if date == "" {
		return time.Now().UTC()
	}
	parsed, err := time.ParseInLocation("2006-01-02", date, time.UTC)
	if err != nil {
		return time.Now().UTC()
	}
	return parsed
}

func fredSourceField(config ProviderConfig) string {
	if config.SourceField == "" {
		return "value"
	}
	return config.SourceField
}

func roundJS(value float64, precision int) float64 {
	factor := math.Pow(10, float64(maxInt(0, precision)))
	return math.Floor(value*factor+0.5) / factor
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
