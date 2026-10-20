package economicdata

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"
)

// newRowID generates the client-side id Prisma writes for @default(cuid()):
// a leading "c" and 24 hexadecimal characters. MySQL has no default for these
// columns, so every insert must provide one.
func newRowID() (string, error) {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer), nil
}

// EnsureCatalog mirrors AkshareService.ensureCatalog. It creates categories,
// items, item-category relations and missing fetch configs, and refreshes the
// source and metadata fields that NestJS treats as definition-owned. It never
// deletes items that are absent from the catalog.
func (s *Service) EnsureCatalog(ctx context.Context) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("economicdata: mysql is not configured")
	}
	definitions := Catalog()
	categoryKeys := make([]string, 0)
	seenCategories := map[string]bool{}
	for _, definition := range definitions {
		for _, key := range definition.Categories {
			if !seenCategories[key] {
				seenCategories[key] = true
				categoryKeys = append(categoryKeys, key)
			}
		}
	}
	sort.Strings(categoryKeys)
	categories, err := s.loadCategoryMap(ctx, categoryKeys)
	if err != nil {
		return err
	}
	for _, key := range categoryKeys {
		if _, ok := categories[key]; ok {
			continue
		}
		id, idErr := newRowID()
		if idErr != nil {
			return idErr
		}
		if _, execErr := s.db.ExecContext(ctx,
			"INSERT IGNORE INTO `EconomicCategory` (`id`,`key`,`label`,`createdAt`,`updatedAt`) VALUES (?,?,?,NOW(3),NOW(3))",
			id, key, categoryLabel(key)); execErr != nil {
			return fmt.Errorf("create economic category %s: %w", key, execErr)
		}
	}
	categories, err = s.loadCategoryMap(ctx, categoryKeys)
	if err != nil {
		return err
	}

	slugs := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		slugs = append(slugs, definition.Slug)
	}
	existing, err := s.loadItemsBySlugs(ctx, slugs)
	if err != nil {
		return err
	}
	existingConfigs, err := s.loadFetchConfigsByItemIDs(ctx, itemIDs(existing))
	if err != nil {
		return err
	}

	type newItem struct {
		definition Definition
		metadata   ItemMetadata
		categories []string
	}
	var createItems []newItem
	var updates []itemUpdate
	var relations []itemCategory
	var configs []fetchConfigInsert
	now := time.Now().UTC()

	for _, definition := range definitions {
		seed := buildSeedMetadata(definition)
		custom := buildCustomMetadata(definition)
		existingItem, ok := existing[definition.Slug]
		if !ok {
			meta := mergeCustomMetadata(seed, custom)
			createItems = append(createItems, newItem{definition: definition, metadata: normalizeMetadata(meta), categories: definition.Categories})
			continue
		}
		current := parseItemMetadata(existingItem.Metadata)
		merged := mergeMetadata(current, seed)
		if s.forceParserSync[definition.Slug] || isMockSeed(existingItem) {
			merged.Parser = seed.Parser
		}
		if s.forceFilterSync[definition.Slug] || isMockSeed(existingItem) {
			merged.Filter = seed.Filter
		}
		if s.forceDefaultParamsSync[definition.Slug] || isMockSeed(existingItem) {
			merged.DefaultParams = seed.DefaultParams
		}
		merged = mergeCustomMetadata(merged, custom)
		merged = normalizeMetadata(merged)

		update := itemUpdate{ID: existingItem.ID}
		if existingItem.GroupLabel == nil || *existingItem.GroupLabel == "" {
			if len(definition.Categories) > 0 {
				update.GroupLabel = stringPtr(definition.Categories[0])
			}
		}
		shouldSyncSource := existingItem.SourceFunction == definition.SourceFunction ||
			isMockSeed(existingItem) ||
			s.forceSourceSync[definition.Slug] ||
			parseProviderKind(current.ProviderKind) != definition.ProviderKind
		if shouldSyncSource {
			if existingItem.SourceFunction != definition.SourceFunction {
				update.SourceFunction = stringPtr(definition.SourceFunction)
			}
			if existingItem.SourceEndpoint != definition.Endpoint {
				update.SourceEndpoint = stringPtr(definition.Endpoint)
			}
			if nullStringValue(existingItem.SourceDocURL) != definition.DocURL {
				update.SourceDocURL = stringPtr(definition.DocURL)
			}
			if existingItem.ValueType != definition.ValueType {
				update.ValueType = valueTypePtr(definition.ValueType)
			}
			// NestJS leaves the column untouched when the definition has no
			// defaultUnit (undefined is omitted from the Prisma update).
			if definition.DefaultUnit != "" && nullStringValue(existingItem.DefaultUnit) != definition.DefaultUnit {
				update.DefaultUnit = stringPtr(definition.DefaultUnit)
			}
			if existingItem.DefaultFrequency != definition.DefaultFrequency {
				update.DefaultFrequency = frequencyPtr(definition.DefaultFrequency)
			}
		}
		if (existingItem.Description == nil || *existingItem.Description == "") && definition.Description != "" {
			update.Description = stringPtr(definition.Description)
		}
		if !metadataEqual(current, merged) {
			raw, marshalErr := json.Marshal(merged)
			if marshalErr != nil {
				return marshalErr
			}
			update.Metadata = raw
		}
		if update.hasChanges() {
			updates = append(updates, update)
		}
		for _, key := range definition.Categories {
			category, ok := categories[key]
			if !ok {
				log.Printf("economicdata: missing category %s for %s", key, definition.Slug)
				continue
			}
			relations = append(relations, itemCategory{ItemID: existingItem.ID, CategoryID: category.ID})
		}
		if _, ok := existingConfigs[existingItem.ID]; !ok {
			frequency := existingItem.DefaultFrequency
			if frequency == "" {
				frequency = definition.DefaultFrequency
			}
			configs = append(configs, fetchConfigInsert{ItemID: existingItem.ID, Frequency: frequency, IsEnabled: definition.DefaultEnabled})
		}
	}

	if len(createItems) > 0 {
		for _, entry := range createItems {
			id, idErr := newRowID()
			if idErr != nil {
				return idErr
			}
			metaRaw, marshalErr := json.Marshal(entry.metadata)
			if marshalErr != nil {
				return marshalErr
			}
			var groupLabel any
			if len(entry.definition.Categories) > 0 {
				groupLabel = entry.definition.Categories[0]
			}
			_, execErr := s.db.ExecContext(ctx,
				"INSERT IGNORE INTO `EconomicDataItem` (`id`,`slug`,`displayName`,`groupLabel`,`description`,`sourceFunction`,`sourceEndpoint`,`sourceDocUrl`,`valueType`,`defaultUnit`,`defaultFrequency`,`isActive`,`metadata`,`createdAt`,`updatedAt`) "+
					"VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
				id, entry.definition.Slug, entry.definition.DisplayName, groupLabel, nullableText(entry.definition.Description),
				entry.definition.SourceFunction, entry.definition.Endpoint, nullableText(entry.definition.DocURL),
				entry.definition.ValueType, nullableText(entry.definition.DefaultUnit), entry.definition.DefaultFrequency,
				metaRaw, now, now)
			if execErr != nil {
				return fmt.Errorf("create economic item %s: %w", entry.definition.Slug, execErr)
			}
			created, loadErr := s.loadItemBySlug(ctx, entry.definition.Slug)
			if loadErr != nil {
				return loadErr
			}
			if created == nil {
				continue
			}
			for _, key := range entry.categories {
				category, ok := categories[key]
				if !ok {
					continue
				}
				relations = append(relations, itemCategory{ItemID: created.ID, CategoryID: category.ID})
			}
			configs = append(configs, fetchConfigInsert{ItemID: created.ID, Frequency: entry.definition.DefaultFrequency, IsEnabled: entry.definition.DefaultEnabled})
		}
	}

	if len(updates) > 0 {
		if err := s.applyItemUpdates(ctx, updates, now); err != nil {
			return err
		}
	}
	if len(relations) > 0 {
		if err := s.insertRelations(ctx, relations, now); err != nil {
			return err
		}
	}
	if len(configs) > 0 {
		if err := s.insertConfigs(ctx, configs, now); err != nil {
			return err
		}
	}
	log.Printf("economicdata: catalog synchronized (%d definitions, %d created, %d updated)", len(definitions), len(createItems), len(updates))
	return nil
}

