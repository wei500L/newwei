package providers

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// sentimentProcessedItemStatusCompleted is the ProcessedItem.status the
// sentiment aggregations match.
const sentimentProcessedItemStatusCompleted = "completed"

// sentimentProcessedItemsCollection is the Mongoose 8 default collection name
// of ProcessedItem.
const sentimentProcessedItemsCollection = "processeditems"

// clampEntityInt mirrors clampInt: a non-number or non-finite input returns
// min, otherwise Math.trunc then clamp to [min, max]. Both entity providers
// (sentiment and association) copy the same helper in NestJS, so the Go port
// shares this one.
func clampEntityInt(value float64, min, max int) int {
	if !isFiniteMetricNumber(value) {
		return min
	}
	normalized := math.Trunc(value)
	if normalized < float64(min) {
		return min
	}
	if normalized > float64(max) {
		return max
	}
	return int(normalized)
}

// clampEntityFloat mirrors clampFloat: a non-number or non-finite input returns
// min, otherwise clamp to [min, max].
func clampEntityFloat(value float64, min, max float64) float64 {
	if !isFiniteMetricNumber(value) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// sentimentWindowStats is SentimentWindowStats: the five counters of one window.
type sentimentWindowStats struct {
	Total    float64 `json:"total"`
	Negative float64 `json:"negative"`
	Positive float64 `json:"positive"`
	Neutral  float64 `json:"neutral"`
	ScoreSum float64 `json:"scoreSum"`
}

// sentimentStatsRow is the $group output. The fields stay untyped so the
// `typeof row?.total === "number"` guards can be applied by stats().
type sentimentStatsRow struct {
	Total    any `bson:"total"`
	Negative any `bson:"negative"`
	Positive any `bson:"positive"`
	Neutral  any `bson:"neutral"`
	ScoreSum any `bson:"scoreSum"`
}

// stats applies the typeof guards and returns the counters.
func (row sentimentStatsRow) stats() sentimentWindowStats {
	return sentimentWindowStats{
		Total:    sentimentCounterValue(row.Total),
		Negative: sentimentCounterValue(row.Negative),
		Positive: sentimentCounterValue(row.Positive),
		Neutral:  sentimentCounterValue(row.Neutral),
		ScoreSum: sentimentCounterValue(row.ScoreSum),
	}
}

// sentimentCounterValue is `typeof value === "number" ? value : 0`.
func sentimentCounterValue(value any) float64 {
	number, ok := bsonNumericValue(value)
	if !ok || !isFiniteMetricNumber(number) {
		return 0
	}
	return number
}

// sentimentWindowContext is the window/baseline object of the context.
type sentimentWindowContext struct {
	Start         string  `json:"start"`
	End           string  `json:"end"`
	Minutes       int     `json:"minutes"`
	Total         float64 `json:"total"`
	Negative      float64 `json:"negative"`
	Positive      float64 `json:"positive"`
	Neutral       float64 `json:"neutral"`
	ScoreSum      float64 `json:"scoreSum"`
	NegativeRatio float64 `json:"negativeRatio"`
	AvgScore      float64 `json:"avgScore"`
}

// sentimentInsufficientContext is the insufficient_docs context.
type sentimentInsufficientContext struct {
	Error           string               `json:"error"`
	EntityName      string               `json:"entityName"`
	EntityType      *string              `json:"entityType"`
	MinDocsInWindow int                  `json:"minDocsInWindow"`
	Current         sentimentWindowStats `json:"current"`
	Baseline        sentimentWindowStats `json:"baseline"`
}

// sentimentEvidence is one evidence item of the context.
type sentimentEvidence struct {
	ProcessedID    string  `json:"processedId"`
	ItemMetaID     string  `json:"itemMetaId"`
	CreatedAt      string  `json:"createdAt"`
	IngestedAt     *string `json:"ingestedAt"`
	PublishedAt    *string `json:"publishedAt"`
	Title          *string `json:"title"`
	Source         *string `json:"source"`
	SentimentLabel *string `json:"sentimentLabel"`
	Summary        *string `json:"summary"`
}

// sentimentContext is the successful evaluation context.
type sentimentContext struct {
	EntityName          string                 `json:"entityName"`
	EntityType          *string                `json:"entityType"`
	Window              sentimentWindowContext `json:"window"`
	Baseline            sentimentWindowContext `json:"baseline"`
	Z                   float64                `json:"z"`
	MinEntityConfidence float64                `json:"minEntityConfidence"`
	Evidence            []sentimentEvidence    `json:"evidence"`
}

// sentimentEvidenceDoc is one projected ProcessedItem. Dates and the _id stay
// untyped because NestJS checks `instanceof Date` and calls toString().
type sentimentEvidenceDoc struct {
	ID         any `bson:"_id"`
	ItemMetaID any `bson:"itemMetaId"`
	CreatedAt  any `bson:"createdAt"`
	IngestedAt any `bson:"ingestedAt"`
	Result     any `bson:"result"`
}

// sentimentProvider is EntitySentimentMetricProvider.
type sentimentProvider struct {
	deps Dependencies
}

// NewEntitySentiment returns the entity_sentiment metric provider.
func NewEntitySentiment(deps Dependencies) Provider {
	return &sentimentProvider{deps: deps}
}

// Type is AlertMetricProvider.entity_sentiment.
func (p *sentimentProvider) Type() string {
	return TypeEntitySentiment
}

// Fetch mirrors EntitySentimentMetricProvider.fetch: a z-score of the negative
// ratio of the current window against the equally long window before it.
func (p *sentimentProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metadata := readRuleMetadata(rule.Metadata)
	minEntityConfidence := clampEntityFloat(
		metadata.numberOr("minEntityConfidence", 0.5), 0, 1)
	minDocsInWindow := clampEntityInt(
		metadata.numberOr("minDocsInWindow", 5), 1, 10_000)
	baselineWindowMin := clampEntityInt(
		metadata.numberOr("baselineWindowMin", 7*24*60), 60, 365*24*60)
	includeEvidenceItems := clampEntityInt(
		metadata.numberOr("includeEvidenceItems", 5), 0, 20)
	entityType := ""
	if value, ok := metadata.text("entityType"); ok {
		entityType = strings.TrimSpace(value)
	}

	windowMinutesRaw := 60.0
	if rule.ChangeWindowMin != nil {
		windowMinutesRaw = float64(*rule.ChangeWindowMin)
	} else if value, ok := metadata.number("windowMinutes"); ok {
		windowMinutesRaw = value
	}
	windowMinutes := clampEntityInt(windowMinutesRaw, 5, 7*24*60)

	now := p.deps.now().UTC()
	windowEnd := now
	windowStart := windowEnd.Add(-time.Duration(windowMinutes) * time.Minute)
	baselineEnd := windowStart
	baselineStart := baselineEnd.Add(-time.Duration(baselineWindowMin) * time.Minute)

	entityName := strings.TrimSpace(rule.MetricSlug)
	if entityName == "" {
		return sentimentEvaluation(sentimentSlugMissingContext{Error: "entity_missing"})
	}

	current, err := p.computeWindowStats(ctx, rule.OrgID, entityName, entityType,
		minEntityConfidence, windowStart, windowEnd)
	if err != nil {
		return Evaluation{}, err
	}
	baseline, err := p.computeWindowStats(ctx, rule.OrgID, entityName, entityType,
		minEntityConfidence, baselineStart, baselineEnd)
	if err != nil {
		return Evaluation{}, err
	}

	entityTypePointer := stringPointerWhenSet(entityType)
	if current.Total < float64(minDocsInWindow) || baseline.Total < float64(minDocsInWindow) {
		raw, err := marshalProviderContext(sentimentInsufficientContext{
			Error:           "insufficient_docs",
			EntityName:      entityName,
			EntityType:      entityTypePointer,
			MinDocsInWindow: minDocsInWindow,
			Current:         current,
			Baseline:        baseline,
		})
		if err != nil {
			return Evaluation{}, err
		}
		return Evaluation{Context: raw}, nil
	}

	currentNegRatio := 0.0
	if current.Total > 0 {
		currentNegRatio = current.Negative / current.Total
	}
	baselineNegRatio := 0.0
	if baseline.Total > 0 {
		baselineNegRatio = baseline.Negative / baseline.Total
	}
	currentAvg := 0.0
	if current.Total > 0 {
		currentAvg = current.ScoreSum / current.Total
	}
	baselineAvg := 0.0
	if baseline.Total > 0 {
		baselineAvg = baseline.ScoreSum / baseline.Total
	}

	// Standard error of the baseline negative ratio, floored like the NestJS
	// formula so a degenerate baseline yields se > 0 and z = 0 instead of NaN.
	se := math.Sqrt(math.Max(1e-12,
		(baselineNegRatio*(1-baselineNegRatio))/math.Max(1, current.Total)))
	z := 0.0
	if se > 0 {
		z = (currentNegRatio - baselineNegRatio) / se
	}

	evidence := make([]sentimentEvidence, 0)
	if includeEvidenceItems > 0 && current.Negative > 0 && currentNegRatio > baselineNegRatio {
		evidence, err = p.fetchEvidence(ctx, rule.OrgID, entityName, entityType,
			minEntityConfidence, windowStart, windowEnd, includeEvidenceItems)
		if err != nil {
			return Evaluation{}, err
		}
	}

	raw, err := marshalProviderContext(sentimentContext{
		EntityName: entityName,
		EntityType: entityTypePointer,
		Window: sentimentWindowContext{
			Start:         jsISOTimestamp(windowStart),
			End:           jsISOTimestamp(windowEnd),
			Minutes:       windowMinutes,
			Total:         current.Total,
			Negative:      current.Negative,
			Positive:      current.Positive,
			Neutral:       current.Neutral,
			ScoreSum:      current.ScoreSum,
			NegativeRatio: currentNegRatio,
			AvgScore:      currentAvg,
		},
		Baseline: sentimentWindowContext{
			Start:         jsISOTimestamp(baselineStart),
			End:           jsISOTimestamp(baselineEnd),
			Minutes:       baselineWindowMin,
			Total:         baseline.Total,
			Negative:      baseline.Negative,
			Positive:      baseline.Positive,
			Neutral:       baseline.Neutral,
			ScoreSum:      baseline.ScoreSum,
			NegativeRatio: baselineNegRatio,
			AvgScore:      baselineAvg,
		},
		Z:                   z,
		MinEntityConfidence: minEntityConfidence,
		Evidence:            evidence,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Latest: evaluationNumber(z), Context: raw}, nil
}

// sentimentSlugMissingContext is {error: "entity_missing"}.
type sentimentSlugMissingContext struct {
	Error string `json:"error"`
}

// sentimentEvaluation returns a value-less evaluation that only carries context.
func sentimentEvaluation(payload any) (Evaluation, error) {
	raw, err := marshalProviderContext(payload)
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: raw}, nil
}

// buildSortAtWindowOr is buildSortAtWindowOr: the five $or branches that treat
// sortAt as the event time, falling back to ingestedAt and then createdAt when
// sortAt is missing or null.
func buildSortAtWindowOr(start, end time.Time) bson.A {
	window := func() bson.D {
		return bson.D{
			{Key: "$gte", Value: start},
			{Key: "$lt", Value: end},
		}
	}
	missing := bson.D{{Key: "$exists", Value: false}}
	return bson.A{
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
	}
}

// sentimentEntityMatch is the `$elemMatch` entity condition.
func sentimentEntityMatch(entityName, entityType string, minEntityConfidence float64) bson.D {
	match := bson.D{
		{Key: "name", Value: entityName},
		{Key: "confidence", Value: bson.D{{Key: "$gte", Value: minEntityConfidence}}},
	}
	if entityType != "" {
		match = append(match, bson.E{Key: "type", Value: entityType})
	}
	return match
}

// buildSentimentWindowPipeline is computeWindowStats' aggregation: count the
// sentiment labels of the documents whose sortAt (or fallback) falls in the
// window and that mention the entity.
func buildSentimentWindowPipeline(orgID, entityName, entityType string, minEntityConfidence float64, start, end time.Time) mongo.Pipeline {
	return mongo.Pipeline{
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: sentimentProcessedItemStatusCompleted},
			{Key: "$or", Value: buildSortAtWindowOr(start, end)},
			{Key: "result.sentiment_label", Value: bson.D{
				{Key: "$exists", Value: true},
				{Key: "$ne", Value: nil},
			}},
			{Key: "result.entities", Value: bson.D{{Key: "$elemMatch",
				Value: sentimentEntityMatch(entityName, entityType, minEntityConfidence)}}},
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
}

// computeWindowStats runs the window aggregation with allowDiskUse(true).
func (p *sentimentProvider) computeWindowStats(ctx context.Context, orgID, entityName, entityType string, minEntityConfidence float64, start, end time.Time) (sentimentWindowStats, error) {
	if p.deps.Mongo == nil {
		return sentimentWindowStats{}, errors.New("alertworker/providers: entity sentiment: mongo is not configured")
	}
	cursor, err := p.deps.Mongo.Collection(sentimentProcessedItemsCollection).Aggregate(ctx,
		buildSentimentWindowPipeline(orgID, entityName, entityType, minEntityConfidence, start, end),
		options.Aggregate().SetAllowDiskUse(true),
	)
	if err != nil {
		return sentimentWindowStats{}, fmt.Errorf("alertworker/providers: entity sentiment aggregate: %w", err)
	}
	var rows []sentimentStatsRow
	if err := cursor.All(ctx, &rows); err != nil {
		return sentimentWindowStats{}, fmt.Errorf("alertworker/providers: entity sentiment decode: %w", err)
	}
	if len(rows) == 0 {
		return sentimentWindowStats{}, nil
	}
	return rows[0].stats(), nil
}

// fetchEvidence reads the negative documents of the window for the context.
func (p *sentimentProvider) fetchEvidence(ctx context.Context, orgID, entityName, entityType string, minEntityConfidence float64, start, end time.Time, limit int) ([]sentimentEvidence, error) {
	if p.deps.Mongo == nil {
		return nil, errors.New("alertworker/providers: entity sentiment: mongo is not configured")
	}
	cursor, err := p.deps.Mongo.Collection(sentimentProcessedItemsCollection).Find(ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "status", Value: sentimentProcessedItemStatusCompleted},
			{Key: "$or", Value: buildSortAtWindowOr(start, end)},
			// /^negative$/i: an inline case-insensitive regex.
			{Key: "result.sentiment_label", Value: bson.D{
				{Key: "$regex", Value: "^negative$"},
				{Key: "$options", Value: "i"},
			}},
			{Key: "result.entities", Value: bson.D{{Key: "$elemMatch",
				Value: sentimentEntityMatch(entityName, entityType, minEntityConfidence)}}},
		},
		options.Find().
			// _id is included by default, exactly like the Mongoose projection.
			SetProjection(bson.D{
				{Key: "itemMetaId", Value: 1},
				{Key: "createdAt", Value: 1},
				{Key: "ingestedAt", Value: 1},
				{Key: "result.title", Value: 1},
				{Key: "result.summary", Value: 1},
				{Key: "result.published_at", Value: 1},
				{Key: "result.source", Value: 1},
				{Key: "result.sentiment_label", Value: 1},
			}).
			SetSort(bson.D{
				{Key: "sortAt", Value: -1},
				{Key: "ingestedAt", Value: -1},
				{Key: "createdAt", Value: -1},
			}).
			SetLimit(int64(limit)),
	)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity sentiment evidence query: %w", err)
	}
	var docs []sentimentEvidenceDoc
	if err := cursor.All(ctx, &docs); err != nil {
		return nil, fmt.Errorf("alertworker/providers: entity sentiment evidence decode: %w", err)
	}
	evidence := make([]sentimentEvidence, 0, len(docs))
	for _, doc := range docs {
		evidence = append(evidence, sentimentEvidenceFromDoc(doc))
	}
	return evidence, nil
}

