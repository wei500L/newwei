package newsnowclusteringops

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

// testStringPointer returns a pointer to a copy of value, for building nullable
// row columns in tests.
func testStringPointer(value string) *string {
	return &value
}

// testKeywordWeights indexes keyword summaries by keyword for order-insensitive
// assertions.
func testKeywordWeights(entries []CandidateKeywordSummary) map[string]float64 {
	out := make(map[string]float64, len(entries))
	for _, entry := range entries {
		out[entry.Keyword] = entry.Weight
	}
	return out
}

func TestRoundMetricAndClamp01(t *testing.T) {
	roundCases := []struct {
		name  string
		input float64
		want  float64
	}{
		{"rounds down", 0.12344321, 0.1234},
		{"rounds up", 0.123456789, 0.1235},
		{"keeps exact", 0.5, 0.5},
		{"zero", 0, 0},
		{"nan", math.NaN(), 0},
		{"positive infinity", math.Inf(1), 0},
		{"negative infinity", math.Inf(-1), 0},
	}
	for _, testCase := range roundCases {
		t.Run("roundMetric/"+testCase.name, func(t *testing.T) {
			if got := roundMetric(testCase.input); got != testCase.want {
				t.Fatalf("roundMetric(%v) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}

	clampCases := []struct {
		name  string
		input float64
		want  float64
	}{
		{"above one", 1.5, 1},
		{"below zero", -0.2, 0},
		{"nan", math.NaN(), 0},
		{"rounds to four decimals up", 0.123456789, 0.1235},
		{"rounds to four decimals down", 0.987612345, 0.9876},
	}
	for _, testCase := range clampCases {
		t.Run("clamp01/"+testCase.name, func(t *testing.T) {
			if got := clamp01(testCase.input); got != testCase.want {
				t.Fatalf("clamp01(%v) = %v, want %v", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestClamp01Rounded6 checks that the archive classifier keeps its own six
// decimal rounding instead of reusing the opinion index clamp01.
func TestClamp01Rounded6(t *testing.T) {
	cases := []struct {
		input float64
		want  float64
	}{
		{0.123456789, 0.123457},
		{1.5, 1},
		{-0.5, 0},
		{math.NaN(), 0},
	}
	for _, testCase := range cases {
		if got := clamp01Rounded6(testCase.input); got != testCase.want {
			t.Fatalf("clamp01Rounded6(%v) = %v, want %v", testCase.input, got, testCase.want)
		}
	}
}

func TestMergeWeightedMetric(t *testing.T) {
	cases := []struct {
		name           string
		newsnowValue   *float64
		pipelineValue  *float64
		newsnowWeight  float64
		pipelineWeight float64
		want           float64
	}{
		{
			name:           "both sides use the configured weights",
			newsnowValue:   float64Pointer(0.8),
			pipelineValue:  float64Pointer(0.4),
			newsnowWeight:  newsnowBlendWeight,
			pipelineWeight: pipelineBlendWeight,
			want:           0.7,
		},
		{
			name:           "only newsnow passes through rounded",
			newsnowValue:   float64Pointer(0.81234),
			pipelineValue:  nil,
			newsnowWeight:  newsnowBlendWeight,
			pipelineWeight: pipelineBlendWeight,
			want:           0.8123,
		},
		{
			name:           "only pipeline passes through rounded",
			newsnowValue:   nil,
			pipelineValue:  float64Pointer(0.45678),
			newsnowWeight:  newsnowBlendWeight,
			pipelineWeight: pipelineBlendWeight,
			want:           0.4568,
		},
		{
			name:           "neither side is zero",
			newsnowValue:   nil,
			pipelineValue:  nil,
			newsnowWeight:  newsnowBlendWeight,
			pipelineWeight: pipelineBlendWeight,
			want:           0,
		},
		{
			name:           "zero total weight falls back to the plain mean",
			newsnowValue:   float64Pointer(0.2),
			pipelineValue:  float64Pointer(0.4),
			newsnowWeight:  0,
			pipelineWeight: 0,
			want:           0.3,
		},
		{
			name:           "candidate count vs article count weighting",
			newsnowValue:   float64Pointer(0.2),
			pipelineValue:  float64Pointer(1),
			newsnowWeight:  5,
			pipelineWeight: 1,
			want:           0.3333,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := mergeWeightedMetric(
				testCase.newsnowValue,
				testCase.pipelineValue,
				testCase.newsnowWeight,
				testCase.pipelineWeight,
			)
			if got != testCase.want {
				t.Fatalf("mergeWeightedMetric = %v, want %v", got, testCase.want)
			}
		})
	}
}

// TestBlendWeights pins the fusion constants the merged buckets depend on.
func TestBlendWeights(t *testing.T) {
	if newsnowBlendWeight != 0.75 {
		t.Fatalf("newsnowBlendWeight = %v, want 0.75", newsnowBlendWeight)
	}
	if pipelineBlendWeight != 0.25 {
		t.Fatalf("pipelineBlendWeight = %v, want 0.25", pipelineBlendWeight)
	}
	if newsnowBlendWeight+pipelineBlendWeight != 1 {
		t.Fatalf("blend weights must sum to 1")
	}
}

func TestComputeIndexValue(t *testing.T) {
	cases := []struct {
		name                                     string
		attention, breadth, freshness, sentiment float64
		want                                     float64
	}{
		{"all ones", 1, 1, 1, 1, 1},
		{"all halves", 0.5, 0.5, 0.5, 0.5, 0.5},
		{"weighted mix", 0.8, 0.4, 0.6, 0.2, 0.62},
		{"all zeros", 0, 0, 0, 0, 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := computeIndexValue(testCase.attention, testCase.breadth, testCase.freshness, testCase.sentiment)
			if got != testCase.want {
				t.Fatalf(
					"computeIndexValue(%v, %v, %v, %v) = %v, want %v",
					testCase.attention, testCase.breadth, testCase.freshness, testCase.sentiment, got, testCase.want,
				)
			}
		})
	}
}

// TestMergeKeywordSummaries covers keyword bucket merging by normalized key.
func TestMergeKeywordSummaries(t *testing.T) {
	got := mergeKeywordSummaries([]CandidateKeywordSummary{
		{Keyword: "经济", Weight: 1},
		{Keyword: " 经济 ", Weight: 0.5},
		{Keyword: "Policy", Weight: 0.25},
		{Keyword: "", Weight: 5},
		{Keyword: "dropped", Weight: 0},
	})
	if len(got) != 2 {
		t.Fatalf("mergeKeywordSummaries returned %d entries, want 2: %#v", len(got), got)
	}
	weights := testKeywordWeights(got)
	if weights["经济"] != 1.5 {
		t.Fatalf("经济 weight = %v, want 1.5", weights["经济"])
	}
	if weights["Policy"] != 0.25 {
		t.Fatalf("Policy weight = %v, want 0.25", weights["Policy"])
	}
}

// TestMergeKeywordSummariesCapsAtTwelve checks the MAX_KEYWORDS_PER_INDEX cap.
func TestMergeKeywordSummariesCapsAtTwelve(t *testing.T) {
	values := make([]CandidateKeywordSummary, 0, 20)
	for index := 0; index < 20; index++ {
		values = append(values, CandidateKeywordSummary{
			Keyword: string(rune(0x4e00+index)) + "词",
			Weight:  float64(20 - index),
		})
	}
	if got := len(mergeKeywordSummaries(values)); got != maxKeywordsPerIndex {
		t.Fatalf("mergeKeywordSummaries returned %d entries, want %d", got, maxKeywordsPerIndex)
	}
}

// TestBuildPipelineKeywords covers the topic/entity/title keyword weighting.
func TestBuildPipelineKeywords(t *testing.T) {
	quality := 1.0
	row := opinionPipelineArticleRow{
		Title:        testStringPointer("中国 基建"),
		TopicsJSON:   []byte(`["经济"]`),
		EntitiesJSON: []byte(`["财政部", {"name":"国务院"}]`),
		QualityScore: &quality,
	}

	neutral := buildPipelineKeywords(row, sentimentLabel(""))
	if len(neutral) != 3 {
		t.Fatalf("neutral pipeline keywords = %#v, want 3 entries", neutral)
	}
	neutralWeights := testKeywordWeights(neutral)
	if neutralWeights["经济"] != 1 {
		t.Fatalf("topic weight = %v, want 1", neutralWeights["经济"])
	}
	if neutralWeights["财政部"] != 0.8 {
		t.Fatalf("entity weight = %v, want 0.8", neutralWeights["财政部"])
	}
	if neutralWeights["国务院"] != 0.8 {
		t.Fatalf("object entity weight = %v, want 0.8", neutralWeights["国务院"])
	}

	negative := buildPipelineKeywords(row, sentimentLabelNegative)
	negativeWeights := testKeywordWeights(negative)
	if negativeWeights["经济"] != 1.2 {
		t.Fatalf("boosted topic weight = %v, want 1.2", negativeWeights["经济"])
	}
	if negativeWeights["财政部"] != 0.96 {
		t.Fatalf("boosted entity weight = %v, want 0.96", negativeWeights["财政部"])
	}

	// Without topics or entities the title fallback runs at the fallback
	// quality score: 0.45 * (0.6 + 0.4 * 0.5) = 0.36.
	fallbackRow := opinionPipelineArticleRow{Title: testStringPointer("中国 基建")}
	fallback := testKeywordWeights(buildPipelineKeywords(fallbackRow, sentimentLabel("")))
	if fallback["中国"] != 0.36 {
		t.Fatalf("fallback keyword weight = %v, want 0.36", fallback["中国"])
	}
	if fallback["基建"] != 0.36 {
		t.Fatalf("fallback keyword weight = %v, want 0.36", fallback["基建"])
	}
}

func TestBuildPipelineKeywordsCapsAtTen(t *testing.T) {
	topics := make([]string, 0, maxKeywordsPerCandidate+4)
	for index := 0; index < maxKeywordsPerCandidate+4; index++ {
		topics = append(topics, string(rune(0x4e00+index))+"题")
	}
	raw, err := json.Marshal(topics)
	if err != nil {
		t.Fatalf("marshal topics: %v", err)
	}
	row := opinionPipelineArticleRow{TopicsJSON: raw}
	if got := len(buildPipelineKeywords(row, sentimentLabel(""))); got != maxKeywordsPerCandidate {
		t.Fatalf("buildPipelineKeywords returned %d entries, want %d", got, maxKeywordsPerCandidate)
	}
}

func TestExtractTitleFallbackKeywords(t *testing.T) {
	cases := []struct {
		name  string
		title string
		want  []string
	}{
		{"cjk runs", "中国 美国 日本", []string{"中国", "美国", "日本"}},
		{"latin runs", "launches chip plan", []string{"launches", "chip", "plan"}},
		{"cjk before latin", "中国 launches chip plan", []string{"中国", "launches", "chip", "plan"}},
		{"case insensitive dedup", "China china CHINA", []string{"China"}},
		{"empty title", "   ", []string{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := extractTitleFallbackKeywords(testCase.title)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("extractTitleFallbackKeywords(%q) = %#v, want %#v", testCase.title, got, testCase.want)
			}
			if got == nil {
				t.Fatalf("result must be a non-nil slice")
			}
		})
	}
}

func TestExtractTitleFallbackKeywordsCapsAtTen(t *testing.T) {
	tokens := make([]string, 0, 12)
	for index := 0; index < 12; index++ {
		tokens = append(tokens, string(rune(0x4e00+index))+string(rune(0x4e01+index)))
	}
	got := extractTitleFallbackKeywords(strings.Join(tokens, " "))
	if len(got) != maxKeywordsPerCandidate {
		t.Fatalf("extractTitleFallbackKeywords returned %d entries, want %d", len(got), maxKeywordsPerCandidate)
	}
	if got[0] != tokens[0] {
		t.Fatalf("first keyword = %q, want %q", got[0], tokens[0])
	}
}

func TestNormalizeCountryCode(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"alpha3", "USA", "USA"},
		{"alpha2", "US", "USA"},
		{"english name", "United States", "USA"},
		{"chinese name", "美国", "USA"},
		{"long chinese name", "中华人民共和国", "CHN"},
		{"unknown token", "Neverland", ""},
		{"empty", "", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := normalizeCountryCode(testCase.input); got != testCase.want {
				t.Fatalf("normalizeCountryCode(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestExtractCountryCodeFromText(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"U.S. rewrite", "U.S. officials confirmed the report", "USA"},
		// The JS module rewrites "U.K." to "UK", but "UK" is neither a valid
		// alpha-2 code nor an alias the scan keeps (its normalized label is only
		// two characters and the alias length guard skips those), so the result
		// stays null. The port reproduces that gap exactly.
		{"U.K. rewrite stays unresolved", "U.K. ministers met today", ""},
		{"alpha token", "talks with JPN continue", "JPN"},
		{"english name in text", "the economy of United States grew", "USA"},
		{"chinese name in text", "美国宣布新的关税措施", "USA"},
		{"no country", "local weather forecast", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := extractCountryCodeFromText(testCase.input); got != testCase.want {
				t.Fatalf("extractCountryCodeFromText(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

// TestRuleVerticalForArticle uses real taxonomy keywords: 基建 and 地方政府 are
// strong DOMESTIC_AFFAIRS keywords, 关税/峰会/双边关系 are strong
// FOREIGN_AFFAIRS keywords.
func TestRuleVerticalForArticle(t *testing.T) {
	cases := []struct {
		name  string
		title string
		want  ArchiveVertical
	}{
		{
			name:  "domestic chinese headline",
			title: "国务院部署地方政府专项债与基建投资",
			want:  ArchiveVerticalDomesticAffairs,
		},
		{
			name:  "foreign headline",
			title: "中美就关税问题举行峰会并讨论双边关系",
			want:  ArchiveVerticalForeignAffairs,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ruleVerticalForArticle(testCase.title, "", "", "", nil, nil)
			if got != testCase.want {
				t.Fatalf("ruleVerticalForArticle(%q) = %q, want %q", testCase.title, got, testCase.want)
			}
		})
	}
}

func TestRuleVerticalForArticleIgnoresForeignChineseHeadline(t *testing.T) {
	got := ruleVerticalForArticle("中美就关税问题举行峰会并讨论双边关系", "", "", "", nil, nil)
	if got == ArchiveVerticalDomesticAffairs {
		t.Fatalf("a foreign headline must not classify as DOMESTIC_AFFAIRS")
	}
}

func TestBuildDomesticOpinionIndexEmpty(t *testing.T) {
	now := time.Date(2026, 1, 2, 4, 30, 0, 0, time.UTC)
	response := BuildDomesticOpinionIndex(0, now, nil, nil, nil, nil)

	if response.DataState != NewsnowDataStateEmpty {
		t.Fatalf("DataState = %q, want %q", response.DataState, NewsnowDataStateEmpty)
	}
	if response.EmptyReason == nil {
		t.Fatalf("EmptyReason must be set")
	}
	if *response.EmptyReason != NewsnowDomesticOpinionEmptyReasonNoRecentSnapshotsOrPipelineData {
		t.Fatalf("EmptyReason = %q", *response.EmptyReason)
	}
	if response.Latest != nil {
		t.Fatalf("Latest must be nil")
	}
	if response.GeneratedAt != "2026-01-02T04:30:00.000Z" {
		t.Fatalf("GeneratedAt = %q", response.GeneratedAt)
	}
	if response.Diagnostics.RequestedHours != defaultTrendHours {
		t.Fatalf("RequestedHours = %d, want %d", response.Diagnostics.RequestedHours, defaultTrendHours)
	}
	if response.Diagnostics.SnapshotCount != 0 || response.Diagnostics.PipelineBucketCount != 0 {
		t.Fatalf("diagnostics = %#v, want zero counts", response.Diagnostics)
	}
	assertEmptySlices(t, response)
}

// TestBuildDomesticOpinionIndexClampsHours checks the requested-hours clamp.
func TestBuildDomesticOpinionIndexClampsHours(t *testing.T) {
	now := time.Date(2026, 1, 2, 4, 30, 0, 0, time.UTC)
	cases := []struct {
		hours int
		want  int
	}{
		{-5, defaultTrendHours},
		{0, defaultTrendHours},
		{5, 5},
		{500, maxTrendHours},
	}
	for _, testCase := range cases {
		response := BuildDomesticOpinionIndex(testCase.hours, now, nil, nil, nil, nil)
		if response.Diagnostics.RequestedHours != testCase.want {
			t.Fatalf("hours=%d: RequestedHours = %d, want %d", testCase.hours, response.Diagnostics.RequestedHours, testCase.want)
		}
	}
}

// TestBuildDomesticOpinionIndexMergesSharedBucket covers the 0.75/0.25 fusion of
// one snapshot hour and one pipeline hour that share the same bucket.
func TestBuildDomesticOpinionIndexMergesSharedBucket(t *testing.T) {
	now := time.Date(2026, 1, 2, 4, 30, 0, 0, time.UTC)
	bucketStart := time.Date(2026, 1, 2, 4, 0, 0, 0, time.UTC)

	domesticSourceID := ""
	for id := range domesticSourceIDs {
		domesticSourceID = id
		break
	}
	if domesticSourceID == "" {
		t.Fatal("domesticSourceIDs is empty")
	}

	snapshots := []opinionSnapshotRow{{
		BucketStart:        bucketStart,
		IndexValue:         0.5,
		AttentionScore:     0.8,
		BreadthScore:       0.4,
		FreshnessScore:     0.6,
		SentimentPressure:  0.2,
		CandidateCount:     5,
		KeywordSummaryJSON: []byte(`[{"keyword":"政策","weight":2},{"keyword":"","weight":1},{"keyword":"x","weight":0}]`),
	}}

	processedItemID := "processed-item-1"
	processedItemIDNeutral := "processed-item-2"
	sourceID := domesticSourceID
	sentiment := "negative"
	eventAt := time.Date(2026, 1, 2, 4, 20, 0, 0, time.UTC)
	articles := []opinionPipelineArticleRow{
		{
			ID:                 "article-1",
			Title:              testStringPointer("中国政府推动基建投资"),
			TopicsJSON:         []byte(`["经济","经济政策"]`),
			EntitiesJSON:       []byte(`[{"name":"财政部"},"国务院"]`),
			Language:           testStringPointer("zh-CN"),
			EventAt:            eventAt,
			ProcessedAt:        eventAt.Add(-time.Hour),
			CleanedMarkdownRef: &processedItemID,
			CrawlAt:            eventAt.Add(-10 * time.Minute),
		},
		{
			ID:                 "article-2",
			TopicsJSON:         []byte(`["经济","经济政策"]`),
			EntitiesJSON:       []byte(`[{"name":"财政部"},"国务院"]`),
			Language:           testStringPointer("zh"),
			EventAt:            eventAt.Add(-10 * time.Minute),
			ProcessedAt:        eventAt.Add(-time.Hour),
			CleanedMarkdownRef: &processedItemIDNeutral,
			CrawlAt:            eventAt.Add(-10 * time.Minute),
		},
	}
	signals := map[string]processedItemSignal{
		processedItemID:        {SourceID: &sourceID, Sentiment: &sentiment},
		processedItemIDNeutral: {SourceID: &sourceID},
	}
	candidates := []opinionCandidateRow{
		{Label: "低热度", CandidateScore: 0.2, DomesticRatio: 0.5, SourceCount: 3},
		{Label: "高热度", CandidateScore: 0.9, DomesticRatio: 0.8, SourceCount: 2},
	}

	response := BuildDomesticOpinionIndex(24, now, snapshots, candidates, articles, signals)

	if response.DataState != NewsnowDataStateReady {
		t.Fatalf("DataState = %q, want %q", response.DataState, NewsnowDataStateReady)
	}
	if response.EmptyReason != nil {
		t.Fatalf("EmptyReason must be nil")
	}
	if response.Latest == nil {
		t.Fatal("Latest must not be nil")
	}
	if len(response.Trend) != 1 {
		t.Fatalf("Trend has %d buckets, want 1", len(response.Trend))
	}
	if response.Trend[0].BucketStart != "2026-01-02T04:00:00.000Z" {
		t.Fatalf("BucketStart = %q", response.Trend[0].BucketStart)
	}
	if response.Latest.CandidateCount != 5 {
		t.Fatalf("CandidateCount = %d, want 5", response.Latest.CandidateCount)
	}
	if response.Diagnostics.SnapshotCount != 1 || response.Diagnostics.PipelineBucketCount != 1 {
		t.Fatalf("diagnostics = %#v, want one of each", response.Diagnostics)
	}

	// The pipeline side of the same hour comes from the two domestic articles:
	// their attention feeds the 0.75/0.25 fusion, their shared source and single
	// sentiment document feed breadth and sentiment pressure.
	newsnowAttention := 0.8
	pipelineAttention := roundMetric(clamp01(math.Log1p(2) / math.Log1p(12)))
	wantAttention := roundMetric(newsnowAttention*newsnowBlendWeight + pipelineAttention*pipelineBlendWeight)
	if response.Latest.AttentionScore != wantAttention {
		t.Fatalf("AttentionScore = %v, want %v", response.Latest.AttentionScore, wantAttention)
	}
	if wantAttention != 0.7071 {
		t.Fatalf("sanity: expected fusion value = %v, want 0.7071", wantAttention)
	}
	wantSentiment := roundMetric((0.2*5 + 1*2) / 7)
	if response.Latest.SentimentPressure != wantSentiment {
		t.Fatalf("SentimentPressure = %v, want %v", response.Latest.SentimentPressure, wantSentiment)
	}

	if response.Breakdown.Latest == nil {
		t.Fatal("Breakdown.Latest must not be nil")
	}
	if response.Breakdown.Latest.Newsnow == nil {
		t.Fatal("Breakdown.Latest.Newsnow must not be nil")
	}
	if response.Breakdown.Latest.Pipeline == nil {
		t.Fatal("Breakdown.Latest.Pipeline must not be nil")
	}
	if response.Breakdown.Latest.Pipeline.ArticleCount != 2 {
		t.Fatalf("Pipeline.ArticleCount = %d, want 2", response.Breakdown.Latest.Pipeline.ArticleCount)
	}
	if response.Breakdown.Latest.Pipeline.SourceCount != 1 {
		t.Fatalf("Pipeline.SourceCount = %d, want 1", response.Breakdown.Latest.Pipeline.SourceCount)
	}
	if response.Breakdown.Latest.Newsnow.CandidateCount != 5 {
		t.Fatalf("Newsnow.CandidateCount = %d, want 5", response.Breakdown.Latest.Newsnow.CandidateCount)
	}
	if len(response.Breakdown.TopKeywords.Newsnow) != 1 {
		t.Fatalf("Newsnow top keywords = %#v, want the single valid entry", response.Breakdown.TopKeywords.Newsnow)
	}
	if len(response.Breakdown.TopKeywords.Pipeline) != 4 {
		t.Fatalf("Pipeline top keywords = %#v, want 4 entries", response.Breakdown.TopKeywords.Pipeline)
	}
	if len(response.TopCandidates) != 2 {
		t.Fatalf("TopCandidates = %#v, want 2 entries", response.TopCandidates)
	}
	if response.TopCandidates[0].Label != "高热度" || response.TopCandidates[1].Label != "低热度" {
		t.Fatalf("TopCandidates order = %#v", response.TopCandidates)
	}
	if response.TopCandidates[0].CandidateScore != 0.9 {
		t.Fatalf("top candidate score = %v, want 0.9", response.TopCandidates[0].CandidateScore)
	}
}

// TestBuildDomesticOpinionIndexSeparatesBuckets covers two different hours: the
// snapshot-only hour and the pipeline-only hour stay separate and ordered.
func TestBuildDomesticOpinionIndexSeparatesBuckets(t *testing.T) {
	now := time.Date(2026, 1, 2, 4, 30, 0, 0, time.UTC)

	snapshots := []opinionSnapshotRow{{
		BucketStart:       time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC),
		IndexValue:        0.42,
		AttentionScore:    0.7,
		BreadthScore:      0.3,
		FreshnessScore:    0.5,
		SentimentPressure: 0.1,
		CandidateCount:    3,
	}}

	processedItemID := "processed-item-2"
	sourceID := ""
	for id := range domesticSourceIDs {
		sourceID = id
		break
	}
	if sourceID == "" {
		t.Fatal("domesticSourceIDs is empty")
	}
	eventAt := time.Date(2026, 1, 2, 4, 10, 0, 0, time.UTC)
	articles := []opinionPipelineArticleRow{{
		ID:                 "article-2",
		Title:              testStringPointer("地方政府基建投资"),
		TopicsJSON:         []byte(`["经济"]`),
		EventAt:            eventAt,
		ProcessedAt:        eventAt,
		CleanedMarkdownRef: &processedItemID,
		CrawlAt:            eventAt,
	}}
	signals := map[string]processedItemSignal{
		processedItemID: {SourceID: &sourceID},
	}
	candidates := []opinionCandidateRow{{Label: "ignored", CandidateScore: 0.9, DomesticRatio: 1, SourceCount: 9}}

	response := BuildDomesticOpinionIndex(24, now, snapshots, candidates, articles, signals)

	if len(response.Trend) != 2 {
		t.Fatalf("Trend has %d buckets, want 2", len(response.Trend))
	}
	if response.Trend[0].BucketStart != "2026-01-02T03:00:00.000Z" {
		t.Fatalf("first bucket = %q", response.Trend[0].BucketStart)
	}
	if response.Trend[1].BucketStart != "2026-01-02T04:00:00.000Z" {
		t.Fatalf("second bucket = %q", response.Trend[1].BucketStart)
	}
	if response.Trend[0].IndexValue != 0.42 {
		t.Fatalf("snapshot-only IndexValue = %v, want 0.42", response.Trend[0].IndexValue)
	}
	if response.Trend[0].CandidateCount != 3 {
		t.Fatalf("snapshot-only CandidateCount = %d, want 3", response.Trend[0].CandidateCount)
	}
	if response.Trend[1].CandidateCount != 0 {
		t.Fatalf("pipeline-only CandidateCount = %d, want 0", response.Trend[1].CandidateCount)
	}
	if response.Latest == nil || response.Latest.BucketStart != "2026-01-02T04:00:00.000Z" {
		t.Fatalf("Latest = %#v, want the pipeline-only hour", response.Latest)
	}
	if response.Breakdown.Latest == nil || response.Breakdown.Latest.Newsnow != nil {
		t.Fatalf("pipeline-only latest must not carry a newsnow source")
	}
	if response.Breakdown.Latest.Pipeline == nil {
		t.Fatal("pipeline-only latest must carry a pipeline source")
	}
	// Top candidates are only loaded for a snapshot-backed latest bucket.
	if response.TopCandidates == nil || len(response.TopCandidates) != 0 {
		t.Fatalf("TopCandidates = %#v, want an empty non-nil slice", response.TopCandidates)
	}
	assertNonNilSlices(t, response)
}

// assertEmptySlices checks the empty response keeps every array field non-nil.
func assertEmptySlices(t *testing.T, response DomesticOpinionIndexResponse) {
	t.Helper()
	if response.Trend == nil || len(response.Trend) != 0 {
		t.Fatalf("Trend = %#v, want an empty non-nil slice", response.Trend)
	}
	if response.TopKeywords == nil || len(response.TopKeywords) != 0 {
		t.Fatalf("TopKeywords = %#v, want an empty non-nil slice", response.TopKeywords)
	}
	if response.TopCandidates == nil || len(response.TopCandidates) != 0 {
		t.Fatalf("TopCandidates = %#v, want an empty non-nil slice", response.TopCandidates)
	}
	if response.Breakdown.Latest != nil {
		t.Fatalf("Breakdown.Latest must be nil")
	}
	if response.Breakdown.Trend == nil || len(response.Breakdown.Trend) != 0 {
		t.Fatalf("Breakdown.Trend = %#v, want an empty non-nil slice", response.Breakdown.Trend)
	}
	if response.Breakdown.TopKeywords.Newsnow == nil || response.Breakdown.TopKeywords.Pipeline == nil {
		t.Fatalf("Breakdown.TopKeywords slices must be non-nil")
	}
}

// assertNonNilSlices checks a ready response never serializes an array as null.
func assertNonNilSlices(t *testing.T, response DomesticOpinionIndexResponse) {
	t.Helper()
	if response.Trend == nil {
		t.Fatal("Trend must be non-nil")
	}
	if response.TopKeywords == nil {
		t.Fatal("TopKeywords must be non-nil")
	}
	if response.TopCandidates == nil {
		t.Fatal("TopCandidates must be non-nil")
	}
	if response.Breakdown.Trend == nil {
		t.Fatal("Breakdown.Trend must be non-nil")
	}
	if response.Breakdown.TopKeywords.Newsnow == nil || response.Breakdown.TopKeywords.Pipeline == nil {
		t.Fatal("Breakdown.TopKeywords slices must be non-nil")
	}
	for index, point := range response.Breakdown.Trend {
		if point.Newsnow == nil && point.Pipeline == nil {
			t.Fatalf("Breakdown.Trend[%d] has neither source", index)
		}
	}
}
