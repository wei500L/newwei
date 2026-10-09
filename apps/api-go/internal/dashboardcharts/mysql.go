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

func (s *MySQLStore) SectorPoint(ctx context.Context, itemID, field string, start, end time.Time, desc bool) (*samplePoint, error) {
	direction := "ASC"
	if desc {
		direction = "DESC"
	}
	row := s.db.QueryRowContext(ctx, `
SELECT recordedAt, value, unit
FROM EconomicDataPoint
WHERE itemId = ? AND sourceField = ? AND recordedAt >= ? AND recordedAt <= ?
ORDER BY recordedAt `+direction+`
LIMIT 1`, itemID, field, start.UTC(), end.UTC())
	point, err := scanSample(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &point, nil
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
		parsed, err := strconv.ParseFloat(string(rawValue), 64)
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

type scanner interface {
	Scan(dest ...any) error
}

func scanSample(row scanner) (samplePoint, error) {
	var point samplePoint
	var rawValue []byte
	err := row.Scan(&point.RecordedAt, &rawValue, &point.Unit)
	if err != nil {
		return samplePoint{}, err
	}
	parsed, err := strconv.ParseFloat(string(rawValue), 64)
	if err != nil {
		return samplePoint{}, err
	}
	point.Value = parsed
	return point, nil
}
