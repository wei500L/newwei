package platformgovernance

import (
	"context"
	"math"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// AssistantSafetyMetricsRow is one day of the GET
// /api/system-settings/assistant-safety/metrics response.
type AssistantSafetyMetricsRow struct {
	Date        string                      `json:"date"`
	TotalRuns   int64                       `json:"totalRuns"`
	BlockedRuns int64                       `json:"blockedRuns"`
	BlockedRate float64                     `json:"blockedRate"`
	Guardrails  []AssistantSafetyCountEntry `json:"guardrails"`
	Codes       []AssistantSafetyCodeEntry  `json:"codes"`
}

// AssistantSafetyCountEntry is one guardrail bucket.
type AssistantSafetyCountEntry struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

// AssistantSafetyCodeEntry is one blocked-code bucket.
type AssistantSafetyCodeEntry struct {
	Code  string `json:"code"`
	Count int64  `json:"count"`
}

// safetyMetricsTotalRow is one totals facet document.
type safetyMetricsTotalRow struct {
	Date        string `bson:"_id"`
	TotalRuns   int64  `bson:"totalRuns"`
	BlockedRuns int64  `bson:"blockedRuns"`
}

// safetyMetricsGuardrailRow is one guardrails facet document.
type safetyMetricsGuardrailRow struct {
	Date       string                      `bson:"_id"`
	Guardrails []AssistantSafetyCountEntry `bson:"guardrails"`
}

// safetyMetricsCodeRow is one codes facet document.
type safetyMetricsCodeRow struct {
	Date  string                     `bson:"_id"`
	Codes []AssistantSafetyCodeEntry `bson:"codes"`
}

// safetyMetricsFacet is the single document the $facet stage emits.
type safetyMetricsFacet struct {
	Totals     []safetyMetricsTotalRow     `bson:"totals"`
	Guardrails []safetyMetricsGuardrailRow `bson:"guardrails"`
	Codes      []safetyMetricsCodeRow      `bson:"codes"`
}

// assistantSafetyMetrics runs the assistant-safety daily metrics aggregation for
// the caller's org and pads the result to one row per day in the window.
//
// windowDays is computed exactly like AssistantSafetyMetricsService:
// max(1, min(90, floor(days))).
func (s *Service) assistantSafetyMetrics(ctx context.Context, orgID string, days float64) ([]AssistantSafetyMetricsRow, error) {
	collection := s.mongoCollection(collectionAssistantRuns)
	if collection == nil {
		return nil, errNoMongo
	}

	windowDays := safetyMetricsWindowDays(days)
	start := safetyMetricsWindowStart(time.Now().UTC(), windowDays)

	// dateExpr formats each document's createdAt as YYYY-MM-DD in UTC, exactly
	// like the NestJS $dateToString expression (which defaults to UTC).
	dateExpr := bson.D{{Key: "$dateToString", Value: bson.D{
		{Key: "format", Value: "%Y-%m-%d"},
		{Key: "date", Value: "$createdAt"},
	}}}

	pipeline := bson.A{
		// The orgId filter is mandatory: the metrics must never aggregate
		// another tenant's assistant runs.
		bson.D{{Key: "$match", Value: bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "createdAt", Value: bson.D{{Key: "$gte", Value: start}}},
		}}},
		bson.D{{Key: "$addFields", Value: bson.D{{Key: "date", Value: dateExpr}}}},
		bson.D{{Key: "$facet", Value: bson.D{
			{Key: "totals", Value: bson.A{
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$date"},
					{Key: "totalRuns", Value: bson.D{{Key: "$sum", Value: 1}}},
					{Key: "blockedRuns", Value: bson.D{{Key: "$sum", Value: bson.D{
						{Key: "$cond", Value: bson.A{
							bson.D{{Key: "$eq", Value: bson.A{"$output.blocked", true}}},
							1,
							0,
						}},
					}}}},
				}}},
				bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
			}},
			{Key: "guardrails", Value: bson.A{
				bson.D{{Key: "$match", Value: bson.D{{Key: "output.blocked", Value: true}}}},
				bson.D{{Key: "$match", Value: bson.D{{Key: "output.appliedGuardrails", Value: bson.D{
					{Key: "$type", Value: "array"},
				}}}}},
				bson.D{{Key: "$addFields", Value: bson.D{{Key: "date", Value: dateExpr}}}},
				bson.D{{Key: "$unwind", Value: "$output.appliedGuardrails"}},
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: bson.D{
						{Key: "date", Value: "$date"},
						{Key: "name", Value: "$output.appliedGuardrails"},
					}},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$_id.date"},
					{Key: "guardrails", Value: bson.D{{Key: "$push", Value: bson.D{
						{Key: "name", Value: "$_id.name"},
						{Key: "count", Value: "$count"},
					}}}},
				}}},
				bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
			}},
			{Key: "codes", Value: bson.A{
				bson.D{{Key: "$match", Value: bson.D{{Key: "output.blocked", Value: true}}}},
				bson.D{{Key: "$match", Value: bson.D{{Key: "output.code", Value: bson.D{
					{Key: "$type", Value: "string"},
				}}}}},
				bson.D{{Key: "$addFields", Value: bson.D{{Key: "date", Value: dateExpr}}}},
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: bson.D{
						{Key: "date", Value: "$date"},
						{Key: "code", Value: "$output.code"},
					}},
					{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
				}}},
				bson.D{{Key: "$group", Value: bson.D{
					{Key: "_id", Value: "$_id.date"},
					{Key: "codes", Value: bson.D{{Key: "$push", Value: bson.D{
						{Key: "code", Value: "$_id.code"},
						{Key: "count", Value: "$count"},
					}}}},
				}}},
				bson.D{{Key: "$sort", Value: bson.D{{Key: "_id", Value: 1}}}},
			}},
		}}},
	}

	cursor, err := collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = cursor.Close(ctx)
	}()
	var facets []safetyMetricsFacet
	if err := cursor.All(ctx, &facets); err != nil {
		return nil, err
	}
	var facet safetyMetricsFacet
	if len(facets) > 0 {
		facet = facets[0]
	}
	return padSafetyMetricsRows(facet, start, windowDays), nil
}

