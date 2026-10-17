package newsnowclusteringops

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

// assertClose fails when got and want differ by more than 1e-9.
func assertClose(t *testing.T, label string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("%s = %v, want %v", label, got, want)
	}
}

// TestAffinityRecencyDecay pins the decay multiplier and its 0.2 floor.
func TestAffinityRecencyDecay(t *testing.T) {
	assertClose(t, "factor(0)", affinityRecencyFactor(0), 1)
	// 1 - 14/(14*1.25) = 0.2, which is also the clamp floor.
	assertClose(t, "factor(14)", affinityRecencyFactor(14), 0.2)
	assertClose(t, "factor(7)", affinityRecencyFactor(7), 0.6)
	// Anything older than 14 days is already clamped by affinityElapsedDays,
	// but the factor floor must hold on its own too.
	assertClose(t, "factor(20)", affinityRecencyFactor(20), 0.2)
	assertClose(t, "factor(100)", affinityRecencyFactor(100), 0.2)
}

// TestAffinityElapsedDaysClamp pins the [0, 14] day clamp.
func TestAffinityElapsedDaysClamp(t *testing.T) {
	const dayMs = int64(24 * 60 * 60 * 1000)
	nowMillis := time.Now().UnixMilli()

	assertClose(t, "elapsed(now)", affinityElapsedDays(int(nowMillis), nowMillis), 0)
	assertClose(t, "elapsed(14d)", affinityElapsedDays(0, 14*dayMs), 14)
	assertClose(t, "elapsed(28d)", affinityElapsedDays(0, 28*dayMs), 14)
	assertClose(t, "elapsed(future)", affinityElapsedDays(50*dayMs, 10*dayMs), 0)
	assertClose(t, "elapsed(1d)", affinityElapsedDays(0, dayMs), 1)

	// A missing affinity entry uses the 14 day default, which lands on the
	// 0.2 factor floor.
	assertClose(t, "missing entry factor", affinityRecencyFactor(float64(newsnowSmartScoreMaxAgeDays)), 0.2)
}

// TestNormalizeBehaviorScoreBoundaries pins the log1p normalization edges.
func TestNormalizeBehaviorScoreBoundaries(t *testing.T) {
	const maxScore = 10.0
	normalizer := math.Log1p(maxScore)

	assertClose(t, "raw 0", normalizeBehaviorScore(0, normalizer), 0)
	assertClose(t, "raw negative", normalizeBehaviorScore(-5, normalizer), 0)
	assertClose(t, "raw == max", normalizeBehaviorScore(maxScore, normalizer), 1)
	assertClose(t, "raw > max", normalizeBehaviorScore(maxScore*2, normalizer), 1)
	assertClose(t, "half", normalizeBehaviorScore(math.Exp(0.5*normalizer)-1, normalizer), 0.5)
	// A zero normalizer means "no positive behavior anywhere": everything is 0.
	assertClose(t, "zero normalizer", normalizeBehaviorScore(7, 0), 0)
}

// TestMaxScoreValueIgnoresNonPositiveValues pins Math.max(0, ...values).
func TestMaxScoreValueIgnoresNonPositiveValues(t *testing.T) {
	assertClose(t, "empty", maxScoreValue(map[string]float64{}), 0)
	assertClose(t, "all negative", maxScoreValue(map[string]float64{"a": -3, "b": -0.5}), 0)
	assertClose(t, "mixed", maxScoreValue(map[string]float64{"a": -3, "b": 4.5}), 4.5)
	assertClose(t, "non-finite", maxScoreValue(map[string]float64{"a": math.Inf(1), "b": math.NaN()}), 0)
}

// scoreFor builds a neutral scoring input with no affinity and no weights.
func scoreFor(positiveRaw, negativeRaw float64) sourceScoringInput {
	return sourceScoringInput{
		SourceID:            "source",
		PositiveBehaviorRaw: positiveRaw,
		NegativeBehaviorRaw: negativeRaw,
		PositiveNormalizer:  math.Log1p(10),
		NegativeNormalizer:  math.Log1p(10),
		AffinityWeight:      0,
		BehaviorWeight:      1,
	}
}

