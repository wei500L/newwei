package metrics

import (
	"strings"
	"testing"
)

// renderFamily returns the rendered exposition lines of one metric family.
func renderedSeries(t *testing.T, name string) []string {
	t.Helper()
	var lines []string
	for _, line := range strings.Split(Render(), "\n") {
		if strings.HasPrefix(line, name+"{") || strings.HasPrefix(line, name+"_bucket{") ||
			strings.HasPrefix(line, name+"_sum{") || strings.HasPrefix(line, name+"_count{") {
			lines = append(lines, line)
		}
	}
	return lines
}

// hasSeries reports whether the rendered family contains a series whose line
// carries every one of the given label fragments.
func hasSeries(lines []string, fragments ...string) bool {
	for _, line := range lines {
		matched := true
		for _, fragment := range fragments {
			if !strings.Contains(line, fragment) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// TestElasticsearchProducerUsesTheNestLabelSet proves the ES helper emits exactly
// the integration/operation/status triple the two NestJS search call sites use, and
// that success and failure are distinguished.
func TestElasticsearchProducerUsesTheNestLabelSet(t *testing.T) {
	for _, operation := range []string{OperationItemsSearch, OperationItemsLiteralKeywordSearch} {
		RecordElasticsearchEvent(operation, true)
		RecordElasticsearchEvent(operation, false)
		lines := renderedSeries(t, "integration_events_total")
		if !hasSeries(lines, `integration="elasticsearch"`, `operation="`+operation+`"`, `status="success"`) {
			t.Errorf("no success series for %s in:\n%s", operation, strings.Join(lines, "\n"))
		}
		if !hasSeries(lines, `integration="elasticsearch"`, `operation="`+operation+`"`, `status="failure"`) {
			t.Errorf("no failure series for %s in:\n%s", operation, strings.Join(lines, "\n"))
		}
	}
}

// TestVectorProducerRecordsOnlyTheFailureStatus mirrors the single NestJS vector
// call site: there is no success sample, only the degraded-to-empty failure.
func TestVectorProducerRecordsOnlyTheFailureStatus(t *testing.T) {
	RecordVectorSearchFailure()
	lines := renderedSeries(t, "integration_events_total")
	if !hasSeries(lines, `integration="vector"`, `operation="items_vector_search"`, `status="failure"`) {
		t.Errorf("no vector failure series in:\n%s", strings.Join(lines, "\n"))
	}
	if hasSeries(lines, `integration="vector"`, `status="success"`) {
		t.Error("a vector success series exists, but NestJS never records one")
	}
}

// TestLiteLLMProducerUsesFallbackStatusAndTheFourOperations pins the operation
// names and the status value: "fallback", not "failure", and exactly the four the
// NestJS recordModelFallbackOrWarn call sites pass.
func TestLiteLLMProducerUsesFallbackStatusAndTheFourOperations(t *testing.T) {
	for _, operation := range []string{
		OperationCompletionFallback,
		OperationResponsesFallback,
		OperationRerankFallback,
		OperationStreamFallback,
	} {
		RecordLiteLLMFallback(operation)
		lines := renderedSeries(t, "integration_events_total")
		if !hasSeries(lines, `integration="litellm"`, `operation="`+operation+`"`, `status="fallback"`) {
			t.Errorf("no litellm fallback series for %s in:\n%s", operation, strings.Join(lines, "\n"))
		}
	}
	if hasSeries(renderedSeries(t, "integration_events_total"), `integration="litellm"`, `status="failure"`) {
		t.Error("a litellm failure series exists, but the NestJS call site records status fallback")
	}
}

// TestPipelineProducerIsKeyedByTenantAndSlug proves the gauge keeps the two labels
// the NestJS provider passes, so a per-tenant series cannot collide.
func TestPipelineProducerIsKeyedByTenantAndSlug(t *testing.T) {
	RecordPipelineValue("org-a", "pipeline.success_rate", 0.75)
	RecordPipelineValue("org-a", "pipeline.ingestion_p90_ms", 120)
	RecordPipelineValue("org-b", "pipeline.success_rate", 0.5)
	lines := renderedSeries(t, "pipeline_metric_value")
	cases := []struct{ tenant, metric, value string }{
		{"org-a", "pipeline.success_rate", "0.75"},
		{"org-a", "pipeline.ingestion_p90_ms", "120"},
		{"org-b", "pipeline.success_rate", "0.5"},
	}
	for _, testCase := range cases {
		if !hasSeries(lines, `org_id="`+testCase.tenant+`"`, `metric="`+testCase.metric+`"`, " "+testCase.value) {
			t.Errorf("missing series %s/%s=%s in:\n%s",
				testCase.tenant, testCase.metric, testCase.value, strings.Join(lines, "\n"))
		}
	}
}

// TestPipelineProducerFiltersNonFiniteValues keeps SetPipelineMetric's contract:
// NaN and an infinity are dropped instead of corrupting the exposition text.
func TestPipelineProducerFiltersNonFiniteValues(t *testing.T) {
	RecordPipelineValue("org-nan", "pipeline.success_rate", nanValue())
	RecordPipelineValue("org-inf", "pipeline.success_rate", infValue())
	lines := renderedSeries(t, "pipeline_metric_value")
	if hasSeries(lines, `org_id="org-nan"`) {
		t.Error("a NaN value produced a series")
	}
	if hasSeries(lines, `org_id="org-inf"`) {
		t.Error("an infinite value produced a series")
	}
}

// nanValue and infValue keep math out of the assertions' import list.
func nanValue() float64 {
	var zero float64
	return zero / zero
}

func infValue() float64 {
	var one, zero float64 = 1, 0
	return one / zero
}
