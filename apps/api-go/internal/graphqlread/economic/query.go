package economic

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const (
	defaultPageLimit = 100
	maxPageLimit     = 1000
	noRowLimit       = -1
)

type itemRow struct {
	slug             string
	displayName      sql.NullString
	groupLabel       sql.NullString
	defaultUnit      sql.NullString
	defaultFrequency string
	metadata         []byte
}

func (item itemRow) model() EconomicDataItemModel {
	display := item.slug
	if item.displayName.Valid {
		display = item.displayName.String
	}
	return EconomicDataItemModel{
		Slug:        item.slug,
		DisplayName: display,
		GroupLabel:  nullString(item.groupLabel),
		DefaultUnit: nullString(item.defaultUnit),
		Metadata:    parseMetadata(item.metadata),
	}
}

type dataPoint struct {
	id          string
	itemID      string
	recordedAt  time.Time
	dataType    string
	value       float64
	unit        sql.NullString
	sourceField sql.NullString
	item        itemRow
}

type loadRequest struct {
	category    string
	start       time.Time
	end         time.Time
	granularity string
	paginate    bool
	cursor      string
	limit       int
}

type loadResult struct {
	points     []dataPoint
	hasMore    bool
	nextCursor *string
	totalCount *int
}

type reader struct {
	db *sql.DB
}

