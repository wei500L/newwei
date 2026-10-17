package newsindicators

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/economic"
)

type reader struct {
	db *sql.DB
}

const associationSelect = `a.id, a.scopeType, a.scopeKey, a.scopeKeyType, a.featureMetric,
 a.windowDays, a.lagDays, a.correlation, a.pValue, a.sampleSize,
 a.analyzedStartAt, a.analyzedEndAt, a.lastEvaluatedAt, a.metadata,
 i.slug, i.displayName, i.groupLabel, i.defaultUnit, i.metadata`

const backtestSelect = `associationId, id, status, windowStart, windowEnd, config, metrics, error, createdAt, updatedAt`

type associationRow struct {
	id              string
	scopeType       string
	scopeKey        string
	scopeKeyType    string
	featureMetric   string
	windowDays      int
	lagDays         int
	correlation     float64
	pValue          sql.NullFloat64
	sampleSize      int
	analyzedStartAt time.Time
	analyzedEndAt   time.Time
	lastEvaluatedAt time.Time
	metadata        []byte
	slug            string
	displayName     sql.NullString
	groupLabel      sql.NullString
	defaultUnit     sql.NullString
	itemMetadata    []byte
}

type backtestRow struct {
	associationID string
	id            string
	status        string
	windowStart   time.Time
	windowEnd     time.Time
	config        []byte
	metrics       []byte
	err           sql.NullString
	createdAt     time.Time
	updatedAt     time.Time
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAssociation(row rowScanner) (associationRow, error) {
	var record associationRow
	err := row.Scan(
		&record.id, &record.scopeType, &record.scopeKey, &record.scopeKeyType, &record.featureMetric,
		&record.windowDays, &record.lagDays, &record.correlation, &record.pValue, &record.sampleSize,
		&record.analyzedStartAt, &record.analyzedEndAt, &record.lastEvaluatedAt, &record.metadata,
		&record.slug, &record.displayName, &record.groupLabel, &record.defaultUnit, &record.itemMetadata,
	)
	return record, err
}

func scanBacktest(row rowScanner) (backtestRow, error) {
	var record backtestRow
	err := row.Scan(
		&record.associationID, &record.id, &record.status, &record.windowStart, &record.windowEnd,
		&record.config, &record.metrics, &record.err, &record.createdAt, &record.updatedAt,
	)
	return record, err
}

func (row associationRow) model() NewsIndicatorAssociationModel {
	return NewsIndicatorAssociationModel{
		ID:              row.id,
		ScopeType:       row.scopeType,
		ScopeKey:        row.scopeKey,
		ScopeKeyType:    row.scopeKeyType,
		FeatureMetric:   row.featureMetric,
		Indicator:       row.itemModel(),
		WindowDays:      row.windowDays,
		LagDays:         row.lagDays,
		Correlation:     row.correlation,
		PValue:          nullFloat(row.pValue),
		SampleSize:      row.sampleSize,
		AnalyzedStartAt: row.analyzedStartAt,
		AnalyzedEndAt:   row.analyzedEndAt,
		LastEvaluatedAt: row.lastEvaluatedAt,
		Metadata:        parseJSONColumn(row.metadata),
	}
}

func (row associationRow) itemModel() economic.EconomicDataItemModel {
	display := row.slug
	if row.displayName.Valid {
		display = row.displayName.String
	}
	return economic.EconomicDataItemModel{
		Slug:        row.slug,
		DisplayName: display,
		GroupLabel:  nullString(row.groupLabel),
		DefaultUnit: nullString(row.defaultUnit),
		Metadata:    parseJSONColumn(row.itemMetadata),
	}
}

func (row backtestRow) model() NewsIndicatorAssociationBacktestRunModel {
	return NewsIndicatorAssociationBacktestRunModel{
		ID:          row.id,
		Status:      row.status,
		WindowStart: row.windowStart,
		WindowEnd:   row.windowEnd,
		Config:      parseJSONColumn(row.config),
		Metrics:     parseJSONColumn(row.metrics),
		Error:       nullString(row.err),
		CreatedAt:   row.createdAt,
		UpdatedAt:   row.updatedAt,
	}
}

// list mirrors newsIndicatorAssociations: orgId from the server identity;
// indicatorSlug/scopeType/scopeKey/featureMetric are optional filters; ordering
// is lastEvaluatedAt desc, correlation desc; list items carry latestBacktest
// (one) but no backtests array.
func (r *reader) list(call contract.Context) (any, error) {
	if r == nil || r.db == nil {
		return nil, failure(http.StatusInternalServerError, "Internal server error")
	}
	limit := optionalInt(call.Args, "limit", 50, 1, 200)
	where := []string{"a.orgId = ?"}
	args := []any{call.Identity.OrgID}
	if slug, ok := contract.StringArg(call.Args, "indicatorSlug"); ok {
		if trimmed := strings.TrimSpace(slug); trimmed != "" {
			where = append(where, "i.slug = ?")
			args = append(args, trimmed)
		}
	}
	if scopeType, ok := contract.StringArg(call.Args, "scopeType"); ok {
		if trimmed := strings.TrimSpace(scopeType); trimmed != "" {
			where = append(where, "a.scopeType = ?")
			args = append(args, trimmed)
		}
	}
	if scopeKey, ok := contract.StringArg(call.Args, "scopeKey"); ok {
		if trimmed := strings.TrimSpace(scopeKey); trimmed != "" {
			where = append(where, "a.scopeKey = ?")
			args = append(args, trimmed)
		}
	}
	if metric, ok := contract.StringArg(call.Args, "featureMetric"); ok {
		if trimmed := strings.TrimSpace(metric); trimmed != "" {
			where = append(where, "a.featureMetric = ?")
			args = append(args, trimmed)
		}
	}
	args = append(args, limit)

	rows, err := r.db.QueryContext(call.Ctx,
		"SELECT "+associationSelect+
			" FROM NewsIndicatorAssociation a JOIN EconomicDataItem i ON i.id = a.indicatorItemId"+
			" WHERE "+strings.Join(where, " AND ")+
			" ORDER BY a.lastEvaluatedAt DESC, a.correlation DESC LIMIT ?", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := []associationRow{}
	for rows.Next() {
		record, err := scanAssociation(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	ids := make([]string, 0, len(records))
	for _, record := range records {
		ids = append(ids, record.id)
	}
	latest, err := r.latestBacktests(call.Ctx, ids)
	if err != nil {
		return nil, err
	}

	out := make([]NewsIndicatorAssociationModel, 0, len(records))
	for _, record := range records {
		model := record.model()
		if backtest, ok := latest[record.id]; ok {
			value := backtest.model()
			model.LatestBacktest = &value
		}
		out = append(out, model)
	}
	return out, nil
}

// detail mirrors newsIndicatorAssociation: nullable root (nil, nil) when the
// row is missing or belongs to another org. backtestsLimit>0 returns the
// backtests array (createdAt desc) and latestBacktest = backtests[0];
// backtestsLimit=0 omits both (GraphQL null).
func (r *reader) detail(call contract.Context) (any, error) {
	if r == nil || r.db == nil {
		return nil, failure(http.StatusInternalServerError, "Internal server error")
	}
	id, ok := contract.StringArg(call.Args, "id")
	if !ok {
		return nil, failure(http.StatusBadRequest, "id is required")
	}
	backtestsLimit := optionalInt(call.Args, "backtestsLimit", 10, 0, 100)

	row := r.db.QueryRowContext(call.Ctx,
		"SELECT "+associationSelect+
			" FROM NewsIndicatorAssociation a JOIN EconomicDataItem i ON i.id = a.indicatorItemId"+
			" WHERE a.orgId = ? AND a.id = ? LIMIT 1", call.Identity.OrgID, id)
	record, err := scanAssociation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	model := record.model()
	if backtestsLimit > 0 {
		backtests, err := r.backtestsForAssociation(call.Ctx, id, backtestsLimit)
		if err != nil {
			return nil, err
		}
		model.Backtests = backtests
		if len(backtests) > 0 {
			first := backtests[0]
			model.LatestBacktest = &first
		}
	}
	return model, nil
}

func (r *reader) latestBacktests(ctx context.Context, ids []string) (map[string]backtestRow, error) {
	out := map[string]backtestRow{}
	if len(ids) == 0 {
		return out, nil
	}
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := r.db.QueryContext(ctx,
		"SELECT "+backtestSelect+" FROM NewsIndicatorAssociationBacktestRun"+
			" WHERE associationId IN ("+placeholders(len(ids))+") ORDER BY associationId ASC, createdAt DESC", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanBacktest(rows)
		if err != nil {
			return nil, err
		}
		if _, exists := out[record.associationID]; exists {
			continue
		}
		out[record.associationID] = record
	}
	return out, rows.Err()
}

func (r *reader) backtestsForAssociation(ctx context.Context, associationID string, limit int) ([]NewsIndicatorAssociationBacktestRunModel, error) {
	rows, err := r.db.QueryContext(ctx,
		"SELECT "+backtestSelect+" FROM NewsIndicatorAssociationBacktestRun"+
			" WHERE associationId = ? ORDER BY createdAt DESC LIMIT ?", associationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NewsIndicatorAssociationBacktestRunModel{}
	for rows.Next() {
		record, err := scanBacktest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, record.model())
	}
	return out, rows.Err()
}

func optionalInt(args map[string]any, name string, fallback, min, max int) int {
	number, ok := contract.IntArg(args, name)
	if !ok {
		return clampInt(fallback, min, max)
	}
	return clampInt(number, min, max)
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	text := value.String
	return &text
}

func nullFloat(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	number := value.Float64
	return &number
}

// parseJSONColumn returns the decoded JSON value, or nil for NULL/empty/invalid.
func parseJSONColumn(raw []byte) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func failure(status int, message string) error {
	return &contract.Failure{Status: status, Message: message}
}
