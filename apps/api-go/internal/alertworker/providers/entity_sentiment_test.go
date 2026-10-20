package providers

import (
	"math"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func TestClampEntityInt(t *testing.T) {
	cases := []struct {
		name  string
		value float64
		min   int
		max   int
		want  int
	}{
		{name: "truncates", value: 5.9, min: 1, max: 10, want: 5},
		{name: "truncates negative", value: -5.9, min: -10, max: 10, want: -5},
		{name: "clamps low", value: -1, min: 5, max: 100, want: 5},
		{name: "clamps high", value: 1e9, min: 1, max: 10_000, want: 10_000},
		{name: "nan returns min", value: math.NaN(), min: 5, max: 10, want: 5},
		{name: "infinity returns min", value: math.Inf(-1), min: 5, max: 10, want: 5},
		{name: "inside range", value: 42.4, min: 5, max: 100, want: 42},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := clampEntityInt(testCase.value, testCase.min, testCase.max); got != testCase.want {
				t.Fatalf("want %d, got %d", testCase.want, got)
			}
		})
	}
}

func TestClampEntityFloat(t *testing.T) {
	cases := []struct {
		name  string
		value float64
		min   float64
		max   float64
		want  float64
	}{
		{name: "inside", value: 0.25, min: 0, max: 1, want: 0.25},
		{name: "clamps high", value: 1.5, min: 0, max: 1, want: 1},
		{name: "clamps low", value: -0.2, min: 0, max: 1, want: 0},
		{name: "nan returns min", value: math.NaN(), min: 0.5, max: 1, want: 0.5},
		{name: "no truncation", value: 0.999, min: 0.5, max: 0.999, want: 0.999},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := clampEntityFloat(testCase.value, testCase.min, testCase.max); got != testCase.want {
				t.Fatalf("want %v, got %v", testCase.want, got)
			}
		})
	}
}

// TestBuildSortAtWindowOr asserts the five fallback branches with
// reflect.DeepEqual against a hand-written bson.A.
func TestBuildSortAtWindowOr(t *testing.T) {
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	end := start.Add(60 * time.Minute)
	window := bson.D{
		{Key: "$gte", Value: start},
		{Key: "$lt", Value: end},
	}
	missing := bson.D{{Key: "$exists", Value: false}}

	want := bson.A{
		bson.D{{Key: "sortAt", Value: bson.D{
			{Key: "$gte", Value: start},
			{Key: "$lt", Value: end},
		}}},
		bson.D{
			{Key: "sortAt", Value: missing},
			{Key: "ingestedAt", Value: window},
		},
		bson.D{
			{Key: "sortAt", Value: nil},
			{Key: "ingestedAt", Value: window},
		},
		bson.D{
			{Key: "sortAt", Value: missing},
			{Key: "ingestedAt", Value: missing},
			{Key: "createdAt", Value: window},
		},
		bson.D{
			{Key: "sortAt", Value: nil},
			{Key: "ingestedAt", Value: missing},
			{Key: "createdAt", Value: window},
		},
	}
	if got := buildSortAtWindowOr(start, end); !reflect.DeepEqual(got, want) {
		t.Fatalf("sortAt $or mismatch:\nwant %#v\ngot  %#v", want, got)
	}
}

