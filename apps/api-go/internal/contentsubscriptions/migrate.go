package contentsubscriptions

import (
	"context"
	"database/sql"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/personalnews"
)

type migrationMarker struct {
	MigratedAt string `json:"migratedAt"`
}

// ensureSubscriptionMigration 只在标记不存在时把摘要偏好里的
// focusTopics/focusEntities 写成 legacy 订阅。任一步失败都不写标记，
// 所以下一次读取会重试；标记写上之后重复读取直接返回。
func (s *Service) ensureSubscriptionMigration(ctx context.Context, q queryer, orgID, userID string) error {
	exists, err := s.settingExists(ctx, q, orgID, userID, migrationSettingKey)
	if err != nil || exists {
		return err
	}
	raw, found, err := s.readSetting(ctx, q, orgID, userID, digestPreferenceKey)
	if err != nil {
		return err
	}
	record := map[string]any{}
	if found {
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err == nil {
			if obj, ok := parsed.(map[string]any); ok {
				record = obj
			}
		}
	}
	topics := normalizeStringArray(record["focusTopics"], personalnews.LimitPerKind)
	entities := normalizeStringArray(record["focusEntities"], personalnews.LimitPerKind)
	if len(topics) > 0 {
		if err := s.replaceSubscriptionsByKind(ctx, q, orgID, userID, personalnews.KindTopic, topics, personalnews.SourceLegacy); err != nil {
			return err
		}
	}
	if len(entities) > 0 {
		if err := s.replaceSubscriptionsByKind(ctx, q, orgID, userID, personalnews.KindEntity, entities, personalnews.SourceLegacy); err != nil {
			return err
		}
	}
	payload, err := json.Marshal(migrationMarker{MigratedAt: nowMillis().UTC().Format("2006-01-02T15:04:05.000Z")})
	if err != nil {
		return err
	}
	return s.upsertSetting(ctx, q, orgID, userID, migrationSettingKey, payload, nowMillis())
}

func (s *Service) replaceSubscriptionsByKind(ctx context.Context, q queryer, orgID, userID, kind string, values []string, source string) error {
	s.ensureFresh(ctx, orgID)
	taxonomy, err := s.loadTaxonomy(ctx, orgID)
	if err != nil {
		return err
	}
	inputs := make([]normalizedEntry, 0, len(values))
	for _, value := range values {
		inputs = append(inputs, normalizedEntry{Kind: kind, DisplayValue: value, Source: source})
	}
	normalized := normalizeInputEntries(inputs)
	if len(normalized) > personalnews.LimitPerKind {
		normalized = normalized[:personalnews.LimitPerKind]
	}
	next := make(map[string]struct{}, len(normalized))
	for _, entry := range normalized {
		next[entry.NormalizedValue] = struct{}{}
	}
	current, err := s.listKindIDs(ctx, q, orgID, userID, kind)
	if err != nil {
		return err
	}
	existing := make(map[string]struct{}, len(current))
	deleteIDs := make([]string, 0)
	for _, row := range current {
		existing[row.NormalizedValue] = struct{}{}
		if _, keep := next[row.NormalizedValue]; !keep {
			deleteIDs = append(deleteIDs, row.ID)
		}
	}
	if err := s.deleteSubscriptionsByIDs(ctx, q, orgID, userID, deleteIDs); err != nil {
		return err
	}
	missing := make([]normalizedEntry, 0)
	for _, entry := range normalized {
		if _, ok := existing[entry.NormalizedValue]; !ok {
			missing = append(missing, entry)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	resolved, err := s.resolveEntries(ctx, orgID, missing)
	if err != nil {
		return err
	}
	byKey := indexResolutions(resolved)
	at := nowMillis()
	for _, entry := range missing {
		resolution, ok := byKey[subscriptionKey(entry.Kind, entry.NormalizedValue)]
		if !ok {
			resolution = adHocResolution(entry, taxonomy.Version)
		}
		row, err := insertionFromResolution(entry, resolution, taxonomy.Version, source)
		if err != nil {
			return err
		}
		if err := s.insertSubscriptions(ctx, q, orgID, userID, []insertSubscription{row}, at, false); err != nil {
			if isDuplicateKey(err) {
				continue
			}
			return err
		}
	}
	return nil
}

func (s *Service) GetDigestPreferenceValues(ctx context.Context, orgID, userID string) (topics, entities []string, err error) {
	values, err := s.GetDigestSubscriptionValues(ctx, orgID, userID)
	if err != nil {
		return nil, nil, err
	}
	return values.FocusTopics, values.FocusEntities, nil
}

func (s *Service) GetDigestSubscriptionValues(ctx context.Context, orgID, userID string) (personalnews.DigestSubscriptionValues, error) {
	var values personalnews.DigestSubscriptionValues
	err := s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureSubscriptionMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		var err error
		values, err = s.readDigestValues(ctx, conn, orgID, userID)
		return err
	})
	if err != nil {
		return personalnews.DigestSubscriptionValues{}, err
	}
	return values, nil
}