// sentimentEvidenceFromDoc maps one document; the untyped fields are guarded
// exactly like the NestJS mapper's typeof checks.
func sentimentEvidenceFromDoc(doc sentimentEvidenceDoc) sentimentEvidence {
	ingestedAt := sentimentDateValue(doc.IngestedAt)
	processedAt := sentimentDateValue(doc.CreatedAt)

	// createdAt = ingestedAt ?? processedAt ?? String(doc.createdAt ?? "").
	createdAt := ""
	switch {
	case ingestedAt != nil:
		createdAt = jsISOTimestamp(*ingestedAt)
	case processedAt != nil:
		createdAt = jsISOTimestamp(*processedAt)
	default:
		createdAt = sentimentJSString(doc.CreatedAt)
	}

	var ingestedAtPointer *string
	if ingestedAt != nil {
		text := jsISOTimestamp(*ingestedAt)
		ingestedAtPointer = &text
	}
	itemMetaID := ""
	if text, ok := doc.ItemMetaID.(string); ok {
		itemMetaID = text
	}
	return sentimentEvidence{
		ProcessedID:    sentimentIDString(doc.ID),
		ItemMetaID:     itemMetaID,
		CreatedAt:      createdAt,
		IngestedAt:     ingestedAtPointer,
		PublishedAt:    sentimentResultString(doc.Result, "published_at"),
		Title:          sentimentResultString(doc.Result, "title"),
		Source:         sentimentResultString(doc.Result, "source"),
		SentimentLabel: sentimentResultString(doc.Result, "sentiment_label"),
		Summary:        sentimentResultString(doc.Result, "summary"),
	}
}

