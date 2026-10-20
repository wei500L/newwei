package dashboardcharts

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// MySQLStore 读 EconomicDataItem / EconomicDataPoint。
// 查询不带 orgId：NestJS 这两个图表也是全局经济序列，不是租户表。
type MySQLStore struct {
	db *sql.DB
}

func NewMySQLStore(db *sql.DB) *MySQLStore {
	return &MySQLStore{db: db}
}

func (s *MySQLStore) SectorItems(ctx context.Context) ([]sectorItem, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT i.id, i.slug, i.displayName, i.defaultUnit, i.metadata
FROM EconomicDataItem i
WHERE i.isActive = 1
  AND EXISTS (
    SELECT 1
    FROM EconomicDataItemCategory ic
    INNER JOIN EconomicCategory c ON c.id = ic.categoryId
    WHERE ic.itemId = i.id AND c.`+"`key`"+` = ?
  )
ORDER BY i.displayName ASC
LIMIT ?`, sectorCategory, maxSectorCells)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []sectorItem
	for rows.Next() {
		var item sectorItem
		var meta []byte
		if err := rows.Scan(&item.ID, &item.Slug, &item.DisplayName, &item.DefaultUnit, &meta); err != nil {
			return nil, err
		}
		if len(meta) > 0 {
			item.Metadata = json.RawMessage(meta)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *MySQLStore) SectorFields(ctx context.Context, ids []string, start, end time.Time) (map[string][]string, error) {
	fields := map[string][]string{}
	if len(ids) == 0 {
		return fields, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+2)
	for _, id := range ids {
		args = append(args, id)
	}
	args = append(args, start.UTC(), end.UTC())
	rows, err := s.db.QueryContext(ctx, `
SELECT itemId, sourceField
FROM EconomicDataPoint
WHERE itemId IN (`+placeholders+`)
  AND recordedAt >= ? AND recordedAt <= ?
GROUP BY itemId, sourceField`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var itemID, sourceField string
		if err := rows.Scan(&itemID, &sourceField); err != nil {
			return nil, err
		}
		if itemID == "" || sourceField == "" {
			continue
		}
		fields[itemID] = append(fields[itemID], sourceField)
	}
	return fields, rows.Err()
}

// sectorEndpointQuery builds the batched first/last lookup. Every branch keeps
// the plan of the previous single-point queries: equality on itemId +
// sourceField walks the (itemId, sourceField, recordedAt) index in range order
// and LIMIT 1 stops at the first row. Joining the branches with UNION ALL turns
// 2*N round trips into one without widening any branch into a range scan.
//
// Each branch is parenthesised because MySQL rejects a per-SELECT ORDER BY +
// LIMIT inside a bare UNION (the ORDER BY would bind to the whole union).
func sectorEndpointQuery(keys []seriesKey, start, end time.Time) (string, []any) {
	edge := func(rank int, direction string) string {
		return "(SELECT " + strconv.Itoa(rank) + " AS `edge`, itemId, sourceField, recordedAt, value, unit" +
			"\nFROM EconomicDataPoint" +
			"\nWHERE itemId = ? AND sourceField = ? AND recordedAt >= ? AND recordedAt <= ?" +
			"\nORDER BY recordedAt " + direction +
			"\nLIMIT 1)"
	}
	var query strings.Builder
	query.Grow(len(keys) * 2 * 320)
	args := make([]any, 0, len(keys)*8)
	for _, key := range keys {
		for _, branch := range [2]string{edge(sectorFirstEdge, "ASC"), edge(sectorLastEdge, "DESC")} {
			if query.Len() > 0 {
				query.WriteString("\nUNION ALL\n")
			}
			query.WriteString(branch)
			args = append(args, key.ItemID, key.Field, start.UTC(), end.UTC())
		}
	}
	return query.String(), args
}

const (
	sectorFirstEdge = 1
	sectorLastEdge  = 0
)

// SectorEndpoints returns the first and last sample of every requested series.
// A series without rows in the window is absent from the result, which is what
// the old two lookups signalled with a nil point.
func (s *MySQLStore) SectorEndpoints(ctx context.Context, keys []seriesKey, start, end time.Time) (map[seriesKey]seriesEndpoints, error) {
	endpoints := make(map[seriesKey]seriesEndpoints, len(keys))
	if len(keys) == 0 {
		return endpoints, nil
	}
	query, args := sectorEndpointQuery(keys, start, end)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			edge   int
			key    seriesKey
			point  samplePoint
			rawVal []byte
		)
		if err := rows.Scan(&edge, &key.ItemID, &key.Field, &point.RecordedAt, &rawVal, &point.Unit); err != nil {
			return nil, err
		}
		value, err := parseDecimal(rawVal)
		if err != nil {
			return nil, err
		}
		point.Value = value
		entry := endpoints[key]
		if edge == sectorFirstEdge {
			entry.First = point
		} else {
			entry.Last = point
		}
		endpoints[key] = entry
	}
	return endpoints, rows.Err()
}

func (s *MySQLStore) CandleItem(ctx context.Context) (*candleItem, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT id, displayName, defaultFrequency, defaultUnit, metadata
FROM EconomicDataItem
WHERE slug = ?
LIMIT 1`, candlestickSlug)
	var item candleItem
	var meta []byte
	err := row.Scan(&item.ID, &item.DisplayName, &item.DefaultFrequency, &item.DefaultUnit, &meta)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(meta) > 0 {
		item.Metadata = json.RawMessage(meta)
	}
	return &item, nil
}

func (s *MySQLStore) CandlePoints(ctx context.Context, itemID string, fields []string, start, end time.Time) ([]rawPoint, error) {
	if len(fields) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(fields)), ",")
	args := make([]any, 0, len(fields)+3)
	args = append(args, itemID, start.UTC(), end.UTC())
	for _, field := range fields {
		args = append(args, field)
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT recordedAt, value, unit, sourceField
FROM EconomicDataPoint
WHERE itemId = ? AND recordedAt >= ? AND recordedAt <= ?
  AND sourceField IN (`+placeholders+`)
ORDER BY recordedAt ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var points []rawPoint
	for rows.Next() {
		var point rawPoint
		var rawValue []byte
		if err := rows.Scan(&point.RecordedAt, &rawValue, &point.Unit, &point.SourceField); err != nil {
			return nil, err
		}
		parsed, err := parseDecimal(rawValue)
		if err != nil {
			return nil, err
		}
		point.Value = parsed
		points = append(points, point)
	}
	return points, rows.Err()
}

func (s *MySQLStore) CandleCount(ctx context.Context, itemID string, start, end time.Time) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM EconomicDataPoint
WHERE itemId = ? AND recordedAt >= ? AND recordedAt <= ?`, itemID, start.UTC(), end.UTC()).Scan(&count)
	return count, err
}

func (s *MySQLStore) CandleFields(ctx context.Context, itemID string, start, end time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT DISTINCT sourceField
FROM EconomicDataPoint
WHERE itemId = ? AND recordedAt >= ? AND recordedAt <= ?
LIMIT 50`, itemID, start.UTC(), end.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fields []string
	for rows.Next() {
		var field string
		if err := rows.Scan(&field); err != nil {
			return nil, err
		}
		fields = append(fields, field)
	}
	return fields, rows.Err()
}

// parseDecimal reads a DECIMAL(38,12) column and folds -0 into +0.
// JSON.stringify prints negative zero as "0" while encoding/json prints "-0",
// so a stored "-0.000000000000" must not reach the response.
func parseDecimal(raw []byte) (float64, error) {
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil {
		return 0, err
	}
	if value == 0 {
		return 0, nil
	}
	return value, nil
}
