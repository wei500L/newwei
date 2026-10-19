package archivereading

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestBuildClassificationTextAndHash(t *testing.T) {
	rule := ClassifyRuleSignals(RuleInput{
		Title:    "  East China Sea patrol  ",
		Topics:   []string{"defense", "defense", " "},
		Entities: []Entity{{Name: "Japan"}, {Name: "Japan"}},
		Location: "Tokyo",
		Source:   "wire",
	})
	text := buildClassificationText(classificationTextInput{
		Title:    "  East China Sea patrol  ",
		Summary:  "summary",
		Topics:   []string{"defense", "defense", " "},
		Entities: []Entity{{Name: "Japan"}, {Name: "Japan"}},
		Location: "Tokyo",
		Source:   "wire",
		Rule:     rule,
	})
	for _, line := range []string{
		"Title: East China Sea patrol",
		"Summary: summary",
		"Topics: defense",
		"Entities: Japan",
		"Location: Tokyo",
		"Source: wire",
		"Region hint: " + string(rule.Region),
	} {
		if !strings.Contains(text, line) {
			t.Fatalf("classification text missing %q:\n%s", line, text)
		}
	}
	if strings.Count(text, "defense") != 1 || strings.Count(text, "Japan") != 1 {
		t.Fatalf("classification text did not de-duplicate:\n%s", text)
	}
	hash := hashClassificationText(text)
	if len(hash) != 64 {
		t.Fatalf("hash length = %d, want 64", len(hash))
	}
	if hashClassificationText(text+"!") == hash {
		t.Fatal("hash did not change with the text")
	}
}

func TestCachedStaleReasons(t *testing.T) {
	row := storedClassificationRow{
		TaxonomyVersion: classificationTaxonomyVersion,
		PipelineVersion: classificationPipelineVersion,
		EmbeddingModel:  "embed-a",
		RerankModel:     "rerank-a",
	}
	if reasons := cachedStaleReasons(row, modelSelection{}); len(reasons) != 0 {
		t.Fatalf("unconfigured models must not be stale: %v", reasons)
	}
	embed := "embed-b"
	rerank := "rerank-b"
	reasons := cachedStaleReasons(row, modelSelection{EmbeddingModel: &embed, RerankModel: &rerank})
	if len(reasons) != 2 || reasons[0] != StaleEmbeddingModel || reasons[1] != StaleRerankModel {
		t.Fatalf("model stale reasons = %v", reasons)
	}
	old := row
	old.TaxonomyVersion = "archive-vertical-v1"
	old.PipelineVersion = "archive-hybrid-v1"
	reasons = cachedStaleReasons(old, modelSelection{})
	if len(reasons) != 2 || reasons[0] != StaleTaxonomyVersion || reasons[1] != StalePipelineVersion {
		t.Fatalf("version stale reasons = %v", reasons)
	}
}

func TestSelectVerticalOutcome(t *testing.T) {
	var fused scoreVector
	fused[verticalIndex(VerticalEastSea)] = 0.60
	fused[verticalIndex(VerticalSouthSea)] = 0.55
	rule := RuleSignals{CountryMatchedVerticals: []Vertical{VerticalSouthSea}}
	outcome := selectVerticalOutcome(fused, scoreVector{}, scoreVector{}, scoreVector{}, rule)
	if outcome.vertical != VerticalSouthSea || outcome.reason != DecisionStrongRuleOverride {
		t.Fatalf("strong override = %+v", outcome)
	}

	fused = scoreVector{}
	fused[verticalIndex(VerticalEastSea)] = 0.45
	var ruleScores scoreVector
	ruleScores[verticalIndex(VerticalDomesticAffairs)] = 0.9
	outcome = selectVerticalOutcome(fused, ruleScores, scoreVector{}, scoreVector{}, RuleSignals{})
	if outcome.vertical != VerticalDomesticAffairs || outcome.reason != DecisionLowSemanticConfidence {
		t.Fatalf("low-semantic fallback = %+v", outcome)
	}

	outcome = selectVerticalOutcome(scoreVector{}, scoreVector{}, scoreVector{}, scoreVector{}, RuleSignals{})
	if outcome.vertical != VerticalForeignAffairs || outcome.reason != DecisionDefaultForeignAffairs {
		t.Fatalf("default fallback = %+v", outcome)
	}
}

