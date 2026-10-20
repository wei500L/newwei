package newsnowhottest

import (
	"strings"
	"testing"
)

func TestComputePreferenceScore(t *testing.T) {
	profile := ScoringProfile{
		Items:  ScoreMap{"i1": 10},
		Events: ScoreMap{},
		Topics: ScoreMap{"t1": 5, "t2": 10},
	}
	maxima := dimensionMaxima{
		Items:  maxRecordValue(profile.Items),
		Topics: maxRecordValue(profile.Topics),
	}
	itemID := "i1"
	score := computePreferenceScore(preferenceInput{
		matchedItemID: &itemID,
		topics:        []string{"t1", "t2"},
		record:        profile,
		maxima:        maxima,
	})
	want := roundN(1*0.32+0.75*0.18, 4)
	if score != want {
		t.Fatalf("preference score = %v, want %v", score, want)
	}
	if got := normalizeTermScore(nil, profile.Items, 10); got != 0 {
		t.Fatalf("nil key score = %v", got)
	}
	if got := averageNormalizedTerms([]string{"t1", "t1", "t2"}, profile.Topics, 10, 4); got != 0.75 {
		t.Fatalf("dedupe average = %v", got)
	}
}

func TestComputeSourceScore(t *testing.T) {
	if got := computeSourceScore("s1", []string{"s1"}, map[string]float64{"s1": 50}); got != 0.625 {
		t.Fatalf("focus source = %v", got)
	}
	if got := computeSourceScore("s1", nil, map[string]float64{"s1": 200}); got != 0.75 {
		t.Fatalf("clamped affinity = %v", got)
	}
	if got := computeSourceScore("s2", nil, nil); got != 0 {
		t.Fatalf("missing source = %v", got)
	}
}

func TestComputeHotnessScore(t *testing.T) {
	candidate := 0.6
	freshness := 0.8
	if got := computeHotnessScore(&candidate, &freshness, 0, 8); got != 0.66 {
		t.Fatalf("analyzed hotness = %v", got)
	}
	if got := computeHotnessScore(nil, nil, 0, 8); got != 1 {
		t.Fatalf("fallback first = %v", got)
	}
	if got := computeHotnessScore(nil, nil, 7, 8); got != 0.125 {
		t.Fatalf("fallback last = %v", got)
	}
	if got := computeHotnessScore(nil, nil, 7, 0); got != 0.1 {
		t.Fatalf("fallback floor = %v", got)
	}
}

func TestNegativeFeedbackFilter(t *testing.T) {
	profile := ScoringProfile{
		Negative: NegativeScores{
			Sources: ScoreMap{"a": 1},
			Topics:  ScoreMap{"topic": 2},
		},
	}
	base := blockedInput{
		sourceID: "a-b",
		source:   SourceDescriptor{Name: "Source A"},
		negative: profile.Negative,
	}
	if !blockedByNegativeFeedback(base) {
		t.Fatal("base source alias must match the negative source")
	}
	base.sourceID = "other"
	if blockedByNegativeFeedback(base) {
		t.Fatal("unrelated source must not be blocked")
	}
	base.topics = []string{"topic"}
	if !blockedByNegativeFeedback(base) {
		t.Fatal("negative topic must block")
	}
	if hasPositiveScore(ScoreMap{}, nil) || hasPositiveScore(ScoreMap{"x": 0}, strPtr("x")) {
		t.Fatal("empty or zero scores are not positive")
	}
}

func strPtr(value string) *string { return &value }

func TestDedupeCandidatesKeepsBestAtFirstPosition(t *testing.T) {
	first := candidate{ID: "s1:a", SourceID: "s1", URL: "https://example.com/a", FinalScore: 0.4}
	second := candidate{ID: "s1:b", SourceID: "s1", URL: "https://example.com/a", FinalScore: 0.7}
	other := candidate{ID: "s1:c", SourceID: "s1", URL: "https://example.com/c", FinalScore: 0.5}
	deduped := dedupeCandidates([]candidate{first, second, other})
	if len(deduped) != 2 {
		t.Fatalf("deduped = %d", len(deduped))
	}
	if deduped[0].ID != "s1:b" || deduped[0].FinalScore != 0.7 {
		t.Fatalf("best value must win: %+v", deduped[0])
	}
	if deduped[1].ID != "s1:c" {
		t.Fatalf("order = %+v", deduped)
	}
}

func TestBuildDedupeKeyFallsBackToMatches(t *testing.T) {
	eventID := "e1"
	itemID := "i1"
	if got := buildDedupeKey(candidate{URL: "not a url", MatchedEventID: &eventID}); got != "event:e1" {
		t.Fatalf("event key = %q", got)
	}
	if got := buildDedupeKey(candidate{URL: "", MatchedItemID: &itemID}); got != "item:i1" {
		t.Fatalf("item key = %q", got)
	}
	if got := buildDedupeKey(candidate{ID: "s1:k", SourceID: "s1", URL: ""}); got != "s1:s1:k" {
		t.Fatalf("fallback key = %q", got)
	}
}

func TestResolveReasonLabel(t *testing.T) {
	if got := resolveReasonLabel(reasonInput{collaborativeScore: 0.9, contentScore: 0.1}); got != "相似用户也在关注" {
		t.Fatalf("collaborative label = %q", got)
	}
	eventID := "e"
	if got := resolveReasonLabel(reasonInput{contentScore: 0.9, matchedEventID: &eventID}); got != "匹配近期事件偏好" {
		t.Fatalf("event label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{contentScore: 0.9, isRising: true}); got != "匹配近期主题偏好" {
		t.Fatalf("content label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{sourceScore: 0.9, focusSources: []string{"s1"}, sourceID: "s1"}); got != "来自你关注的来源" {
		t.Fatalf("focus label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{sourceScore: 0.9, sourceID: "s2"}); got != "来源偏好较高" {
		t.Fatalf("source label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{isRising: true}); got != "热点正在上升" {
		t.Fatalf("rising label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{isNew: true}); got != "新进入热点候选" {
		t.Fatalf("new label = %q", got)
	}
	if got := resolveReasonLabel(reasonInput{}); got != "当前热度较高" {
		t.Fatalf("default label = %q", got)
	}
}

func TestNormalizeBehaviorTerm(t *testing.T) {
	term := normalizeBehaviorTerm("  Hello   World  ")
	if term == nil || *term != "hello world" {
		t.Fatalf("term = %v", term)
	}
	if normalizeBehaviorTerm("   ") != nil {
		t.Fatal("blank term must be nil")
	}
	long := strings.Repeat("a", 120)
	term = normalizeBehaviorTerm(long)
	if term == nil || len(*term) != 96 {
		t.Fatalf("truncated term length = %d", len(*term))
	}
}

func TestNormalizeDomain(t *testing.T) {
	if got := normalizeDomain("HTTPS://WWW.Example.COM/a"); got == nil || *got != "example.com" {
		t.Fatalf("domain = %v", got)
	}
	if normalizeDomain("not a url") != nil {
		t.Fatal("invalid url must be nil")
	}
}