// TestScoreSourceBehaviorWeighting pins the positive/negative behavior
// asymmetry: positive behavior scores above no behavior, negative behavior
// scores below it.
func TestScoreSourceBehaviorWeighting(t *testing.T) {
	positiveOnly := scoreSource(scoreFor(10, 0))
	noBehavior := scoreSource(scoreFor(0, 0))
	negativeOnly := scoreSource(scoreFor(0, 10))

	if !(positiveOnly.Score > noBehavior.Score) {
		t.Fatalf("positive-only score %v must exceed no-behavior score %v", positiveOnly.Score, noBehavior.Score)
	}
	if !(negativeOnly.Score < noBehavior.Score) {
		t.Fatalf("negative-only score %v must be below no-behavior score %v", negativeOnly.Score, noBehavior.Score)
	}
	assertClose(t, "positive weight 1", positiveOnly.Score, 100)
	// behaviorWeighted = (0 - 1*1.15) * 100 = -115, clamped to 0 for display.
	assertClose(t, "negative weighted", negativeOnly.Score, -115)
	assertClose(t, "negative display", negativeOnly.DisplayScore, 0)
	// negativeContribution is the negative signal's positive share of the
	// behavior weight: 1 * 100 * 1 = 100.
	assertClose(t, "negative detail", negativeOnly.Detail.NegativeContribution, 100)
}

// TestScoreSourceRecencyAndFocus pins affinity decay inside scoreSource plus
// the focus bonus and the 0..100 display clamp.
func TestScoreSourceRecencyAndFocus(t *testing.T) {
	const dayMs = int64(24 * 60 * 60 * 1000)
	now := 100 * dayMs

	fresh := scoreSource(sourceScoringInput{
		SourceID:       "fresh",
		HasAffinity:    true,
		Affinity:       usersettings.NewsnowSourceAffinity{Score: 80, LastInteractedAt: int(now)},
		AffinityWeight: 1,
		NowMillis:      now,
	})
	assertClose(t, "fresh affinity", fresh.Score, 80)

	stale := scoreSource(sourceScoringInput{
		SourceID:       "stale",
		HasAffinity:    true,
		Affinity:       usersettings.NewsnowSourceAffinity{Score: 80, LastInteractedAt: 0},
		AffinityWeight: 1,
		NowMillis:      now,
	})
	assertClose(t, "stale affinity", stale.Score, 80*0.2)

	// The focus bonus is added after weighting but before the display clamp.
	focused := scoreSource(sourceScoringInput{SourceID: "focus", IsFocus: true, FocusSourceBonus: 0.35})
	assertClose(t, "focus bonus", focused.Score, 0.35)
	assertClose(t, "focus display", focused.DisplayScore, 0.35)
	assertClose(t, "focus detail", focused.Detail.FocusBonus, 0.35)

	notFocused := scoreSource(sourceScoringInput{SourceID: "plain", IsFocus: false, FocusSourceBonus: 150})
	assertClose(t, "no focus bonus", notFocused.Score, 0)

	// combinedScore may exceed 100; only displayScore is clamped.
	capped := scoreSource(sourceScoringInput{SourceID: "capped", IsFocus: true, FocusSourceBonus: 150})
	assertClose(t, "capped combined", capped.Score, 150)
	assertClose(t, "capped display", capped.DisplayScore, 100)
	assertClose(t, "capped detail", capped.Detail.CombinedScore, 150)
}

// TestApplyManualOrder pins ordering, filtering and de-duplication.
func TestApplyManualOrder(t *testing.T) {
	got := applyManualOrder([]string{"a", "b", "c"}, []string{"c", "a", "c", "z"})
	want := []string{"c", "a", "b"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("applyManualOrder = %v, want %v", got, want)
	}

	got = applyManualOrder([]string{"a", "b"}, nil)
	if strings.Join(got, ",") != "a,b" {
		t.Fatalf("applyManualOrder(nil) = %v, want [a b]", got)
	}

	got = applyManualOrder([]string{"a", "b"}, []string{"z"})
	if strings.Join(got, ",") != "a,b" {
		t.Fatalf("applyManualOrder(unknown) = %v, want [a b]", got)
	}
}