func TestQualityWeightAndQualityScore(t *testing.T) {
	cases := []struct {
		score  *float64
		weight int
	}{
		{nil, 1},
		{floatPtr(0.0), 1},
		{floatPtr(0.19), 1},
		{floatPtr(0.2), 2},
		{floatPtr(0.4), 3},
		{floatPtr(0.6), 4},
		{floatPtr(0.8), 5},
		{floatPtr(1.5), 5},
	}
	for _, tc := range cases {
		if got := qualityToWeight(tc.score); got != tc.weight {
			t.Fatalf("qualityToWeight(%v) = %d, want %d", tc.score, got, tc.weight)
		}
	}
	if got := normalizeQuality(floatPtr(1.5)); got == nil || *got != 1 {
		t.Fatalf("quality clamp = %v", got)
	}
}

func floatPtr(value float64) *float64 { return &value }

func TestCursorRoundTripAndClamp(t *testing.T) {
	encoded := encodeCursor(VerticalSouthSea, 37)
	offset, ok := decodeCursor(VerticalSouthSea, encoded)
	if !ok || offset != 37 {
		t.Fatalf("cursor = %d,%t", offset, ok)
	}
	if _, ok := decodeCursor(VerticalEastSea, encoded); ok {
		t.Fatal("cursor accepted for the wrong vertical")
	}
	if _, ok := decodeCursor(VerticalEastSea, "not-base64"); ok {
		t.Fatal("bad cursor accepted")
	}
	padded := base64.URLEncoding.EncodeToString([]byte(`{"v":"EAST_SEA","o":"12.9"}`))
	offset, ok = decodeCursor(VerticalEastSea, padded)
	if !ok || offset != 12 {
		t.Fatalf("string offset = %d,%t", offset, ok)
	}
	if got := clampOffset(999, 10); got != 10 {
		t.Fatalf("clampOffset = %d", got)
	}
}

func TestMonthRangeBoundaries(t *testing.T) {
	start, end, err := monthRange("2026-02")
	if err != nil {
		t.Fatal(err)
	}
	if got := start.Format(time.RFC3339Nano); got != "2026-02-01T00:00:00Z" {
		t.Fatalf("start = %s", got)
	}
	if end.Day() != 28 || end.Hour() != 23 || end.Minute() != 59 || end.Second() != 59 || end.Nanosecond() != 999000000 {
		t.Fatalf("end = %s", end.Format(time.RFC3339Nano))
	}
	if _, _, err := monthRange("2026-13"); err == nil {
		t.Fatal("month 13 accepted")
	} else if archiveError, ok := err.(*Error); !ok || archiveError.AppCode != AppCodeMonthInvalid {
		t.Fatalf("month error = %#v", err)
	}
}

func TestDigestSorting(t *testing.T) {
	now := time.Now().UTC()
	items := []DigestItem{
		{ProcessedArticleID: "b", Weight: 3, SortAt: now},
		{ProcessedArticleID: "a", Weight: 3, SortAt: now},
		{ProcessedArticleID: "c", Weight: 5, SortAt: now.Add(-time.Hour)},
	}
	sortDigestItems(items, false)
	want := []string{"c", "a", "b"}
	for index, id := range want {
		if items[index].ProcessedArticleID != id {
			t.Fatalf("order = %v, want %v", items, want)
		}
	}
	higher := 0.9
	lower := 0.4
	items = []DigestItem{
		{ProcessedArticleID: "a", Weight: 5, SortAt: now, RelevanceScore: &lower},
		{ProcessedArticleID: "b", Weight: 1, SortAt: now, RelevanceScore: &higher},
	}
	sortDigestItems(items, true)
	if items[0].ProcessedArticleID != "b" {
		t.Fatalf("relevance order = %v", items)
	}
}

func TestAllowedWeightsDefault(t *testing.T) {
	set := allowedWeightSet(nil)
	for value := 1; value <= 5; value++ {
		if !set[value] {
			t.Fatalf("default weights missing %d", value)
		}
	}
	set = allowedWeightSet([]Weight{WeightFive, WeightTwo})
	if !set[5] || !set[2] || set[3] {
		t.Fatalf("weight filter = %v", set)
	}
}
