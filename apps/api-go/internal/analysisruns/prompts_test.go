package analysisruns

import (
	"strings"
	"testing"
)

func TestRenderPromptTemplateReplacesOnlyKnownPlaceholders(t *testing.T) {
	rendered := renderPromptTemplate("a={{a}} b={{missing}} c={{c}}", map[string]string{
		"a": "1.5",
		"c": "x",
	})
	if rendered != "a=1.5 b= c=x" {
		t.Fatalf("rendered = %q", rendered)
	}
}

func TestCorrelationMessagesNumberNewsAndUseEmptyFallback(t *testing.T) {
	builder := NewPromptBuilder(PromptOverrides{})
	messages := builder.CorrelationMessages(CorrelationInput{
		IndicatorName: "CPI",
		Value:         101.5,
		ChangePercent: -2.25,
		StartDate:     "2026-01-01",
		EndDate:       "2026-01-31",
		NewsSummaries: []string{"first", "second"},
	})
	user := messages[len(messages)-1].Content
	if !strings.Contains(user, "1. first\n2. second") {
		t.Fatalf("news numbering missing: %q", user)
	}
	if !strings.Contains(user, "当前值 101.5") || !strings.Contains(user, "环比变化 -2.25%") {
		t.Fatalf("number formatting mismatch: %q", user)
	}

	empty := builder.CorrelationMessages(CorrelationInput{
		IndicatorName: "CPI",
		StartDate:     "a",
		EndDate:       "b",
		NewsSummaries: nil,
	})
	if !strings.Contains(empty[len(empty)-1].Content, "相关新闻：无相关新闻") {
		t.Fatalf("empty news fallback missing: %q", empty[len(empty)-1].Content)
	}
}

func TestPromptOverrideEmptyStringIsReal(t *testing.T) {
	empty := ""
	builder := NewPromptBuilder(PromptOverrides{CorrelationSystem: &empty})
	messages := builder.CorrelationMessages(CorrelationInput{})
	if messages[0].Content != "" {
		t.Fatalf("system prompt = %q, want configured empty string", messages[0].Content)
	}
}

func TestGeoTransportMessagesEmbedJSONStringifyShape(t *testing.T) {
	builder := NewPromptBuilder(PromptOverrides{})
	context := GeoContext{
		Filters: GeoFilters{
			TransportKinds: []string{"aircraft"},
			StartDate:      "2026-01-01",
			EndDate:        "2026-01-02",
		},
		ObjectKeys:    []string{"abc"},
		TrackPointIDs: []string{"p1"},
		Hotspots:      []GeoHotspot{{GeoCell: "cell<1>", Count: 2}},
		Objects: []GeoObject{{
			ObjectKey:        "abc",
			EntityKind:       "aircraft",
			SourceScope:      "all",
			Name:             "ABC",
			LatestObservedAt: "2026-01-02T00:00:00.000Z",
			LatestPosition:   GeoPosition{Lat: 1.5, Lng: 2.5},
			TrackPoints: []GeoTrackPoint{{
				TrackPointID: "p1",
				ObservedAt:   "2026-01-02T00:00:00.000Z",
				Lat:          1.5,
				Lng:          2.5,
			}},
		}},
	}
	messages := builder.GeoTransportMessages(GeoTransportInput{
		TransportKinds: []string{"aircraft"},
		StartDate:      "2026-01-01",
		EndDate:        "2026-01-02",
	}, context)
	user := messages[len(messages)-1].Content
	if !strings.Contains(user, "\"trackPointIds\": [") {
		t.Fatalf("context JSON missing: %q", user)
	}
	if !strings.Contains(user, "\"geoCell\": \"cell<1>\"") {
		t.Fatalf("HTML escaping changed the context: %q", user)
	}
	// Nullable fields are present as null, not omitted.
	if !strings.Contains(user, "\"displayCategory\": null") {
		t.Fatalf("nullable field should serialize as null: %q", user)
	}
}

func TestAnomalyPrefixIsOnlyAddedWhenFindingsExist(t *testing.T) {
	builder := NewPromptBuilder(PromptOverrides{})
	_, findings, statsSummary := builder.AnomalyMessages(AnomalyInput{
		Metric:    "m",
		Timestamp: "t",
		Series:    &[]SeriesPoint{{Timestamp: "a", Value: 1}},
	})
	if len(findings) != 0 {
		t.Fatalf("unexpected findings: %+v", findings)
	}
	if statsSummary != "未检测到显著的统计异常" {
		t.Fatalf("stats summary = %q", statsSummary)
	}
}
