package itemsreading

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/llmembed"
	"github.com/wei500L/newwei/apps/api-go/internal/metrics"
)

// vectorFailureCount returns the integration_events_total value of the vector
// failure series, so a test can assert an exact delta on the shared registry.
func vectorFailureCount(t *testing.T) float64 {
	t.Helper()
	for _, line := range strings.Split(metrics.Render(), "\n") {
		if !strings.HasPrefix(line, "integration_events_total{") {
			continue
		}
		if !strings.Contains(line, `integration="vector"`) ||
			!strings.Contains(line, `operation="items_vector_search"`) ||
			!strings.Contains(line, `status="failure"`) {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			t.Fatalf("unexpected exposition line %q", line)
		}
		value, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			t.Fatalf("parse %q: %v", line, err)
		}
		return value
	}
	return 0
}

// TestVectorRecallRecordsTheFailureEvent drives the real RecallIDs entry point over
// an embedder that cannot resolve a profile (no MySQL), which makes the loader fail
// the way an unavailable model or vector service does. The production path must record
// exactly one vector failure sample and still degrade to empty candidates.
func TestVectorRecallRecordsTheFailureEvent(t *testing.T) {
	recall := &vectorRecall{
		// A client with no database cannot resolve the embedding profile, so Embed
		// returns errEmbeddingUnavailable and the loader fails.
		embedder: llmembed.NewClient(nil),
	}
	before := vectorFailureCount(t)
	for _, query := range []string{"climate policy outlook", "supply chain disruption"} {
		ids, err := recall.RecallIDs(context.Background(), "org-1", query)
		if err != nil {
			t.Fatalf("RecallIDs(%q) = %v, want a degraded empty result", query, err)
		}
		if len(ids) != 0 {
			t.Fatalf("RecallIDs(%q) = %v, want empty", query, ids)
		}
	}
	after := vectorFailureCount(t)
	if after != before+2 {
		t.Fatalf("vector failure counter went %v -> %v, want exactly two samples", before, after)
	}
}

// TestVectorHardFailRecordsBeforeSurfacingItsTypedError proves the hard-fail branch
// is recorded as well: NestJS throws its ServiceUnavailableException inside the
// loader, so it reaches the same recording catch.
func TestVectorHardFailRecordsBeforeSurfacingItsTypedError(t *testing.T) {
	recall := &vectorRecall{
		embedder: llmembed.NewClient(nil),
		hardFail: true,
	}
	before := vectorFailureCount(t)
	_, err := recall.RecallIDs(context.Background(), "org-1", "a query long enough to run")
	var unavailable *ItemVectorUnavailableError
	if !errors.As(err, &unavailable) {
		t.Fatalf("error = %v, want *ItemVectorUnavailableError", err)
	}
	if after := vectorFailureCount(t); after != before+1 {
		t.Fatalf("a hard-fail recall recorded %v -> %v, want one sample", before, after)
	}
}

// TestVectorSkipPathsRecordNothing proves the two early returns record no event: a
// recall with no embedder and a query too short to search both return before any
// integration call, exactly like the NestJS guards before its try block.
func TestVectorSkipPathsRecordNothing(t *testing.T) {
	before := vectorFailureCount(t)
	empty := &vectorRecall{}
	if ids, err := empty.RecallIDs(context.Background(), "org-1", "a long enough query"); err != nil || len(ids) != 0 {
		t.Fatalf("RecallIDs without an embedder = (%v, %v)", ids, err)
	}
	short := &vectorRecall{embedder: llmembed.NewClient(nil)}
	if ids, err := short.RecallIDs(context.Background(), "org-1", "ab"); err != nil || len(ids) != 0 {
		t.Fatalf("RecallIDs with a short query = (%v, %v)", ids, err)
	}
	if after := vectorFailureCount(t); after != before {
		t.Fatalf("skipped recalls recorded %v -> %v", before, after)
	}
}