func (s *Service) ReplaceSubscriptionsFromDigestPreference(ctx context.Context, orgID, userID string, topics, entities *[]string) error {
	return s.withUserLock(ctx, orgID, userID, func(ctx context.Context, conn *sql.Conn) error {
		if err := s.ensureSubscriptionMigration(ctx, conn, orgID, userID); err != nil {
			return err
		}
		if topics != nil {
			if err := s.replaceSubscriptionsByKind(ctx, conn, orgID, userID, personalnews.KindTopic, *topics, personalnews.SourceLegacy); err != nil {
				return err
			}
		}
		if entities != nil {
			if err := s.replaceSubscriptionsByKind(ctx, conn, orgID, userID, personalnews.KindEntity, *entities, personalnews.SourceLegacy); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Service) readDigestValues(ctx context.Context, q queryer, orgID, userID string) (personalnews.DigestSubscriptionValues, error) {
	rows, err := q.QueryContext(ctx, `
SELECT kind, normalizedValue, displayValue, metadata
FROM UserContentSubscription
WHERE orgId = ? AND userId = ?
ORDER BY kind ASC, displayValue ASC`, orgID, userID)
	if err != nil {
		return personalnews.DigestSubscriptionValues{}, err
	}
	defer rows.Close()
	values := personalnews.DigestSubscriptionValues{
		FocusTopics:   []string{},
		FocusEntities: []string{},
		FocusKeywords: []string{},
		FocusSources:  []personalnews.DigestSource{},
		FocusGeos:     []personalnews.DigestGeo{},
	}
	geoOrder := make([]string, 0)
	geos := map[string]personalnews.DigestGeo{}
	for rows.Next() {
		var kind, normalized, display string
		var metadata []byte
		if err := rows.Scan(&kind, &normalized, &display, &metadata); err != nil {
			return personalnews.DigestSubscriptionValues{}, err
		}
		switch kind {
		case personalnews.KindTopic:
			values.FocusTopics = append(values.FocusTopics, display)
		case personalnews.KindEntity:
			values.FocusEntities = append(values.FocusEntities, display)
		case personalnews.KindKeyword:
			values.FocusKeywords = append(values.FocusKeywords, display)
		case personalnews.KindSource:
			values.FocusSources = append(values.FocusSources, personalnews.DigestSource{
				SourceID:     normalized,
				DisplayValue: display,
			})
		case personalnews.KindGeo:
			text := display
			if text == "" {
				text = normalized
			}
			canonical := canonicalizeGeoValue(text)
			key := canonical.NormalizedValue
			if key == "" {
				key = normalized
			}
			label := canonical.DisplayValue
			if label == "" {
				label = display
			}
			if key == "" || label == "" {
				continue
			}
			geo := personalnews.DigestGeo{NormalizedValue: key, DisplayValue: label}
			if code, ok := metadataCountry(metadata); ok {
				geo.CountryCodeAlpha2 = code
			} else if canonical.CountryCodeAlpha2 != "" {
				geo.CountryCodeAlpha2 = canonical.CountryCodeAlpha2
			}
			if _, exists := geos[key]; !exists {
				geoOrder = append(geoOrder, key)
			}
			geos[key] = geo
		}
	}
	if err := rows.Err(); err != nil {
		return personalnews.DigestSubscriptionValues{}, err
	}
	for _, key := range geoOrder {
		values.FocusGeos = append(values.FocusGeos, geos[key])
	}
	return values, nil
}

func metadataCountry(raw []byte) (string, bool) {
	if metadataJSON(raw)[0] != '{' {
		return "", false
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", false
	}
	code, ok := obj["countryCodeAlpha2"].(string)
	if !ok || code == "" {
		return "", false
	}
	return code, true
}

func indexResolutions(items []personalnews.CatalogResolution) map[string]personalnews.CatalogResolution {
	out := make(map[string]personalnews.CatalogResolution, len(items))
	for _, item := range items {
		out[subscriptionKey(item.Kind, item.NormalizedValue)] = item
	}
	return out
}

func adHocResolution(entry normalizedEntry, taxonomyVersion string) personalnews.CatalogResolution {
	version := taxonomyVersion
	return personalnews.CatalogResolution{
		Kind:            entry.Kind,
		NormalizedValue: entry.NormalizedValue,
		DisplayValue:    entry.DisplayValue,
		TaxonomyVersion: &version,
	}
}

func insertionFromResolution(entry normalizedEntry, resolution personalnews.CatalogResolution, taxonomyVersion, source string) (insertSubscription, error) {
	version := taxonomyVersion
	if resolution.TaxonomyVersion != nil && *resolution.TaxonomyVersion != "" {
		version = *resolution.TaxonomyVersion
	}
	metadata, err := metadataForStore(resolution.Metadata)
	if err != nil {
		return insertSubscription{}, err
	}
	if source == "" {
		source = entry.Source
	}
	if source == "" {
		source = personalnews.SourceManual
	}
	display := resolution.DisplayValue
	if display == "" {
		display = entry.DisplayValue
	}
	return insertSubscription{
		Kind:            entry.Kind,
		NormalizedValue: entry.NormalizedValue,
		DisplayValue:    display,
		TaxonomyPath:    resolution.TaxonomyPath,
		TaxonomyVersion: version,
		Source:          source,
		Metadata:        metadata,
	}, nil
}

func metadataForStore(metadata map[string]any) ([]byte, error) {
	if metadata == nil {
		return []byte("{}"), nil
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	if len(encoded) == 0 || encoded[0] != '{' {
		return []byte("{}"), nil
	}
	return encoded, nil
}
