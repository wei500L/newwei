package economicdata

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

const (
	dataPointBatchSize     = 1000
	dataPointBatchMaxBytes = 2_000_000
)

type upsertDataPointRow struct {
	recordedAt  time.Time
	value       string
	unit        *string
	dataType    ValueType
	sourceField string
	metaJSON    []byte
	bytes       int
}

type latestDataPointRow struct {
	value    string
	unit     *string
	dataType string
}

// bulkUpsertDataPoints deduplicates by (recordedAt millis, sourceField), keeps
// the last point, applies the optional unchanged-latest filter, then inserts in
// row/byte bounded batches.
func (s *Service) bulkUpsertDataPoints(ctx context.Context, itemID string, points []ParsedDataPoint, definition *ItemConfig) (int, error) {
	deduped := map[string]ParsedDataPoint{}
	order := make([]string, 0, len(points))
	for _, point := range points {
		if math.IsNaN(point.Value) || math.IsInf(point.Value, 0) {
			continue
		}
		key := fmt.Sprintf("%d|%s", point.RecordedAt.UnixMilli(), point.SourceField)
		if _, exists := deduped[key]; !exists {
			order = append(order, key)
		}
		deduped[key] = point
	}
	if len(deduped) == 0 {
		return 0, nil
	}
	sorted := make([]ParsedDataPoint, 0, len(deduped))
	for _, key := range order {
		sorted = append(sorted, deduped[key])
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].RecordedAt.Equal(sorted[j].RecordedAt) {
			return sorted[i].SourceField < sorted[j].SourceField
		}
		return sorted[i].RecordedAt.Before(sorted[j].RecordedAt)
	})
	rows := make([]upsertDataPointRow, 0, len(sorted))
	for _, point := range sorted {
		row, err := toUpsertRow(itemID, point)
		if err != nil {
			return 0, err
		}
		rows = append(rows, row)
	}
	var err error
	rows, err = s.filterUnchangedLatestRows(ctx, itemID, definition, rows)
	if err != nil {
		return 0, err
	}
	if len(rows) == 0 {
		return 0, nil
	}
	chunk := make([]upsertDataPointRow, 0, dataPointBatchSize)
	chunkBytes := 0
	for _, row := range rows {
		if len(chunk) >= dataPointBatchSize || (len(chunk) > 0 && chunkBytes+row.bytes > dataPointBatchMaxBytes) {
			if err := s.executeUpsertChunk(ctx, itemID, chunk); err != nil {
				return 0, err
			}
			chunk = chunk[:0]
			chunkBytes = 0
		}
		chunk = append(chunk, row)
		chunkBytes += row.bytes
	}
	if len(chunk) > 0 {
		if err := s.executeUpsertChunk(ctx, itemID, chunk); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}

func toUpsertRow(itemID string, point ParsedDataPoint) (upsertDataPointRow, error) {
	value := strconv.FormatFloat(point.Value, 'f', -1, 64)
	var meta []byte
	if len(point.Meta) > 0 {
		meta = append([]byte(nil), point.Meta...)
	}
	row := upsertDataPointRow{
		recordedAt:  point.RecordedAt.UTC(),
		value:       value,
		unit:        point.Unit,
		dataType:    point.DataType,
		sourceField: point.SourceField,
		metaJSON:    meta,
	}
	row.bytes = estimateRowBytes(itemID, row)
	return row, nil
}

func estimateRowBytes(itemID string, row upsertDataPointRow) int {
	bytes := 96 + len(itemID) + len(row.recordedAt.UTC().Format(time.RFC3339Nano)) + len(row.dataType) + len(row.value) + len(row.sourceField) + len(row.metaJSON)
	if row.unit != nil {
		bytes += len(*row.unit)
	}
	return bytes
}

func (s *Service) filterUnchangedLatestRows(ctx context.Context, itemID string, definition *ItemConfig, rows []upsertDataPointRow) ([]upsertDataPointRow, error) {
	if !s.shouldSkipUnchangedLatestRows(definition) || len(rows) == 0 {
		return rows, nil
	}
	fields := make([]string, 0)
	seen := map[string]bool{}
	for _, row := range rows {
		if !seen[row.sourceField] {
			seen[row.sourceField] = true
			fields = append(fields, row.sourceField)
		}
	}
	latest, err := s.loadLatestRows(ctx, itemID, fields)
	if err != nil {
		return nil, err
	}
	if len(latest) == 0 {
		return rows, nil
	}
	filtered := make([]upsertDataPointRow, 0, len(rows))
	for _, row := range rows {
		existing, ok := latest[row.sourceField]
		if !ok || !latestRowMatches(existing, row) {
			filtered = append(filtered, row)
		}
	}
	return filtered, nil
}

func (s *Service) shouldSkipUnchangedLatestRows(definition *ItemConfig) bool {
	if !s.env.SkipUnchangedLatest || definition == nil {
		return false
	}
	if definition.DefaultFrequency != FrequencyRealtime && definition.DefaultFrequency != FrequencyHourly {
		return false
	}
	if definition.ProviderKind != ProviderAkshare {
		return false
	}
	parser := definition.ProviderConfig.Parser
	return parser != nil && parser.Type == ParserLatest && parser.TimestampField == ""
}

