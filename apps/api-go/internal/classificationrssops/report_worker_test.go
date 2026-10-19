package classificationrssops

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

// TestParseQualityJobDispatch locks the processor dispatch contract: review
// seeds need jobType == "review_seed_item" plus orgId and processedItemId, the
// report branch also accepts old payloads without jobType, and anything else is
// skipped instead of failing the job.
func TestParseQualityJobDispatch(t *testing.T) {
	cases := []struct {
		name     string
		payload  string
		wantOK   bool
		wantKind qualityJobKind
		wantOrg  string
		wantID   string
	}{
		{
			name:     "report",
			payload:  `{"jobType":"report","orgId":"org-1","reportJobId":"job-1","traceId":"trace-1"}`,
			wantOK:   true,
			wantKind: qualityJobReport,
			wantOrg:  "org-1",
			wantID:   "job-1",
		},
		{
			name:     "legacy report without jobType",
			payload:  `{"orgId":"org-2","reportJobId":"job-2"}`,
			wantOK:   true,
			wantKind: qualityJobReport,
			wantOrg:  "org-2",
			wantID:   "job-2",
		},
		{
			name:     "review seed",
			payload:  `{"jobType":"review_seed_item","orgId":"org-3","processedItemId":"pid-3","traceId":"trace-3"}`,
			wantOK:   true,
			wantKind: qualityJobReviewSeed,
			wantOrg:  "org-3",
			wantID:   "pid-3",
		},
		{
			name:     "review seed without processedItemId falls back to report",
			payload:  `{"jobType":"review_seed_item","orgId":"org-4","reportJobId":"job-4"}`,
			wantOK:   true,
			wantKind: qualityJobReport,
			wantOrg:  "org-4",
			wantID:   "job-4",
		},
		{
			name:     "blank values are trimmed and skipped",
			payload:  `{"jobType":"report","orgId":"   ","reportJobId":"job-5"}`,
			wantOK:   false,
			wantKind: qualityJobSkip,
		},
		{
			name:     "non-string orgId is skipped",
			payload:  `{"jobType":"report","orgId":7,"reportJobId":"job-6"}`,
			wantOK:   false,
			wantKind: qualityJobSkip,
		},
		{
			name:     "missing both ids is skipped",
			payload:  `{}`,
			wantOK:   false,
			wantKind: qualityJobSkip,
		},
		{
			name:     "invalid json is skipped",
			payload:  `not json`,
			wantOK:   false,
			wantKind: qualityJobSkip,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dispatch, ok := parseQualityJob(json.RawMessage(tc.payload))
			if ok != tc.wantOK {
				t.Fatalf("ok = %t, want %t", ok, tc.wantOK)
			}
			if dispatch.Kind != tc.wantKind {
				t.Fatalf("kind = %d, want %d", dispatch.Kind, tc.wantKind)
			}
			if tc.wantKind == qualityJobReport && dispatch.ReportJobID != tc.wantID {
				t.Fatalf("reportJobId = %q, want %q", dispatch.ReportJobID, tc.wantID)
			}
			if tc.wantKind == qualityJobReviewSeed && dispatch.ProcessedItemID != tc.wantID {
				t.Fatalf("processedItemId = %q, want %q", dispatch.ProcessedItemID, tc.wantID)
			}
			if tc.wantOrg != "" && dispatch.OrgID != tc.wantOrg {
				t.Fatalf("orgId = %q, want %q", dispatch.OrgID, tc.wantOrg)
			}
		})
	}
}

// TestShouldSeedReview locks the gate comparison: a missing confidence never
// seeds, and the threshold itself is inclusive on the "no review" side.
func TestShouldSeedReview(t *testing.T) {
	below := 0.39
	equal := 0.4
	above := 0.41
	if shouldSeedReview(nil, 0.4) {
		t.Fatal("nil confidence must not seed a review")
	}
	if !shouldSeedReview(&below, 0.4) {
		t.Fatal("confidence below the gate must seed a review")
	}
	if shouldSeedReview(&equal, 0.4) {
		t.Fatal("confidence equal to the gate must not seed a review")
	}
	if shouldSeedReview(&above, 0.4) {
		t.Fatal("confidence above the gate must not seed a review")
	}
}

