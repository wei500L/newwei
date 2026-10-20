package archivepreparationworker

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

func TestCombineArchiveScoresFixedWeights(t *testing.T) {
	rule := map[archivereading.Vertical]float64{
		archivereading.VerticalEastSea: 0.8, archivereading.VerticalSouthSea: 0.2,
		archivereading.VerticalWestFront: 0, archivereading.VerticalForeignAffairs: 0, archivereading.VerticalDomesticAffairs: 0,
	}
	embedding := map[archivereading.Vertical]float64{
		archivereading.VerticalEastSea: 0.6, archivereading.VerticalSouthSea: 0.4,
		archivereading.VerticalWestFront: 0, archivereading.VerticalForeignAffairs: 0, archivereading.VerticalDomesticAffairs: 0,
	}
	rerank := map[archivereading.Vertical]float64{
		archivereading.VerticalEastSea: 0.4, archivereading.VerticalSouthSea: 0.6,
		archivereading.VerticalWestFront: 0, archivereading.VerticalForeignAffairs: 0, archivereading.VerticalDomesticAffairs: 0,
	}
	fused := combineArchiveScores(rule, embedding, rerank)
	if !approxEqual(fused[archivereading.VerticalEastSea], 0.62) {
		t.Fatalf("east = %v", fused[archivereading.VerticalEastSea])
	}
	if !approxEqual(fused[archivereading.VerticalSouthSea], 0.38) {
		t.Fatalf("south = %v", fused[archivereading.VerticalSouthSea])
	}
}

func approxEqual(left, right float64) bool {
	delta := left - right
	if delta < 0 {
		delta = -delta
	}
	return delta < 1e-9
}

func TestSelectOutcomeStrongRuleOverride(t *testing.T) {
	fused := scoreMap()
	fused[archivereading.VerticalEastSea] = 0.7
	fused[archivereading.VerticalSouthSea] = 0.65
	rule := scoreMap()
	rule[archivereading.VerticalSouthSea] = 1
	embedding := scoreMap()
	embedding[archivereading.VerticalEastSea] = 0.6
	rerank := scoreMap()
	rerank[archivereading.VerticalEastSea] = 0.6
	context := archivereading.RuleSignals{
		CountryMatchedVerticals: []archivereading.Vertical{archivereading.VerticalSouthSea},
	}
	vertical, reason := archivereading.SelectOutcome(fused, rule, embedding, rerank, context)
	if vertical != archivereading.VerticalSouthSea || reason != archivereading.DecisionStrongRuleOverride {
		t.Fatalf("vertical=%s reason=%s", vertical, reason)
	}
}

func TestSelectOutcomeLowSemanticConfidence(t *testing.T) {
	fused := scoreMap()
	fused[archivereading.VerticalEastSea] = 0.6
	fused[archivereading.VerticalSouthSea] = 0.4
	rule := scoreMap()
	rule[archivereading.VerticalSouthSea] = 1
	embedding := scoreMap()
	embedding[archivereading.VerticalEastSea] = 0.5
	rerank := scoreMap()
	rerank[archivereading.VerticalEastSea] = 0.5
	vertical, reason := archivereading.SelectOutcome(fused, rule, embedding, rerank, archivereading.RuleSignals{})
	if vertical != archivereading.VerticalSouthSea || reason != archivereading.DecisionLowSemanticConfidence {
		t.Fatalf("vertical=%s reason=%s", vertical, reason)
	}
}

func TestSelectOutcomeDefaultForeignAffairs(t *testing.T) {
	fused := scoreMap()
	fused[archivereading.VerticalEastSea] = 0.45
	fused[archivereading.VerticalSouthSea] = 0.3
	embedding := scoreMap()
	embedding[archivereading.VerticalEastSea] = 0.5
	rerank := scoreMap()
	rerank[archivereading.VerticalEastSea] = 0.5
	context := archivereading.RuleSignals{CountryMatchedVerticals: []archivereading.Vertical{archivereading.VerticalEastSea}}
	vertical, reason := archivereading.SelectOutcome(fused, scoreMap(), embedding, rerank, context)
	if vertical != archivereading.VerticalForeignAffairs || reason != archivereading.DecisionDefaultForeignAffairs {
		t.Fatalf("vertical=%s reason=%s", vertical, reason)
	}
}

func TestNormalizeVerticalScoresEqualMaxMin(t *testing.T) {
	aggregated := scoreMap()
	aggregated[archivereading.VerticalEastSea] = 0.42
	aggregated[archivereading.VerticalSouthSea] = 0.42
	aggregated[archivereading.VerticalWestFront] = 0.42
	aggregated[archivereading.VerticalForeignAffairs] = 0.42
	aggregated[archivereading.VerticalDomesticAffairs] = 0.42
	normalized := normalizeVerticalScores(aggregated)
	for _, vertical := range archivereading.VerticalOrder {
		if normalized[vertical] != 1 {
			t.Fatalf("%s = %v", vertical, normalized[vertical])
		}
	}
}

func TestAverageTopScoresUsesTopTwo(t *testing.T) {
	if got := averageTopScores([]float64{0.2, 0.9, 0.5}); !approxEqual(got, 0.7) {
		t.Fatalf("average = %v", got)
	}
	if got := averageTopScores(nil); got != 0 {
		t.Fatalf("empty = %v", got)
	}
}
