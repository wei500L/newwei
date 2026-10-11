package contentcatalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

func (s *Service) syncCatalog(ctx context.Context, orgID string) error {
	if s.db == nil {
		return errDatabaseUnavailable
	}
	merged, taxonomy, err := s.loadAllCandidates(ctx, orgID)
	if err != nil {
		return err
	}
	if len(merged) == 0 {
		return s.replaceSnapshot(ctx, orgID, nil)
	}
	classified, err := s.classifyCandidates(ctx, orgID, merged, taxonomy)
	if err != nil {
		return err
	}
	byKey := make(map[string]resolution, len(classified))
	for _, entry := range classified {
		byKey[subscriptionKey(entry.Kind, entry.NormalizedValue)] = entry
	}
	rows := make([]resolution, 0, len(merged))
	seen := map[string]struct{}{}
	for _, item := range merged {
		key := subscriptionKey(item.Kind, item.NormalizedValue)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		resolved, ok := byKey[key]
		if !ok {
			resolved = adHocResolution(item, taxonomy.Version, catalogTaxonomyPath(item, nil, taxonomy, nil))
		}
		resolved.Count = item.Count
		resolved.LastSeenAt = item.LastSeenAt
		resolved.DisplayValue = item.DisplayValue
		if item.Metadata != nil {
			resolved.Metadata = item.Metadata
			resolved.MetadataExplicit = true
		}
		rows = append(rows, resolved)
	}
	return s.replaceSnapshot(ctx, orgID, rows)
}

func (s *Service) replaceSnapshot(ctx context.Context, orgID string, rows []resolution) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
DELETE FROM ContentSubscriptionCatalog
WHERE orgId = ? AND kind IN ('topic','entity','source','keyword','geo')`, orgID); err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, batch := range chunk(rows, catalogPersistBatch) {
		if err := insertCatalogBatch(ctx, tx, orgID, batch, now); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return tx.Commit()
}

func insertCatalogBatch(ctx context.Context, tx *sql.Tx, orgID string, rows []resolution, now time.Time) error {
	if len(rows) == 0 {
		return nil
	}
	var builder strings.Builder
	builder.WriteString(`INSERT INTO ContentSubscriptionCatalog