// sentimentResultString reads one projected result field with the NestJS
// `typeof value === "string" ? value : null` guard. The driver decodes embedded
// documents into bson.D by default; bson.M is accepted for completeness.
func sentimentResultString(result any, key string) *string {
	switch document := result.(type) {
	case bson.D:
		for _, element := range document {
			if element.Key != key {
				continue
			}
			if text, ok := element.Value.(string); ok {
				return &text
			}
			return nil
		}
	case bson.M:
		if text, ok := document[key].(string); ok {
			return &text
		}
	}
	return nil
}

// sentimentDateValue is `value instanceof Date`: only BSON dates (decoded as
// time.Time or bson.DateTime) qualify.
func sentimentDateValue(value any) *time.Time {
	switch typed := value.(type) {
	case time.Time:
		date := typed
		return &date
	case bson.DateTime:
		date := typed.Time()
		return &date
	default:
		return nil
	}
}

// sentimentIDString is `doc._id.toString()`.
func sentimentIDString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case bson.ObjectID:
		return typed.Hex()
	case string:
		return typed
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// sentimentJSString is String(doc.createdAt ?? "") for the fallback branch.
func sentimentJSString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case time.Time:
		return jsISOTimestamp(typed)
	case bson.DateTime:
		return jsISOTimestamp(typed.Time())
	case float64:
		return fmt.Sprintf("%v", typed)
	case int32:
		return fmt.Sprintf("%v", typed)
	case int64:
		return fmt.Sprintf("%v", typed)
	case bool:
		return fmt.Sprintf("%v", typed)
	default:
		return ""
	}
}