// TestNormalizeRankingSourceWeights pins the ratio normalization, the
// non-finite guards and the all-zero 50/50 fallback.
func TestNormalizeRankingSourceWeights(t *testing.T) {
	weights := normalizeRankingSourceWeights(3, 1)
	assertClose(t, "affinity(3,1)", weights.Affinity, 0.75)
	assertClose(t, "behavior(3,1)", weights.Behavior, 0.25)

	weights = normalizeRankingSourceWeights(0, 0)
	assertClose(t, "affinity(0,0)", weights.Affinity, 0.5)
	assertClose(t, "behavior(0,0)", weights.Behavior, 0.5)

	weights = normalizeRankingSourceWeights(-1, 0)
	assertClose(t, "affinity(-1,0)", weights.Affinity, 0.5)
	assertClose(t, "behavior(-1,0)", weights.Behavior, 0.5)

	weights = normalizeRankingSourceWeights(math.Inf(1), 0)
	assertClose(t, "affinity(+Inf,0)", weights.Affinity, 0.5)
	assertClose(t, "behavior(+Inf,0)", weights.Behavior, 0.5)

	weights = normalizeRankingSourceWeights(math.NaN(), 2)
	assertClose(t, "affinity(NaN,2)", weights.Affinity, 0)
	assertClose(t, "behavior(NaN,2)", weights.Behavior, 1)

	weights = normalizeRankingSourceWeights(0.42, 0.58)
	assertClose(t, "affinity(0.42,0.58)", weights.Affinity, 0.42)
}

// TestResolveStaleTTLMs pins both strategies, the throttleWindowMs*2 floor and
// the 1000 ms floor.
func TestResolveStaleTTLMs(t *testing.T) {
	cases := []struct {
		name           string
		cacheTTLMs     int
		throttleWindow int
		strategy       StaleTTLStrategy
		multiplier     int
		fixedMs        int
		want           int
	}{
		{"multiplier", 20000, 10000, StaleTTLStrategyMultiplier, 3, 60000, 60000},
		{"multiplier throttle floor", 1000, 600000, StaleTTLStrategyMultiplier, 1, 1000, 1200000},
		{"fixed", 20000, 10000, StaleTTLStrategyFixed, 3, 45000, 45000},
		{"fixed throttle floor", 0, 30000, StaleTTLStrategyFixed, 1, 1000, 60000},
		{"1000ms floor", 0, 0, StaleTTLStrategyMultiplier, 1, 1000, 1000},
	}
	for _, testCase := range cases {
		got := resolveStaleTTLMs(testCase.cacheTTLMs, testCase.throttleWindow, testCase.strategy, testCase.multiplier, testCase.fixedMs)
		if got != testCase.want {
			t.Fatalf("%s: resolveStaleTTLMs = %d, want %d", testCase.name, got, testCase.want)
		}
	}

	// The policy method must agree with the free function.
	policy := PersonalizationPolicy{
		CacheTTLMs:         20000,
		ThrottleWindowMs:   10000,
		StaleTTLStrategy:   StaleTTLStrategyMultiplier,
		StaleTTLMultiplier: 3,
		StaleTTLFixedMs:    60000,
	}
	if got := policy.ResolveStaleTTLMs(); got != 60000 {
		t.Fatalf("policy.ResolveStaleTTLMs() = %d, want 60000", got)
	}
}