func categoryLabel(key string) string {
	tokens := strings.Split(key, "-")
	for index, token := range tokens {
		if token == "" {
			continue
		}
		tokens[index] = strings.ToUpper(token[:1]) + token[1:]
	}
	return strings.Join(tokens, " ")
}

func isMockSeed(item ItemRow) bool {
	return item.SourceFunction == "mock" && item.SourceEndpoint == "mock"
}

func itemIDs(items map[string]ItemRow) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullStringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func valueTypePtr(value ValueType) *ValueType { return &value }
func frequencyPtr(value Frequency) *Frequency { return &value }

type itemUpdate struct {
	ID               string
	GroupLabel       *string
	SourceFunction   *string
	SourceEndpoint   *string
	SourceDocURL     *string
	ValueType        *ValueType
	DefaultUnit      *string
	DefaultFrequency *Frequency
	Description      *string
	Metadata         json.RawMessage
}

func (u itemUpdate) hasChanges() bool {
	return u.GroupLabel != nil || u.SourceFunction != nil || u.SourceEndpoint != nil ||
		u.SourceDocURL != nil || u.ValueType != nil || u.DefaultUnit != nil ||
		u.DefaultFrequency != nil || u.Description != nil || len(u.Metadata) > 0
}

type itemCategory struct {
	ItemID     string
	CategoryID string
}

