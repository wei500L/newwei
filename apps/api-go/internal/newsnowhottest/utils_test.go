package newsnowhottest

import (
	"math"
	"testing"
	"time"
)

func TestNormalizeTitleMirrorsJavaScript(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"  OpenAI 发布\u3000新模型！！ ", "openai 发布 新模型"},
		{"Hello---World", "hello world"},
		{"A_B/C", "a b c"},
		{"\uFEFF标题\uFEFF", "标题"},
		{"already clean", "already clean"},
	}
	for _, tc := range cases {
		if got := normalizeTitle(tc.input); got != tc.want {
			t.Fatalf("normalizeTitle(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestParseHeatValue(t *testing.T) {
	text := func(value string) *string { return &value }
	cases := []struct {
		input *string
		want  *float64
	}{
		{nil, nil},
		{text(""), nil},
		{text("abc"), nil},
		{text("3,456"), ptrFloat(3456)},
		{text("1.2万"), ptrFloat(12000)},
		{text("1.5亿"), ptrFloat(150000000)},
		{text("5k"), ptrFloat(5000)},
		{text("2b"), ptrFloat(2000000000)},
		{text("1m 2k"), ptrFloat(1000000)},
		{text("第 12 名"), ptrFloat(12)},
	}
	for _, tc := range cases {
		got := parseHeatValue(tc.input)
		if tc.want == nil {
			if got != nil {
				t.Fatalf("parseHeatValue(%v) = %v, want nil", tc.input, *got)
			}
			continue
		}
		if got == nil || math.Abs(*got-*tc.want) > 1e-9 {
			t.Fatalf("parseHeatValue(%v) = %v, want %v", tc.input, got, *tc.want)
		}
	}
}

func ptrFloat(value float64) *float64 { return &value }

func TestComputeFreshness(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	nowMillis := now.UnixMilli()

	score, isNew, isRising := computeFreshness(nowMillis, nil, 1)
	if score != 1 || !isNew || isRising {
		t.Fatalf("nil state = (%v,%v,%v), want (1,true,false)", score, isNew, isRising)
	}

	state := &SignalState{
		FirstSeenAt: isoTime(now.Add(-2 * time.Hour)),
		LastSeenAt:  isoTime(now.Add(-time.Minute)),
		LastRank:    intOrNull(5),
	}
	score, isNew, isRising = computeFreshness(nowMillis, state, 2)
	// newness 0.82 at exactly two hours, rank gain 3 -> rise 0.25.
	want := roundN(0.82*0.7+0.25*0.3, 4)
	if score != want || isNew || !isRising {
		t.Fatalf("state = (%v,%v,%v), want (%v,false,true)", score, isNew, isRising, want)
	}
}

func TestComputeHeatAndCandidateScores(t *testing.T) {
	heatValue := 1000.0
	heat := computeHeatScore(1, 8, &heatValue, 1000, 1, 1)
	if heat != 0.73 {
		t.Fatalf("heat = %v, want 0.73", heat)
	}
	failure := 0.5
	candidate := computeCandidateScore(heat, 1, 1, 1, &failure)
	want := roundN(0.73*0.34+1*0.24+0+1*0.1+0.5*0.08, 4)
	if candidate != want {
		t.Fatalf("candidate = %v, want %v", candidate, want)
	}
	if got := computeCandidateScore(0, 0, 1, 0, nil); got != roundN(0.5*0.08, 4) {
		t.Fatalf("default confidence = %v", got)
	}
	if got := computeHeatScore(9, 8, nil, 100, 1, 0); got != 0 {
		t.Fatalf("clamped heat = %v, want 0", got)
	}
}

func TestBuildHeuristicClusters(t *testing.T) {
	signals := []SignalSeed{
		{
			SignalKey: "k1", SourceID: "s1", Title: "OpenAI releases a new model today",
			HeatValue: numberOrNull(100), Rank: 1,
		},
		{
			SignalKey: "k2", SourceID: "s2", Title: "OpenAI releases a new model today!",
			HeatValue: numberOrNull(50), Rank: 2,
		},
		{
			SignalKey: "k3", SourceID: "s1", Title: "完全不同的话题内容",
			HeatValue: numberOrNull(10), Rank: 3,
		},
	}
	clusters := buildHeuristicClusters(signals)
	if len(clusters) != 2 {
		t.Fatalf("clusters = %d, want 2", len(clusters))
	}
	first := clusters[0]
	if len(first.SourceIDs) != 2 || first.SourceIDs[0] != "s1" || first.SourceIDs[1] != "s2" {
		t.Fatalf("sourceIds = %v", first.SourceIDs)
	}
	if first.RepresentativeTitle != signals[0].Title {
		t.Fatalf("representative = %q", first.RepresentativeTitle)
	}
	if first.TotalHeatValue != 150 || first.MaxHeatValue != 100 || first.AvgRank != 1.5 {
		t.Fatalf("cluster metrics = %+v", first)
	}
	if len(first.ItemKeys) != 2 || first.ItemKeys[0] != "k1" || first.ItemKeys[1] != "k2" {
		t.Fatalf("itemKeys = %v", first.ItemKeys)
	}
	if first.ClusterID == "" {
		t.Fatal("cluster id is empty")
	}
}

func TestBuildGlobalInputSignatureOrderIndependent(t *testing.T) {
	heat := "1.2万"
	left := []SignatureEntry{
		{SourceID: "b-source", Failed: false, Items: []SignatureItem{
			{ID: "2", Title: "Second", URL: "https://b.example/2", HeatText: &heat, Rank: 2},
			{ID: "1", Title: "First!", URL: "https://b.example/1", Rank: 1},
		}},
		{SourceID: "a-source", Failed: true},
	}
	right := []SignatureEntry{
		{SourceID: "a-source", Failed: true},
		{SourceID: "B-SOURCE", Failed: false, Items: []SignatureItem{
			{ID: "1", Title: "first", URL: "HTTPS://b.example/1", Rank: 1},
			{ID: "2", Title: "second", URL: "https://b.example/2", HeatText: &heat, Rank: 2},
		}},
	}
	if buildGlobalInputSignature(left) != buildGlobalInputSignature(right) {
		t.Fatal("signature must not depend on entry/item order, case or punctuation")
	}
	changed := append([]SignatureEntry{}, right...)
	changed[1].Items = append([]SignatureItem{}, right[1].Items...)
	changed[1].Items[0].Rank = 5
	if buildGlobalInputSignature(left) == buildGlobalInputSignature(changed) {
		t.Fatal("rank change must change the signature")
	}
}

func TestLocaleCompareIsRootCollation(t *testing.T) {
	if localeCompare("alpha", "alpha") != 0 {
		t.Fatal("equal strings must compare equal")
	}
	// Root collation compares letters case-insensitively at the primary level,
	// while byte order puts every uppercase letter before every lowercase one.
	// This is exactly why the id tie-break cannot use bytes.
	if localeCompare("a", "B") >= 0 {
		t.Fatal("collation must order a before B")
	}
	if !("a" > "B") {
		t.Fatal("byte order is expected to disagree with collation for this fixture")
	}
	if localeCompare("a", "b") >= 0 || localeCompare("b", "a") <= 0 {
		t.Fatal("basic order is broken")
	}
}

func TestCacheKeysMatchNest(t *testing.T) {
	cases := map[string]string{
		buildStateKey("org1", "sig1"):      "newsnow:hottest:state:v1:org1:sig1",
		buildAnalysisCacheKey("org1"):      "newsnow:hottest:analysis:v1:org1:fresh",
		buildAnalysisStaleCacheKey("org1"): "newsnow:hottest:analysis:v1:org1:stale",
		buildGlobalSignatureCacheKey():     "newsnow:hottest:global:v1:signature",
		buildGlobalSnapshotCacheKey():      "newsnow:hottest:global:v1:fresh",
		buildGlobalSnapshotStaleCacheKey(): "newsnow:hottest:global:v1:stale",
	}
	for got, want := range cases {
		if got != want {
			t.Fatalf("key = %q, want %q", got, want)
		}
	}
}

func TestBuildSignalKeyAndBridgeExternalID(t *testing.T) {
	key := buildSignalKey("s1", " Hello, World! ", " HTTPS://Example.com/A ")
	if len(key) != 40 {
		t.Fatalf("signal key = %q", key)
	}
	if key != buildSignalKey("s1", "hello world", "https://example.com/A") {
		t.Fatal("signal key must normalize the title and lowercase the URL")
	}
	externalID := buildBridgeExternalId("s1", " HTTPS://Example.com/A ")
	if externalID != "newsnow:s1:"+sha1Hex("https://example.com/a") {
		t.Fatalf("external id = %q", externalID)
	}
}

func TestResolveEmptyReason(t *testing.T) {
	reason := resolveEmptyReason(nil, Diagnostics{SourcesRequested: 0}, 0)
	if reason == nil || *reason != EmptyNoHottestSourcesConfigured {
		t.Fatalf("reason = %v", reason)
	}
	reason = resolveEmptyReason(nil, Diagnostics{SourcesRequested: 1, SourcesSucceeded: 0, SourcesFailed: 1}, 0)
	if reason == nil || *reason != EmptyAllSourcesFailed {
		t.Fatalf("reason = %v", reason)
	}
	reason = resolveEmptyReason(nil, Diagnostics{SourcesRequested: 1, SourcesSucceeded: 1}, 0)
	if reason == nil || *reason != EmptyNoSourceItems {
		t.Fatalf("reason = %v", reason)
	}
	reason = resolveEmptyReason(nil, Diagnostics{SourcesRequested: 1, SourcesSucceeded: 1, SourceItemsFetched: 3}, 0)
	if reason == nil || *reason != EmptyNoHotSignals {
		t.Fatalf("reason = %v", reason)
	}
	reason = resolveEmptyReason(nil, Diagnostics{SourcesRequested: 1, SourcesSucceeded: 1, SourceItemsFetched: 3}, 2)
	if reason == nil || *reason != EmptyNoCandidates {
		t.Fatalf("reason = %v", reason)
	}
	if reason := resolveEmptyReason([]EventCandidate{{CandidateID: "c"}}, Diagnostics{}, 1); reason != nil {
		t.Fatalf("non-empty candidates reason = %v", reason)
	}
}

func TestTruncateJS(t *testing.T) {
	if got := truncateJS("abc", 5); got != "abc" {
		t.Fatalf("truncate short = %q", got)
	}
	if got := truncateJS("abcdef", 3); got != "abc" {
		t.Fatalf("truncate = %q", got)
	}
	// One emoji is two UTF-16 code units; the limit may not split it.
	if got := truncateJS("ab😀", 3); got != "ab" {
		t.Fatalf("truncate surrogate = %q", got)
	}
}
