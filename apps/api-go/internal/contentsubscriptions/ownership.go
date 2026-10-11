package contentsubscriptions

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
)

type ownershipEntry struct {
	OwnerMonitorIds    []string
	OwnerMonitorNames  []string
	ManualMonitorOwned bool
	SystemSyncOwned    bool
}

type rejectedSuggestions struct {
	Topics       []string `json:"topics"`
	Entities     []string `json:"entities"`
	LexicalTerms []string `json:"lexicalTerms"`
}

type managedMetadata struct {
	ManagedBySituationMonitor bool `json:"managedBySituationMonitor"`
}

type subscriptionLite struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
}

type desiredSubscription struct {
	Kind            string
	NormalizedValue string
	DisplayValue    string
}

// reconcileContentSubscriptionSync 对齐 situation-monitor-monitors.service.ts
// 的同名方法：先迁移遗留监控（已有行则不动它们的地点和向量），再按手动
// 监控补回订阅，最后重写 system_sync 的字段并清空它自己的地点。
func (s *Service) reconcileContentSubscriptionSync(ctx context.Context, q queryer, orgID, userID string) error {
	if err := s.ensureLegacyMonitorMigration(ctx, q, orgID, userID); err != nil {
		return err
	}
	if err := s.reconcileManualMonitorSubscriptions(ctx, q, orgID, userID); err != nil {
		return err
	}
	return s.syncSystemMonitorFromSubscriptions(ctx, q, orgID, userID)
}

func (s *Service) buildSubscriptionOwnershipMap(ctx context.Context, q queryer, orgID, userID string) (map[string]ownershipEntry, error) {
	if err := s.ensureLegacyMonitorMigration(ctx, q, orgID, userID); err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `
SELECT id, kind, name, approvedTopics, approvedEntities
FROM SituationMonitorMonitor
WHERE orgId = ? AND userId = ?
ORDER BY kind ASC, createdAt DESC`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ownership := map[string]ownershipEntry{}
	for rows.Next() {
		var id, kind, name string
		var topics, entities []byte
		if err := rows.Scan(&id, &kind, &name, &topics, &entities); err != nil {
			return nil, err
		}
		for _, topic := range parseStringArray(topics, maxApprovedSuggestions) {
			key := subscriptionKey("topic", normalizeTerm(topic))
			upsertOwnership(ownership, key, id, name, kind)
		}
		for _, entity := range parseStringArray(entities, maxApprovedSuggestions) {
			key := subscriptionKey("entity", normalizeTerm(entity))
			upsertOwnership(ownership, key, id, name, kind)
		}
	}
	return ownership, rows.Err()
}

func upsertOwnership(ownership map[string]ownershipEntry, key, id, name, kind string) {
	_, value, ok := strings.Cut(key, ":")
	if !ok || value == "" {
		return
	}
	current, ok := ownership[key]
	if !ok {
		current = ownershipEntry{
			OwnerMonitorIds:   []string{},
			OwnerMonitorNames: []string{},
		}
	}
	if !stringSliceHas(current.OwnerMonitorIds, id) {
		current.OwnerMonitorIds = append(current.OwnerMonitorIds, id)
	}
	if !stringSliceHas(current.OwnerMonitorNames, name) {
		current.OwnerMonitorNames = append(current.OwnerMonitorNames, name)
	}
	if kind == "system_sync" {
		current.SystemSyncOwned = true
	} else {
		current.ManualMonitorOwned = true
	}
	ownership[key] = current
}

func (s *Service) ensureLegacyMonitorMigration(ctx context.Context, q queryer, orgID, userID string) error {
	var count int
	if err := q.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM SituationMonitorMonitor WHERE orgId = ? AND userId = ?",
		orgID, userID,
	).Scan(&count); err != nil {
		return err
	}
	// 已经有监控行时直接返回。已存的地点和 embedding 保持不动，
	// 这里不调用 Nominatim，也不重新计算向量。
	if count > 0 {
		return nil
	}
	raw, found, err := s.readSetting(ctx, q, orgID, userID, legacyMonitorsKey)
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
		keywords := normalizeKeywordList(asStrings(record["keywords"]))
		if name == "" || len(keywords) == 0 {
			continue
		}
		if err := s.insertLegacyMonitor(ctx, q, orgID, userID, record, name, keywords, now); err != nil {
			return err
		}
	}
	return s.syncSystemMonitorFromSubscriptions(ctx, q, orgID, userID)
}

