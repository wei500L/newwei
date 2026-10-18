package itemsreading

import (
	"encoding/base64"
	"math"
	"testing"
	"time"
)

// TestDecodeItemsCursorAcceptsLegacyAndJSONShapes pins the cursor compatibility
// contract: the JSON object written by EncodeItemsCursor, the legacy bare
// base64(id), and an undecodable value treated as no cursor.
func TestDecodeItemsCursorAcceptsLegacyAndJSONShapes(t *testing.T) {
	createdAt := "2026-10-18T10:00:00.000Z"
	offset := 7
	encoded := EncodeItemsCursor(ItemsCursorPayload{ID: "item-1", CreatedAt: &createdAt, Offset: &offset})
	decoded := DecodeItemsCursor(&encoded)
	if decoded == nil || decoded.ID != "item-1" || decoded.CreatedAt == nil || *decoded.CreatedAt != createdAt {
		t.Fatalf("json cursor round trip = %+v", decoded)
	}
	if decoded.Offset == nil || *decoded.Offset != 7 {
		t.Fatalf("json cursor offset = %+v", decoded.Offset)
	}

	legacy := base64.StdEncoding.EncodeToString([]byte("item-legacy"))
	fromLegacy := DecodeItemsCursor(&legacy)
	if fromLegacy == nil || fromLegacy.ID != "item-legacy" {
		t.Fatalf("legacy cursor = %+v", fromLegacy)
	}

	if got := DecodeItemsCursor(nil); got != nil {
		t.Fatalf("nil cursor = %+v", got)
	}
	blank := "   "
	if got := DecodeItemsCursor(&blank); got != nil {
		t.Fatalf("blank cursor = %+v", got)
	}
	notBase64 := "!!!!"
	if got := DecodeItemsCursor(&notBase64); got != nil {
		t.Fatalf("undecodable cursor = %+v", got)
	}
	noID := base64.StdEncoding.EncodeToString([]byte(`{"createdAt":"2026-10-18T10:00:00.000Z"}`))
	if got := DecodeItemsCursor(&noID); got != nil {
		t.Fatalf("json cursor without id = %+v", got)
	}
}

// TestResolveListFiltersPrefersExplicitObject pins the presence rule: an
// explicit filters object wins, including {}, while a null/omitted filters
// argument falls back to the historical payload filters.
func TestResolveListFiltersPrefersExplicitObject(t *testing.T) {
	legacy := &ItemFilters{Topics: []string{"legacy"}}
	parsed := ParsedSearchPayload{Search: "climate", Filters: legacy}

	if got := resolveListFilters(parsed, nil, true); got != nil {
		t.Fatalf("explicit empty filters must win as no filters, got %+v", got)
	}
	explicit := &ItemFilters{Topics: []string{"  explicit  "}}
	got := resolveListFilters(parsed, explicit, true)
	if got == nil || len(got.Topics) != 1 || got.Topics[0] != "explicit" {
		t.Fatalf("explicit filters = %+v", got)
	}
	fromLegacy := resolveListFilters(parsed, nil, false)
	if fromLegacy == nil || len(fromLegacy.Topics) != 1 || fromLegacy.Topics[0] != "legacy" {
		t.Fatalf("legacy filters = %+v", fromLegacy)
	}
}

// TestResolveListRankingModeRequiresDecodedSearch pins that RELEVANCE is honoured
// only when the decoded search term is non-blank.
func TestResolveListRankingModeRequiresDecodedSearch(t *testing.T) {
	if got := resolveListRankingMode(ItemsRankingRelevance, "climate"); got != ItemsRankingRelevance {
		t.Fatalf("relevance with search = %s", got)
	}
	if got := resolveListRankingMode(ItemsRankingRelevance, "   "); got != ItemsRankingRecency {
		t.Fatalf("relevance with blank search = %s", got)
	}
	if got := resolveListRankingMode(ItemsRankingRecency, "climate"); got != ItemsRankingRecency {
		t.Fatalf("explicit recency = %s", got)
	}
}

// TestCheckedOffsetBounds pins the IR2 pagination-offset ceiling.
func TestCheckedOffsetBounds(t *testing.T) {
	if offset, ok := checkedOffset(1, 50); !ok || offset != 0 {
		t.Fatalf("first page offset = %d ok=%v", offset, ok)
	}
	if offset, ok := checkedOffset(2, 10); !ok || offset != 10 {
		t.Fatalf("second page offset = %d ok=%v", offset, ok)
	}
	if _, ok := checkedOffset(MaxPaginationOffset, 50); ok {
		t.Fatal("out-of-range offset must be rejected")
	}
	if _, ok := checkedOffset(0, 10); ok {
		t.Fatal("page below one must be rejected")
	}
}

// TestRelevanceAndPersonalizedFormulasDiffer pins both ranking formulas and the
// fact that they are not shared.
func TestRelevanceAndPersonalizedFormulasDiffer(t *testing.T) {
	relevance := finalRelevanceScore(1, 1, 1, 1)
	if math.Abs(relevance-1) > 1e-9 {
		t.Fatalf("max relevance score = %v", relevance)
	}
	partial := finalRelevanceScore(0, 0, defaultSourceTrustScore, 0.5)
	want := defaultWeightSourceTrust*defaultSourceTrustScore + defaultWeightQuality*0.5
	if math.Abs(partial-want) > 1e-9 {
		t.Fatalf("partial relevance score = %v want %v", partial, want)
	}

	recency := personalizedRecencyScore(0)
	if math.Abs(recency-1) > 1e-9 {
		t.Fatalf("fresh personalized recency = %v", recency)
	}
	if got := personalizedRecencyScore(36); math.Abs(got-0.5) > 1e-9 {
		t.Fatalf("36h personalized recency = %v", got)
	}
	behavior := personalizedBehaviorScore(math.E-1, 0)
	if math.Abs(behavior-1) > 1e-9 {
		t.Fatalf("behavior score = %v", behavior)
	}
	final := personalizedFinalScore(1, 0)
	if math.Abs(final-0.78) > 1e-9 {
		t.Fatalf("personalized final = %v", final)
	}
}

