package providers

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestClampInt(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		min   int
		max   int
		want  int
	}{
		{name: "truncates towards zero", value: 90.9, min: 30, max: 3650, want: 90},
		{name: "truncates negative values towards zero", value: -5.9, min: 30, max: 3650, want: 30},
		{name: "clamps below the minimum", value: 29.99, min: 30, max: 3650, want: 30},
		{name: "clamps above the maximum", value: 3650.9, min: 30, max: 3650, want: 3650},
		{name: "NaN yields the minimum", value: math.NaN(), min: 30, max: 3650, want: 30},
		{name: "positive infinity yields the minimum", value: math.Inf(1), min: 30, max: 3650, want: 30},
		{name: "negative infinity yields the minimum", value: math.Inf(-1), min: 30, max: 3650, want: 30},
		{name: "huge values clamp without overflowing", value: 1e300, min: 30, max: 3650, want: 3650},
		{name: "seasonal period lower bound", value: -3, min: 0, max: 366, want: 0},
	}
	for _, test := range tests {
		if got := clampInt(test.value, test.min, test.max); got != test.want {
			t.Fatalf("%s: clampInt(%v, %d, %d) = %d, want %d", test.name, test.value, test.min, test.max, got, test.want)
		}
	}
}

func TestClampFloat(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		min   float64
		max   float64
		want  float64
	}{
		{name: "keeps a value inside the range", value: 0.95, min: 0.5, max: 0.999, want: 0.95},
		{name: "clamps below the minimum", value: 0.4, min: 0.5, max: 0.999, want: 0.5},
		{name: "clamps above the maximum", value: 0.9999, min: 0.5, max: 0.999, want: 0.999},
		{name: "NaN yields the minimum", value: math.NaN(), min: 0.5, max: 0.999, want: 0.5},
		{name: "infinity yields the minimum", value: math.Inf(1), min: 0.5, max: 0.999, want: 0.5},
	}
	for _, test := range tests {
		if got := clampFloat(test.value, test.min, test.max); got != test.want {
			t.Fatalf("%s: clampFloat(%v, %v, %v) = %v, want %v", test.name, test.value, test.min, test.max, got, test.want)
		}
	}
}

func TestToAnomalyMetadata(t *testing.T) {
	t.Run("missing metadata", func(t *testing.T) {
		metadata := toAnomalyMetadata(nil)
		if metadata.LookbackDays != nil || metadata.ModelKind != nil || metadata.SourceField != nil {
			t.Fatalf("metadata = %+v, want zero value", metadata)
		}
	})
	t.Run("null metadata", func(t *testing.T) {
		metadata := toAnomalyMetadata([]byte(`null`))
		if metadata.LookbackDays != nil {
			t.Fatalf("lookbackDays = %v, want nil", *metadata.LookbackDays)
		}
	})
	t.Run("array metadata is not an object", func(t *testing.T) {
		metadata := toAnomalyMetadata([]byte(`[1,2,3]`))
		if metadata.LookbackDays != nil || metadata.ModelKind != nil {
			t.Fatalf("metadata = %+v, want zero value", metadata)
		}
	})
	t.Run("reads typed fields", func(t *testing.T) {
		metadata := toAnomalyMetadata([]byte(`{"lookbackDays":90,"confidenceLevel":0.9,"modelKind":" ETS ","sourceField":" close "}`))
		if metadata.LookbackDays == nil || *metadata.LookbackDays != 90 {
			t.Fatalf("lookbackDays = %v", metadata.LookbackDays)
		}
		if metadata.ConfidenceLevel == nil || *metadata.ConfidenceLevel != 0.9 {
			t.Fatalf("confidenceLevel = %v", metadata.ConfidenceLevel)
		}
		if metadata.ModelKind == nil || *metadata.ModelKind != " ETS " {
			t.Fatalf("modelKind = %v", metadata.ModelKind)
		}
		if metadata.SourceField == nil || *metadata.SourceField != " close " {
			t.Fatalf("sourceField = %v", metadata.SourceField)
		}
	})
	t.Run("other JSON types are rejected like the typeof guards", func(t *testing.T) {
		metadata := toAnomalyMetadata([]byte(`{"lookbackDays":"90","modelKind":5,"sourceField":null}`))
		if metadata.LookbackDays != nil {
			t.Fatalf("lookbackDays = %v, want nil", *metadata.LookbackDays)
		}
		if metadata.ModelKind != nil {
			t.Fatalf("modelKind = %v, want nil", *metadata.ModelKind)
		}
		if metadata.SourceField != nil {
			t.Fatalf("sourceField = %v, want nil", *metadata.SourceField)
		}
	})
}