func (s *Service) insertLegacyMonitor(ctx context.Context, q queryer, orgID, userID string, record map[string]any, name string, keywords []string, now time.Time) error {
	id, err := newRowID()
	if err != nil {
		return err
	}
	enabled := true
	if value, ok := record["enabled"].(bool); ok {
		enabled = value
	}
	color := sql.NullString{}
	if normalized, ok := normalizeColor(record["color"]); ok {
		color = sql.NullString{String: normalized, Valid: true}
	}
	locName, lat, lng, country, hasLocation := legacyLocation(record["location"])
	model, vector := storedEmbedding(record)
	createdAt := now
	if created, ok := asFinite(record["createdAt"]); ok {
		createdAt = time.UnixMilli(int64(created)).UTC().Truncate(time.Millisecond)
	}
	var locationName, locationCountry any
	var locationLat, locationLng any
	if hasLocation {
		locationName = locName
		locationLat = lat
		locationLng = lng
		if country != "" {
			locationCountry = country
		}
	}
	_, err = q.ExecContext(ctx, `
INSERT INTO SituationMonitorMonitor (
  id, orgId, userId, kind, name, enabled, color,
  rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexicalTerms, rejectedSuggestions,
  locationName, locationLat, locationLng, locationBounds, locationCountryCode,
  queryEmbeddingModel, queryEmbeddingVector, lastResolvedAt, createdAt, updatedAt
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, orgID, userID, "manual", name, enabled, color,
		jsonArray(keywords), jsonArray([]string{}), jsonArray([]string{}), nil, nil, jsonArray(keywords), emptyRejected(),
		locationName, locationLat, locationLng, nil, locationCountry,
		nullString(model), vector, now, createdAt, now,
	)
	return err
}

// legacyLocation 只接受 JSON 里已经有的 name/lat/lng。缺坐标时返回 false，
// 不向地理编码服务补全。
func legacyLocation(value any) (name string, lat, lng float64, country string, ok bool) {
	record, isObject := value.(map[string]any)
	if !isObject {
		return "", 0, 0, "", false
	}
	name = normalizeName(asString(record["name"]))
	lat, latOK := asFinite(record["lat"])
	lng, lngOK := asFinite(record["lng"])
	if name == "" || !latOK || !lngOK {
		return "", 0, 0, "", false
	}
	if alpha3 := normalizeCountryCode(name); alpha3 != "" {
		country = countryAlpha2(alpha3)
	}
	return name, lat, lng, country, true
}

func storedEmbedding(record map[string]any) (sql.NullString, any) {
	var model sql.NullString
	if text := strings.TrimSpace(asString(record["queryEmbeddingModel"])); text != "" {
		model = sql.NullString{String: text, Valid: true}
	}
	numbers := finiteNumbers(record["queryEmbeddingVector"])
	if len(numbers) == 0 {
		return model, nil
	}
	encoded, err := json.Marshal(numbers)
	if err != nil {
		return model, nil
	}
	return model, encoded
}

func (s *Service) reconcileManualMonitorSubscriptions(ctx context.Context, q queryer, orgID, userID string) error {
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
	managed, err := json.Marshal(managedMetadata{ManagedBySituationMonitor: true})
	if err != nil {
		return err
	}
	for _, entry := range desired {
		if _, ok := byKey[subscriptionKey(entry.Kind, entry.NormalizedValue)]; ok {
			continue
		}
		if err := s.insertSubscriptions(ctx, q, orgID, userID, []insertSubscription{{
			Kind:            entry.Kind,
			NormalizedValue: entry.NormalizedValue,
			DisplayValue:    entry.DisplayValue,
			Source:          "manual",
			Metadata:        managed,
		}}, at, false); err != nil {
			if isDuplicateKey(err) {
				continue
			}
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
	return s.deleteSubscriptionsByIDs(ctx, q, orgID, userID, deleteIDs)
}

func collectDesired(desired map[string]desiredSubscription, kind string, values []string) {
	for _, value := range values {
		normalized := normalizeTerm(value)
		if normalized == "" {
			continue
		}
		desired[subscriptionKey(kind, normalized)] = desiredSubscription{
			Kind:            kind,
			NormalizedValue: normalized,
			DisplayValue:    normalizeDisplayValue(value),
		}
	}
}

func (s *Service) syncSystemMonitorFromSubscriptions(ctx context.Context, q queryer, orgID, userID string) error {
	subs, err := s.loadSubscriptionLite(ctx, q, orgID, userID)
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
		switch row.Kind {
		case "topic":
			if _, owned := manualOwned[subscriptionKey(row.Kind, row.NormalizedValue)]; !owned {
				orphanTopics = append(orphanTopics, row.DisplayValue)
			}
		case "entity":
			if _, owned := manualOwned[subscriptionKey(row.Kind, row.NormalizedValue)]; !owned {
				orphanEntities = append(orphanEntities, row.DisplayValue)
			}
		case "keyword":
			keywords = append(keywords, row.DisplayValue)
		case "source":
			sources = append(sources, row.DisplayValue)
		case "geo":
			geos = append(geos, row.DisplayValue)
		}
	}
	approvedTopics := normalizeStringList(orphanTopics, maxApprovedSuggestions)
	approvedEntities := normalizeStringList(orphanEntities, maxApprovedSuggestions)
	approvedSources := normalizeStringList(sources, maxApprovedSuggestions)
	approvedGeos := normalizeStringList(geos, maxApprovedSuggestions)
	rawKeywords := normalizeKeywordList(keywords)
	lexicalInput := make([]string, 0, len(orphanTopics)+len(orphanEntities)+len(keywords))
	lexicalInput = append(lexicalInput, orphanTopics...)
	lexicalInput = append(lexicalInput, orphanEntities...)
	lexicalInput = append(lexicalInput, keywords...)
	approvedLexical := normalizeStringList(lexicalInput, maxApprovedTerms)
	now := nowMillis()
	var existingID string
	err = q.QueryRowContext(ctx, `
SELECT id FROM SituationMonitorMonitor
WHERE orgId = ? AND userId = ? AND kind = 'system_sync'
LIMIT 1`, orgID, userID).Scan(&existingID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && existingID != "" {
		// 地点列按 Nest 清空。queryEmbedding* 不在这条 UPDATE 里：
		// 本链不调用嵌入 HTTP，已写入的向量保持原值。
		_, err = q.ExecContext(ctx, `
UPDATE SituationMonitorMonitor SET
  name = ?, enabled = ?, color = ?,
  rawKeywords = ?, approvedTopics = ?, approvedEntities = ?,
  approvedSources = ?, approvedGeos = ?, approvedLexicalTerms = ?,
  rejectedSuggestions = ?,
  locationName = NULL, locationLat = NULL, locationLng = NULL,
  locationBounds = NULL, locationCountryCode = NULL,
  lastResolvedAt = ?, updatedAt = ?
WHERE id = ? AND orgId = ? AND userId = ?`,
			systemSyncMonitorName, true, systemSyncMonitorColor,
			jsonArray(rawKeywords), jsonArray(approvedTopics), jsonArray(approvedEntities),
			jsonArray(approvedSources), jsonArray(approvedGeos), jsonArray(approvedLexical),
			emptyRejected(),
			now, now,
			existingID, orgID, userID,
		)
		return err
	}
	id, err := newRowID()
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `
INSERT INTO SituationMonitorMonitor (
  id, orgId, userId, kind, name, enabled, color,
  rawKeywords, approvedTopics, approvedEntities, approvedSources, approvedGeos, approvedLexicalTerms, rejectedSuggestions,
  locationName, locationLat, locationLng, locationBounds, locationCountryCode,
  queryEmbeddingModel, queryEmbeddingVector, lastResolvedAt, createdAt, updatedAt
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, orgID, userID, "system_sync", systemSyncMonitorName, true, systemSyncMonitorColor,
		jsonArray(rawKeywords), jsonArray(approvedTopics), jsonArray(approvedEntities),
		jsonArray(approvedSources), jsonArray(approvedGeos), jsonArray(approvedLexical), emptyRejected(),
		nil, nil, nil, nil, nil,
		nil, nil, now, now, now,
	)
	return err
}

func (s *Service) loadSubscriptionLite(ctx context.Context, q queryer, orgID, userID string) ([]subscriptionLite, error) {
	rows, err := q.QueryContext(ctx, `
SELECT kind, normalizedValue, displayValue
FROM UserContentSubscription
WHERE orgId = ? AND userId = ?
ORDER BY updatedAt DESC`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []subscriptionLite
	for rows.Next() {
		var row subscriptionLite
		if err := rows.Scan(&row.Kind, &row.NormalizedValue, &row.DisplayValue); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func parseStringArray(raw []byte, limit int) []string {
	if len(raw) == 0 {
		return nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	return normalizeStringList(asStrings(parsed), limit)
}

func managedByMonitor(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return false
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return false
	}
	flag, ok := record["managedBySituationMonitor"].(bool)
	return ok && flag
}

func emptyRejected() []byte {
	return mustObject(rejectedSuggestions{
		Topics:       []string{},
		Entities:     []string{},
		LexicalTerms: []string{},
	})
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func asStrings(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if ok {
			out = append(out, text)
		}
	}
	return out
}

func asFinite(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func finiteNumbers(value any) []float64 {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]float64, 0, len(items))
	for _, item := range items {
		number, ok := asFinite(item)
		if ok {
			out = append(out, number)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func nullString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func stringSliceHas(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
