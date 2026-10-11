package situationmonitors

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type desiredSubscription struct {
	kind            string
	normalizedValue string
	displayValue    string
}

func (s *Service) reconcileContentSubscriptionSync(ctx context.Context, q queryer, orgID, userID string) error {
	if err := s.ensureLegacyMigration(ctx, q, orgID, userID); err != nil {
		return err
	}
	if err := s.reconcileManualSubscriptions(ctx, q, orgID, userID); err != nil {
		return err
	}
	return s.syncSystemMonitor(ctx, q, orgID, userID)
}

func (s *Service) reconcileManualSubscriptions(ctx context.Context, q queryer, orgID, userID string) error {
	rows, err := q.QueryContext(ctx, `
SELECT approvedTopics, approvedEntities
FROM SituationMonitorMonitor
WHERE orgId = ? AND userId = ? AND kind = 'manual'
ORDER BY createdAt DESC`, orgID, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	desired := map[string]desiredSubscription{}
	for rows.Next() {
		var topics, entities []byte
		if err := rows.Scan(&topics, &entities); err != nil {
			return err
		}
		collectDesired(desired, "topic", parseStringArray(topics, maxApprovedSuggestions))
		collectDesired(desired, "entity", parseStringArray(entities, maxApprovedSuggestions))
	}
	if err := rows.Err(); err != nil {
		return err
	}
	existingRows, err := q.QueryContext(ctx, `
SELECT id, kind, normalizedValue, metadata
FROM UserContentSubscription
WHERE orgId = ? AND userId = ?`, orgID, userID)
	if err != nil {
		return err
	}
	defer existingRows.Close()
	type existingSub struct {
		id         string
		kind       string
		normalized string
		metadata   []byte
	}
	existing := make([]existingSub, 0)
	byKey := map[string]struct{}{}
	for existingRows.Next() {
		var row existingSub
		if err := existingRows.Scan(&row.id, &row.kind, &row.normalized, &row.metadata); err != nil {
			return err
		}
		existing = append(existing, row)
		byKey[subscriptionKey(row.kind, row.normalized)] = struct{}{}
	}
	if err := existingRows.Err(); err != nil {
		return err
	}
	at := nowMillis()
	managed, err := json.Marshal(map[string]bool{"managedBySituationMonitor": true})
	if err != nil {
		return err
	}
	for _, entry := range desired {
		if _, ok := byKey[subscriptionKey(entry.kind, entry.normalizedValue)]; ok {
			continue
		}
		id, err := newRowID()
		if err != nil {
			return err
		}
		if _, err := q.ExecContext(ctx, `
INSERT INTO UserContentSubscription
(id, orgId, userId, kind, normalizedValue, displayValue, source, metadata, createdAt, updatedAt)
VALUES (?,?,?,?,?,?,?,?,?,?)`,
			id, orgID, userID, entry.kind, entry.normalizedValue, entry.displayValue, "manual", managed, at, at,
		); err != nil {
			return err
		}
	}
	deleteIDs := make([]string, 0)
	for _, row := range existing {
		if !managedByMonitor(row.metadata) {
			continue
		}
		if _, ok := desired[subscriptionKey(row.kind, row.normalized)]; ok {
			continue
		}
		deleteIDs = append(deleteIDs, row.id)
	}
	if len(deleteIDs) == 0 {
		return nil
	}
	args := make([]any, 0, 2+len(deleteIDs))
	args = append(args, orgID, userID)
	query := "DELETE FROM UserContentSubscription WHERE orgId = ? AND userId = ? AND id IN ("
	for i, id := range deleteIDs {
		if i > 0 {
			query += ","
		}
		query += "?"
		args = append(args, id)
	}
	query += ")"
	_, err = q.ExecContext(ctx, query, args...)
	return err
}

func collectDesired(desired map[string]desiredSubscription, kind string, values []string) {
	for _, value := range values {
		normalized := normalizeTerm(value)
		if normalized == "" {
			continue
		}
		desired[subscriptionKey(kind, normalized)] = desiredSubscription{
			kind:            kind,
			normalizedValue: normalized,
			displayValue:    normalizeDisplayValue(value),
		}
	}
}

func managedByMonitor(raw []byte) bool {
	record := asObject(raw)
	flag, ok := record["managedBySituationMonitor"].(bool)
	return ok && flag
}

func (s *Service) syncSystemMonitor(ctx context.Context, q queryer, orgID, userID string) error {
	subs, err := loadSubscriptionLite(ctx, q, orgID, userID)
	if err != nil {
		return err
	}
	manualRows, err := q.QueryContext(ctx, `
SELECT approvedTopics, approvedEntities
FROM SituationMonitorMonitor
WHERE orgId = ? AND userId = ? AND kind = 'manual'`, orgID, userID)
	if err != nil {
		return err
	}
	defer manualRows.Close()
	manualOwned := map[string]struct{}{}
	for manualRows.Next() {
		var topics, entities []byte
		if err := manualRows.Scan(&topics, &entities); err != nil {
			return err
		}
		for _, topic := range parseStringArray(topics, maxApprovedSuggestions) {
			if normalized := normalizeTerm(topic); normalized != "" {
				manualOwned[subscriptionKey("topic", normalized)] = struct{}{}
			}
		}
		for _, entity := range parseStringArray(entities, maxApprovedSuggestions) {
			if normalized := normalizeTerm(entity); normalized != "" {
				manualOwned[subscriptionKey("entity", normalized)] = struct{}{}
			}
		}
	}
	if err := manualRows.Err(); err != nil {
		return err
	}
	var orphanTopics, orphanEntities, keywords, sources, geos []string
	for _, row := range subs {
		switch row.kind {
		case "topic":
			if _, owned := manualOwned[subscriptionKey(row.kind, row.normalized)]; !owned {
				orphanTopics = append(orphanTopics, row.display)
			}
		case "entity":
			if _, owned := manualOwned[subscriptionKey(row.kind, row.normalized)]; !owned {
				orphanEntities = append(orphanEntities, row.display)
			}
		case "keyword":
			keywords = append(keywords, row.display)
		case "source":
			sources = append(sources, row.display)
		case "geo":
			geos = append(geos, row.display)
		}
	}
	approvedTopics := normalizeStringList(orphanTopics, maxApprovedSuggestions)
	approvedEntities := normalizeStringList(orphanEntities, maxApprovedSuggestions)
	approvedSources := normalizeStringList(sources, maxApprovedSuggestions)
	approvedGeos := normalizeStringList(geos, maxApprovedSuggestions)
	rawKeywords := normalizeKeywordList(keywords)
	lexicalInput := append(append(append([]string{}, orphanTopics...), orphanEntities...), keywords...)
	approvedLexical := normalizeStringList(lexicalInput, maxApprovedTerms)
	embedding := s.buildQueryEmbedding(ctx, orgID, buildQueryText(systemSyncName, rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical, nil), "monitor-query-embedding")
	now := nowMillis()
	payload := persistedFromParts(systemSyncName, true, sql.NullString{String: systemSyncColor, Valid: true}, rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexical, emptyRejected(), nil, embedding, now)
	var existingID string
	err = q.QueryRowContext(ctx, `
SELECT id FROM SituationMonitorMonitor
WHERE orgId = ? AND userId = ? AND kind = 'system_sync'
ORDER BY createdAt ASC
LIMIT 1`, orgID, userID).Scan(&existingID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if existingID != "" {
		_, err = s.updateMonitor(ctx, q, orgID, userID, existingID, payload)
		return err
	}
	_, err = s.insertMonitor(ctx, q, orgID, userID, "system_sync", payload, now)
	return err
}

type subscriptionLite struct {
	kind       string
	normalized string
	display    string
}

func loadSubscriptionLite(ctx context.Context, q queryer, orgID, userID string) ([]subscriptionLite, error) {
	rows, err := q.QueryContext(ctx, `
SELECT kind, normalizedValue, displayValue
FROM UserContentSubscription
WHERE orgId = ? AND userId = ?
ORDER BY updatedAt DESC`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]subscriptionLite, 0)
	for rows.Next() {
		var row subscriptionLite
		if err := rows.Scan(&row.kind, &row.normalized, &row.display); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
