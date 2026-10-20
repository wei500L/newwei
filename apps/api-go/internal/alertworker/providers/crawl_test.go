package providers

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func TestCrawlNormalizeWindowMinutes(t *testing.T) {
	cases := []struct {
		name  string
		value float64
		want  int
	}{
		{name: "zero falls back", value: 0, want: 60},
		{name: "negative falls back", value: -5, want: 60},
		{name: "nan falls back", value: math.NaN(), want: 60},
		{name: "positive infinity falls back", value: math.Inf(1), want: 60},
		// Math.round(0.4) = 0, then Math.max(1, ...) = 1.
		{name: "rounds down to one", value: 0.4, want: 1},
		{name: "rounds to one", value: 1.4, want: 1},
		{name: "rounds up", value: 1.5, want: 2},
		{name: "rounds half up", value: 2.5, want: 3},
		{name: "keeps whole numbers", value: 90, want: 90},
		{name: "clamps to one day", value: 1440, want: 1440},
		{name: "clamps high", value: 1441, want: 1440},
		{name: "clamps very high", value: 1e9, want: 1440},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := crawlNormalizeWindowMinutes(testCase.value); got != testCase.want {
				t.Fatalf("want %d, got %d", testCase.want, got)
			}
		})
	}
}

func TestCrawlSafeRate(t *testing.T) {
	pipelineFloatEqual(t, "zero denominator", crawlSafeRate(3, 0), nil)
	pipelineFloatEqual(t, "negative denominator", crawlSafeRate(3, -1), nil)
	pipelineFloatEqual(t, "half", crawlSafeRate(5, 10), evaluationNumber(0.5))
	pipelineFloatEqual(t, "zero numerator", crawlSafeRate(0, 4), evaluationNumber(0))
	pipelineFloatEqual(t, "one", crawlSafeRate(4, 4), evaluationNumber(1))
}

func TestCrawlChangePercent(t *testing.T) {
	pipelineFloatEqual(t, "nil latest", crawlChangePercent(nil, evaluationNumber(5)), nil)
	pipelineFloatEqual(t, "nil previous", crawlChangePercent(evaluationNumber(5), nil), nil)
	pipelineFloatEqual(t, "zero previous", crawlChangePercent(evaluationNumber(5), evaluationNumber(0)), nil)
	// 0.5 and 0.25 are exact binary fractions, so the percentage is exact too.
	pipelineFloatEqual(t, "increase",
		crawlChangePercent(evaluationNumber(0.5), evaluationNumber(0.25)), evaluationNumber(100))
	pipelineFloatEqual(t, "decrease",
		crawlChangePercent(evaluationNumber(0.25), evaluationNumber(0.5)), evaluationNumber(-50))
}

func TestResolveCrawlTaskStatuses(t *testing.T) {
	cases := []struct {
		name     string
		metadata string
		want     []string
	}{
		// Absent metadata defaults to the failed status.
		{name: "default", metadata: `{}`, want: []string{"failed"}},
		// Requested statuses are filtered through Object.values(CrawlTaskStatus).
		{
			name:     "filtered through allowed statuses",
			metadata: `{"statuses":["completed","bogus","running"]}`,
			want:     []string{"completed", "running"},
		},
		{
			name:     "singular status",
			metadata: `{"status":"paused"}`,
			want:     []string{"paused"},
		},
		{
			name:     "singular unknown status is dropped",
			metadata: `{"status":"bogus"}`,
			want:     []string{},
		},
		// An explicitly empty filter stays empty (Prisma `in: []` matches nothing).
		{name: "empty array", metadata: `{"statuses":[]}`, want: []string{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			metadata := readRuleMetadata(json.RawMessage(testCase.metadata))
			got := resolveCrawlTaskStatuses(metadata)
			if !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("want %#v, got %#v", testCase.want, got)
			}
			if got == nil {
				t.Fatal("resolution must return a non-nil slice")
			}
		})
	}
}