// TestAggregatedMetricsMatchRowByRow is the O1 equivalence proof: grouping the
// raw annotation paths first and normalizing afterwards must produce the same
// totals, accuracy, matrix and problem pairs as the row-by-row loop, including
// case, whitespace, slash and empty-value collapsing.
func TestAggregatedMetricsMatchRowByRow(t *testing.T) {
	path := func(value string) *string { return &value }
	pairs := []confusionPair{
		// Four spellings of one category path collapse into a single cell.
		{Predicted: path(" Tech/AI "), Actual: path("tech/ai")},
		{Predicted: path("tech/ai"), Actual: path("TECH/AI")},
		{Predicted: path("/tech/ai/"), Actual: path(" tech/ai ")},
		{Predicted: path("tech/ai"), Actual: path("finance")},
		{Predicted: path("finance"), Actual: path("tech/ai")},
		{Predicted: path("Finance"), Actual: path("finance")},
		{Predicted: path(""), Actual: path("finance")},
		{Predicted: nil, Actual: path("")},
		{Predicted: path("//"), Actual: path("   ")},
		{Predicted: path("unknown"), Actual: path("unknown")},
		{Predicted: path("sports"), Actual: path("sports")},
	}
	settings := qualitySettings{ReportMinPairCount: 1, ReportMinPairErrorRate: 0.09}

	rowByRow := computeConfusionMetrics(pairs, settings)

	// Reproduce the $group stage: unique raw pairs with their counts.
	type rawPair struct{ predicted, actual *string }
	order := make([]rawPair, 0, len(pairs))
	counts := make(map[string]int, len(pairs))
	for _, pair := range pairs {
		key := derefString(pair.Predicted) + "\x00" + derefString(pair.Actual)
		if _, ok := counts[key]; !ok {
			order = append(order, pair)
		}
		counts[key]++
	}
	aggregatedInput := make([]annotationPairCount, 0, len(order))
	for _, pair := range order {
		key := derefString(pair.Predicted) + "\x00" + derefString(pair.Actual)
		aggregatedInput = append(aggregatedInput, annotationPairCount{
			Predicted: pair.Predicted,
			Actual:    pair.Actual,
			Count:     counts[key],
		})
	}
	aggregated := computeConfusionMetricsFromCounts(aggregatedInput, settings)

	if rowByRow.Total != aggregated.Total || rowByRow.Correct != aggregated.Correct || rowByRow.Accuracy != aggregated.Accuracy {
		t.Fatalf("row=%d/%d/%v aggregated=%d/%d/%v",
			rowByRow.Total, rowByRow.Correct, rowByRow.Accuracy,
			aggregated.Total, aggregated.Correct, aggregated.Accuracy)
	}
	if aggregated.Total != len(pairs) {
		t.Fatalf("total = %d, want %d", aggregated.Total, len(pairs))
	}
	if aggregated.Correct != 8 {
		t.Fatalf("correct = %d, want 8", aggregated.Correct)
	}
	// Three rows that normalize to tech/ai => tech/ai must merge into one cell.
	if cell := confusionCell(aggregated.ConfusionMatrix, "tech/ai", "tech/ai"); cell != 3 {
		t.Fatalf("tech/ai => tech/ai = %d, want 3 (matrix %+v)", cell, aggregated.ConfusionMatrix)
	}
	// Empty, blank and "unknown" predicted values all land in "unknown".
	if cell := confusionCell(aggregated.ConfusionMatrix, "unknown", "unknown"); cell != 3 {
		t.Fatalf("unknown => unknown = %d, want 3 (matrix %+v)", cell, aggregated.ConfusionMatrix)
	}
	if len(aggregated.ProblemPathPairs) != 3 {
		t.Fatalf("problem pairs = %+v, want 3", aggregated.ProblemPathPairs)
	}

	// The aggregate path sorts by count first, so only the cell content (not the
	// tie order) is contractual.
	if !reflect.DeepEqual(sortedConfusion(rowByRow.ConfusionMatrix), sortedConfusion(aggregated.ConfusionMatrix)) {
		t.Fatalf("confusion matrix mismatch:\nrow=%+v\nagg=%+v", rowByRow.ConfusionMatrix, aggregated.ConfusionMatrix)
	}
	if !reflect.DeepEqual(sortedProblem(rowByRow.ProblemPathPairs), sortedProblem(aggregated.ProblemPathPairs)) {
		t.Fatalf("problem pairs mismatch:\nrow=%+v\nagg=%+v", rowByRow.ProblemPathPairs, aggregated.ProblemPathPairs)
	}
	if !sort.SliceIsSorted(aggregated.ConfusionMatrix, func(i, j int) bool {
		return aggregated.ConfusionMatrix[i].Count > aggregated.ConfusionMatrix[j].Count
	}) {
		t.Fatal("confusion matrix must be sorted by count descending")
	}
	if diff := aggregated.Accuracy - 0.7273; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("accuracy = %v, want 0.7273", aggregated.Accuracy)
	}
}