// TestBuildSentimentWindowPipelineShape asserts the full aggregation with
// reflect.DeepEqual against a hand-written bson.D pipeline.
func TestBuildSentimentWindowPipelineShape(t *testing.T) {
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	end := start.Add(60 * time.Minute)
	window := func() bson.D {
		return bson.D{
			{Key: "$gte", Value: start},
			{Key: "$lt", Value: end},
		}
	}
	missing := bson.D{{Key: "$exists", Value: false}}

	want := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: "org-1"},
			{Key: "status", Value: "completed"},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "sortAt", Value: window()}},
				bson.D{
					{Key: "sortAt", Value: missing},
					{Key: "ingestedAt", Value: window()},
				},
				bson.D{
					{Key: "sortAt", Value: nil},
					{Key: "ingestedAt", Value: window()},
				},
				bson.D{
					{Key: "sortAt", Value: missing},
					{Key: "ingestedAt", Value: missing},
					{Key: "createdAt", Value: window()},
				},
				bson.D{
					{Key: "sortAt", Value: nil},
					{Key: "ingestedAt", Value: missing},
					{Key: "createdAt", Value: window()},
				},
			}},
			{Key: "result.sentiment_label", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: nil},
			}},
			{Key: "result.entities", Value: bson.D{{Key: "$elemMatch", Value: bson.D{
				{Key: "name", Value: "ACME"},
				{Key: "confidence", Value: bson.D{{Key: "$gte", Value: 0.5}}},
				{Key: "type", Value: "company"},
			}}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "sentiment", Value: bson.D{{Key: "$toLower", Value: "$result.sentiment_label"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "sentiment", Value: 1},
			{Key: "score", Value: bson.D{{Key: "$switch", Value: bson.D{
				{Key: "branches", Value: bson.A{
					bson.D{
						{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "positive"}}}},
						{Key: "then", Value: 1},
					},
					bson.D{
						{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "neutral"}}}},
						{Key: "then", Value: 0},
					},
					bson.D{
						{Key: "case", Value: bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "negative"}}}},
						{Key: "then", Value: -1},
					},
				}},
				{Key: "default", Value: 0},
			}}}},
			{Key: "neg", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "negative"}}}, 1, 0,
			}}}},
			{Key: "pos", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "positive"}}}, 1, 0,
			}}}},
			{Key: "neu", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$eq", Value: bson.A{"$sentiment", "neutral"}}}, 1, 0,
			}}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "total", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "negative", Value: bson.D{{Key: "$sum", Value: "$neg"}}},
			{Key: "positive", Value: bson.D{{Key: "$sum", Value: "$pos"}}},
			{Key: "neutral", Value: bson.D{{Key: "$sum", Value: "$neu"}}},
			{Key: "scoreSum", Value: bson.D{{Key: "$sum", Value: "$score"}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "_id", Value: 0},
			{Key: "total", Value: 1},
			{Key: "negative", Value: 1},
			{Key: "positive", Value: 1},
			{Key: "neutral", Value: 1},
			{Key: "scoreSum", Value: 1},
		}}},
	}

	got := buildSentimentWindowPipeline("org-1", "ACME", "company", 0.5, start, end)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sentiment pipeline mismatch:\nwant %#v\ngot  %#v", want, got)
	}

	// An empty entityType drops the type condition from $elemMatch.
	withoutType := buildSentimentWindowPipeline("org-1", "ACME", "", 0.5, start, end)
	match, ok := withoutType[0][0].Value.(bson.D)
	if !ok {
		t.Fatalf("first stage is not a $match document: %#v", withoutType[0])
	}
	var entities bson.D
	for _, element := range match {
		if element.Key == "result.entities" {
			entities = element.Value.(bson.D)
		}
	}
	elemMatch, ok := entities[0].Value.(bson.D)
	if !ok || len(elemMatch) != 2 {
		t.Fatalf("want an entity condition without type, got %#v", entities)
	}
}

func TestSentimentCounterValue(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  float64
	}{
		{name: "int32", value: int32(4), want: 4},
		{name: "int64", value: int64(6), want: 6},
		{name: "double", value: 2.5, want: 2.5},
		{name: "nil", value: nil, want: 0},
		{name: "string", value: "3", want: 0},
		{name: "nan", value: math.NaN(), want: 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := sentimentCounterValue(testCase.value); got != testCase.want {
				t.Fatalf("want %v, got %v", testCase.want, got)
			}
		})
	}
}

