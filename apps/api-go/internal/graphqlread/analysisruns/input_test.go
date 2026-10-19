package analysisrunsgraphql

import (
	"testing"
)

func inputArgs(input map[string]any) map[string]any {
	return map[string]any{"input": input}
}

func validCorrelation() map[string]any {
	return map[string]any{
		"indicatorName": "CPI",
		"value":         101.5,
		"changePercent": -2.25,
		"startDate":     "2026-01-01",
		"endDate":       "2026-01-31",
		"newsSummaries": []any{"a", "b"},
	}
}

func TestParseCorrelationInput(t *testing.T) {
	input, err := parseCorrelationInput(inputArgs(validCorrelation()))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if input.IndicatorName != "CPI" || input.Value != 101.5 || input.ChangePercent != -2.25 {
		t.Fatalf("input = %+v", input)
	}
	if len(input.NewsSummaries) != 2 {
		t.Fatalf("news = %+v", input.NewsSummaries)
	}
}

func TestParseCorrelationRejectsMissingAndNonFinite(t *testing.T) {
	missing := validCorrelation()
	delete(missing, "indicatorName")
	if _, err := parseCorrelationInput(inputArgs(missing)); err == nil {
		t.Fatal("missing indicatorName should fail")
	}
	broken := validCorrelation()
	broken["value"] = "not-a-number"
	if _, err := parseCorrelationInput(inputArgs(broken)); err == nil {
		t.Fatal("non-numeric value should fail")
	}
}

func TestParseGeoTransportBboxAndObjectKeys(t *testing.T) {
	args := inputArgs(map[string]any{
		"transportKinds": []any{"aircraft", "vessel"},
		"startDate":      "2026-01-01",
		"endDate":        "2026-01-02",
		"bbox":           []any{float64(1), float64(2), float64(3), float64(4)},
		"objectKeys":     []any{"a", "b"},
	})
	input, err := parseGeoTransportInput(args)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(input.Bbox) != 4 || len(input.ObjectKeys) != 2 {
		t.Fatalf("input = %+v", input)
	}

	emptyKeys := inputArgs(map[string]any{
		"transportKinds": []any{"aircraft"},
		"startDate":      "a",
		"endDate":        "b",
		"objectKeys":     []any{},
	})
	parsed, err := parseGeoTransportInput(emptyKeys)
	if err != nil {
		t.Fatalf("empty objectKeys should be accepted: %v", err)
	}
	if parsed.ObjectKeys != nil {
		t.Fatalf("empty objectKeys must not become a filter: %+v", parsed.ObjectKeys)
	}
}

func TestParseGeoTransportRejectsBboxSizeAndKindCount(t *testing.T) {
	tooShortBbox := inputArgs(map[string]any{
		"transportKinds": []any{"aircraft"},
		"startDate":      "a",
		"endDate":        "b",
		"bbox":           []any{float64(1), float64(2)},
	})
	if _, err := parseGeoTransportInput(tooShortBbox); err == nil {
		t.Fatal("bbox of length 2 should fail at submission")
	}
	tooManyKinds := inputArgs(map[string]any{
		"transportKinds": []any{"aircraft", "vessel", "aircraft"},
		"startDate":      "a",
		"endDate":        "b",
	})
	if _, err := parseGeoTransportInput(tooManyKinds); err == nil {
		t.Fatal("three transportKinds should fail")
	}
	noKinds := inputArgs(map[string]any{
		"transportKinds": []any{},
		"startDate":      "a",
		"endDate":        "b",
	})
	if _, err := parseGeoTransportInput(noKinds); err == nil {
		t.Fatal("empty transportKinds should fail")
	}
}

func TestParseAnomalySeriesPreservesAbsentAndNull(t *testing.T) {
	base := map[string]any{
		"metric":           "m",
		"timestamp":        "t",
		"value":            float64(1),
		"deviationPercent": float64(2),
		"newsList":         []any{},
		"policyList":       []any{},
	}
	absent, err := parseAnomalyInput(inputArgs(base))
	if err != nil {
		t.Fatalf("absent series: %v", err)
	}
	if absent.Series != nil {
		t.Fatalf("absent series = %+v, want nil pointer", absent.Series)
	}

	explicitNull := map[string]any{}
	for key, value := range base {
		explicitNull[key] = value
	}
	explicitNull["series"] = nil
	nullInput, err := parseAnomalyInput(inputArgs(explicitNull))
	if err != nil {
		t.Fatalf("null series: %v", err)
	}
	if nullInput.Series == nil || len(*nullInput.Series) != 0 {
		t.Fatalf("explicit null series = %+v, want pointer to empty slice", nullInput.Series)
	}

	withSeries := map[string]any{}
	for key, value := range base {
		withSeries[key] = value
	}
	withSeries["series"] = []any{map[string]any{"timestamp": "a", "value": float64(3)}}
	seriesInput, err := parseAnomalyInput(inputArgs(withSeries))
	if err != nil {
		t.Fatalf("series: %v", err)
	}
	if seriesInput.Series == nil || len(*seriesInput.Series) != 1 || (*seriesInput.Series)[0].Value != 3 {
		t.Fatalf("series = %+v", seriesInput.Series)
	}
}

func TestParseAnomalyRejectsNonFiniteSeriesValue(t *testing.T) {
	args := inputArgs(map[string]any{
		"metric":           "m",
		"timestamp":        "t",
		"value":            float64(1),
		"deviationPercent": float64(2),
		"newsList":         []any{},
		"policyList":       []any{},
		"series":           []any{map[string]any{"timestamp": "a", "value": "NaN"}},
	})
	if _, err := parseAnomalyInput(args); err == nil {
		t.Fatal("non-numeric series value should fail")
	}
}
