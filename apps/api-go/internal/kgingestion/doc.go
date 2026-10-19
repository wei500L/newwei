// Package kgingestion owns the knowledge-graph automatic construction
// background chain: the five-minute scheduler, the global tick gate, the
// per-organization lock, processed-article cursors, relation normalization and
// multi-model validation, the transactional entity/edge/evidence write and the
// article-entity linking step.
//
// Execution ownership is controlled by API_GO_KNOWLEDGE_GRAPH_INGESTION_MODE.
// The NestJS cron reads the same variable and returns before claiming the tick
// gate when Go owns the chain. Both sides use the same Redis tick-gate key and
// the same organization lock key, so a mixed-version window can never process
// one organization twice even if both schedulers are briefly live.
//
// The package registers no HTTP or GraphQL route.
package kgingestion
