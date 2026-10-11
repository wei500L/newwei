package situationmonitors

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

func (s *Service) ensureLegacyMigration(ctx context.Context, q queryer, orgID, userID string) error {
	count, err := s.countMonitors(ctx, q, orgID, userID)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	raw, found, err := readSetting(ctx, q, orgID, userID, legacyMonitorsKey)
	if err != nil {
		return err
	}
	var entries []any
	if found {
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err == nil {
			if list, ok := parsed.([]any); ok {
				entries = list
			}
		}
	}
	if len(entries) > maxManualMonitors {
		entries = entries[:maxManualMonitors]
	}
	now := nowMillis()
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		name := normalizeName(asString(record["name"]))
		keywords := normalizeKeywordList(asStringList(record["keywords"]))
		if name == "" || len(keywords) == 0 {
			continue
		}
		if err := s.insertLegacyMonitor(ctx, q, orgID, userID, record, name, keywords, now); err != nil {
			return err
		}
	}
	return s.syncSystemMonitor(ctx, q, orgID, userID)
}

func (s *Service) insertLegacyMonitor(ctx context.Context, q queryer, orgID, userID string, record map[string]any, name string, keywords []string, now time.Time) error {
	enabled := true
	if value, ok := record["enabled"].(bool); ok {
		enabled = value
	}
	color := sql.NullString{}
	if text, ok := record["color"].(string); ok {
		if normalized, valid := normalizeColor(text); valid {
			color = sql.NullString{String: normalized, Valid: true}
		}
	}
	loc := legacyLocation(record["location"])
	embedding := s.buildQueryEmbedding(ctx, orgID, buildQueryText(name, keywords, nil, nil, nil, nil, keywords, loc), "monitor-query-embedding")
	createdAt := now
	if created, ok := asFinite(record["createdAt"]); ok {
		createdAt = time.UnixMilli(int64(created)).UTC().Truncate(time.Millisecond)
	}
	_, err := s.insertMonitor(ctx, q, orgID, userID, "manual", persistedFromParts(name, enabled, color, keywords, nil, nil, nil, nil, keywords, emptyRejected(), loc, embedding, now), createdAt)
	return err
}

func persistedFromParts(
	name string,
	enabled bool,
	color sql.NullString,
	rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical []string,
	rejected rejectedState,
	loc *locationDTO,
	embedding embeddingPayload,
	resolved time.Time,
) persistedMonitor {
	var locationName, locationLat, locationLng, locationBounds, locationCountry any
	if loc != nil {
		locationName = loc.Name
		locationLat = loc.Lat
		locationLng = loc.Lng
		if loc.Bounds != nil {
			locationBounds = mustJSON(*loc.Bounds)
		}
		if loc.CountryCodeAlpha2 != "" {
			locationCountry = loc.CountryCodeAlpha2
		}
	}
	var model, vector any
	if embedding.model.Valid && stringsTrim(embedding.model.String) != "" {
		model = embedding.model.String
	}
	if len(embedding.vector) > 0 {
		vector = embedding.vector
	}
	if approvedTopics == nil {
		approvedTopics = []string{}
	}
	if approvedEntities == nil {
		approvedEntities = []string{}
	}
	if approvedSources == nil {
		approvedSources = []string{}
	}
	if approvedGeos == nil {
		approvedGeos = []string{}
	}
	if approvedLexical == nil {
		approvedLexical = []string{}
	}
	if rawKeywords == nil {
		rawKeywords = []string{}
	}
	return persistedMonitor{
		Name:             name,
		Enabled:          enabled,
		Color:            color,
		RawKeywords:      jsonArray(rawKeywords),
		ApprovedTopics:   jsonArray(approvedTopics),
		ApprovedEntities: jsonArray(approvedEntities),
		ApprovedSources:  jsonArray(approvedSources),
		ApprovedGeos:     jsonArray(approvedGeos),
		ApprovedLexical:  jsonArray(approvedLexical),
		Rejected:         mustJSON(rejected),
		LocationName:     locationName,
		LocationLat:      locationLat,
		LocationLng:      locationLng,
		LocationBounds:   locationBounds,
		LocationCountry:  locationCountry,
		EmbedModel:       model,
		EmbedVector:      vector,
		LastResolved:     resolved,
	}
}
