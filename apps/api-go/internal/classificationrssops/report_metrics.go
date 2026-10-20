package classificationrssops

import (
	"context"
	"sort"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Sample metrics for a quality report.
//
// O1: computeSampleMetrics in NestJS loads every annotation document of the
// organization (or of one sample) into memory and counts the raw pairs in
// JavaScript. The report worker instead groups by the two raw path values in
// Mongo and only normalizes/merges the (much smaller) result set in Go.
//
// The aggregation must be exactly equivalent, so normalization happens after
// grouping: two annotations whose raw paths differ only in case, surrounding
// whitespace or slashes collapse into one matrix cell with the summed count,
// which is what the row-by-row loop produces. The only observable difference is
// the ordering of two cells with the same count, which NestJS leaves in natural
// (insertion) order; the aggregation orders ties by the raw pair so the output
// is deterministic.

// annotationPairCount is one grouped (predicted, actual) pair of raw annotation
// path values with its total count.
type annotationPairCount struct {
	Predicted *string
	Actual    *string
	Count     int
}

// computeSampleMetricsAggregated mirrors computeSampleMetrics but reads the
// counts from a Mongo $group instead of loading every annotation.
func (s *Service) computeSampleMetricsAggregated(ctx context.Context, orgID string, sampleID *string) (sampleMetrics, error) {
	settings := s.qualitySettingsFor(ctx, orgID)
	counts, err := s.aggregateAnnotationPairCounts(ctx, orgID, sampleID)
	if err != nil {
		return sampleMetrics{}, err
	}
	return computeConfusionMetricsFromCounts(counts, settings), nil
}

// aggregateAnnotationPairCounts groups classificationannotations by the raw
// predicted and human category paths.
func (s *Service) aggregateAnnotationPairCounts(ctx context.Context, orgID string, sampleID *string) ([]annotationPairCount, error) {
	collection, err := s.collection(annotationsCollection)
	if err != nil {
		return nil, err
	}
	match := bson.D{{Key: "orgId", Value: orgID}}
	if sampleID != nil {
		match = append(match, bson.E{Key: "sampleId", Value: *sampleID})
	}
	pipeline := mongo.Pipeline{
		bson.D{{Key: "$match", Value: match}},
		bson.D{{Key: "$group", Value: bson.D{
			{Key: "_id", Value: bson.D{
				{Key: "predicted", Value: "$predictedCategoryPath"},
				{Key: "actual", Value: "$humanCategoryPath"},
			}},
			{Key: "count", Value: bson.D{{Key: "$sum", Value: 1}}},
		}}},
		// Deterministic order for the merge step: highest count first, then the
		// raw values. The count ordering survives the merge, so the final
		// matrix keeps the same "count descending" order NestJS sorts into.
		bson.D{{Key: "$sort", Value: bson.D{
			{Key: "count", Value: -1},
			{Key: "_id.predicted", Value: 1},
			{Key: "_id.actual", Value: 1},
		}}},
	}
	cursor, err := collection.Aggregate(ctx, pipeline)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID struct {
			Predicted bson.RawValue `bson:"predicted"`
			Actual    bson.RawValue `bson:"actual"`
		} `bson:"_id"`
		Count int `bson:"count"`
	}
	if err := cursor.All(ctx, &rows); err != nil {
		return nil, err
	}
	counts := make([]annotationPairCount, 0, len(rows))
	for _, row := range rows {
		counts = append(counts, annotationPairCount{
			Predicted: rawString(row.ID.Predicted),
			Actual:    rawString(row.ID.Actual),
			Count:     row.Count,
		})
	}
	return counts, nil
}

// confusionAccumulator counts normalized confusion cells. Both the per-row and
// the aggregated input funnel through it so the metric half is shared.
type confusionAccumulator struct {
	order   []string
	counts  map[string]int
	total   int
	correct int
}

func newConfusionAccumulator(capacity int) *confusionAccumulator {
	return &confusionAccumulator{
		order:  make([]string, 0, capacity),
		counts: make(map[string]int, capacity),
	}
}

// add merges one (predicted, actual) pair with the given weight. Empty or
// blank paths become the literal "unknown", exactly like normalizePath ?? "unknown".
func (a *confusionAccumulator) add(predicted, actual *string, weight int) {
	predictedPath := "unknown"
	if normalized := normalizePath(derefString(predicted)); normalized != nil {
		predictedPath = *normalized
	}
	actualPath := "unknown"
	if normalized := normalizePath(derefString(actual)); normalized != nil {
		actualPath = *normalized
	}
	key := predictedPath + "=>" + actualPath
	if _, ok := a.counts[key]; !ok {
		a.order = append(a.order, key)
	}
	a.counts[key] += weight
	a.total += weight
	if predictedPath == actualPath {
		a.correct += weight
	}
}

// metrics builds the same sampleMetrics computeSampleMetrics returns.
func (a *confusionAccumulator) metrics(settings qualitySettings) sampleMetrics {
	confusionMatrix := make([]confusionEntry, 0, len(a.order))
	for _, key := range a.order {
		predicted, actual := splitConfusionKey(key)
		confusionMatrix = append(confusionMatrix, confusionEntry{
			PredictedPath: predicted,
			ActualPath:    actual,
			Count:         a.counts[key],
		})
	}
	sort.SliceStable(confusionMatrix, func(left, right int) bool {
		return confusionMatrix[left].Count > confusionMatrix[right].Count
	})

	problemPathPairs := make([]problemPathPair, 0, len(confusionMatrix))
	for _, entry := range confusionMatrix {
		if entry.PredictedPath == entry.ActualPath {
			continue
		}
		errorRate := ratio4(float64(entry.Count), float64(a.total), 0)
		if entry.Count < settings.ReportMinPairCount || errorRate < settings.ReportMinPairErrorRate {
			continue
		}
		problemPathPairs = append(problemPathPairs, problemPathPair{
			PredictedPath: entry.PredictedPath,
			ActualPath:    entry.ActualPath,
			Count:         entry.Count,
			ErrorRate:     errorRate,
		})
	}
	sort.SliceStable(problemPathPairs, func(left, right int) bool {
		return problemPathPairs[left].Count > problemPathPairs[right].Count
	})
	if len(problemPathPairs) > 50 {
		problemPathPairs = problemPathPairs[:50]
	}

	return sampleMetrics{
		Total:            a.total,
		Correct:          a.correct,
		Accuracy:         ratio4(float64(a.correct), float64(a.total), 0),
		ConfusionMatrix:  confusionMatrix,
		ProblemPathPairs: problemPathPairs,
	}
}

// computeConfusionMetricsFromCounts is the metric half of the aggregation path:
// merge the grouped raw pairs by their normalized paths, then compute.
func computeConfusionMetricsFromCounts(counts []annotationPairCount, settings qualitySettings) sampleMetrics {
	accumulator := newConfusionAccumulator(len(counts))
	for _, count := range counts {
		accumulator.add(count.Predicted, count.Actual, count.Count)
	}
	return accumulator.metrics(settings)
}
