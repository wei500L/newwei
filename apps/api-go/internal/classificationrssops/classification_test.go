package classificationrssops

import "testing"

// TestComputeConfusionMetrics pins the confusion matrix, the accuracy and the
// problem-pair thresholds used by the sampling annotations endpoint.
func TestComputeConfusionMetrics(t *testing.T) {
	settings := defaultQualitySettings()
	settings.ReportMinPairCount = 1
	settings.ReportMinPairErrorRate = 0.2
	pairs := []confusionPair{
		{Predicted: strPtr("tech/ai"), Actual: strPtr("tech/ai")},
		{Predicted: strPtr("tech/ai"), Actual: strPtr("tech/ai")},
		{Predicted: strPtr("tech/ai"), Actual: strPtr("sports/football")},
		{Predicted: strPtr("sports/football"), Actual: strPtr("tech/ai")},
		{Predicted: strPtr("///"), Actual: strPtr("finance/markets")},
	}
	metrics := computeConfusionMetrics(pairs, settings)
	if metrics.Total != 5 {
		t.Fatalf("total = %d, want 5", metrics.Total)
	}
	if metrics.Correct != 2 {
		t.Fatalf("correct = %d, want 2", metrics.Correct)
	}
	if metrics.Accuracy != 0.4 {
		t.Fatalf("accuracy = %v, want 0.4", metrics.Accuracy)
	}
	if len(metrics.ConfusionMatrix) != 4 {
		t.Fatalf("confusion matrix = %#v", metrics.ConfusionMatrix)
	}
	if metrics.ConfusionMatrix[0].PredictedPath != "tech/ai" ||
		metrics.ConfusionMatrix[0].ActualPath != "tech/ai" ||
		metrics.ConfusionMatrix[0].Count != 2 {
		t.Fatalf("first cell = %#v", metrics.ConfusionMatrix[0])
	}
	// Equal-count pairs keep their confusion-matrix insertion order, so the
	// slash-only predicted path (normalized to "unknown") is the last one.
	if len(metrics.ProblemPathPairs) != 3 {
		t.Fatalf("problem pairs = %#v", metrics.ProblemPathPairs)
	}
	problem := metrics.ProblemPathPairs[2]
	if problem.PredictedPath != "unknown" || problem.ActualPath != "finance/markets" {
		t.Fatalf("problem pair = %#v", problem)
	}
	if problem.Count != 1 || problem.ErrorRate != 0.2 {
		t.Fatalf("problem pair numbers = %#v", problem)
	}
}

// TestComputeConfusionMetricsEmpty pins the zero-denominator fallbacks.
func TestComputeConfusionMetricsEmpty(t *testing.T) {
	metrics := computeConfusionMetrics(nil, defaultQualitySettings())
	if metrics.Total != 0 || metrics.Correct != 0 || metrics.Accuracy != 0 {
		t.Fatalf("empty metrics = %#v", metrics)
	}
	if metrics.ConfusionMatrix == nil || metrics.ProblemPathPairs == nil {
		t.Fatalf("empty metrics must serialize as empty arrays: %#v", metrics)
	}
}

// TestComputeConfusionMetricsThresholds pins both problem-pair thresholds.
func TestComputeConfusionMetricsThresholds(t *testing.T) {
	settings := defaultQualitySettings()
	settings.ReportMinPairCount = 3
	settings.ReportMinPairErrorRate = 0.5
	pairs := []confusionPair{
		{Predicted: strPtr("a"), Actual: strPtr("b")},
		{Predicted: strPtr("a"), Actual: strPtr("b")},
		{Predicted: strPtr("c"), Actual: strPtr("d")},
		{Predicted: strPtr("c"), Actual: strPtr("d")},
		{Predicted: strPtr("c"), Actual: strPtr("d")},
		{Predicted: strPtr("e"), Actual: strPtr("e")},
	}
	metrics := computeConfusionMetrics(pairs, settings)
	// "a=>b" has count 2 (< 3) and "c=>d" has count 3 but an error rate of 0.5
	// which passes; only the second pair qualifies.
	if len(metrics.ProblemPathPairs) != 1 {
		t.Fatalf("problem pairs = %#v", metrics.ProblemPathPairs)
	}
	if metrics.ProblemPathPairs[0].PredictedPath != "c" || metrics.ProblemPathPairs[0].Count != 3 {
		t.Fatalf("problem pair = %#v", metrics.ProblemPathPairs[0])
	}
	if metrics.ProblemPathPairs[0].ErrorRate != 0.5 {
		t.Fatalf("error rate = %v", metrics.ProblemPathPairs[0].ErrorRate)
	}
}

// TestCorrectedCategoryPathValidation pins the defect-2 fix: a corrected verdict
// without a usable path is a 400 and never reaches Mongo.
func TestCorrectedCategoryPathValidation(t *testing.T) {
	normalized, err := correctedCategoryPath(ReviewDecisionCorrected, strPtr("  Tech//AI/ "))
	if err != nil || normalized == nil || *normalized != "tech/ai" {
		t.Fatalf("normalized corrected path = %v (%v)", normalized, err)
	}
	for _, raw := range []string{"", "///", "  "} {
		_, err := correctedCategoryPath(ReviewDecisionCorrected, strPtr(raw))
		status, message, ok := statusOf(err)
		if !ok || status != 400 {
			t.Fatalf("corrected path %q error = %v", raw, err)
		}
		if message != "correctedCategoryPath is required when status=corrected" {
			t.Fatalf("corrected path %q message = %q", raw, message)
		}
	}
	if _, err := correctedCategoryPath(ReviewDecisionCorrected, nil); err == nil {
		t.Fatalf("missing corrected path must be rejected")
	}
	// Approved and rejected verdicts always clear the stored path.
	for _, status := range []ReviewDecisionStatus{ReviewDecisionApproved, ReviewDecisionRejected} {
		normalized, err := correctedCategoryPath(status, strPtr("tech/ai"))
		if err != nil || normalized != nil {
			t.Fatalf("%s path = %v (%v)", status, normalized, err)
		}
	}
}

// TestSplitConfusionKey pins the NestJS destructuring of key.split("=>").
func TestSplitConfusionKey(t *testing.T) {
	predicted, actual := splitConfusionKey("a=>b=>c")
	if predicted != "a" || actual != "b" {
		t.Fatalf("split = %q/%q", predicted, actual)
	}
	predicted, actual = splitConfusionKey("a")
	if predicted != "a" || actual != "" {
		t.Fatalf("single part = %q/%q", predicted, actual)
	}
}

// TestAuditActorIDNormalization pins defect 4: machine tokens must not be written
// into the AuditLog.actorId foreign key.
func TestAuditActorIDNormalization(t *testing.T) {
	if got := auditActorID("machine:tok-1"); got != "" {
		t.Fatalf("machine actor = %q, want empty", got)
	}
	if got := auditActorID("user-1"); got != "user-1" {
		t.Fatalf("human actor = %q", got)
	}
}