func TestAssociationTargets(t *testing.T) {
	edges := []associationEdge{
		// score 0.4
		{ID: "e1", Type: "supplies", FromEntityID: "seed", ToEntityID: "b", Weight: 0.5, Confidence: 0.8},
		// score 0.81
		{ID: "e2", Type: "competes_with", FromEntityID: "a", ToEntityID: "seed", Weight: 0.9, Confidence: 0.9},
		// score 0.18, below the 0.3 threshold
		{ID: "e3", Type: "upstream_of", FromEntityID: "seed", ToEntityID: "c", Weight: 0.9, Confidence: 0.2},
		// neighbor document missing: skipped
		{ID: "e4", Type: "affects_company", FromEntityID: "seed", ToEntityID: "missing", Weight: 1, Confidence: 1},
	}
	neighbors := map[string]associationEntity{
		"a": {ID: "a", Type: "company", CanonicalName: "A Corp"},
		"b": {ID: "b", Type: "industry", CanonicalName: "B Industry"},
		"c": {ID: "c", Type: "policy", CanonicalName: "C Policy"},
	}

	got := associationTargets("seed", edges, neighbors, 0.3, 10)
	if len(got) != 2 {
		t.Fatalf("want 2 targets, got %#v", got)
	}
	if got[0].EntityID != "a" || math.Abs(got[0].Score-0.81) > 1e-12 || got[0].RelationType != "competes_with" {
		t.Fatalf("first target should be the a edge, got %#v", got[0])
	}
	if got[0].Name != "A Corp" || got[0].Type != "company" {
		t.Fatalf("first target entity fields: %#v", got[0])
	}
	if got[1].EntityID != "b" || math.Abs(got[1].Score-0.4) > 1e-12 {
		t.Fatalf("second target should be the b edge, got %#v", got[1])
	}

	// maxTargets keeps only the strongest scores.
	top := associationTargets("seed", edges, neighbors, 0.3, 1)
	if len(top) != 1 || top[0].EntityID != "a" {
		t.Fatalf("maxTargets=1: got %#v", top)
	}

	// A zero threshold keeps the 0.18 edge too.
	loose := associationTargets("seed", edges, neighbors, 0, 10)
	if len(loose) != 3 {
		t.Fatalf("threshold 0: want 3 targets, got %#v", loose)
	}

	// An empty result is non-nil so the context renders [].
	empty := associationTargets("seed", nil, nil, 0.3, 10)
	if empty == nil || len(empty) != 0 {
		t.Fatalf("want non-nil empty slice, got %#v", empty)
	}
}

func TestAssociationImpactScore(t *testing.T) {
	targets := []associationTarget{{Score: 0.8}, {Score: 0.2}}
	if got, want := associationImpactScore(-2.5, targets), 2.0; math.Abs(got-want) > 1e-12 {
		t.Fatalf("want %v, got %v", want, got)
	}
	if got := associationImpactScore(3, nil); got != 0 {
		t.Fatalf("no targets: want 0, got %v", got)
	}
	if got := associationImpactScore(0, targets); got != 0 {
		t.Fatalf("zero source: want 0, got %v", got)
	}
}