func (s *Service) loadLatestRows(ctx context.Context, itemID string, sourceFields []string) (map[string]latestDataPointRow, error) {
	result := map[string]latestDataPointRow{}
	if len(sourceFields) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(sourceFields)), ",")
	args := make([]any, 0, len(sourceFields)+1)
	args = append(args, itemID)
	for _, field := range sourceFields {
		args = append(args, field)
	}
	limit := len(sourceFields) * 8
	if limit < 64 {
		limit = 64
	}
	query := "SELECT `sourceField`,`value`,`unit`,`dataType` FROM `EconomicDataPoint` WHERE `itemId` = ? AND `sourceField` IN (" +
		placeholders + ") ORDER BY `recordedAt` DESC, `id` DESC LIMIT " + strconv.Itoa(limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			field    string
			value    []byte
			unit     sql.NullString
			dataType string
		)
		if err := rows.Scan(&field, &value, &unit, &dataType); err != nil {
			return nil, err
		}
		if _, exists := result[field]; exists {
			continue
		}
		row := latestDataPointRow{value: string(value), dataType: dataType}
		if unit.Valid {
			row.unit = &unit.String
		}
		result[field] = row
		if len(result) >= len(sourceFields) {
			break
		}
	}
	return result, rows.Err()
}

func latestRowMatches(existing latestDataPointRow, row upsertDataPointRow) bool {
	if existing.dataType != string(row.dataType) || !sameUnit(existing.unit, row.unit) {
		return false
	}
	left, leftOK := new(big.Rat).SetString(existing.value)
	right, rightOK := new(big.Rat).SetString(row.value)
	return leftOK && rightOK && left.Cmp(right) == 0
}

func sameUnit(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *Service) applyProviderCleanup(ctx context.Context, itemID string, cleanup []time.Time) (int, error) {
	unique := map[int64]time.Time{}
	for _, recordedAt := range cleanup {
		if recordedAt.IsZero() {
			continue
		}
		unique[recordedAt.UnixMilli()] = recordedAt.UTC()
	}
	if len(unique) == 0 {
		return 0, nil
	}
	values := make([]time.Time, 0, len(unique))
	for _, recordedAt := range unique {
		values = append(values, recordedAt)
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")
	args := make([]any, 0, len(values)+1)
	args = append(args, itemID)
	for _, value := range values {
		args = append(args, value)
	}
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM `EconomicDataPoint` WHERE `itemId` = ? AND `recordedAt` IN ("+placeholders+")", args...)
	if err != nil {
		return 0, err
	}
	affected, _ := result.RowsAffected()
	return int(affected), nil
}

func (s *Service) executeUpsertChunk(ctx context.Context, itemID string, rows []upsertDataPointRow) error {
	if len(rows) == 0 {
		return nil
	}
	query, args, err := buildUpsertQuery(itemID, rows)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, query, args...)
	if err == nil {
		return nil
	}
	if isPacketTooLarge(err) && len(rows) > 1 {
		mid := (len(rows) + 1) / 2
		if splitErr := s.executeUpsertChunk(ctx, itemID, rows[:mid]); splitErr != nil {
			return splitErr
		}
		return s.executeUpsertChunk(ctx, itemID, rows[mid:])
	}
	return err
}

func buildUpsertQuery(itemID string, rows []upsertDataPointRow) (string, []any, error) {
	args := make([]any, 0, len(rows)*8)
	placeholders := make([]string, 0, len(rows))
	for _, row := range rows {
		id, err := newRowID()
		if err != nil {
			return "", nil, err
		}
		placeholders = append(placeholders, "(?,?,?,?,?,?,?,?)")
		var meta any
		if len(row.metaJSON) > 0 {
			meta = row.metaJSON
		}
		var unit any
		if row.unit != nil {
			unit = *row.unit
		}
		args = append(args, id, itemID, row.recordedAt, row.dataType, row.value, unit, row.sourceField, meta)
	}
	query := "INSERT INTO `EconomicDataPoint` (`id`,`itemId`,`recordedAt`,`dataType`,`value`,`unit`,`sourceField`,`sourceMeta`) VALUES " +
		strings.Join(placeholders, ",") +
		" ON DUPLICATE KEY UPDATE `value` = VALUES(`value`), `unit` = VALUES(`unit`), `dataType` = VALUES(`dataType`), `sourceMeta` = VALUES(`sourceMeta`)"
	return query, args, nil
}

func isPacketTooLarge(err error) bool {
	var mysqlErr *mysql.MySQLError
	if !errorsAs(err, &mysqlErr) {
		return false
	}
	if mysqlErr.Number == 1153 {
		return true
	}
	message := strings.ToLower(mysqlErr.Message)
	return strings.Contains(message, "max_allowed_packet") || (strings.Contains(message, "packet") && strings.Contains(message, "too"))
}

// errorsAs is a tiny wrapper so this file's import list stays explicit.
func errorsAs(err error, target **mysql.MySQLError) bool {
	for err != nil {
		if mysqlErr, ok := err.(*mysql.MySQLError); ok {
			*target = mysqlErr
			return true
		}
		type unwrapper interface{ Unwrap() error }
		wrapped, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = wrapped.Unwrap()
	}
	return false
}
