package userdigest

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

// Sentiment 是主题或实体最新一个桶的情绪。字段顺序即 JSON 顺序。
type Sentiment struct {
	BucketStart   string  `json:"bucketStart"`
	TotalDocs     int     `json:"totalDocs"`
	AvgScore      float64 `json:"avgScore"`
	NegativeRatio float64 `json:"negativeRatio"`
}

// IndicatorAssociation 是一条 volume 关联。latestBacktest 无记录时为 null，字段仍在。
type IndicatorAssociation struct {
	ScopeType            string    `json:"scopeType"`
	FeatureMetric        string    `json:"featureMetric"`
	IndicatorSlug        string    `json:"indicatorSlug"`
	IndicatorDisplayName string    `json:"indicatorDisplayName"`
	LagDays              int       `json:"lagDays"`
	Correlation          float64   `json:"correlation"`
	PValue               *float64  `json:"pValue"`
	LatestBacktest       *Backtest `json:"latestBacktest"`
}

// Backtest 是该关联 createdAt 最新的一条回测。metrics 保持 Prisma JSON。
type Backtest struct {
	CreatedAt string          `json:"createdAt"`
	Metrics   json.RawMessage `json:"metrics"`
}

func (s *Service) loadTopicSentiments(ctx context.Context, orgID string, topics []string) (map[string]Sentiment, error) {
	out := map[string]Sentiment{}
	if len(topics) == 0 {
		return out, nil
	}
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	query := `SELECT topic, bucketStart, totalDocs, avgScore, negativeRatio
FROM TopicSentimentSnapshot
WHERE orgId = ? AND topic IN (` + placeholders(len(topics)) + `)
ORDER BY topic ASC, bucketStart DESC`
	args := make([]any, 0, len(topics)+1)
	args = append(args, orgID)
	for _, topic := range topics {
		args = append(args, topic)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: topic sentiment: %v", errMySQL, err)
	}
	defer rows.Close()
	for rows.Next() {
		var topic string
		var bucket sql.NullTime
		var sentiment Sentiment
		if err := rows.Scan(&topic, &bucket, &sentiment.TotalDocs, &sentiment.AvgScore, &sentiment.NegativeRatio); err != nil {
			return nil, fmt.Errorf("%w: scan topic sentiment: %v", errMySQL, err)
		}
		if _, ok := out[topic]; ok {
			continue
		}
		if bucket.Valid {
			sentiment.BucketStart = isoTime(bucket.Time)
		}
		out[topic] = sentiment
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: topic sentiment: %v", errMySQL, err)
	}
	return out, nil
}

func (s *Service) loadEntitySentiments(ctx context.Context, orgID string, names []string) (map[string]Sentiment, error) {
	out := map[string]Sentiment{}
	if len(names) == 0 {
		return out, nil
	}
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	query := `SELECT entityName, bucketStart, totalDocs, avgScore, negativeRatio
FROM EntitySentimentSnapshot
WHERE orgId = ? AND entityName IN (` + placeholders(len(names)) + `)
ORDER BY entityName ASC, bucketStart DESC, entityType ASC`
	args := make([]any, 0, len(names)+1)
	args = append(args, orgID)
	for _, name := range names {
		args = append(args, name)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: entity sentiment: %v", errMySQL, err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var bucket sql.NullTime
		var sentiment Sentiment
		if err := rows.Scan(&name, &bucket, &sentiment.TotalDocs, &sentiment.AvgScore, &sentiment.NegativeRatio); err != nil {
			return nil, fmt.Errorf("%w: scan entity sentiment: %v", errMySQL, err)
		}
		if _, ok := out[name]; ok {
			continue
		}
		if bucket.Valid {
			sentiment.BucketStart = isoTime(bucket.Time)
		}
		out[name] = sentiment
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: entity sentiment: %v", errMySQL, err)
	}
	return out, nil
}

type indicatorScope struct {
	scopeType string
	scopeKey  string
}