// safetyMetricsWindowDays mirrors AssistantSafetyMetricsService:
// max(1, min(90, floor(days))). A non-finite day count keeps the 14 day default
// the controller substitutes.
func safetyMetricsWindowDays(days float64) int {
	if math.IsNaN(days) || math.IsInf(days, 0) {
		return 14
	}
	return int(math.Max(1, math.Min(90, math.Floor(days))))
}

// safetyMetricsWindowStart returns the first day of the window: today's UTC
// midnight moved back windowDays-1 days.
func safetyMetricsWindowStart(now time.Time, windowDays int) time.Time {
	start := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return start.AddDate(0, 0, -(windowDays - 1))
}

// padSafetyMetricsRows turns the $facet result into exactly windowDays rows, one
// per UTC day in order. Days without data report zero counts and empty arrays,
// and entries with an empty guardrail name or code are dropped.
func padSafetyMetricsRows(facet safetyMetricsFacet, start time.Time, windowDays int) []AssistantSafetyMetricsRow {
	out := make([]AssistantSafetyMetricsRow, 0, windowDays)
	for offset := 0; offset < windowDays; offset++ {
		day := start.AddDate(0, 0, offset)
		key := day.Format("2006-01-02")

		var counts safetyMetricsTotalRow
		for _, row := range facet.Totals {
			if row.Date == key {
				counts = row
				break
			}
		}

		dayGuardrails := []AssistantSafetyCountEntry{}
		for _, row := range facet.Guardrails {
			if row.Date != key {
				continue
			}
			for _, entry := range row.Guardrails {
				// Empty names are dropped, exactly like the NestJS mapper.
				if entry.Name == "" {
					continue
				}
				dayGuardrails = append(dayGuardrails, entry)
			}
			break
		}

		dayCodes := []AssistantSafetyCodeEntry{}
		for _, row := range facet.Codes {
			if row.Date != key {
				continue
			}
			for _, entry := range row.Codes {
				if entry.Code == "" {
					continue
				}
				dayCodes = append(dayCodes, entry)
			}
			break
		}

		blockedRate := 0.0
		if counts.TotalRuns > 0 {
			blockedRate = float64(counts.BlockedRuns) / float64(counts.TotalRuns)
		}
		out = append(out, AssistantSafetyMetricsRow{
			Date:        key,
			TotalRuns:   counts.TotalRuns,
			BlockedRuns: counts.BlockedRuns,
			BlockedRate: blockedRate,
			Guardrails:  dayGuardrails,
			Codes:       dayCodes,
		})
	}
	return out
}