func TestAssociationNormalizeSearchKeys(t *testing.T) {
	// Company suffix stripping, in insertion order and lowercased.
	got := associationNormalizeSearchKeys("ACME Inc")
	want := []string{"acme inc", "acme"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	// Bracketed segments are removed and collapsed.
	got = associationNormalizeSearchKeys("贵州茅台(600519)")
	want = []string{"贵州茅台(600519)", "贵州茅台"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	// Multiple suffixes match independently: 股份有限公司 before 有限公司,
	// mirroring the NestJS suffix table order.
	if got := associationCompanyAliasCandidates("贵州茅台股份有限公司"); !reflect.DeepEqual(got,
		[]string{"贵州茅台股份有限公司", "贵州茅台", "贵州茅台股份"}) {
		t.Fatalf("company aliases: %v", got)
	}
	bracketAliases := associationCompanyAliasCandidates("贵州茅台（集团）股份有限公司")
	foundCollapsed := false
	for _, alias := range bracketAliases {
		if alias == "贵州茅台 股份有限公司" {
			foundCollapsed = true
		}
	}
	if !foundCollapsed {
		t.Fatalf("bracket stripping missing: %v", bracketAliases)
	}

	// Ticker aliases: bare code, code.EXCHANGE and EXCHANGEcode.
	got = associationNormalizeSearchKeys("600519.SH")
	want = []string{"600519.sh", "600519", "sh600519"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	// A bare code expands to all three exchanges.
	got = associationNormalizeSearchKeys("600519")
	for _, expected := range []string{"600519", "600519.sh", "sh600519", "600519.sz", "sz600519", "600519.bj", "bj600519"} {
		found := false
		for _, key := range got {
			if key == expected {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("missing key %q in %v", expected, got)
		}
	}

	// Blank input has no keys; the list is capped at 20 entries.
	if keys := associationNormalizeSearchKeys("   "); len(keys) != 0 {
		t.Fatalf("blank input: want no keys, got %v", keys)
	}
}

func TestAssociationTickerHelpers(t *testing.T) {
	code, exchange, ok := associationParseTicker("sh600519")
	if !ok || code != "600519" || exchange != "SH" {
		t.Fatalf("prefix ticker: got %q/%q/%v", code, exchange, ok)
	}
	code, exchange, ok = associationParseTicker(" 600519.bj ")
	if !ok || code != "600519" || exchange != "BJ" {
		t.Fatalf("dot ticker: got %q/%q/%v", code, exchange, ok)
	}
	code, exchange, ok = associationParseTicker("600519")
	if !ok || code != "600519" || exchange != "" {
		t.Fatalf("bare ticker: got %q/%q/%v", code, exchange, ok)
	}
	if _, _, ok := associationParseTicker("ACME"); ok {
		t.Fatal("ACME must not parse as a ticker")
	}
	if !associationLooksLikeTicker("600519.SH") {
		t.Fatal("600519.SH should look like a ticker")
	}
}

func TestAssociationSortCandidates(t *testing.T) {
	// A ticker-shaped query prefers the instrument entity regardless of the
	// alias source or type preference.
	tickerCandidates := []associationCandidate{
		{Entity: associationEntity{ID: "company", Type: "company"}, Source: "user"},
		{Entity: associationEntity{ID: "instrument", Type: "instrument"}, Source: "llm"},
	}
	associationSortCandidates(tickerCandidates, true)
	if tickerCandidates[0].Entity.ID != "instrument" {
		t.Fatalf("ticker query should prefer the instrument, got %v", tickerCandidates)
	}

	// Otherwise the alias source order wins: user, seed, derived, llm.
	sourceCandidates := []associationCandidate{
		{Entity: associationEntity{ID: "llm", Type: "company"}, Source: "llm"},
		{Entity: associationEntity{ID: "user", Type: "organization"}, Source: "user"},
	}
	associationSortCandidates(sourceCandidates, false)
	if sourceCandidates[0].Entity.ID != "user" {
		t.Fatalf("source preference should win, got %v", sourceCandidates)
	}

	// With the same source the entity type preference decides: company before
	// industry.
	typeCandidates := []associationCandidate{
		{Entity: associationEntity{ID: "industry", Type: "industry"}, Source: "seed"},
		{Entity: associationEntity{ID: "company", Type: "company"}, Source: "seed"},
	}
	associationSortCandidates(typeCandidates, false)
	if typeCandidates[0].Entity.ID != "company" {
		t.Fatalf("type preference should win, got %v", typeCandidates)
	}
}

func TestMaxAssociationEdgeLimit(t *testing.T) {
	if got := maxAssociationEdgeLimit(1); got != 50 {
		t.Fatalf("maxTargets=1: want 50, got %d", got)
	}
	if got := maxAssociationEdgeLimit(10); got != 100 {
		t.Fatalf("maxTargets=10: want 100, got %d", got)
	}
	if got := maxAssociationEdgeLimit(50); got != 500 {
		t.Fatalf("maxTargets=50: want 500, got %d", got)
	}
}
