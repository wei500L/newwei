package workspace

import (
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// clampDays mirrors the sentiment resolver clamp: days defaults to 30 and is
// clamped into 1..365.
func clampDays(value int, ok bool) int {
	days := 30
	if ok {
		days = value
	}
	if days < 1 {
		days = 1
	}
	if days > 365 {
		days = 365
	}
	return days
}

// entitySentimentSeries implements the entitySentimentSeries root. entityName
// is trimmed before the lookup because every writer stores the trimmed name;
// an empty name returns an empty series instead of matching nothing.
func (s *service) entitySentimentSeries(ctx contract.Context) ([]EntitySentimentSnapshotModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	name, _ := contract.StringArg(ctx.Args, "entityName")
	name = jsTrim(name)
	if name == "" {
		return []EntitySentimentSnapshotModel{}, nil
	}
	entityType, _ := contract.StringArg(ctx.Args, "entityType")
	entityType = strings.ToLower(jsTrim(entityType))
	days, hasDays := contract.IntArg(ctx.Args, "days")
	days = clampDays(days, hasDays)
	since := s.clock().UTC().Add(-time.Duration(days) * 24 * time.Hour)

	rows, err := s.db.QueryContext(s.call(ctx),
		"SELECT entityName, entityType, bucketStart, totalDocs, negativeDocs, positiveDocs, neutralDocs, "+
			"scoreSum, avgScore, negativeRatio, evidenceProcessedItemIds FROM EntitySentimentSnapshot "+
			"WHERE orgId = ? AND entityName = ? AND entityType = ? AND bucketStart >= ? ORDER BY bucketStart ASC",
		ctx.Identity.OrgID, name, entityType, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]EntitySentimentSnapshotModel, 0)
	for rows.Next() {
		var model EntitySentimentSnapshotModel
		var evidence []byte
		var bucketStart time.Time
		if err := rows.Scan(&model.EntityName, &model.EntityType, &bucketStart, &model.TotalDocs,
			&model.NegativeDocs, &model.PositiveDocs, &model.NeutralDocs, &model.ScoreSum,
			&model.AvgScore, &model.NegativeRatio, &evidence); err != nil {
			return nil, err
		}
		model.BucketStart = utcTime(bucketStart)
		model.EvidenceProcessedItemIDs = jsonScalar(evidence)
		out = append(out, model)
	}
	return out, rows.Err()
}

// topicSentimentSeries implements the topicSentimentSeries root with the same
// trim and clamp rules as entitySentimentSeries.
func (s *service) topicSentimentSeries(ctx contract.Context) ([]TopicSentimentSnapshotModel, error) {
	if s == nil || s.db == nil {
		return nil, errDatabaseUnavailable
	}
	topic, _ := contract.StringArg(ctx.Args, "topic")
	topic = jsTrim(topic)
	if topic == "" {
		return []TopicSentimentSnapshotModel{}, nil
	}
	days, hasDays := contract.IntArg(ctx.Args, "days")
	days = clampDays(days, hasDays)
	since := s.clock().UTC().Add(-time.Duration(days) * 24 * time.Hour)

	rows, err := s.db.QueryContext(s.call(ctx),
		"SELECT topic, bucketStart, totalDocs, negativeDocs, positiveDocs, neutralDocs, scoreSum, avgScore, "+
			"negativeRatio, evidenceProcessedItemIds FROM TopicSentimentSnapshot "+
			"WHERE orgId = ? AND topic = ? AND bucketStart >= ? ORDER BY bucketStart ASC",
		ctx.Identity.OrgID, topic, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TopicSentimentSnapshotModel, 0)
	for rows.Next() {
		var model TopicSentimentSnapshotModel
		var evidence []byte
		var bucketStart time.Time
		if err := rows.Scan(&model.Topic, &bucketStart, &model.TotalDocs, &model.NegativeDocs,
			&model.PositiveDocs, &model.NeutralDocs, &model.ScoreSum, &model.AvgScore,
			&model.NegativeRatio, &evidence); err != nil {
			return nil, err
		}
		model.BucketStart = utcTime(bucketStart)
		model.EvidenceProcessedItemIDs = jsonScalar(evidence)
		out = append(out, model)
	}
	return out, rows.Err()
}
