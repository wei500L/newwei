package searchreindex

import "context"

// NewElasticsearchFromEnv exposes the Elasticsearch writer built from the
// ELASTICSEARCH_* environment to the startup reconciliation, which must run the
// same ensureIndex the NestJS ItemsElasticsearchService runs in onModuleInit.
// It returns nil when Elasticsearch is disabled or has no node.
func NewElasticsearchFromEnv() *Elasticsearch {
	return newElasticsearchFromEnv()
}

// EnsureIndex creates the items index with the current mappings when missing,
// then adds the alias when missing. It is the exported form of the onModuleInit
// call in items-elasticsearch.service.ts.
func (e *Elasticsearch) EnsureIndex(ctx context.Context) error {
	if e == nil {
		return nil
	}
	return e.ensureIndex(ctx)
}
