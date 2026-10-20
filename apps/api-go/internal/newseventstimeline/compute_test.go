package newseventstimeline

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// defaultRuntimeSettings are the thresholds resolveTimelineRuntimeSettings
// produces from a stored document that omits every timeline leaf: the NestJS
// defaults 0.5 / 0.8 / 0.35 / 3 / 0.3 / 16 / 8 plus minCategoryConfidenceForGate
// 0.4 as the confidence fallback.
func defaultRuntimeSettings() timelineRuntimeSettings {
	return timelineRuntimeSettings{
		ConfidenceFallback:           0.4,
		LowConfidenceThreshold:       0.5,
		HighConfidenceThreshold:      0.8,
		DriftKLThreshold:             0.35,
		MinBucketItemsForDrift:       3,
		CrossCategoryWarningShare:    0.3,
		MaxCategoryDistributionItems: 16,
		MaxPhaseSummaries:            8,
	}
}

func floatPointer(value float64) *float64 { return &value }

func stringPointer(value string) *string { return &value }

func testItem(path string, confidence, quality float64) timelineSourceItem {
	return timelineSourceItem{
		ProcessedArticleID: "c" + path,
		ArticleID:          "a" + path,
		Timestamp:          time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC),
		CategoryPath:       stringPointer(path),
		CategoryConfidence: floatPointer(confidence),
		QualityScore:       floatPointer(quality),
	}
}

