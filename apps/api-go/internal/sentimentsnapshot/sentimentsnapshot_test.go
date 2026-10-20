package sentimentsnapshot

import (
	"math"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func mustRawValue(t *testing.T, fragment string) bson.RawValue {
	t.Helper()
	var holder struct {
		Value bson.RawValue `bson:"value"`
	}
	if err := bson.UnmarshalExtJSON([]byte(`{"value":`+fragment+`}`), false, &holder); err != nil {
		t.Fatalf("decode %q: %v", fragment, err)
	}
	return holder.Value
}

// TestBSONCounter pins the numeric decoding for the three BSON types $sum can
// produce, including the double rounding.
func TestBSONCounter(t *testing.T) {
	cases := []struct {
		fragment string
		want     int64
	}{
		{`5`, 5},
		{`{"$numberLong":"10"}`, 10},
		{`5.5`, 6},
		{`2.5`, 3},
		{`-2.5`, -3},
		{`7.0`, 7},
		{`{"$numberLong":"-3"}`, -3},
	}
	for _, test := range cases {
		if got := bsonCounter(mustRawValue(t, test.fragment)); got != test.want {
			t.Errorf("bsonCounter(%s) = %d, want %d", test.fragment, got, test.want)
		}
	}
	if got := bsonCounter(bson.RawValue{}); got != 0 {
		t.Errorf("bsonCounter(missing) = %d, want 0", got)
	}
}

// TestAverageAndRatio pins avgScore and negativeRatio as float64 divisions with
// the zero-document guard.
func TestAverageAndRatio(t *testing.T) {
	row := sentimentAggregateRow{TotalDocs: 3, NegativeDocs: 1, ScoreSum: 2}
	if got := row.avgScore(); math.Abs(got-2.0/3.0) > 1e-15 {
		t.Errorf("avgScore = %v, want 2/3", got)
	}
	if got := row.negativeRatio(); math.Abs(got-1.0/3.0) > 1e-15 {
		t.Errorf("negativeRatio = %v, want 1/3", got)
	}
	empty := sentimentAggregateRow{}
	if got := empty.avgScore(); got != 0 {
		t.Errorf("avgScore with no documents = %v, want 0", got)
	}
	if got := empty.negativeRatio(); got != 0 {
		t.Errorf("negativeRatio with no documents = %v, want 0", got)
	}
	topic := topicAggregateRow{TotalDocs: 4, NegativeDocs: 3, ScoreSum: -1}
	if got := topic.avgScore(); got != -0.25 {
		t.Errorf("topic avgScore = %v, want -0.25", got)
	}
	if got := topic.negativeRatio(); got != 0.75 {
		t.Errorf("topic negativeRatio = %v, want 0.75", got)
	}
}

func stageDocument(t *testing.T, stage any) bson.D {
	t.Helper()
	document, ok := stage.(bson.D)
	if !ok {
		t.Fatalf("stage is %T, want bson.D", stage)
	}
	return document
}

func memberValue(t *testing.T, document bson.D, key string) any {
	t.Helper()
	for _, element := range document {
		if element.Key == key {
			return element.Value
		}
	}
	t.Fatalf("document has no %q member", key)
	return nil
}

// TestEntitySentimentPipelineShape pins the stage order and the parameters the
// NestJS pipeline uses.
func TestEntitySentimentPipelineShape(t *testing.T) {
	start := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	end := start.Add(24 * time.Hour)
	pipeline := entitySentimentPipeline("org-1", start, end)
	// match, unwind, match, project, project, group, project, sort, limit
	if len(pipeline) != 9 {
		t.Fatalf("pipeline has %d stages, want 9", len(pipeline))
	}

	match := stageDocument(t, pipeline[0])
	if _, ok := match[0].Value.(bson.D); !ok {
		t.Fatalf("first member is %T, want the $match document", match[0].Value)
	}
	matchBody := match[0].Value.(bson.D)
	if got := memberValue(t, matchBody, "orgId"); got != "org-1" {
		t.Errorf("orgId predicate = %v", got)
	}
	if got := memberValue(t, matchBody, "status"); got != "completed" {
		t.Errorf("status predicate = %v", got)
	}
	createdAt := memberValue(t, matchBody, "createdAt").(bson.D)
	if got := memberValue(t, createdAt, "$gte"); got != start {
		t.Errorf("createdAt $gte = %v, want %v", got, start)
	}
	if got := memberValue(t, createdAt, "$lt"); got != end {
		t.Errorf("createdAt $lt = %v, want %v", got, end)
	}

	unwind := stageDocument(t, pipeline[1])
	if got := memberValue(t, unwind, "$unwind"); got != "$result.entities" {
		t.Errorf("$unwind = %v", got)
	}

	second := stageDocument(t, pipeline[2])[0].Value.(bson.D)
	nameMatch := memberValue(t, second, "result.entities.name").(bson.D)
	if got := memberValue(t, nameMatch, "$type"); got != "string" {
		t.Errorf("name $type = %v", got)
	}
	if got := memberValue(t, nameMatch, "$ne"); got != "" {
		t.Errorf("name $ne = %v", got)
	}
	confidenceMatch := memberValue(t, second, "result.entities.confidence").(bson.D)
	if got := memberValue(t, confidenceMatch, "$gte"); got != minEntityConfidence {
		t.Errorf("confidence $gte = %v, want %v", got, minEntityConfidence)
	}

	group := stageDocument(t, pipeline[5])
	groupBody := memberValue(t, group, "$group").(bson.D)
	if got := memberValue(t, groupBody, "totalDocs").(bson.D)[0].Value; got != 1 {
		t.Errorf("totalDocs accumulator = %v, want $sum 1", got)
	}

	sortStage := stageDocument(t, pipeline[7])
	sortBody := memberValue(t, sortStage, "$sort").(bson.D)
	if len(sortBody) != 2 || sortBody[0].Key != "totalDocs" || sortBody[1].Key != "negativeDocs" {
		t.Fatalf("$sort keys = %v, want totalDocs then negativeDocs", sortBody)
	}
	if sortBody[0].Value != -1 || sortBody[1].Value != -1 {
		t.Errorf("$sort directions = %v/%v, want -1/-1", sortBody[0].Value, sortBody[1].Value)
	}

	limit := stageDocument(t, pipeline[8])
	if got := memberValue(t, limit, "$limit"); got != maxRowsPerBucket {
		t.Errorf("$limit = %v, want %d", got, maxRowsPerBucket)
	}
}

// TestTopicSentimentPipelineShape pins the topic pipeline's unwind, type filter
// and 191-code-point truncation.
func TestTopicSentimentPipelineShape(t *testing.T) {
	start := time.Date(2026, 10, 19, 0, 0, 0, 0, time.UTC)
	pipeline := topicSentimentPipeline("org-2", start, start.Add(24*time.Hour))
	if len(pipeline) != 9 {
		t.Fatalf("pipeline has %d stages, want 9", len(pipeline))
	}
	unwind := stageDocument(t, pipeline[1])
	if got := memberValue(t, unwind, "$unwind"); got != "$result.topics" {
		t.Errorf("$unwind = %v", got)
	}
	second := stageDocument(t, pipeline[2])[0].Value.(bson.D)
	topicMatch := memberValue(t, second, "result.topics").(bson.D)
	if got := memberValue(t, topicMatch, "$type"); got != "string" {
		t.Errorf("topic $type = %v", got)
	}
	project := stageDocument(t, pipeline[6])
	projectBody := memberValue(t, project, "$project").(bson.D)
	substr := memberValue(t, projectBody, "topic").(bson.D)
	arguments := memberValue(t, substr, "$substrCP").(bson.A)
	if len(arguments) != 3 || arguments[0] != "$_id.topic" || arguments[2] != maxNameCodePoints {
		t.Errorf("$substrCP arguments = %v", arguments)
	}
	if maxNameCodePoints != 191 {
		t.Errorf("maxNameCodePoints = %d, want the VARCHAR(191) width", maxNameCodePoints)
	}
}

// TestSentimentNextWallClockDelay pins the hourly alignment.
func TestSentimentNextWallClockDelay(t *testing.T) {
	midHour := time.Date(2026, 10, 20, 10, 30, 0, 0, time.UTC)
	if got := nextWallClockDelay(midHour, hourlyInterval); got != 30*time.Minute {
		t.Errorf("nextWallClockDelay(%v, 1h) = %v, want 30m", midHour, got)
	}
	aligned := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)
	if got := nextWallClockDelay(aligned, hourlyInterval); got != time.Hour {
		t.Errorf("nextWallClockDelay(%v, 1h) = %v, want 1h", aligned, got)
	}
	if rebuildDays != 2 {
		t.Errorf("rebuildDays = %d, want 2", rebuildDays)
	}
}
