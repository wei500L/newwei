package sentimentsnapshot

import (
	"time"
)

// Constants copied verbatim from sentiment-snapshot.ingestion.service.ts.
const (
	rebuildDays         = 2
	minEntityConfidence = 0.5
	maxRowsPerBucket    = 5000
	tickGateTTL         = 55 * time.Minute
	orgLockTTL          = 5 * time.Minute
	hourlyInterval      = time.Hour
	maxNameCodePoints   = 191
	sentimentWriteChunk = 500
	processedItemsName  = "processeditems"
	entitySnapshotTable = "EntitySentimentSnapshot"
	topicSnapshotTable  = "TopicSentimentSnapshot"
	snapshotTickGateKey = "cron:sentiment-snapshot:tick-gate"
	snapshotOrgLockFmt  = "cron:sentiment-snapshot:org:"
)

// sentimentAggregateRow is one decoded entity aggregation row. The Mongo $sum
// accumulators arrive as int32, int64 or double and are normalized to int64.
type sentimentAggregateRow struct {
	Name         string
	Type         string
	TotalDocs    int64
	NegativeDocs int64
	PositiveDocs int64
	NeutralDocs  int64
	ScoreSum     int64
}

// topicAggregateRow is one decoded topic aggregation row.
type topicAggregateRow struct {
	Topic        string
	TotalDocs    int64
	NegativeDocs int64
	PositiveDocs int64
	NeutralDocs  int64
	ScoreSum     int64
}

// avgScore and negativeRatio mirror the NestJS expressions:
// totalDocs > 0 ? scoreSum / totalDocs : 0, both computed in float64.
func (r sentimentAggregateRow) avgScore() float64 {
	if r.TotalDocs > 0 {
		return float64(r.ScoreSum) / float64(r.TotalDocs)
	}
	return 0
}

func (r sentimentAggregateRow) negativeRatio() float64 {
	if r.TotalDocs > 0 {
		return float64(r.NegativeDocs) / float64(r.TotalDocs)
	}
	return 0
}

func (r topicAggregateRow) avgScore() float64 {
	if r.TotalDocs > 0 {
		return float64(r.ScoreSum) / float64(r.TotalDocs)
	}
	return 0
}

func (r topicAggregateRow) negativeRatio() float64 {
	if r.TotalDocs > 0 {
		return float64(r.NegativeDocs) / float64(r.TotalDocs)
	}
	return 0
}

// toUTCDayStart mirrors toUtcDayStart.
func toUTCDayStart(value time.Time) time.Time {
	utc := value.UTC()
	return time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC)
}
