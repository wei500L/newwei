package knowledgereview

import (
	"database/sql"
	"testing"
	"time"
)

func TestAggregateActiveEvidence(t *testing.T) {
	first := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	middle := first.Add(time.Hour)
	last := middle.Add(time.Hour)

	weight, confidence, firstSeenAt, lastSeenAt := aggregateActiveEvidence([]activeEvidenceRow{
		{confidence: sql.NullFloat64{Float64: 0.2, Valid: true}, createdAt: first},
		{confidence: sql.NullFloat64{Valid: false}, createdAt: middle},
		{confidence: sql.NullFloat64{Float64: 1.4, Valid: true}, createdAt: last},
	})

	if weight != 3 {
		t.Fatalf("weight = %d", weight)
	}
	// 0.2 stays 0.2, a missing value becomes 0.5 and 1.4 clamps to 1.0.
	want := (0.2 + 0.5 + 1.0) / 3
	if confidence < want-1e-9 || confidence > want+1e-9 {
		t.Fatalf("confidence = %v want %v", confidence, want)
	}
	if !firstSeenAt.Equal(first) || !lastSeenAt.Equal(last) {
		t.Fatalf("seen window = %v..%v", firstSeenAt, lastSeenAt)
	}
}

func TestAggregateActiveEvidenceKeepsZeroConfidence(t *testing.T) {
	created := time.Date(2026, 10, 1, 10, 0, 0, 0, time.UTC)
	weight, confidence, _, _ := aggregateActiveEvidence([]activeEvidenceRow{
		{confidence: sql.NullFloat64{Float64: 0, Valid: true}, createdAt: created},
		{confidence: sql.NullFloat64{Float64: 0, Valid: true}, createdAt: created},
	})
	if weight != 2 || confidence != 0 {
		t.Fatalf("zero confidence must not fall back to 0.5: weight=%d confidence=%v", weight, confidence)
	}
}

func TestConfidenceOrDefault(t *testing.T) {
	if got := confidenceOrDefault(0, false); got != 0.5 {
		t.Fatalf("missing = %v", got)
	}
	if got := confidenceOrDefault(-2, true); got != 0 {
		t.Fatalf("negative = %v", got)
	}
	if got := confidenceOrDefault(3, true); got != 1 {
		t.Fatalf("above one = %v", got)
	}
	if got := confidenceOrDefault(0, true); got != 0 {
		t.Fatalf("zero = %v", got)
	}
}