func TestCrawlSafeNonNegativeInt(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  int
	}{
		{name: "nil", value: nil, want: 0},
		{name: "string", value: "7", want: 0},
		{name: "int32", value: int32(7), want: 7},
		{name: "int64", value: int64(9), want: 9},
		{name: "float rounds down", value: 3.4, want: 3},
		{name: "float rounds up", value: 3.6, want: 4},
		{name: "float half rounds up", value: 2.5, want: 3},
		{name: "negative clamps", value: -2.4, want: 0},
		{name: "nan", value: math.NaN(), want: 0},
		{name: "infinity", value: math.Inf(1), want: 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := crawlSafeNonNegativeInt(testCase.value); got != testCase.want {
				t.Fatalf("want %d, got %d", testCase.want, got)
			}
		})
	}
}

// TestBuildCrawlPreflightPipelineShape compares the builder against a
// hand-written bson.D pipeline with reflect.DeepEqual (not JSON), so the exact
// stage order, keys and literal values are asserted.
func TestBuildCrawlPreflightPipelineShape(t *testing.T) {
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	end := start.Add(60 * time.Minute)

	want := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: "org-1"},
			{Key: "queue", Value: "crawl4ai"},
			{Key: "stage", Value: "preflight"},
			{Key: "createdAt", Value: bson.D{
				{Key: "$gte", Value: start},
				{Key: "$lt", Value: end},
			}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "runs", Value: bson.D{{Key: "$sum", Value: 1}}},
			{Key: "failures", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$cond", Value: bson.A{
					bson.D{{Key: "$eq", Value: bson.A{"$status", "failed"}}},
					1,
					0,
				}},
			}}}},
			{Key: "http304Hits", Value: bson.D{{Key: "$sum", Value: bson.D{
				{Key: "$cond", Value: bson.A{
					bson.D{{Key: "$and", Value: bson.A{
						bson.D{{Key: "$isNumber", Value: "$data.status"}},
						bson.D{{Key: "$eq", Value: bson.A{
							bson.D{{Key: "$round", Value: bson.A{"$data.status", 0}}},
							304,
						}}},
					}}},
					1,
					0,
				}},
			}}}},
		}}},
	}

	if got := buildCrawlPreflightPipeline("org-1", start, &end); !reflect.DeepEqual(got, want) {
		t.Fatalf("preflight pipeline mismatch:\nwant %#v\ngot  %#v", want, got)
	}

	// The previous window has no upper bound: only $gte is present.
	openEnded := buildCrawlPreflightPipeline("org-1", start, nil)
	match, ok := openEnded[0][0].Value.(bson.D)
	if !ok {
		t.Fatalf("first stage is not a $match document: %#v", openEnded[0])
	}
	for _, element := range match {
		if element.Key != "createdAt" {
			continue
		}
		window, ok := element.Value.(bson.D)
		if !ok {
			t.Fatalf("createdAt is not a document: %#v", element.Value)
		}
		if len(window) != 1 || window[0].Key != "$gte" {
			t.Fatalf("want only $gte, got %#v", window)
		}
	}
}

// TestBuildCrawlDedupePipelineShape is the second aggregation shape assertion.
func TestBuildCrawlDedupePipelineShape(t *testing.T) {
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)

	want := mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: "org-1"},
			{Key: "queue", Value: "crawl4ai"},
			{Key: "stage", Value: "dedupe"},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: start}}},
		}}},
		bson.D{{Key: "$project", Value: bson.D{
			{Key: "evaluatedCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$isNumber", Value: "$data.evaluatedCount"}},
				bson.D{{Key: "$max", Value: bson.A{
					bson.D{{Key: "$round", Value: bson.A{"$data.evaluatedCount", 0}}},
					0,
				}}},
				0,
			}}}},
			{Key: "orgReuseCount", Value: bson.D{{Key: "$cond", Value: bson.A{
				bson.D{{Key: "$isNumber", Value: "$data.orgReuseCount"}},
				bson.D{{Key: "$max", Value: bson.A{
					bson.D{{Key: "$round", Value: bson.A{"$data.orgReuseCount", 0}}},
					0,
				}}},
				0,
			}}}},
		}}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: nil},
			{Key: "evaluatedCount", Value: bson.D{{Key: "$sum", Value: "$evaluatedCount"}}},
			{Key: "orgReuseCount", Value: bson.D{{Key: "$sum", Value: "$orgReuseCount"}}},
		}}},
	}

	if got := buildCrawlDedupePipeline("org-1", start, nil); !reflect.DeepEqual(got, want) {
		t.Fatalf("dedupe pipeline mismatch:\nwant %#v\ngot  %#v", want, got)
	}
}