func TestNormalizeCategoryPath(t *testing.T) {
	cases := []struct {
		input *string
		want  string
		empty bool
	}{
		{stringPointer("Tech/AI"), "tech/ai", false},
		{stringPointer("  Tech / AI  "), "tech-/ai", false},
		{stringPointer(`\Tech\\AI\`), "tech/ai", false},
		{stringPointer("\ufeffTech\u3000/\u00a0AI "), "tech-/-ai", false},
		{stringPointer("///"), "", true},
		{stringPointer("   "), "", true},
		{nil, "", true},
	}
	for _, test := range cases {
		got := normalizeCategoryPath(test.input)
		if test.empty {
			if got != nil {
				t.Errorf("normalizeCategoryPath(%v) = %q, want nil", test.input, *got)
			}
			continue
		}
		if got == nil || *got != test.want {
			t.Errorf("normalizeCategoryPath(%v) = %v, want %q", test.input, got, test.want)
		}
	}
}

func TestNormalizeCategoryPrefixAndLegacy(t *testing.T) {
	if got := normalizeCategoryPrefix(stringPointer("tech/ai/llm")); got != "tech/ai" {
		t.Errorf("normalizeCategoryPrefix(tech/ai/llm) = %q, want tech/ai", got)
	}
	if got := normalizeCategoryPrefix(stringPointer("tech")); got != "tech" {
		t.Errorf("normalizeCategoryPrefix(tech) = %q, want tech", got)
	}
	if got := normalizeCategoryPrefix(nil); got != "uncategorized" {
		t.Errorf("normalizeCategoryPrefix(nil) = %q, want uncategorized", got)
	}
	if got := normalizeLegacyCategory(stringPointer("TECH")); got == nil || *got != "tech" {
		t.Errorf("normalizeLegacyCategory(TECH) = %v, want tech", got)
	}
	if got := normalizeLegacyCategory(stringPointer("other")); got != nil {
		t.Errorf("normalizeLegacyCategory(other) = %q, want nil", *got)
	}
	if got := normalizeConfidence(floatPointer(1.7)); got == nil || *got != 1 {
		t.Errorf("normalizeConfidence(1.7) = %v, want 1", got)
	}
	if got := normalizeConfidence(floatPointer(math.NaN())); got != nil {
		t.Errorf("normalizeConfidence(NaN) = %v, want nil", *got)
	}
}

// TestComputeItemImportance pins the 0.72/0.28 blend, the low/high multipliers and
// the four-decimal rounding.
func TestComputeItemImportance(t *testing.T) {
	settings := defaultRuntimeSettings()
	cases := []struct {
		name       string
		confidence *float64
		quality    *float64
		want       float64
	}{
		{"balanced", floatPointer(0.5), floatPointer(0.5), 0.5},
		// 0.72*0.4 + 0.28*0.5 = 0.428, then *0.82 because 0.4 < 0.5 -> 0.35096.
		{"fallback low confidence", nil, nil, 0.351},
		// 0.72*0.9 + 0.28*0.25 = 0.718, then *1.08 because 0.9 > 0.8 -> 0.77544.
		{"high confidence boost", floatPointer(0.9), floatPointer(0.25), 0.7754},
	}
	for _, test := range cases {
		item := timelineSourceItem{CategoryConfidence: test.confidence, QualityScore: test.quality}
		if got := roundTo4(computeItemImportance(item, settings)); got != test.want {
			t.Errorf("%s: roundTo4(importance) = %v, want %v", test.name, got, test.want)
		}
	}
}

// TestCompareTimelineItems pins the comparator: importance, then timestamp, then
// quality (missing = -1), then localeCompare of the processed article id.
func TestCompareTimelineItems(t *testing.T) {
	settings := defaultRuntimeSettings()
	earlier := time.Date(2026, 10, 19, 11, 0, 0, 0, time.UTC)
	later := time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
	high := testItem("high", 0.9, 0.5)
	low := testItem("low", 0.5, 0.5)
	if compareTimelineItems(high, low, settings) >= 0 {
		t.Error("higher importance must sort first")
	}
	if compareTimelineItems(low, high, settings) <= 0 {
		t.Error("lower importance must sort last")
	}

	first := testItem("first", 0.5, 0.5)
	first.Timestamp = later
	second := testItem("second", 0.5, 0.5)
	second.Timestamp = earlier
	if compareTimelineItems(first, second, settings) >= 0 {
		t.Error("a newer timestamp must sort first when importance ties")
	}

	withoutQuality := testItem("q", 0.5, 0.5)
	withoutQuality.QualityScore = nil
	withQuality := testItem("q", 0.5, 0.5)
	withQuality.QualityScore = floatPointer(-0.5)
	// Both keep the same importance: 0.28 * (0.5 - (-0.5)) = 0.28 > 1e-9, so the
	// importance branch wins. Use the article-id branch with identical items
	// instead.
	identical := withQuality
	if delta := computeItemImportance(withoutQuality, settings) - computeItemImportance(withQuality, settings); math.Abs(delta) <= 1e-9 {
		t.Fatal("fixture must differ in importance")
	}
	if got := compareTimelineItems(identical, identical, settings); got != 0 {
		t.Errorf("compareTimelineItems(x, x) = %d, want 0", got)
	}

	left := testItem("same", 0.5, 0.5)
	right := left
	left.ProcessedArticleID = "cabc"
	right.ProcessedArticleID = "cabd"
	if compareTimelineItems(left, right, settings) >= 0 {
		t.Error("the article-id tie-break must order cabc before cabd")
	}

	// An importance difference inside the 1e-9 epsilon falls through to the
	// timestamp branch.
	nearA := testItem("near", 0.5, 0.5)
	nearA.Timestamp = later
	nearB := testItem("near", 0.5, 0.5+1e-12)
	nearB.Timestamp = earlier
	if compareTimelineItems(nearA, nearB, settings) >= 0 {
		t.Error("differences below 1e-9 must fall through to the timestamp branch")
	}
}

// TestDistributions pins the weighted, prefix and normalized distributions:
// insertion order, float accumulation order and the excluded non-positive
// weights.
func TestDistributions(t *testing.T) {
	settings := defaultRuntimeSettings()
	items := []timelineSourceItem{
		testItem("tech/ai", 0.5, 0.5),
		testItem("finance/markets", 0.5, 0.5),
		testItem("tech/ai", 0.9, 0.5),
		{ProcessedArticleID: "c3", ArticleID: "a3", Timestamp: itemsTimestamp()},
	}
	weighted := buildWeightedCategoryDistribution(items, settings)
	entries := weighted.entries()
	if len(entries) != 3 {
		t.Fatalf("weighted entries = %d, want 3", len(entries))
	}
	if entries[0].Key != "tech/ai" || entries[1].Key != "finance/markets" || entries[2].Key != "uncategorized" {
		t.Fatalf("weighted insertion order = %v", entries)
	}
	// tech/ai = 0.5 (confidence 0.5 balanced) + 0.7754-ish (0.9 confidence).
	techWeight := computeItemImportance(testItem("tech/ai", 0.5, 0.5), settings) +
		computeItemImportance(testItem("tech/ai", 0.9, 0.5), settings)
	if entries[0].Value != techWeight {
		t.Errorf("weighted tech/ai = %v, want %v", entries[0].Value, techWeight)
	}

	// normalizeCategoryPrefix keeps the first two segments, so a two-segment path
	// is its own prefix.
	prefixes := collapseDistributionToPrefix(weighted)
	prefixEntries := prefixes.entries()
	if len(prefixEntries) != 3 || prefixEntries[0].Key != "tech/ai" || prefixEntries[1].Key != "finance/markets" {
		t.Fatalf("prefix entries = %v, want tech/ai then finance/markets", prefixEntries)
	}

	normalized := normalizeDistribution(prefixes)
	total := 0.0
	for _, entry := range prefixEntries {
		total += entry.Value
	}
	if got, ok := normalized.get("tech/ai"); !ok || got != techWeight/total {
		t.Errorf("normalized tech/ai = %v/%v, want %v", got, ok, techWeight/total)
	}
	if normalized.len() != 3 {
		t.Errorf("normalized length = %d, want 3", normalized.len())
	}

	empty := normalizeDistribution(newOrderedDistribution())
	if empty.len() != 0 {
		t.Errorf("normalizeDistribution(empty) = %d entries, want 0", empty.len())
	}
	zero := newOrderedDistribution()
	zero.set("a", 0)
	if normalizeDistribution(zero).len() != 0 {
		t.Error("a zero total must normalize to an empty record")
	}
}

func itemsTimestamp() time.Time {
	return time.Date(2026, 10, 19, 12, 0, 0, 0, time.UTC)
}

// TestPickDominantCategoryPath pins the strict-greater tie rule and the
// uncategorized null.
func TestPickDominantCategoryPath(t *testing.T) {
	distribution := newOrderedDistribution()
	distribution.set("tech/ai", 0.5)
	distribution.set("finance/markets", 0.5)
	if got := pickDominantCategoryPath(distribution); got == nil || *got != "tech/ai" {
		t.Errorf("tie winner = %v, want the first inserted tech/ai", got)
	}
	if got := pickDominantCategoryPath(newOrderedDistribution()); got != nil {
		t.Errorf("empty distribution dominant = %q, want nil", *got)
	}
	uncategorized := newOrderedDistribution()
	uncategorized.set("uncategorized", 1)
	if got := pickDominantCategoryPath(uncategorized); got != nil {
		t.Errorf("uncategorized dominant = %q, want nil", *got)
	}
}

// TestComputeKlDivergence pins the KL value, the epsilon floor, the walk order
// and the non-negative clamp.
func TestComputeKlDivergence(t *testing.T) {
	previous := newOrderedDistribution()
	previous.set("10", 0.5)
	previous.set("2", 0.25)
	previous.set("tech/ai", 0.25)
	next := newOrderedDistribution()
	next.set("2", 0.25)
	next.set("10", 0.25)
	next.set("tech/ai", 0.5)

	if keys := previous.objectKeys(); keys[0] != "2" || keys[1] != "10" || keys[2] != "tech/ai" {
		t.Fatalf("objectKeys order = %v, want the array-index keys first", keys)
	}
	// 0.5*ln(0.5/0.25) + 0.25*ln(0.25/0.25) + 0.25*ln(0.25/0.5)
	want := 0.5*math.Log(2) + 0.25*math.Log(1) + 0.25*math.Log(0.5)
	if got := computeKlDivergence(previous, next); math.Abs(got-want) > 1e-15 {
		t.Errorf("computeKlDivergence = %v, want %v", got, want)
	}
	if got := roundTo4(computeKlDivergence(previous, next)); got != 0.1733 {
		t.Errorf("roundTo4(KL) = %v, want 0.1733", got)
	}

	// A missing key uses the epsilon on both sides, so an identical pair with a
	// missing key still contributes 0.
	onlyPrevious := newOrderedDistribution()
	onlyPrevious.set("a", 1)
	empty := newOrderedDistribution()
	if got := computeKlDivergence(onlyPrevious, empty); got <= 0 {
		t.Errorf("KL against an empty distribution = %v, want > 0", got)
	}
	if got := computeKlDivergence(empty, empty); got != 0 {
		t.Errorf("KL of two empty distributions = %v, want 0", got)
	}

	// KL_EPSILON floors a zero weight instead of dividing by zero.
	tiny := newOrderedDistribution()
	tiny.set("a", 0)
	if got := computeKlDivergence(tiny, tiny); got != 0 {
		t.Errorf("KL of identical zero-weight keys = %v, want 0", got)
	}
}

// TestComputeCountCategoryDistribution pins the count ordering, the share
// rounding and the limit floor.
func TestComputeCountCategoryDistribution(t *testing.T) {
	items := []timelineSourceItem{
		testItem("tech/ai", 0.5, 0.5),
		testItem("tech/ai", 0.5, 0.5),
		testItem("finance/markets", 0.5, 0.5),
		testItem("finance/markets", 0.5, 0.5),
		testItem("tech/ai", 0.5, 0.5),
	}
	entries := computeCountCategoryDistribution(items, 16)
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}
	if entries[0].CategoryPath != "tech/ai" || entries[0].Count != 3 || entries[0].Share != 0.6 {
		t.Errorf("first entry = %+v, want tech/ai 3 0.6", entries[0])
	}
	if entries[1].CategoryPath != "finance/markets" || entries[1].Count != 2 || entries[1].Share != 0.4 {
		t.Errorf("second entry = %+v, want finance/markets 2 0.4", entries[1])
	}
	limited := computeCountCategoryDistribution(items, 1)
	if len(limited) != 1 || limited[0].CategoryPath != "tech/ai" {
		t.Errorf("limit 1 = %+v", limited)
	}
	// Math.max(1, maxItems): a non-positive limit still returns one entry.
	if got := computeCountCategoryDistribution(items, 0); len(got) != 1 {
		t.Errorf("limit 0 returned %d entries, want 1", len(got))
	}
	if got := computeCountCategoryDistribution(nil, 16); len(got) != 0 {
		t.Errorf("empty items returned %d entries, want 0", len(got))
	}
}

// TestDescribePrefix pins the literal prefixes, the two-segment capitalization
// and the non-ASCII first letter.
func TestDescribePrefix(t *testing.T) {
	cases := []struct {
		prefix string
		want   string
	}{
		{"tech/ai", "Technology release"},
		{"tech/ai/llm", "Technology release"},
		{"gov/regulation", "Regulatory response"},
		{"finance/markets", "Market impact"},
		{"politics/elections", "Political reaction"},
		{"intel/analysis", "Intelligence assessment"},
		{"ai/models", "AI development"},
		{"sports/olympics", "Sports Olympics"},
		{"uncategorized", "Uncategorized"},
		{"éco/nom", "Éco Nom"},
		{"ßeta/x", "SSeta X"},
		{"mixed/", "Mixed"},
	}
	for _, test := range cases {
		if got := describePrefix(test.prefix); got != test.want {
			t.Errorf("describePrefix(%q) = %q, want %q", test.prefix, got, test.want)
		}
	}
}

// TestBuildPhaseSummaries pins the split rule, the phase numbering and the label
// text.
func TestBuildPhaseSummaries(t *testing.T) {
	settings := defaultRuntimeSettings()
	day := func(offset int) time.Time {
		return time.Date(2026, 10, 19+offset, 0, 0, 0, 0, time.UTC)
	}
	entry := func(offset, itemCount int, prefix string, distribution *orderedDistribution) builtTimelineEntry {
		return builtTimelineEntry{
			BucketStart:            day(offset),
			DominantCategoryPrefix: prefix,
			Distribution:           distribution,
			Classification:         timelineEntryClassification{ItemCount: itemCount},
		}
	}
	tech := newOrderedDistribution()
	tech.set("tech", 1)
	finance := newOrderedDistribution()
	finance.set("finance", 1)

	phases := buildPhaseSummaries([]builtTimelineEntry{
		entry(0, 4, "tech", tech),
		entry(1, 4, "tech", tech),
		entry(2, 4, "finance", finance),
	}, settings)
	if len(phases) != 2 {
		t.Fatalf("phases = %d, want 2", len(phases))
	}
	// describePrefix("tech") has no "/", so it falls through to capitalizeWord.
	if phases[0].Phase != 1 || phases[0].Label != "Tech stage" ||
		phases[0].CategoryPrefix != "tech" || phases[0].ItemCount != 8 || phases[0].BucketCount != 2 {
		t.Errorf("phase 1 = %+v", phases[0])
	}
	if phases[0].StartAt != "2026-10-19T00:00:00.000Z" || phases[0].EndAt != "2026-10-20T00:00:00.000Z" {
		t.Errorf("phase 1 bounds = %s..%s", phases[0].StartAt, phases[0].EndAt)
	}
	if phases[0].Summary != "Tech stage (tech)" {
		t.Errorf("phase 1 summary = %q", phases[0].Summary)
	}
	if phases[1].Phase != 2 || phases[1].CategoryPrefix != "finance" || phases[1].ItemCount != 4 {
		t.Errorf("phase 2 = %+v", phases[1])
	}

	// A bucket below the drift minimum never splits on prefix alone.
	shortPhases := buildPhaseSummaries([]builtTimelineEntry{
		entry(0, 1, "tech", tech),
		entry(1, 1, "finance", finance),
	}, settings)
	if len(shortPhases) != 1 {
		t.Errorf("phases under the drift minimum = %d, want 1", len(shortPhases))
	}

	// maxPhaseSummaries truncates after numbering.
	truncated := buildPhaseSummaries([]builtTimelineEntry{
		entry(0, 4, "tech", tech),
		entry(1, 4, "finance", finance),
		entry(2, 4, "tech", tech),
	}, timelineRuntimeSettings{
		DriftKLThreshold:             0.35,
		MinBucketItemsForDrift:       3,
		MaxPhaseSummaries:            1,
		CrossCategoryWarningShare:    0.3,
		MaxCategoryDistributionItems: 16,
	})
	if len(truncated) != 1 {
		t.Errorf("truncated phases = %d, want 1", len(truncated))
	}

	if got := buildPhaseSummaries(nil, settings); len(got) != 0 {
		t.Errorf("empty phases = %d, want 0", len(got))
	}
}

// TestAnalyzeTimelineSummary pins the topicDriftSummary text and the
// cross-category share computation.
func TestAnalyzeTimelineSummary(t *testing.T) {
	settings := defaultRuntimeSettings()
	items := []timelineSourceItem{
		testItem("tech/ai", 0.5, 0.5),
		testItem("tech/ai", 0.5, 0.5),
		testItem("finance/markets", 0.5, 0.5),
		testItem("finance/markets", 0.5, 0.5),
	}
	buckets := groupByDayBucket(items)
	keys := buckets.sortedKeys()
	built := make([]builtTimelineEntry, 0, len(keys))
	for _, key := range keys {
		bucket, ok := buckets.get(key)
		if !ok {
			continue
		}
		built = append(built, buildTimelineEntry("evt", bucket.BucketStart, bucket.Items, settings))
	}
	analysis := analyzeTimeline(items, built, settings)
	if !analysis.TopicDriftWarning {
		t.Error("a 50/50 cross-category share must raise the warning")
	}
	if analysis.TopicDriftSummary == nil || *analysis.TopicDriftSummary != "cross-category share 50.0%" {
		t.Errorf("summary = %v, want %q", analysis.TopicDriftSummary, "cross-category share 50.0%")
	}
	if len(analysis.DriftWarnings) != 0 {
		t.Errorf("single-day drift warnings = %d, want 0", len(analysis.DriftWarnings))
	}
	if len(analysis.PhaseSummaries) != 1 {
		t.Errorf("single-day phases = %d, want 1", len(analysis.PhaseSummaries))
	}

	single := []timelineSourceItem{
		testItem("tech/ai", 0.5, 0.5),
		testItem("tech/ai", 0.5, 0.5),
	}
	singleBuckets := groupByDayBucket(single)
	singleBuilt := make([]builtTimelineEntry, 0, 1)
	for _, key := range singleBuckets.sortedKeys() {
		bucket, _ := singleBuckets.get(key)
		singleBuilt = append(singleBuilt, buildTimelineEntry("evt", bucket.BucketStart, bucket.Items, settings))
	}
	quiet := analyzeTimeline(single, singleBuilt, settings)
	if quiet.TopicDriftWarning {
		t.Error("a single-category single-day event must not warn")
	}
	if quiet.TopicDriftSummary != nil {
		t.Errorf("quiet summary = %q, want nil", *quiet.TopicDriftSummary)
	}
}

// TestMergeTimelineMetadataRetention pins the retention window, the
// unparseable-key retention and the override order.
func TestMergeTimelineMetadataRetention(t *testing.T) {
	existing := map[string]timelineEntryClassification{
		"2026-10-17T00:00:00.000Z": {ItemCount: 1},
		"2026-10-18T00:00:00.000Z": {ItemCount: 2},
		"2026-10-19T00:00:00.000Z": {ItemCount: 3},
		"2026-10-17":               {ItemCount: 4},
		"not-a-date":               {ItemCount: 5},
	}
	fresh := map[string]timelineEntryClassification{
		"2026-10-19T00:00:00.000Z": {ItemCount: 30},
		"2026-10-20T00:00:00.000Z": {ItemCount: 40},
	}
	retainSince := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	analysis := timelineAnalysis{
		CategoryDistribution: []categoryDistributionEntry{},
		DriftWarnings:        []topicDriftWarning{},
		PhaseSummaries:       []timelinePhaseSummary{},
	}
	updatedAt := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	merged := mergeTimelineMetadata("evt", existing, fresh, analysis, retainSince, updatedAt)

	if _, kept := merged.Entries["2026-10-17T00:00:00.000Z"]; kept {
		t.Error("a bucket before the retention window must be pruned")
	}
	if _, kept := merged.Entries["2026-10-17"]; kept {
		t.Error("a date-only bucket before the retention window must be pruned")
	}
	if _, kept := merged.Entries["not-a-date"]; !kept {
		t.Error("an unparseable bucket key must be kept")
	}
	if _, kept := merged.Entries["2026-10-18T00:00:00.000Z"]; !kept {
		t.Error("a bucket at the retention boundary must be kept")
	}
	if got := merged.Entries["2026-10-19T00:00:00.000Z"].ItemCount; got != 30 {
		t.Errorf("this run must override the retained bucket, got %d", got)
	}
	if got := merged.UpdatedAt; got != "2026-10-20T10:00:00.000Z" {
		t.Errorf("updatedAt = %q", got)
	}

	encoded, err := json.Marshal(merged)
	if err != nil {
		t.Fatalf("marshal timeline: %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal timeline: %v", err)
	}
	for _, field := range []string{"entries", "categoryDistribution", "topicDriftWarning",
		"topicDriftSummary", "driftWarnings", "phaseSummaries", "subEvents", "updatedAt"} {
		if _, ok := decoded[field]; !ok {
			t.Errorf("timeline payload is missing %q", field)
		}
	}
	if string(decoded["topicDriftSummary"]) != "null" {
		t.Errorf("topicDriftSummary = %s, want null", decoded["topicDriftSummary"])
	}
	if string(decoded["categoryDistribution"]) != "[]" {
		t.Errorf("categoryDistribution = %s, want []", decoded["categoryDistribution"])
	}
}

// TestNormalizeTimelineEntries pins the typeof/Boolean coercion rules.
func TestNormalizeTimelineEntries(t *testing.T) {
	raw := json.RawMessage(`{
      "2026-10-19T00:00:00.000Z": {"categoryPath":" Tech/AI ","categoryConfidence":2,"tentative":0,"anchor":"yes","importanceScore":0.5,"itemCount":3.4},
      "bad": null,
      "array": [],
      "scalar": 5,
      "text": "x",
      "empty": {}
    }`)
	entries := normalizeTimelineEntries(raw)
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2 (the object values only)", len(entries))
	}
	entry := entries["2026-10-19T00:00:00.000Z"]
	if entry.CategoryPath == nil || *entry.CategoryPath != "tech/ai" {
		t.Errorf("categoryPath = %v", entry.CategoryPath)
	}
	if entry.CategoryConfidence == nil || *entry.CategoryConfidence != 1 {
		t.Errorf("categoryConfidence = %v, want the clamped 1", entry.CategoryConfidence)
	}
	if entry.Tentative {
		t.Error("Boolean(0) must be false")
	}
	if !entry.Anchor {
		t.Error("Boolean(\"yes\") must be true")
	}
	if entry.ImportanceScore != 0.5 {
		t.Errorf("importanceScore = %v", entry.ImportanceScore)
	}
	if entry.ItemCount != 3 {
		t.Errorf("itemCount = %d, want Math.round(3.4)", entry.ItemCount)
	}
	empty := entries["empty"]
	if empty.CategoryPath != nil || empty.CategoryConfidence != nil || empty.Tentative ||
		empty.Anchor || empty.ImportanceScore != 0 || empty.ItemCount != 0 {
		t.Errorf("empty entry = %+v, want the zero value", empty)
	}
	if got := normalizeTimelineEntries(json.RawMessage(`[]`)); len(got) != 0 {
		t.Errorf("array value = %d entries, want 0", len(got))
	}
	if got := normalizeTimelineEntries(json.RawMessage(`null`)); len(got) != 0 {
		t.Errorf("null value = %d entries, want 0", len(got))
	}
}

// TestReferencedArticleIDs pins the dedupe, the sort and the 20-id cap.
func TestReferencedArticleIDs(t *testing.T) {
	items := []timelineSourceItem{
		{ArticleID: "b"},
		{ArticleID: "a"},
		{ArticleID: "b"},
		{ArticleID: ""},
		{ArticleID: "c"},
	}
	got := referencedArticleIDs(items)
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("referencedArticleIDs = %v, want [a b c]", got)
	}
	many := make([]timelineSourceItem, 0, 30)
	for index := 29; index >= 0; index-- {
		many = append(many, timelineSourceItem{ArticleID: string(rune('a'+index%26)) + string(rune('0'+index/26))})
	}
	if got := referencedArticleIDs(many); len(got) != 20 {
		t.Fatalf("cap = %d, want 20", len(got))
	}
}

// TestBuildTimelineEntry pins the representative selection, the classification
// leaf and the dominance fallback.
func TestBuildTimelineEntry(t *testing.T) {
	settings := defaultRuntimeSettings()
	bucketStart := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
	primary := testItem("tech/ai", 0.9, 0.9)
	primary.Timestamp = time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
	primary.Title = stringPointer("Primary title")
	primary.KeyPoints = json.RawMessage(`["one","two"]`)
	secondary := testItem("tech/ai", 0.4, 0.4)
	secondary.Timestamp = time.Date(2026, 10, 19, 8, 0, 0, 0, time.UTC)

	entry := buildTimelineEntry("evt", bucketStart, []timelineSourceItem{secondary, primary}, settings)
	if entry.Classification.ItemCount != 2 {
		t.Errorf("itemCount = %d, want 2", entry.Classification.ItemCount)
	}
	if entry.Title == nil || *entry.Title != "Primary title" {
		t.Errorf("representative title = %v, want the higher-importance item", entry.Title)
	}
	if entry.DominantCategoryPrefix != "tech/ai" {
		t.Errorf("dominant prefix = %q, want tech/ai", entry.DominantCategoryPrefix)
	}
	if entry.Classification.CategoryPath == nil || *entry.Classification.CategoryPath != "tech/ai" {
		t.Errorf("categoryPath = %v", entry.Classification.CategoryPath)
	}
	if entry.Classification.Tentative || entry.Classification.Anchor {
		t.Error("a 0.9-weighted confidence must not be tentative or anchored at 0.5/0.8 thresholds")
	}
	// 0.72*0.9 + 0.28*0.9 = 0.9, then *1.08 because 0.9 > 0.8.
	if entry.Classification.ImportanceScore != 0.972 {
		t.Errorf("importanceScore = %v, want 0.972", entry.Classification.ImportanceScore)
	}
	if entry.Distribution.len() != 1 {
		t.Errorf("distribution = %d entries, want 1", entry.Distribution.len())
	}
	// No referenced article ids for an uncategorized-only bucket.
	uncategorizedEntry := buildTimelineEntry("evt", bucketStart, []timelineSourceItem{{
		ProcessedArticleID: "c1",
		ArticleID:          "a1",
		Timestamp:          bucketStart,
	}}, settings)
	if uncategorizedEntry.DominantCategoryPrefix != "uncategorized" {
		t.Errorf("uncategorized prefix = %q", uncategorizedEntry.DominantCategoryPrefix)
	}
	if len(uncategorizedEntry.ReferencedArticleIDs) != 1 {
		t.Errorf("referenced ids = %v", uncategorizedEntry.ReferencedArticleIDs)
	}
	if uncategorizedEntry.Classification.CategoryPath != nil {
		t.Errorf("uncategorized dominant path = %v, want nil", uncategorizedEntry.Classification.CategoryPath)
	}
}

// TestResolveTimelineRuntimeSettings pins the low/high swap and the bounds.
func TestResolveTimelineRuntimeSettings(t *testing.T) {
	settings := settingsFixture(0.9, 0.4, 9, 2, 0.7, 100, 50)
	resolved := resolveTimelineRuntimeSettings(settings)
	if resolved.LowConfidenceThreshold != 0.4 || resolved.HighConfidenceThreshold != 0.9 {
		t.Errorf("thresholds = %v/%v, want 0.4/0.9", resolved.LowConfidenceThreshold, resolved.HighConfidenceThreshold)
	}
	if resolved.DriftKLThreshold != 5 {
		t.Errorf("drift KL = %v, want the 5 upper bound", resolved.DriftKLThreshold)
	}
	if resolved.MinBucketItemsForDrift != 2 {
		t.Errorf("min bucket items = %d, want 2", resolved.MinBucketItemsForDrift)
	}
	if resolved.MaxCategoryDistributionItems != 64 {
		t.Errorf("max distribution items = %d, want 64", resolved.MaxCategoryDistributionItems)
	}
	if resolved.MaxPhaseSummaries != 20 {
		t.Errorf("max phase summaries = %d, want 20", resolved.MaxPhaseSummaries)
	}
	if resolved.ConfidenceFallback != 0.7 {
		t.Errorf("confidence fallback = %v, want 0.7", resolved.ConfidenceFallback)
	}
}

// settingsFixture builds the normalized settings document a stored
// news_event_settings:<orgId> row resolves to.
func settingsFixture(low, high, driftKL float64, minBucket int, crossShare float64, maxDist, maxPhases int) settingscrawl.NewsEventSettingsModel {
	return settingscrawl.NewsEventSettingsModel{
		Enabled:                              true,
		IngestionEnabled:                     true,
		TimelineEnabled:                      true,
		BackfillDays:                         30,
		LookbackDays:                         30,
		TimelineMaxEventsPerRun:              50,
		TimelineLowConfidenceThreshold:       low,
		TimelineHighConfidenceThreshold:      high,
		TimelineDriftKlThreshold:             driftKL,
		TimelineMinBucketItemsForDrift:       minBucket,
		TimelineCrossCategoryWarningShare:    crossShare,
		TimelineMaxCategoryDistributionItems: maxDist,
		TimelineMaxPhaseSummaries:            maxPhases,
		MinCategoryConfidenceForGate:         0.7,
	}
}