// TestNormalizeBehaviorTerm pins trimming, whitespace collapsing and the 96
// unit truncation.
func TestNormalizeBehaviorTerm(t *testing.T) {
	if got := normalizeBehaviorTerm("  Hello   WORLD \n"); got != "hello world" {
		t.Fatalf("normalizeBehaviorTerm = %q, want %q", got, "hello world")
	}
	// \u00a0 is JavaScript whitespace and must collapse like a plain space.
	if got := normalizeBehaviorTerm("a\u00a0b"); got != "a b" {
		t.Fatalf("normalizeBehaviorTerm(nbsp) = %q, want %q", got, "a b")
	}
	if got := normalizeBehaviorTerm("   "); got != "" {
		t.Fatalf("normalizeBehaviorTerm(blank) = %q, want empty", got)
	}
	if got := normalizeBehaviorTerm(strings.Repeat("a", 200)); got != strings.Repeat("a", behaviorTermMaxLength) {
		t.Fatalf("normalizeBehaviorTerm(200 runes) length = %d, want %d", len(got), behaviorTermMaxLength)
	}
	if got := normalizeBehaviorTerm(strings.Repeat("a", behaviorTermMaxLength)); got != strings.Repeat("a", behaviorTermMaxLength) {
		t.Fatalf("normalizeBehaviorTerm(96 runes) must be untouched, got length %d", len(got))
	}
}

