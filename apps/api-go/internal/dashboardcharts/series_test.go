package dashboardcharts

import (
	"database/sql"
	"encoding/json"
	"math"
	"testing"
	"time"
)

func TestHeatmapPrefersLabelThenFallsBack(t *testing.T) {
	preferredMeta := json.RawMessage(`{"dataViz":{"heatmap":{"preferredSourceFields":["收盘价"]}},"parser":{"valueFields":[{"field":"close","label":"收盘价"}]}}`)
	fallbackMeta := json.RawMessage(`{"dataViz":{"heatmap":{"preferredSourceFields":["close"]}}}`)
	items := []sectorItem{
		{ID: "a", Slug: "alpha", DisplayName: "Alpha", Metadata: preferredMeta, DefaultUnit: sql.NullString{String: "pts", Valid: true}},
		{ID: "b", Slug: "beta", DisplayName: "Beta", Metadata: fallbackMeta},
		{ID: "c", Slug: "empty", DisplayName: "Empty"},
	}
	fields := map[string][]string{
		"a": {"volume", "close"},
		"b": {"zzz_custom"},
	}
	batches := 0
	load := func(keys []seriesKey) (map[seriesKey]seriesEndpoints, error) {
		batches++
		loaded := make(map[seriesKey]seriesEndpoints, len(keys))
		for _, key := range keys {
			switch key.ItemID + "/" + key.Field {
			case "a/close":
				loaded[key] = seriesEndpoints{
					First: samplePoint{RecordedAt: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), Value: 100},
					Last:  samplePoint{RecordedAt: time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), Value: 110.5, Unit: sql.NullString{String: "pts", Valid: true}},
				}
			case "b/zzz_custom":
				loaded[key] = seriesEndpoints{
					First: samplePoint{RecordedAt: time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC), Value: 50},
					Last:  samplePoint{RecordedAt: time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC), Value: 40},
				}
			default:
				t.Fatalf("unexpected key %s/%s", key.ItemID, key.Field)
			}
		}
		return loaded, nil
	}
	body, err := buildHeatmap(items, fields, load)
	if err != nil {
		t.Fatal(err)
	}
	if len(body.Cells) != 2 || body.Cells[0].SourceField != "close" || body.Cells[0].Value != 110.5 || body.Cells[0].Change != 10.5 {
		t.Fatalf("preferred cell = %+v", body.Cells)
	}
	if body.Cells[0].X != 0 || body.Cells[1].X != 1 || body.Cells[1].SourceField != "zzz_custom" || body.Cells[1].Change != -20 {
		t.Fatalf("cells = %+v", body.Cells)
	}
	if body.Cells[1].Unit != nil {
		t.Fatalf("fallback unit = %#v", body.Cells[1].Unit)
	}
	if len(body.Warnings) != 1 || body.Warnings[0].Code != fallbackWarning || body.Warnings[0].SelectedSourceField != "zzz_custom" {
		t.Fatalf("warnings = %+v", body.Warnings)
	}
	if body.UpdatedAt == nil || *body.UpdatedAt != "2026-03-11T00:00:00.000Z" {
		t.Fatalf("updatedAt = %v", body.UpdatedAt)
	}
	if len(body.YLabels) != 1 || body.YLabels[0] != "Row 1" || len(body.XLabels) != 4 {
		t.Fatalf("labels x=%v y=%v", body.XLabels, body.YLabels)
	}
	if batches != 1 {
		t.Fatalf("endpoint batches = %d, want one per request", batches)
	}
	empty, err := buildHeatmap(nil, nil, load)
	if err != nil || len(empty.Cells) != 0 || len(empty.YLabels) != 2 {
		t.Fatalf("empty heatmap = %+v err=%v", empty, err)
	}
}

