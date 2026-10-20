package settingscrawl

import (
	"context"
	"database/sql"
)

// This file is the narrow port the knowledge-graph ingestion writer opens onto
// the settings read package. It reuses the knowledgeGraphSettings root's
// bootstrap and normalization instead of copying a second settings document
// shape into the ingestion package.
//
// The Redis cache is deliberately not part of this port: the read root does not
// cache, while KnowledgeGraphSettingsService does (60 s, key
// knowledgeGraph:settings:<orgId>). The ingestion package layers that cache on
// top of this reader, so cache hits are normalized with the same exported
// normalizer and the cache value keeps the NestJS document shape.

// KnowledgeGraphSettingsReader reads knowledge_graph_settings:<orgId> with the
// knowledgeGraphSettings root's semantics: a missing row is bootstrapped to the
// fallback document with enabled and ingestionEnabled forced to true, and a
// MySQL failure degrades to the disabled fallback.
type KnowledgeGraphSettingsReader struct {
	reader *settingsReader
}

// NewKnowledgeGraphSettingsReader builds the reader on the shared MySQL pool.
func NewKnowledgeGraphSettingsReader(db *sql.DB) *KnowledgeGraphSettingsReader {
	return &KnowledgeGraphSettingsReader{reader: &settingsReader{s: &store{db: db}}}
}

// Read returns the normalized settings document for one organization.
func (r *KnowledgeGraphSettingsReader) Read(ctx context.Context, orgID string) (KnowledgeGraphSettingsModel, error) {
	if r == nil || r.reader == nil {
		return DefaultKnowledgeGraphSettings(), nil
	}
	return r.reader.knowledgeGraphSettings(ctx, orgID)
}