func (r *reader) load(ctx context.Context, req loadRequest) (loadResult, error) {
	if r == nil || r.db == nil {
		return loadResult{}, fmt.Errorf("economic data database is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	start, end := req.start.UTC(), req.end.UTC()
	if req.granularity != "" {
		start, end = alignRange(start, end, req.granularity)
	}
	var cursor *pageCursor
	// A granularity window reads every aligned point. Cursor and limit are ignored,
	// and a cursor that does not decode is ignored rather than reported.
	if req.paginate && req.granularity == "" && req.cursor != "" {
		if decoded, ok := decodeCursor(req.cursor); ok {
			cursor = &decoded
		}
	}
	take := noRowLimit
	if req.paginate && req.granularity == "" {
		take = req.limit + 1
		if take < 0 {
			take = 0
		}
	}
	points, err := r.queryPoints(ctx, req.category, start, end, cursor, take)
	if err != nil {
		return loadResult{}, err
	}
	if req.granularity != "" {
		points = bucketPoints(points, req.granularity)
		out := loadResult{points: points}
		if req.paginate {
			out.totalCount = intPtr(len(points))
		}
		return out, nil
	}
	if !req.paginate {
		return loadResult{points: points}, nil
	}
	return pagePoints(points, req.limit), nil
}

func pagePoints(points []dataPoint, limit int) loadResult {
	hasMore := len(points) > limit
	if hasMore && limit >= 0 && limit <= len(points) {
		points = points[:limit]
	}
	if hasMore && limit < 0 {
		points = []dataPoint{}
	}
	var next *string
	if hasMore && len(points) > 0 {
		last := points[len(points)-1]
		encoded := encodeCursor(last.recordedAt, last.id)
		next = &encoded
	}
	return loadResult{points: points, hasMore: hasMore, nextCursor: next}
}

func (r *reader) queryPoints(ctx context.Context, category string, start, end time.Time, cursor *pageCursor, take int) ([]dataPoint, error) {
	query := "SELECT p.`id`, p.`itemId`, p.`recordedAt`, p.`dataType`, p.`value`, p.`unit`, p.`sourceField`, " +
		"i.`slug`, i.`displayName`, i.`groupLabel`, i.`defaultUnit`, i.`defaultFrequency`, i.`metadata` " +
		"FROM `EconomicDataPoint` p " +
		"INNER JOIN `EconomicDataItem` i ON i.`id` = p.`itemId` " +
		"INNER JOIN `EconomicDataItemCategory` ic ON ic.`itemId` = i.`id` " +
		"INNER JOIN `EconomicCategory` c ON c.`id` = ic.`categoryId` " +
		"WHERE c.`key` = ? AND p.`recordedAt` >= ? AND p.`recordedAt` <= ?"
	args := []any{category, start, end}
	if cursor != nil {
		query += " AND (p.`recordedAt` > ? OR (p.`recordedAt` = ? AND p.`id` > ?))"
		args = append(args, cursor.recordedAt, cursor.recordedAt, cursor.id)
	}
	query += " ORDER BY p.`recordedAt` ASC, p.`id` ASC"
	if take >= 0 {
		query += " LIMIT ?"
		args = append(args, take)
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query economic data points: %w", err)
	}
	defer rows.Close()
	points := make([]dataPoint, 0)
	for rows.Next() {
		var point dataPoint
		var recorded time.Time
		var rawValue []byte
		var meta []byte
		if err := rows.Scan(
			&point.id,
			&point.itemID,
			&recorded,
			&point.dataType,
			&rawValue,
			&point.unit,
			&point.sourceField,
			&point.item.slug,
			&point.item.displayName,
			&point.item.groupLabel,
			&point.item.defaultUnit,
			&point.item.defaultFrequency,
			&meta,
		); err != nil {
			return nil, fmt.Errorf("scan economic data point: %w", err)
		}
		parsed, ok := contract.FiniteFloat(rawValue)
		if !ok {
			return nil, fmt.Errorf("economic data point %s: non-finite value", point.id)
		}
		point.value = parsed
		point.recordedAt = recorded.UTC()
		if len(meta) > 0 {
			point.item.metadata = append([]byte(nil), meta...)
		}
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read economic data points: %w", err)
	}
	return points, nil
}

func (r *reader) listFetchConfigs(ctx context.Context) ([]EconomicDataFetchConfigModel, error) {
	if r == nil || r.db == nil {
		return nil, fmt.Errorf("economic data database is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	rows, err := r.db.QueryContext(ctx, "SELECT f.`id`, f.`frequency`, f.`repeatCron`, f.`isEnabled`, f.`lastRunAt`, f.`lastStatus`, f.`lastError`, "+
		"i.`slug`, i.`displayName`, i.`groupLabel`, i.`defaultUnit`, i.`metadata` "+
		"FROM `EconomicDataFetchConfig` f "+
		"INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId` "+
		"ORDER BY f.`updatedAt` DESC")
	if err != nil {
		return nil, fmt.Errorf("query economic fetch configs: %w", err)
	}
	defer rows.Close()
	configs := make([]EconomicDataFetchConfigModel, 0)
	for rows.Next() {
		var (
			id         string
			frequency  string
			repeatCron sql.NullString
			enabled    bool
			lastRun    sql.NullTime
			lastStatus sql.NullString
			lastError  sql.NullString
			item       itemRow
			meta       []byte
		)
		if err := rows.Scan(
			&id,
			&frequency,
			&repeatCron,
			&enabled,
			&lastRun,
			&lastStatus,
			&lastError,
			&item.slug,
			&item.displayName,
			&item.groupLabel,
			&item.defaultUnit,
			&meta,
		); err != nil {
			return nil, fmt.Errorf("scan economic fetch config: %w", err)
		}
		if len(meta) > 0 {
			item.metadata = append([]byte(nil), meta...)
		}
		configs = append(configs, EconomicDataFetchConfigModel{
			ID:         id,
			Frequency:  frequency,
			RepeatCron: nullString(repeatCron),
			IsEnabled:  enabled,
			LastRunAt:  nullTime(lastRun),
			LastStatus: nullString(lastStatus),
			LastError:  nullString(lastError),
			Item:       item.model(),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read economic fetch configs: %w", err)
	}
	return configs, nil
}

// presetCategoryKey is Nest's ECONOMIC_DASHBOARD_REFRESH_PRESET_CONFIG lookup.
// Item counts and the latest run are read from EconomicDataFetchConfig.
var presetCategoryKey = map[string]string{
	"keyMonitor":       "key-monitor",
	"militaryAlert":    "military-alert",
	"economicAlert":    "economic-alert",
	"economicShort":    "economic-short",
	"economicMedium":   "economic-medium",
	"economicLong":     "economic-long",
	"livelihoodPrices": "livelihood-prices",
}

type presetConfigRow struct {
	isEnabled  bool
	itemActive bool
	lastRunAt  sql.NullTime
	lastStatus sql.NullString
	lastError  sql.NullString
}

func (r *reader) presetStatus(ctx context.Context, preset string) (EconomicDataRefreshPresetStatusModel, error) {
	categoryKey, ok := presetCategoryKey[preset]
	if !ok {
		return EconomicDataRefreshPresetStatusModel{}, failure(http.StatusBadRequest, "Unsupported economic refresh preset: "+preset)
	}
	if r == nil || r.db == nil {
		return EconomicDataRefreshPresetStatusModel{}, fmt.Errorf("economic data database is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	rows, err := r.db.QueryContext(ctx, "SELECT f.`isEnabled`, f.`lastRunAt`, f.`lastStatus`, f.`lastError`, i.`isActive` "+
		"FROM `EconomicDataFetchConfig` f "+
		"INNER JOIN `EconomicDataItem` i ON i.`id` = f.`itemId` "+
		"INNER JOIN `EconomicDataItemCategory` ic ON ic.`itemId` = i.`id` "+
		"INNER JOIN `EconomicCategory` c ON c.`id` = ic.`categoryId` "+
		"WHERE c.`key` = ? "+
		"ORDER BY f.`id` ASC", categoryKey)
	if err != nil {
		return EconomicDataRefreshPresetStatusModel{}, fmt.Errorf("query economic refresh preset: %w", err)
	}
	defer rows.Close()
	var (
		total   int
		enabled int
		latest  *presetConfigRow
	)
	for rows.Next() {
		var row presetConfigRow
		if err := rows.Scan(&row.isEnabled, &row.lastRunAt, &row.lastStatus, &row.lastError, &row.itemActive); err != nil {
			return EconomicDataRefreshPresetStatusModel{}, fmt.Errorf("scan economic refresh preset: %w", err)
		}
		total++
		if !row.isEnabled || !row.itemActive {
			continue
		}
		enabled++
		if !row.lastRunAt.Valid {
			continue
		}
		if latest == nil || row.lastRunAt.Time.After(latest.lastRunAt.Time) {
			chosen := row
			latest = &chosen
		}
	}
	if err := rows.Err(); err != nil {
		return EconomicDataRefreshPresetStatusModel{}, fmt.Errorf("read economic refresh preset: %w", err)
	}
	status := EconomicDataRefreshPresetStatusModel{
		Preset:       preset,
		CategoryKey:  categoryKey,
		TotalItems:   total,
		EnabledItems: enabled,
	}
	if latest != nil {
		status.LastRunAt = nullTime(latest.lastRunAt)
		status.LastStatus = nullString(latest.lastStatus)
		status.LastError = nullString(latest.lastError)
	}
	return status, nil
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return stringPtr(value.String)
}

func nullTime(value sql.NullTime) *time.Time {
	if !value.Valid {
		return nil
	}
	instant := value.Time.UTC()
	return &instant
}
