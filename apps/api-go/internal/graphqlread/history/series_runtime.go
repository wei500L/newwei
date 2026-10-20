package history

import (
	"context"
	"database/sql"
	"strconv"
	"strings"
	"time"
)

// This file exports the economic-series reads the assistant forecast and
// correlation paths reuse. It adds no GraphQL root and changes no existing
// query: the candidate search delegates to the same searchSeries SQL the
// assistantEconomicSeriesSuggestions root uses, and the field-count / point
// reads mirror the Prisma queries in AssistantService.

// EconomicSeries is one EconomicDataItem projection: the id plus the metadata
// the assistant output references.
type EconomicSeries struct {
	ID          string
	Slug        string
	DisplayName string
	Description *string
	DocURL      *string
}

// SeriesFieldCount is one sourceField and its sample count, ordered by count
// descending and capped at twelve like listFieldCounts.
type SeriesFieldCount struct {
	Name  string
	Count int
}

// SeriesPoint is one recorded EconomicDataPoint value.
type SeriesPoint struct {
	RecordedAt time.Time
	Value      float64
}

// SearchEconomicSeriesCandidates reuses the suggestion search behind
// assistantEconomicSeriesSuggestions and returns the GraphQL model projection.
func SearchEconomicSeriesCandidates(ctx context.Context, db *sql.DB, term string, limit int) ([]EconomicSeriesSuggestion, error) {
	service := &service{db: db}
	return service.searchSeries(ctx, term, limit)
}

// FindEconomicSeriesBySlug resolves an explicit slug, like
// prisma.economicDataItem.findFirst({ where: { slug } }).
func FindEconomicSeriesBySlug(ctx context.Context, db *sql.DB, slug string) (*EconomicSeries, error) {
	if db == nil {
		return nil, errDatabaseUnavailable
	}
	row := db.QueryRowContext(ctx, `
SELECT id, slug, displayName, description, sourceDocUrl
FROM EconomicDataItem
WHERE slug = ?
LIMIT 1`, slug)
	var item EconomicSeries
	var description, docURL sql.NullString
	if err := row.Scan(&item.ID, &item.Slug, &item.DisplayName, &description, &docURL); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	item.Description = nullStringPtr(description)
	item.DocURL = nullStringPtr(docURL)
	return &item, nil
}

// ListEconomicSeriesFieldCounts mirrors listFieldCounts: group the points in
// the window by sourceField, order by sample count descending, take twelve.
func ListEconomicSeriesFieldCounts(ctx context.Context, db *sql.DB, itemID string, start, end time.Time) ([]SeriesFieldCount, error) {
	if db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := db.QueryContext(ctx, `
SELECT sourceField, COUNT(*)
FROM EconomicDataPoint
WHERE itemId = ? AND recordedAt >= ? AND recordedAt <= ?
GROUP BY sourceField
ORDER BY COUNT(*) DESC
LIMIT 12`, itemID, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SeriesFieldCount, 0, 12)
	for rows.Next() {
		var name sql.NullString
		var count int64
		if err := rows.Scan(&name, &count); err != nil {
			return nil, err
		}
		if !name.Valid || strings.TrimSpace(name.String) == "" {
			continue
		}
		out = append(out, SeriesFieldCount{Name: name.String, Count: int(count)})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// LoadEconomicSeriesPoints mirrors loadSeries: the points of one sourceField in
// the window, oldest first. Prisma Decimal values are parsed with Number()
// semantics; a non-finite value stays in the slice and is filtered by callers.
func LoadEconomicSeriesPoints(ctx context.Context, db *sql.DB, itemID, sourceField string, start, end time.Time) ([]SeriesPoint, error) {
	if db == nil {
		return nil, errDatabaseUnavailable
	}
	rows, err := db.QueryContext(ctx, `
SELECT recordedAt, value
FROM EconomicDataPoint
WHERE itemId = ? AND sourceField = ? AND recordedAt >= ? AND recordedAt <= ?
ORDER BY recordedAt ASC`, itemID, sourceField, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SeriesPoint, 0, 512)
	for rows.Next() {
		var recordedAt time.Time
		var raw sql.RawBytes
		if err := rows.Scan(&recordedAt, &raw); err != nil {
			return nil, err
		}
		value, err := strconv.ParseFloat(string(raw), 64)
		if err != nil {
			value = 0
		}
		out = append(out, SeriesPoint{RecordedAt: recordedAt, Value: value})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
