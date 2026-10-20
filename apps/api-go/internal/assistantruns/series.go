package assistantruns

import (
	"context"
	"database/sql"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
)

// SeriesReader is the economic-series read surface used by the forecast and
// correlation paths. The production implementation reuses the exported
// graphqlread/history queries; tests substitute a fake.
type SeriesReader interface {
	FindBySlug(ctx context.Context, slug string) (*history.EconomicSeries, error)
	SearchCandidates(ctx context.Context, term string, limit int) ([]history.EconomicSeriesSuggestion, error)
	FieldCounts(ctx context.Context, itemID string, start, end time.Time) ([]history.SeriesFieldCount, error)
	Points(ctx context.Context, itemID, sourceField string, start, end time.Time) ([]history.SeriesPoint, error)
}

// historySeriesReader adapts the history package's exported SQL reads.
type historySeriesReader struct {
	db *sql.DB
}

// NewSeriesReader builds the production reader over the shared MySQL pool.
func NewSeriesReader(db *sql.DB) SeriesReader {
	return &historySeriesReader{db: db}
}

func (r *historySeriesReader) FindBySlug(ctx context.Context, slug string) (*history.EconomicSeries, error) {
	return history.FindEconomicSeriesBySlug(ctx, r.db, slug)
}

func (r *historySeriesReader) SearchCandidates(ctx context.Context, term string, limit int) ([]history.EconomicSeriesSuggestion, error) {
	return history.SearchEconomicSeriesCandidates(ctx, r.db, term, limit)
}

func (r *historySeriesReader) FieldCounts(ctx context.Context, itemID string, start, end time.Time) ([]history.SeriesFieldCount, error) {
	return history.ListEconomicSeriesFieldCounts(ctx, r.db, itemID, start, end)
}

func (r *historySeriesReader) Points(ctx context.Context, itemID, sourceField string, start, end time.Time) ([]history.SeriesPoint, error) {
	return history.LoadEconomicSeriesPoints(ctx, r.db, itemID, sourceField, start, end)
}
