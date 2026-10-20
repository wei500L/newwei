package settingscrawl

import (
	"context"
	"database/sql"
)

// This file is the narrow port the news-event ingestion scheduler opens onto the
// settings read package. It reuses the newsEventSettings root's stored-document
// normalization instead of copying a second settings shape into the ingestion
// package, so the background chain sees exactly the values the
// newsEventSettings GraphQL root returns.
//
// The Redis cache is deliberately not part of this port. The read root does not
// cache, while NewsEventsSettingsService does (60 s, key
// newsEvents:settings:<orgId>). Reading MySQL directly therefore returns a value
// that is at most as old as the cached one and never older, which is a stronger
// guarantee than the NestJS scheduler has.
//
// The exported names carry the Ingest suffix so a parallel port of the timeline
// settings reader can add its own wrapper to this package without a duplicate
// declaration.

// NewsEventsIngestSettingsReader reads news_event_settings:<orgId> with the
// newsEventSettings root's semantics: a missing row degrades to the defaults and
// a MySQL failure also degrades to the defaults.
type NewsEventsIngestSettingsReader struct {
	reader *settingsReader
}

// NewNewsEventsIngestSettingsReader builds the reader on the shared MySQL pool.
func NewNewsEventsIngestSettingsReader(db *sql.DB) *NewsEventsIngestSettingsReader {
	return &NewsEventsIngestSettingsReader{reader: &settingsReader{s: &store{db: db}}}
}

// ReadIngestSettings returns the normalized settings document for one
// organization.
func (r *NewsEventsIngestSettingsReader) ReadIngestSettings(ctx context.Context, orgID string) (NewsEventSettingsModel, error) {
	if r == nil || r.reader == nil {
		return defaultNewsEventSettings(), nil
	}
	return r.reader.newsEventSettings(ctx, orgID)
}