func (s *Service) loadIndicators(ctx context.Context, orgID string, events []digestEvent, limit int) (map[string][]IndicatorAssociation, error) {
	out := map[string][]IndicatorAssociation{}
	scopes := map[string]indicatorScope{}
	for _, event := range events {
		if event.PrimaryTopic != nil && *event.PrimaryTopic != "" {
			key := "topic:" + *event.PrimaryTopic
			scopes[key] = indicatorScope{scopeType: "topic", scopeKey: *event.PrimaryTopic}
		}
		if event.PrimaryEntity != nil && *event.PrimaryEntity != "" {
			key := "entity:" + *event.PrimaryEntity
			scopes[key] = indicatorScope{scopeType: "entity", scopeKey: *event.PrimaryEntity}
		}
	}
	if len(scopes) == 0 {
		return out, nil
	}
	if err := s.requireDB(); err != nil {
		return nil, err
	}
	perEvent := limit
	if perEvent < 1 {
		perEvent = 1
	}
	if perEvent > 50 {
		perEvent = 50
	}
	take := perEvent * len(scopes) * 3
	if take > 5000 {
		take = 5000
	}
	var b strings.Builder
	b.WriteString(`SELECT a.id, a.scopeType, a.scopeKey, a.featureMetric, a.lagDays, a.correlation, a.pValue,
i.slug, i.displayName
FROM NewsIndicatorAssociation a
INNER JOIN EconomicDataItem i ON i.id = a.indicatorItemId
WHERE a.orgId = ? AND a.featureMetric = 'volume' AND (`)
	args := []any{orgID}
	index := 0
	for _, scope := range scopes {
		if index > 0 {
			b.WriteString(" OR ")
		}
		b.WriteString("(a.scopeType = ? AND a.scopeKey = ?)")
		args = append(args, scope.scopeType, scope.scopeKey)
		index++
	}
	b.WriteString(`) ORDER BY a.scopeType ASC, a.scopeKey ASC, a.lastEvaluatedAt DESC, a.correlation DESC, a.lagDays ASC, a.id ASC LIMIT ?`)
	args = append(args, take)
	rows, err := s.db.QueryContext(ctx, b.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("%w: indicator associations: %v", errMySQL, err)
	}
	defer rows.Close()
	collected := make([]associationRow, 0)
	for rows.Next() {
		var item associationRow
		var scopeKey string
		var pValue sql.NullFloat64
		var display sql.NullString
		// scopeKey 只用来分组，响应对象里没有这个字段。
		if err := rows.Scan(&item.id, &item.entry.ScopeType, &scopeKey, &item.entry.FeatureMetric, &item.entry.LagDays, &item.entry.Correlation, &pValue, &item.entry.IndicatorSlug, &display); err != nil {
			return nil, fmt.Errorf("%w: scan indicator association: %v", errMySQL, err)
		}
		item.key = item.entry.ScopeType + ":" + scopeKey
		if pValue.Valid {
			value := pValue.Float64
			item.entry.PValue = &value
		}
		if display.Valid {
			item.entry.IndicatorDisplayName = display.String
		} else {
			item.entry.IndicatorDisplayName = item.entry.IndicatorSlug
		}
		collected = append(collected, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: indicator associations: %v", errMySQL, err)
	}
	backtests, err := s.latestBacktests(ctx, associationIDs(collected))
	if err != nil {
		return nil, err
	}
	grouped := map[string][]IndicatorAssociation{}
	for _, item := range collected {
		if backtest, ok := backtests[item.id]; ok {
			copied := backtest
			item.entry.LatestBacktest = &copied
		}
		grouped[item.key] = append(grouped[item.key], item.entry)
	}
	for key, entries := range grouped {
		sortByAbsCorrelation(entries)
		if len(entries) > perEvent {
			entries = entries[:perEvent]
		}
		out[key] = entries
	}
	return out, nil
}

type associationRow struct {
	id    string
	entry IndicatorAssociation
	key   string
}

func associationIDs(rows []associationRow) []string {
	out := make([]string, len(rows))
	for i := range rows {
		out[i] = rows[i].id
	}
	return out
}

func (s *Service) latestBacktests(ctx context.Context, ids []string) (map[string]Backtest, error) {
	out := map[string]Backtest{}
	if len(ids) == 0 {
		return out, nil
	}
	query := `SELECT associationId, createdAt, metrics
FROM NewsIndicatorAssociationBacktestRun
WHERE associationId IN (` + placeholders(len(ids)) + `)
ORDER BY createdAt DESC`
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: indicator backtests: %v", errMySQL, err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var created sql.NullTime
		var metrics []byte
		if err := rows.Scan(&id, &created, &metrics); err != nil {
			return nil, fmt.Errorf("%w: scan indicator backtest: %v", errMySQL, err)
		}
		if _, ok := out[id]; ok {
			continue
		}
		backtest := Backtest{Metrics: json.RawMessage("null")}
		if created.Valid {
			backtest.CreatedAt = isoTime(created.Time)
		}
		if json.Valid(metrics) {
			backtest.Metrics = append(json.RawMessage(nil), metrics...)
		}
		out[id] = backtest
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: indicator backtests: %v", errMySQL, err)
	}
	return out, nil
}
