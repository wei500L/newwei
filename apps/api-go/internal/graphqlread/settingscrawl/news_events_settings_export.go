package settingscrawl

import (
	"context"
	"database/sql"
)

// This file is the narrow port the news-event timeline rebuild opens onto the
// settings read package. It reuses the newsEventSettings root's stored-document
// normalization instead of copying a second settings shape into the timeline
// package, so the timeline threshold resolution sees exactly the values
// NewsEventsSettingsService.getSettings returns.
//
// The Redis cache is deliberately not part of this port. The read root does not
// cache, while NewsEventsSettingsService does (60 s, key
// newsEvents:settings:<orgId>). Reading MySQL directly therefore returns a value
// that is at most as old as the cached one and never older, which is a stronger
// guarantee than the NestJS scheduler has.

// NewsEventsSettingsReader reads news_event_settings:<orgId> with the
// newsEventSettings root's semantics: a missing row degrades to the defaults and
// a MySQL failure also degrades to the defaults.
type NewsEventsSettingsReader struct {
	reader *settingsReader
}

// NewNewsEventsSettingsReader builds the reader on the shared MySQL pool.
func NewNewsEventsSettingsReader(db *sql.DB) *NewsEventsSettingsReader {
	return &NewsEventsSettingsReader{reader: &settingsReader{s: &store{db: db}}}
}

// Read returns the normalized settings document for one organization.
func (r *NewsEventsSettingsReader) Read(ctx context.Context, orgID string) (NewsEventSettingsModel, error) {
	if r == nil || r.reader == nil {
		return defaultNewsEventSettings(), nil
	}
	return r.reader.newsEventSettings(ctx, orgID)
}