(id, orgId, kind, normalizedValue, displayValue, count, lastSeenAt, taxonomyPath, taxonomyVersion, embeddingModel, embeddingVector, metadata, createdAt, updatedAt)
VALUES `)
	args := make([]any, 0, len(rows)*14)
	for i, row := range rows {
		if i > 0 {
			builder.WriteString(",")
		}
		builder.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
		id, err := newCatalogID()
		if err != nil {
			return err
		}
		var path any
		if row.TaxonomyPath != nil && *row.TaxonomyPath != "" {
			path = *row.TaxonomyPath
		}
		var version any
		if row.TaxonomyVersion != "" {
			version = row.TaxonomyVersion
		}
		var model any
		if row.EmbeddingModel != nil && *row.EmbeddingModel != "" {
			model = *row.EmbeddingModel
		}
		var vector any
		if len(row.EmbeddingVector) > 0 {
			encoded, err := json.Marshal(row.EmbeddingVector)
			if err != nil {
				return err
			}
			vector = encoded
		}
		metadata := row.Metadata
		if metadata == nil {
			metadata = map[string]any{}
		}
		encodedMeta, err := json.Marshal(metadata)
		if err != nil {
			return err
		}
		args = append(args, id, orgID, row.Kind, row.NormalizedValue, row.DisplayValue, row.Count, mysqlTime(row.LastSeenAt), path, version, model, vector, encodedMeta, mysqlTime(now), mysqlTime(now))
	}
	_, err := tx.ExecContext(ctx, builder.String(), args...)
	return err
}

func (s *Service) queryCatalog(ctx context.Context, query string, args ...any) ([]catalogRow, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catalogRow
	for rows.Next() {
		item, err := scanCatalogRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if out == nil {
		out = []catalogRow{}
	}
	return out, rows.Err()
}

func scanCatalogRow(rows *sql.Rows) (catalogRow, error) {
	var item catalogRow
	var last time.Time
	var path, version, model sql.NullString
	if err := rows.Scan(
		&item.Kind,
		&item.NormalizedValue,
		&item.DisplayValue,
		&item.Count,
		&last,
		&path,
		&version,
		&model,
		&item.EmbeddingVector,
		&item.Metadata,
	); err != nil {
		return catalogRow{}, err
	}
	item.LastSeenAt = last
	if path.Valid {
		item.TaxonomyPath = path.String
		item.HasTaxonomyPath = true
	}
	if version.Valid {
		item.TaxonomyVersion = version.String
	}
	if model.Valid {
		item.EmbeddingModel = model.String
	}
	return item, nil
}

const catalogSelect = `SELECT kind, normalizedValue, displayValue, count, lastSeenAt, taxonomyPath, taxonomyVersion, embeddingModel, embeddingVector, metadata FROM ContentSubscriptionCatalog`

func (s *Service) listRows(ctx context.Context, orgID, kind, query, taxonomyPath string, limit int) ([]catalogRow, error) {
	since := sinceWindow(time.Now())
	var builder strings.Builder
	builder.WriteString(catalogSelect)
	builder.WriteString(` WHERE orgId = ? AND count >= ? AND lastSeenAt >= ?`)
	args := []any{orgID, catalogMinCount, since}
	if kind != "" {
		builder.WriteString(` AND kind = ?`)
		args = append(args, kind)
	}
	switch strings.TrimSpace(taxonomyPath) {
	case "":
	case uncategorizedFilter:
		builder.WriteString(` AND taxonomyPath IS NULL`)
	default:
		builder.WriteString(` AND taxonomyPath LIKE ?`)
		args = append(args, likePrefix(strings.TrimSpace(taxonomyPath)))
	}
	if trimmed := strings.TrimSpace(query); trimmed != "" {
		_, normalized := normalizeValue(trimmed, "")
		builder.WriteString(` AND (displayValue LIKE ? OR normalizedValue LIKE ?)`)
		args = append(args, likeContains(trimmed), likeContains(normalized))
	}
	builder.WriteString(` ORDER BY count DESC, lastSeenAt DESC, displayValue ASC LIMIT ?`)
	args = append(args, limit)
	return s.queryCatalog(ctx, builder.String(), args...)
}

func (s *Service) recommendationRows(ctx context.Context, orgID string) ([]catalogRow, error) {
	since := sinceWindow(time.Now())
	args := []any{orgID, catalogMinCount, since}
	for _, kind := range catalogKinds {
		args = append(args, kind)
	}
	args = append(args, recommendationPool*4)
	return s.queryCatalog(ctx, catalogSelect+`
WHERE orgId = ? AND count >= ? AND lastSeenAt >= ? AND kind IN (?,?,?,?,?)
ORDER BY count DESC, lastSeenAt DESC
LIMIT ?`, args...)
}

func (s *Service) relatedRows(ctx context.Context, orgID, normalized, branch string) ([]catalogRow, error) {
	since := sinceWindow(time.Now())
	query := catalogSelect + `
WHERE orgId = ? AND kind = ? AND count >= ? AND lastSeenAt >= ? AND normalizedValue <> ?`
	args := []any{orgID, "topic", catalogMinCount, since, normalized}
	if branch != "" {
		query += ` AND taxonomyPath LIKE ?`
		args = append(args, likePrefix(branch))
	}
	query += ` ORDER BY count DESC, lastSeenAt DESC LIMIT ?`
	args = append(args, relatedTopicPool*3)
	return s.queryCatalog(ctx, query, args...)
}

func (s *Service) findCatalogEntries(ctx context.Context, orgID string, entries []inputEntry) (map[string]catalogRow, error) {
	found := map[string]catalogRow{}
	if len(entries) == 0 {
		return found, nil
	}
	var builder strings.Builder
	builder.WriteString(catalogSelect)
	builder.WriteString(` WHERE orgId = ? AND (`)
	args := []any{orgID}
	for i, entry := range entries {
		if i > 0 {
			builder.WriteString(` OR `)
		}
		builder.WriteString(`(kind = ? AND normalizedValue = ?)`)
		args = append(args, entry.Kind, entry.NormalizedValue)
	}
	builder.WriteString(`)`)
	rows, err := s.queryCatalog(ctx, builder.String(), args...)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		found[subscriptionKey(row.Kind, row.NormalizedValue)] = row
	}
	return found, nil
}

func likeContains(value string) string {
	return "%" + escapeLike(value) + "%"
}

func likePrefix(value string) string {
	return escapeLike(value) + "%"
}

func escapeLike(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return replacer.Replace(value)
}