type fetchConfigInsert struct {
	ItemID    string
	Frequency Frequency
	IsEnabled bool
}

type categoryRow struct {
	ID  string
	Key string
}

func (s *Service) loadCategoryMap(ctx context.Context, keys []string) (map[string]categoryRow, error) {
	result := map[string]categoryRow{}
	if len(keys) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",")
	args := make([]any, 0, len(keys))
	for _, key := range keys {
		args = append(args, key)
	}
	rows, err := s.db.QueryContext(ctx, "SELECT `id`,`key` FROM `EconomicCategory` WHERE `key` IN ("+placeholders+")", args...)
	if err != nil {
		return nil, fmt.Errorf("load economic categories: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var row categoryRow
		if err := rows.Scan(&row.ID, &row.Key); err != nil {
			return nil, err
		}
		result[row.Key] = row
	}
	return result, rows.Err()
}

func (s *Service) loadItemsBySlugs(ctx context.Context, slugs []string) (map[string]ItemRow, error) {
	result := map[string]ItemRow{}
	if len(slugs) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(slugs)), ",")
	args := make([]any, 0, len(slugs))
	for _, slug := range slugs {
		args = append(args, slug)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`,`slug`,`displayName`,`description`,`sourceFunction`,`sourceEndpoint`,`sourceDocUrl`,`valueType`,`defaultUnit`,`defaultFrequency`,`isActive`,`metadata`,`groupLabel` "+
			"FROM `EconomicDataItem` WHERE `slug` IN ("+placeholders+")", args...)
	if err != nil {
		return nil, fmt.Errorf("load economic items: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		result[item.Slug] = item
	}
	return result, rows.Err()
}

func (s *Service) loadItemBySlug(ctx context.Context, slug string) (*ItemRow, error) {
	row := s.db.QueryRowContext(ctx,
		"SELECT `id`,`slug`,`displayName`,`description`,`sourceFunction`,`sourceEndpoint`,`sourceDocUrl`,`valueType`,`defaultUnit`,`defaultFrequency`,`isActive`,`metadata`,`groupLabel` "+
			"FROM `EconomicDataItem` WHERE `slug` = ? LIMIT 1", slug)
	item, err := scanItem(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanItem(row scanner) (ItemRow, error) {
	var (
		item        ItemRow
		description sql.NullString
		docURL      sql.NullString
		unit        sql.NullString
		groupLabel  sql.NullString
	)
	if err := row.Scan(&item.ID, &item.Slug, &item.DisplayName, &description, &item.SourceFunction, &item.SourceEndpoint,
		&docURL, &item.ValueType, &unit, &item.DefaultFrequency, &item.IsActive, &item.Metadata, &groupLabel); err != nil {
		return ItemRow{}, err
	}
	if description.Valid {
		item.Description = &description.String
	}
	if docURL.Valid {
		item.SourceDocURL = &docURL.String
	}
	if unit.Valid {
		item.DefaultUnit = &unit.String
	}
	item.GroupLabel = nil
	if groupLabel.Valid {
		item.GroupLabel = &groupLabel.String
	}
	return item, nil
}

func (s *Service) loadFetchConfigsByItemIDs(ctx context.Context, ids []string) (map[string]FetchConfigRow, error) {
	result := map[string]FetchConfigRow{}
	if len(ids) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx,
		"SELECT `id`,`itemId`,`frequency`,`repeatCron`,`isEnabled`,`lastRunAt`,`lastStatus`,`lastError` FROM `EconomicDataFetchConfig` WHERE `itemId` IN ("+placeholders+")", args...)
	if err != nil {
		return nil, fmt.Errorf("load economic fetch configs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			config     FetchConfigRow
			repeatCron sql.NullString
			lastRun    sql.NullTime
			lastStatus sql.NullString
			lastError  sql.NullString
		)
		if err := rows.Scan(&config.ID, &config.ItemID, &config.Frequency, &repeatCron, &config.IsEnabled, &lastRun, &lastStatus, &lastError); err != nil {
			return nil, err
		}
		if repeatCron.Valid {
			config.RepeatCron = &repeatCron.String
		}
		if lastRun.Valid {
			config.LastRunAt = &lastRun.Time
		}
		if lastStatus.Valid {
			status := RunStatus(lastStatus.String)
			config.LastStatus = &status
		}
		if lastError.Valid {
			config.LastError = &lastError.String
		}
		result[config.ItemID] = config
	}
	return result, rows.Err()
}

func (s *Service) applyItemUpdates(ctx context.Context, updates []itemUpdate, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, update := range updates {
		sets := make([]string, 0, 10)
		args := make([]any, 0, 12)
		appendSet := func(column string, value any) {
			sets = append(sets, "`"+column+"` = ?")
			args = append(args, value)
		}
		if update.GroupLabel != nil {
			appendSet("groupLabel", *update.GroupLabel)
		}
		if update.SourceFunction != nil {
			appendSet("sourceFunction", *update.SourceFunction)
		}
		if update.SourceEndpoint != nil {
			appendSet("sourceEndpoint", *update.SourceEndpoint)
		}
		if update.SourceDocURL != nil {
			appendSet("sourceDocUrl", *update.SourceDocURL)
		}
		if update.ValueType != nil {
			appendSet("valueType", *update.ValueType)
		}
		if update.DefaultUnit != nil {
			appendSet("defaultUnit", *update.DefaultUnit)
		}
		if update.DefaultFrequency != nil {
			appendSet("defaultFrequency", *update.DefaultFrequency)
		}
		if update.Description != nil {
			appendSet("description", *update.Description)
		}
		if update.Metadata != nil {
			appendSet("metadata", []byte(update.Metadata))
		}
		appendSet("updatedAt", now)
		args = append(args, update.ID)
		if _, err := tx.ExecContext(ctx, "UPDATE `EconomicDataItem` SET "+strings.Join(sets, ",")+" WHERE `id` = ?", args...); err != nil {
			return fmt.Errorf("update economic item %s: %w", update.ID, err)
		}
	}
	return tx.Commit()
}

func (s *Service) insertRelations(ctx context.Context, relations []itemCategory, now time.Time) error {
	for _, relation := range relations {
		id, err := newRowID()
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx,
			"INSERT IGNORE INTO `EconomicDataItemCategory` (`id`,`itemId`,`categoryId`,`createdAt`) VALUES (?,?,?,?)",
			id, relation.ItemID, relation.CategoryID, now); err != nil {
			return fmt.Errorf("create economic item category: %w", err)
		}
	}
	return nil
}

func (s *Service) insertConfigs(ctx context.Context, configs []fetchConfigInsert, now time.Time) error {
	for _, config := range configs {
		id, err := newRowID()
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx,
			"INSERT IGNORE INTO `EconomicDataFetchConfig` (`id`,`itemId`,`frequency`,`repeatCron`,`isEnabled`,`createdAt`,`updatedAt`) VALUES (?,?,?,NULL,?,?,?)",
			id, config.ItemID, config.Frequency, config.IsEnabled, now, now); err != nil {
			return fmt.Errorf("create economic fetch config: %w", err)
		}
	}
	return nil
}