// TestParseBehaviorScoresKeepsPositiveOrderedTerms pins the normalization and
// the 400 entry cap.
func TestParseBehaviorScoresKeepsPositiveOrderedTerms(t *testing.T) {
	raw := map[string]float64{
		"  Climate  ": 2,
		"energy":      3,
		"skip-zero":   0,
		"skip-nan":    math.NaN(),
		"  ":          5,
	}
	scores := parseBehaviorScores(raw, normalizePreferenceKeyString)
	if len(scores) != 2 {
		t.Fatalf("scores = %+v", scores)
	}
	if scores["energy"] != 3 || scores["climate"] != 2 {
		t.Fatalf("normalized scores = %+v", scores)
	}

	many := make(map[string]float64, personalizedTermCap+10)
	for index := 0; index < personalizedTermCap+10; index++ {
		many[string(rune('a'+index%26))+string(rune('0'+index/26))] = float64(index + 1)
	}
	if got := len(parseBehaviorScores(many, normalizePreferenceKeyString)); got != personalizedTermCap {
		t.Fatalf("capped score count = %d", got)
	}
}

// TestSumPreferenceScoreDedupesAndLimits pins the per-dimension term summation.
func TestSumPreferenceScoreDedupesAndLimits(t *testing.T) {
	profile := map[string]float64{"a": 1, "b": 2, "c": 3, "d": 4}
	if got := sumPreferenceScore([]string{"a", "a", "b"}, profile, 6); got != 3 {
		t.Fatalf("deduped sum = %v", got)
	}
	if got := sumPreferenceScore([]string{"a", "b", "c", "d"}, profile, 2); got != 3 {
		t.Fatalf("limited sum = %v", got)
	}
	if got := sumPreferenceScore(nil, profile, 6); got != 0 {
		t.Fatalf("empty sum = %v", got)
	}
}

// TestSourcePreferenceScoreUsesSourceOrDomain pins the source/domain maximum.
func TestSourcePreferenceScoreUsesSourceOrDomain(t *testing.T) {
	source := "reuters"
	domain := "reuters.com"
	service := &Service{}
	feature := ItemCandidateFeatures{Source: &source, Domain: &domain}
	if got := service.sourcePreferenceScore(feature, map[string]float64{"reuters": 1, "reuters.com": 3}); got != 3 {
		t.Fatalf("domain preferred score = %v", got)
	}
	if got := service.sourcePreferenceScore(feature, map[string]float64{"reuters": 4, "reuters.com": 3}); got != 4 {
		t.Fatalf("source preferred score = %v", got)
	}
	if got := service.sourcePreferenceScore(ItemCandidateFeatures{}, map[string]float64{"x": 1}); got != 0 {
		t.Fatalf("empty feature score = %v", got)
	}
}

// TestNormalizePreferenceKeys pins the key, id and domain normalization.
func TestNormalizePreferenceKeys(t *testing.T) {
	if got := normalizePreferenceKeyString("  Reuters  Wire "); got != "reuters wire" {
		t.Fatalf("preference key = %q", got)
	}
	long := ""
	for index := 0; index < 200; index++ {
		long += "x"
	}
	if got := normalizeBehaviorID(long); len([]rune(got)) != 128 {
		t.Fatalf("behavior id length = %d", len([]rune(got)))
	}
	raw := "https://www.Example.com/path"
	if got := normalizePreferenceDomain(&raw); got != "example.com" {
		t.Fatalf("domain = %q", got)
	}
	bare := "example.com"
	if got := normalizePreferenceDomain(&bare); got != "example.com" {
		t.Fatalf("bare domain = %q", got)
	}
}

// TestSourceTrustAndRecencyHelpers pins the shared scoring helpers.
func TestSourceTrustAndRecencyHelpers(t *testing.T) {
	reuters := "Reuters"
	if got := computeSourceTrustScore(&reuters); got != 0.96 {
		t.Fatalf("reuters trust = %v", got)
	}
	unknown := "some blog"
	if got := computeSourceTrustScore(&unknown); got != defaultSourceTrustScore {
		t.Fatalf("unknown trust = %v", got)
	}
	if got := computeLexicalScore("climate policy", "Climate policy outlook"); got != 1 {
		t.Fatalf("substring lexical = %v", got)
	}
	if got := computeLexicalScore("climate energy", "climate policy"); got != 0.5 {
		t.Fatalf("token lexical = %v", got)
	}
	fresh := computeRecencyScore(time.Now(), 48)
	if math.Abs(fresh-1) > 1e-6 {
		t.Fatalf("fresh recency = %v", fresh)
	}
	halfLife := computeRecencyScore(time.Now().Add(-48*time.Hour), 48)
	if math.Abs(halfLife-0.5) > 1e-3 {
		t.Fatalf("half-life recency = %v", halfLife)
	}
}