// TestExtractDomainFromURL pins absolute, bare, port-qualified and empty input.
func TestExtractDomainFromURL(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"https://www.Example.com/x", "example.com"},
		{"example.com", "example.com"},
		{"https://sub.example.com:8443/path", "sub.example.com"},
		{"https://example.com", "example.com"},
		{"", ""},
		{"   ", ""},
	}
	for _, testCase := range cases {
		if got := extractDomainFromURL(testCase.raw); got != testCase.want {
			t.Fatalf("extractDomainFromURL(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}

// TestResolveBehaviorSourceScoreAliases pins alias resolution (id, base id,
// name, title, home domain), the maximum-wins rule and the negative guard.
func TestResolveBehaviorSourceScoreAliases(t *testing.T) {
	meta := &newsnowMetadataSource{
		Name:  "V2EX",
		Title: "Latest",
		Home:  "https://www.v2ex.com/",
	}
	scores := map[string]float64{
		"v2ex-share": 5,
		"v2ex":       3,
		"latest":     4,
		"v2ex.com":   7,
	}
	if got := resolveBehaviorSourceScore("v2ex-share", meta, scores); got != 7 {
		t.Fatalf("alias max = %v, want 7", got)
	}
	if got := resolveBehaviorSourceScore("v2ex-share", nil, scores); got != 5 {
		t.Fatalf("id-only max = %v, want 5", got)
	}
	if got := resolveBehaviorSourceScore("unknown", nil, scores); got != 0 {
		t.Fatalf("unknown source = %v, want 0", got)
	}
	if got := resolveBehaviorSourceScore("v2ex-share", meta, map[string]float64{"v2ex-share": -3}); got != 0 {
		t.Fatalf("negative-only = %v, want 0", got)
	}

	aliases := buildSourceBehaviorAliases("v2ex-share", meta)
	want := []string{"v2ex-share", "v2ex", "latest", "v2ex.com"}
	if strings.Join(aliases, ",") != strings.Join(want, ",") {
		t.Fatalf("buildSourceBehaviorAliases = %v, want %v", aliases, want)
	}
	if got := buildSourceBehaviorAliases("plain", nil); len(got) != 1 || got[0] != "plain" {
		t.Fatalf("buildSourceBehaviorAliases(plain) = %v, want [plain]", got)
	}
}

// TestStableSerializeForCacheSortsObjectKeys pins recursive key sorting, null
// handling, array order and nested objects.
func TestStableSerializeForCacheSortsObjectKeys(t *testing.T) {
	value := newCacheObject(
		cacheField{Key: "c", Value: newCacheString("x")},
		cacheField{Key: "a", Value: newCacheArray(newCacheInt(1), newCacheInt(2))},
		cacheField{Key: "b", Value: newCacheObject(
			cacheField{Key: "z", Value: newCacheNull()},
			cacheField{Key: "y", Value: newCacheBool(true)},
		)},
	)
	want := `{"a":[1,2],"b":{"y":true,"z":null},"c":"x"}`
	if got := stableSerializeForCache(value); got != want {
		t.Fatalf("stableSerializeForCache = %s, want %s", got, want)
	}

	// Scalars follow encoding/json; NaN and infinities become null like
	// JSON.stringify.
	if got := stableSerializeForCache(newCacheFloat(math.NaN())); got != "null" {
		t.Fatalf("NaN serialization = %s, want null", got)
	}
	if got := stableSerializeForCache(newCacheFloat(0.42)); got != "0.42" {
		t.Fatalf("float serialization = %s, want 0.42", got)
	}
	if got := stableSerializeForCache(newCacheObject()); got != "{}" {
		t.Fatalf("empty object = %s, want {}", got)
	}
	if got := stableSerializeForCache(newCacheArray()); got != "[]" {
		t.Fatalf("empty array = %s, want []", got)
	}
}

// TestSettingsCacheSignatureIsOrderIndependent pins that the settings
// signature is stable across JSON key order and normalizes smart mode.
func TestSettingsCacheSignatureIsOrderIndependent(t *testing.T) {
	first := usersettings.NormalizeNewsnow([]byte(`{"columnOrders":{"b":["x"],"a":["y"]},"sortMode":"smart"}`))
	second := usersettings.NormalizeNewsnow([]byte(`{"sortMode":"personalized","columnOrders":{"a":["y"],"b":["x"]}}`))

	firstSignature := settingsCacheSignature(first)
	if !strings.Contains(firstSignature, `"sortMode":"personalized"`) {
		t.Fatalf("signature %s must normalize smart to personalized", firstSignature)
	}
	if firstSignature != settingsCacheSignature(second) {
		t.Fatalf("signatures differ across key order:\n%s\n%s", firstSignature, settingsCacheSignature(second))
	}

	withAffinity := usersettings.NormalizeNewsnow([]byte(`{"sourceAffinity":{"a":{"score":1},"b":{"score":2}}}`))
	reordered := usersettings.NormalizeNewsnow([]byte(`{"sourceAffinity":{"b":{"score":2},"a":{"score":1}}}`))
	if settingsCacheSignature(withAffinity) != settingsCacheSignature(reordered) {
		t.Fatal("affinity signature must not depend on key order")
	}
}

// TestNormalizeStoredSettings pins the reject-not-clamp contract: absent
// optional fields fall back to defaults, present-but-invalid fields invalidate
// the whole record.
func TestNormalizeStoredSettings(t *testing.T) {
	full := json.RawMessage(`{"cacheTtlMs":30000,"maxCacheEntries":500,"throttleWindowMs":20000,` +
		`"maxRequestsPerWindowPerUser":10,"affinitySourceWeight":1,"behaviorSourceWeight":2,` +
		`"focusSourceBonus":3,"staleTtlStrategy":"fixed","staleTtlMultiplier":5,"staleTtlFixedMs":90000}`)
	policy, ok := normalizeStoredSettings(full)
	if !ok {
		t.Fatal("full valid record must normalize")
	}
	if policy.Source != PersonalizationPolicySourceDatabase {
		t.Fatalf("source = %q, want db", policy.Source)
	}
	if policy.CacheTTLMs != 30000 || policy.MaxCacheEntries != 500 || policy.ThrottleWindowMs != 20000 ||
		policy.MaxRequestsPerWindowPerUser != 10 || policy.StaleTTLMultiplier != 5 || policy.StaleTTLFixedMs != 90000 {
		t.Fatalf("integer fields not preserved: %+v", policy)
	}
	assertClose(t, "affinity", policy.AffinitySourceWeight, 1)
	assertClose(t, "behavior", policy.BehaviorSourceWeight, 2)
	assertClose(t, "focus", policy.FocusSourceBonus, 3)
	if policy.StaleTTLStrategy != StaleTTLStrategyFixed {
		t.Fatalf("strategy = %q, want fixed", policy.StaleTTLStrategy)
	}

	// Optionals absent: required integers accepted, optionals defaulted.
	requiredOnly := json.RawMessage(`{"cacheTtlMs":"20000","maxCacheEntries":2000,` +
		`"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40}`)
	policy, ok = normalizeStoredSettings(requiredOnly)
	if !ok {
		t.Fatal("required-only record must normalize")
	}
	assertClose(t, "default affinity", policy.AffinitySourceWeight, defaultAffinitySourceWeight)
	assertClose(t, "default behavior", policy.BehaviorSourceWeight, defaultBehaviorSourceWeight)
	assertClose(t, "default focus", policy.FocusSourceBonus, defaultFocusSourceBonus)
	if policy.StaleTTLStrategy != StaleTTLStrategyMultiplier || policy.StaleTTLMultiplier != defaultStaleTTLMultiplier ||
		policy.StaleTTLFixedMs != defaultStaleTTLFixedMs {
		t.Fatalf("stale defaults missing: %+v", policy)
	}

	invalid := []json.RawMessage{
		json.RawMessage(`null`),
		json.RawMessage(`[]`),
		json.RawMessage(`"nope"`),
		json.RawMessage(`{}`),
		json.RawMessage(`{"cacheTtlMs":400000,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40}`),
		json.RawMessage(`{"cacheTtlMs":20000.5,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40}`),
		json.RawMessage(`{"cacheTtlMs":20000,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40,"affinitySourceWeight":6}`),
		json.RawMessage(`{"cacheTtlMs":20000,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40,"affinitySourceWeight":null}`),
		json.RawMessage(`{"cacheTtlMs":20000,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40,"behaviorSourceWeight":0,"affinitySourceWeight":0}`),
		json.RawMessage(`{"cacheTtlMs":20000,"maxCacheEntries":2000,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40,"staleTtlStrategy":"bogus"}`),
		json.RawMessage(`{"cacheTtlMs":20000,"maxCacheEntries":99,"throttleWindowMs":10000,"maxRequestsPerWindowPerUser":40}`),
	}
	for _, raw := range invalid {
		if _, ok := normalizeStoredSettings(raw); ok {
			t.Fatalf("normalizeStoredSettings(%s) must fail", raw)
		}
	}
}

// TestNormalizeMetricIncrements pins that only positive fields are written.
func TestNormalizeMetricIncrements(t *testing.T) {
	got := normalizeMetricIncrements(PersonalizationMetricIncrements{
		RequestCount:          2,
		CacheHitFreshCount:    0,
		CacheHitStaleCount:    -3,
		ThrottleLimitedCount:  1,
		ThrottleRejectedCount: 0,
		TrimCount:             0,
		TrimEvictedCount:      5,
	})
	want := "requestCount=2,throttleLimitedCount=1,trimEvictedCount=5"
	parts := make([]string, 0, len(got))
	for _, increment := range got {
		parts = append(parts, increment.Field+"="+strconv.FormatInt(increment.Amount, 10))
	}
	if strings.Join(parts, ",") != want {
		t.Fatalf("normalizeMetricIncrements = %v, want %s", got, want)
	}
	if len(normalizeMetricIncrements(PersonalizationMetricIncrements{})) != 0 {
		t.Fatal("empty increments must produce no writes")
	}
}

// TestBuildMetricsKey pins the UTC day bucket key.
func TestBuildMetricsKey(t *testing.T) {
	late := time.Date(2026, 3, 8, 23, 59, 59, 999000000, time.UTC)
	if got := buildMetricsKey(late); got != "newsnow:personalization:metrics:v1:2026-03-08" {
		t.Fatalf("buildMetricsKey = %s", got)
	}

	// A date east of UTC must still be bucketed by its UTC day.
	plusFourteen := time.FixedZone("+14", 14*60*60)
	localNextDay := time.Date(2026, 3, 9, 10, 0, 0, 0, plusFourteen)
	if got := buildMetricsKey(localNextDay); got != "newsnow:personalization:metrics:v1:2026-03-08" {
		t.Fatalf("buildMetricsKey(local) = %s, want the UTC day", got)
	}
}

// TestValidateColumnKey pins the controller's column rules.
func TestValidateColumnKey(t *testing.T) {
	if got, err := ValidateColumnKey(" China "); err != nil || got != "china" {
		t.Fatalf("ValidateColumnKey(China) = %q, %v", got, err)
	}
	if got, err := ValidateColumnKey("tech_1-X"); err != nil || got != "tech_1-x" {
		t.Fatalf("ValidateColumnKey(tech_1-X) = %q, %v", got, err)
	}
	if _, err := ValidateColumnKey(""); !errors.Is(err, errColumnRequired) {
		t.Fatalf("empty column error = %v, want errColumnRequired", err)
	}
	if _, err := ValidateColumnKey("bad key"); !errors.Is(err, errInvalidColumnFormat) {
		t.Fatalf("blank column error = %v, want errInvalidColumnFormat", err)
	}
	if _, err := ValidateColumnKey(strings.Repeat("a", columnIDMaxLength+1)); !errors.Is(err, errInvalidColumnFormat) {
		t.Fatalf("long column error = %v, want errInvalidColumnFormat", err)
	}
	if got, err := ValidateColumnKey(strings.Repeat("a", columnIDMaxLength)); err != nil || got != strings.Repeat("a", columnIDMaxLength) {
		t.Fatalf("64 char column must be accepted, got %q, %v", got, err)
	}
}

// TestNormalizeSourceIDs pins the combined controller + availability filter.
func TestNormalizeSourceIDs(t *testing.T) {
	available := map[string]struct{}{"ok-1": {}, "ok-2": {}, "V2EX": {}, "v2ex": {}}
	got := NormalizeSourceIDs([]string{" ok-1 ", "BAD ID", "ok-2", "ok-1", "", "V2EX", "v2ex", "missing"}, available)
	want := []string{"ok-1", "ok-2", "V2EX", "v2ex"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("NormalizeSourceIDs = %v, want %v", got, want)
	}

	if got := NormalizeSourceIDs([]string{"ok-1"}, nil); len(got) != 0 {
		t.Fatalf("NormalizeSourceIDs with no availability = %v, want empty", got)
	}

	// The availability-only helper mirrors the NestJS service filter.
	if got := normalizePersonalizationSourceIDs([]string{"a", "b", "a", "c"}, map[string]struct{}{"a": {}, "b": {}}); strings.Join(got, ",") != "a,b" {
		t.Fatalf("normalizePersonalizationSourceIDs = %v, want [a b]", got)
	}
}

// TestCacheKeysAndTTLs pins the cache key composition, the sha1 token and the
// Redis key prefixes.
func TestCacheKeysAndTTLs(t *testing.T) {
	cacheKey := buildPersonalizationCacheKey("org", "user", "tech", []string{"a", "b"}, "sig", "policy")
	if cacheKey != "org|user|tech|a,b|sig|policy" {
		t.Fatalf("buildPersonalizationCacheKey = %s", cacheKey)
	}
	token := hashPersonalizationCacheKey(cacheKey)
	if len(token) != 40 {
		t.Fatalf("sha1 token length = %d, want 40", len(token))
	}
	if got := buildPersonalizationRedisFreshCacheKey(token); got != "news-aggregator:personalization:order:v1:fresh:"+token {
		t.Fatalf("fresh key = %s", got)
	}
	if got := buildPersonalizationRedisStaleCacheKey(token); got != "news-aggregator:personalization:order:v1:stale:"+token {
		t.Fatalf("stale key = %s", got)
	}

	ttlCases := []struct {
		ms   int
		want int
	}{{20000, 20}, {1500, 2}, {1000, 1}, {1, 1}, {0, 1}}
	for _, testCase := range ttlCases {
		if got := msToTTLSeconds(testCase.ms); got != testCase.want {
			t.Fatalf("msToTTLSeconds(%d) = %d, want %d", testCase.ms, got, testCase.want)
		}
	}
}