// confusionCell sums the counts of one matrix cell.
func confusionCell(matrix []confusionEntry, predicted, actual string) int {
	for _, entry := range matrix {
		if entry.PredictedPath == predicted && entry.ActualPath == actual {
			return entry.Count
		}
	}
	return 0
}

// TestAggregatedMetricsThresholdBoundary covers count and errorRate equality on
// both thresholds: both filters are >=.
func TestAggregatedMetricsThresholdBoundary(t *testing.T) {
	path := func(value string) *string { return &value }
	counts := []annotationPairCount{
		// count 3 with errorRate 0.3 -> passes both thresholds
		{Predicted: path("a"), Actual: path("b"), Count: 3},
		// count 2 with errorRate 0.2 -> fails count, would pass rate
		{Predicted: path("a"), Actual: path("c"), Count: 2},
		// count 4 with errorRate 0.4 -> passes both
		{Predicted: path("d"), Actual: path("e"), Count: 4},
		// correct cells are never problem pairs
		{Predicted: path("x"), Actual: path("x"), Count: 1},
	}
	settings := qualitySettings{ReportMinPairCount: 3, ReportMinPairErrorRate: 0.2}
	metrics := computeConfusionMetricsFromCounts(counts, settings)
	if metrics.Total != 10 {
		t.Fatalf("total = %d, want 10", metrics.Total)
	}
	if len(metrics.ProblemPathPairs) != 2 {
		t.Fatalf("problem pairs = %+v, want 2 entries", metrics.ProblemPathPairs)
	}
	if metrics.ProblemPathPairs[0].PredictedPath != "d" || metrics.ProblemPathPairs[0].Count != 4 {
		t.Fatalf("first problem pair = %+v", metrics.ProblemPathPairs[0])
	}

	// An empty input keeps the NestJS shape: zeroed scalars and empty slices.
	empty := computeConfusionMetricsFromCounts(nil, settings)
	if empty.Total != 0 || empty.Correct != 0 || empty.Accuracy != 0 {
		t.Fatalf("empty metrics = %+v", empty)
	}
	if empty.ConfusionMatrix == nil || empty.ProblemPathPairs == nil {
		t.Fatalf("empty metrics must serialize empty arrays, got %+v", empty)
	}
}

func sortedConfusion(entries []confusionEntry) []confusionEntry {
	out := append([]confusionEntry(nil), entries...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].PredictedPath != out[j].PredictedPath {
			return out[i].PredictedPath < out[j].PredictedPath
		}
		return out[i].ActualPath < out[j].ActualPath
	})
	return out
}

func sortedProblem(entries []problemPathPair) []problemPathPair {
	out := append([]problemPathPair(nil), entries...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].PredictedPath != out[j].PredictedPath {
			return out[i].PredictedPath < out[j].PredictedPath
		}
		return out[i].ActualPath < out[j].ActualPath
	})
	return out
}