func TestCandlestickAliasPriorityAndIncomplete(t *testing.T) {
	item := &candleItem{
		ID:               "sp",
		DisplayName:      "标普500指数",
		DefaultFrequency: "daily",
		DefaultUnit:      sql.NullString{String: "pts", Valid: true},
		Metadata:         json.RawMessage(`{"dataViz":{"candlestick":{"ohlc":{"close":["收盘价","close"]}}}}`),
	}
	day1 := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 3, 2, 0, 0, 0, 0, time.UTC)
	points := []rawPoint{
		{RecordedAt: day1, Value: 10, SourceField: "open"},
		{RecordedAt: day1, Value: 12, SourceField: "high"},
		{RecordedAt: day1, Value: 9, SourceField: "low"},
		{RecordedAt: day1, Value: 99, SourceField: "close"},
		{RecordedAt: day1, Value: 11, SourceField: "收盘价", Unit: sql.NullString{String: "pts", Valid: true}},
		{RecordedAt: day2, Value: 11, SourceField: "open"},
		{RecordedAt: day2, Value: 13, SourceField: "high"},
		{RecordedAt: day2, Value: 12, SourceField: "close"},
	}
	success, mismatch := buildCandle(item, points, 0, nil)
	if mismatch != nil {
		t.Fatal("complete alias set must not be a mapping error")
	}
	encoded, err := encodeJSON(success)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	gotPoints, _ := body["points"].([]any)
	if len(gotPoints) != 1 {
		t.Fatalf("points = %s", encoded)
	}
	candle := gotPoints[0].(map[string]any)
	if candle["close"] != float64(11) || candle["open"] != float64(10) || candle["high"] != float64(12) || candle["low"] != float64(9) {
		t.Fatalf("ohlc = %s", encoded)
	}
	if body["skippedIncompleteCount"] != float64(1) || body["latestObservedAt"] != "2026-03-02T00:00:00.000Z" || body["updatedAt"] != "2026-03-01T00:00:00.000Z" {
		t.Fatalf("bounds = %s", encoded)
	}
	fields := body["sourceFields"].(map[string]any)
	if fields["close"] != "收盘价" {
		t.Fatalf("sourceFields = %s", encoded)
	}
	if !json.Valid(encoded) || string(encoded[0]) == "\n" {
		t.Fatalf("body = %s", encoded)
	}

	_, mismatch = buildCandle(item, nil, 3, []string{"turnover", "volume"})
	if mismatch == nil || mismatch.Available[0] != "turnover" {
		t.Fatalf("mismatch = %+v", mismatch)
	}
	missing, mismatch := buildCandle(nil, nil, 0, nil)
	if mismatch != nil || missing.Symbol != candlestickSlug || missing.Interval != "daily" || len(missing.Points) != 0 || missing.IncludeUnit {
		t.Fatalf("missing item = %+v", missing)
	}
}

// Number.prototype.toFixed rounds the two equally close candidates towards
// +Infinity, so an exact negative tie keeps the smaller magnitude. math.Round
// rounds away from zero instead, which produced -0.13 for -0.125.
func TestJSFixedMatchesToFixedTies(t *testing.T) {
	cases := []struct {
		value  float64
		digits int
		want   float64
	}{
		{0.125, 2, 0.13},
		{-0.125, 2, -0.12},
		{1.005, 2, 1},
		{-1.005, 2, -1},
		{-0.001, 2, 0},
		{110.456, 2, 110.46},
		{-20.0, 2, -20},
	}
	for _, entry := range cases {
		if got := jsFixed(entry.value, entry.digits); got != entry.want {
			t.Fatalf("jsFixed(%v, %d) = %v, want %v", entry.value, entry.digits, got, entry.want)
		}
	}
	// A rounded-to-zero negative value must serialise as 0, like JSON.stringify
	// of negative zero, not as "-0".
	if encoded, err := encodeJSON(jsFixed(-0.0001, 2)); err != nil || string(encoded) != "0" {
		t.Fatalf("negative zero = %s err=%v", encoded, err)
	}
}

func TestParseDecimalFoldsNegativeZero(t *testing.T) {
	for _, raw := range []string{"-0.000000000000", "-0", "0"} {
		value, err := parseDecimal([]byte(raw))
		if err != nil {
			t.Fatalf("parse %q: %v", raw, err)
		}
		if math.Signbit(value) {
			t.Fatalf("parse %q kept the sign bit", raw)
		}
	}
	value, err := parseDecimal([]byte("110.500000000000"))
	if err != nil || value != 110.5 {
		t.Fatalf("parse value = %v err=%v", value, err)
	}
}