func TestEconomicAnomalyCacheKey(t *testing.T) {
	end := time.Date(2026, 1, 2, 3, 4, 5, 123_000_000, time.UTC)
	tests := []struct {
		name            string
		itemID          string
		sourceField     string
		modelKind       string
		confidenceLevel float64
		seasonalPeriod  int
		end             time.Time
		want            string
	}{
		{
			name:            "empty source field becomes any",
			itemID:          "item-1",
			sourceField:     "",
			modelKind:       "arima",
			confidenceLevel: 0.95,
			seasonalPeriod:  12,
			end:             end,
			want:            "alerts:economicAnomaly:item-1:any:arima:0.950:12:2026-01-02T03:04:05.123Z",
		},
		{
			name:            "explicit source field, ets and zero period",
			itemID:          "item-2",
			sourceField:     "close",
			modelKind:       "ets",
			confidenceLevel: 0.999,
			seasonalPeriod:  0,
			end:             end,
			want:            "alerts:economicAnomaly:item-2:close:ets:0.999:0:2026-01-02T03:04:05.123Z",
		},
		{
			name:            "toISOString converts to UTC",
			itemID:          "item-1",
			sourceField:     "",
			modelKind:       "arima",
			confidenceLevel: 0.95,
			seasonalPeriod:  12,
			end:             time.Date(2026, 1, 2, 6, 4, 5, 123_000_000, time.FixedZone("MSK", 3*60*60)),
			want:            "alerts:economicAnomaly:item-1:any:arima:0.950:12:2026-01-02T03:04:05.123Z",
		},
	}
	for _, test := range tests {
		got := economicAnomalyCacheKey(test.itemID, test.sourceField, test.modelKind, test.confidenceLevel, test.seasonalPeriod, test.end)
		if got != test.want {
			t.Fatalf("%s: cache key = %q, want %q", test.name, got, test.want)
		}
	}
}

func TestFallbackScore(t *testing.T) {
	tests := []struct {
		name       string
		series     []SeriesPoint
		wantScore  float64
		wantKind   string
		wantReason string
		wantError  string
	}{
		{
			name:      "fewer than three points",
			series:    seriesOf(1, 2),
			wantError: "series_too_short",
		},
		{
			name:       "z-score hit on the last point wins",
			series:     seriesOf(0, 0, 0, 0, 0, 0, 0, 0, 0, 100),
			wantScore:  3,
			wantKind:   "zscore",
			wantReason: "Z-Score 3.00 >= 3",
		},
		{
			name:       "rolling spike on the last point",
			series:     fallbackSpikeSeries(),
			wantScore:  9,
			wantKind:   "rolling_spike",
			wantReason: "Rolling spike |4.5| >= 2.5σ",
		},
		{
			name:     "no hit",
			series:   seriesOf(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
			wantKind: "none",
		},
	}
	for _, test := range tests {
		score, detail := fallbackScore(test.series)
		if score != test.wantScore {
			t.Fatalf("%s: score = %v, want %v", test.name, score, test.wantScore)
		}
		if detail.Kind != test.wantKind {
			t.Fatalf("%s: kind = %q, want %q", test.name, detail.Kind, test.wantKind)
		}
		if detail.Reason != test.wantReason {
			t.Fatalf("%s: reason = %q, want %q", test.name, detail.Reason, test.wantReason)
		}
		if detail.Error != test.wantError {
			t.Fatalf("%s: error = %q, want %q", test.name, detail.Error, test.wantError)
		}
	}
}

// fallbackSpikeSeries has the shape the fallback score must handle: the global
// spread (the 1000 outlier) hides the last point from the z-score detector,
// while the calm 20-point window before it makes the last point a rolling
// spike.
func fallbackSpikeSeries() []SeriesPoint {
	values := []float64{1000}
	for index := 0; index < 20; index++ {
		value := 10.0
		if index%2 == 1 {
			value = 11
		}
		values = append(values, value)
	}
	values = append(values, 15)
	return seriesOf(values...)
}

func TestFallbackScoreTrimsToLast120Points(t *testing.T) {
	// The five 1000s make the global z-score of the last point harmless; with
	// the 120-point trim (which drops them) it becomes an outlier, so a z-score
	// hit proves the slice boundary matches `series.slice(length - 120)`.
	values := []float64{1000, 1000, 1000, 1000, 1000}
	for index := 0; index < 119; index++ {
		values = append(values, 10)
	}
	values = append(values, 20)
	score, detail := fallbackScore(seriesOf(values...))
	if detail.Kind != "zscore" {
		t.Fatalf("kind = %q, want zscore", detail.Kind)
	}
	if score <= 3 {
		t.Fatalf("score = %v, want > 3", score)
	}
}

func TestInsufficientPointsEvaluation(t *testing.T) {
	evaluation, err := insufficientPointsEvaluation(4, 365, "cpi")
	if err != nil {
		t.Fatalf("insufficientPointsEvaluation: %v", err)
	}
	if evaluation.Latest != nil || evaluation.Previous != nil || evaluation.ChangePercent != nil {
		t.Fatalf("evaluation = %+v, want nil values", evaluation)
	}
	want := `{"error":"insufficient_points","points":4,"lookbackDays":365,"metricSlug":"cpi"}`
	if string(evaluation.Context) != want {
		t.Fatalf("context = %s, want %s", evaluation.Context, want)
	}
}

func TestEconomicAnomalySlugMissing(t *testing.T) {
	fixed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	provider := NewEconomicAnomaly(Dependencies{Now: func() time.Time { return fixed }})
	if provider.Type() != TypeEconomicAnomaly {
		t.Fatalf("Type() = %q, want %q", provider.Type(), TypeEconomicAnomaly)
	}
	// The empty slug returns before any query, so deps.DB remains nil here.
	evaluation, err := provider.Fetch(context.Background(), Rule{MetricSlug: "   "})
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if evaluation.Latest != nil || evaluation.Previous != nil || evaluation.ChangePercent != nil {
		t.Fatalf("evaluation = %+v, want nil values", evaluation)
	}
	if string(evaluation.Context) != `{"error":"metric_slug_missing"}` {
		t.Fatalf("context = %s, want metric_slug_missing", evaluation.Context)
	}
}
