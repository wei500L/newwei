package metrics

// The integration and pipeline recorders below are the production call sites for
// the families that internal/metrics/families.go already exposes. Until
// GO-CUTOVER-PREREQS-001 nothing outside tests called them, so
// integration_events_total and pipeline_metric_value had no data on a Go-owned
// path. Each recorder mirrors one NestJS call site:
//
//	integration_events_total
//	  apps/api/src/modules/items/items-elasticsearch.service.ts:286,303,362,376
//	    integration="elasticsearch"
//	    operation="items_search" | "items_literal_keyword_search"
//	    status="success" | "failure"
//	  apps/api/src/modules/items/items-search-query.service.ts:284
//	    integration="vector", operation="items_vector_search", status="failure"
//	    (the success path is deliberately absent in NestJS too: a cached, a
//	    degraded-empty and a successful vector recall are indistinguishable at
//	    that call site, so only the final loader failure is recorded)
//	  apps/api/src/modules/news-pipeline/litellm.service.ts:2372
//	    integration="litellm", operation="completion_fallback" |
//	    "rerank_fallback" | "stream_fallback" | "responses_fallback",
//	    status="fallback"
//	    (recorded only when another model remains, never on the last failure)
//
//	pipeline_metric_value
//	  apps/api/src/modules/alerts/providers/pipeline-metric.provider.ts:155,189,219
//	    gauge(orgId, metricSlug, value) for success_rate/failure_rate, the LLM
//	    latency average and the two ingestion percentiles.
//
// The label sets are fixed by those constants: no call site may invent an
// operation name or a status, so the cardinality stays what NestJS produces.

// Integration names used by the NestJS call sites above.
const (
	// IntegrationElasticsearch is the items Elasticsearch client.
	IntegrationElasticsearch = "elasticsearch"
	// IntegrationVector is the vector recall in items search.
	IntegrationVector = "vector"
	// IntegrationLiteLLM is the LiteLLM gateway client.
	IntegrationLiteLLM = "litellm"
)

// Operation names used by the NestJS call sites above.
const (
	// OperationItemsSearch is items-elasticsearch.service.ts `search`.
	OperationItemsSearch = "items_search"
	// OperationItemsLiteralKeywordSearch is `searchLiteralKeywords`.
	OperationItemsLiteralKeywordSearch = "items_literal_keyword_search"
	// OperationItemsVectorSearch is items-search-query.service.ts vector recall.
	OperationItemsVectorSearch = "items_vector_search"
	// OperationCompletionFallback is the chat-completions model fallback.
	OperationCompletionFallback = "completion_fallback"
	// OperationRerankFallback is the rerank model fallback.
	OperationRerankFallback = "rerank_fallback"
	// OperationStreamFallback is the streaming completion fallback.
	OperationStreamFallback = "stream_fallback"
	// OperationResponsesFallback is the Responses API model fallback.
	OperationResponsesFallback = "responses_fallback"
)

// Integration statuses. "fallback" is LiteLLM's own status; the ES and vector
// call sites use success/failure.
const (
	// IntegrationStatusSuccess is a completed external call.
	IntegrationStatusSuccess = "success"
	// IntegrationStatusFailure is a call that failed and was degraded.
	IntegrationStatusFailure = "failure"
	// IntegrationStatusFallback is a model that failed with a fallback remaining.
	IntegrationStatusFallback = "fallback"
)

// RecordElasticsearchEvent counts one item-search Elasticsearch call outcome.
// The two operations are the only Elasticsearch call sites NestJS instruments.
func RecordElasticsearchEvent(operation string, success bool) {
	status := IntegrationStatusFailure
	if success {
		status = IntegrationStatusSuccess
	}
	RecordIntegrationEvent(IntegrationEventInput{
		Integration: IntegrationElasticsearch,
		Operation:   operation,
		Status:      status,
	})
}

// RecordVectorSearchFailure counts the vector recall degrading to empty results.
// NestJS records only the final failure, after the cache wrap and the direct
// loader retry have both failed, so this has exactly one call site.
func RecordVectorSearchFailure() {
	RecordIntegrationEvent(IntegrationEventInput{
		Integration: IntegrationVector,
		Operation:   OperationItemsVectorSearch,
		Status:      IntegrationStatusFailure,
	})
}

// RecordLiteLLMFallback counts one model that failed while another model
// remained, which is the only case NestJS's recordModelFallbackOrWarn reports.
// An exhausted model list is logged and not counted.
func RecordLiteLLMFallback(operation string) {
	RecordIntegrationEvent(IntegrationEventInput{
		Integration: IntegrationLiteLLM,
		Operation:   operation,
		Status:      IntegrationStatusFallback,
	})
}

// RecordPipelineValue exports one alert-provider evaluation to the
// pipeline_metric_value gauge. orgID is the rule's organization and metric is the
// rule's metric slug, so the series is per tenant exactly like NestJS.
//
// Non-finite values are dropped by SetPipelineMetric; callers must not pre-filter
// the way the provider does, because the provider's own zero fallback is a real
// sample that NestJS exports.
func RecordPipelineValue(orgID, metric string, value float64) {
	SetPipelineMetric(orgID, metric, value)
}
