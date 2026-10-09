package dashboardcharts

import (
	"database/sql"
	"encoding/json"
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
	lookup := func(itemID, field string) (samplePoint, samplePoint, bool, error) {
		switch itemID + "/" + field {
		case "a/close":
			return samplePoint{RecordedAt: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), Value: 100},
				samplePoint{RecordedAt: time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), Value: 110.5, Unit: sql.NullString{String: "pts", Valid: true}},
				true, nil
		case "b/zzz_custom":
			return samplePoint{RecordedAt: time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC), Value: 50},
				samplePoint{RecordedAt: time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC), Value: 40},
				true, nil
		default:
			t.Fatalf("unexpected lookup %s %s", itemID, field)
			return samplePoint{}, samplePoint{}, false, nil
		}
	}
	body, err := buildHeatmap(items, fields, lookup)
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
	empty, err := buildHeatmap(nil, nil, lookup)
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
