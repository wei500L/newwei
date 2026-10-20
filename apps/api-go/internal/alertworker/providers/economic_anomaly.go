package providers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/jsnum"
)

// anomalyMetadata is the typed projection of AlertRule.metadata. Pointers keep
// the NestJS `typeof x === "number"` / `typeof x === "string"` guards: a field
// of another JSON type leaves its pointer nil, exactly like the guard rejecting
// it and the caller using the default.
type anomalyMetadata struct {
	LookbackDays    *float64 `json:"lookbackDays"`
	MaxPoints       *float64 `json:"maxPoints"`
	CacheTTLSeconds *float64 `json:"cacheTtlSeconds"`
	ConfidenceLevel *float64 `json:"confidenceLevel"`
	SeasonalPeriod  *float64 `json:"seasonalPeriod"`
	ModelKind       *string  `json:"modelKind"`
	SourceField     *string  `json:"sourceField"`
}

// anomalyLatestPoint is the newest matching point (findFirst), joined with its
// item.
type anomalyLatestPoint struct {
	itemID      string
	value       float64
	recordedAt  time.Time
	sourceField string
	itemName    string
}

// anomalyPointRow is one row of the series query (recordedAt + value only).
type anomalyPointRow struct {
	recordedAt time.Time
	value      float64
}

// anomalyForecastContext is the event context of the model-forecast branch, in
// the NestJS object literal order.
type anomalyForecastContext struct {
	Observed    float64         `json:"observed"`
	Expected    float64         `json:"expected"`
	Lower       float64         `json:"lower"`
	Upper       float64         `json:"upper"`
	Sigma       float64         `json:"sigma"`
	Residual    float64         `json:"residual"`
	Score       float64         `json:"score"`
	MetricSlug  string          `json:"metricSlug"`
	ItemName    string          `json:"itemName"`
	RecordedAt  string          `json:"recordedAt"`
	Model       json.RawMessage `json:"model,omitempty"`
	Diagnostics json.RawMessage `json:"diagnostics,omitempty"`
}

// anomalyFallbackDetail is the `fallback` value: either a detector hit
// ({kind, reason}) or the too-short marker ({error}).
type anomalyFallbackDetail struct {
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
}

// anomalyFallbackContext is the event context of the local-detector branch.
type anomalyFallbackContext struct {
	Observed   float64               `json:"observed"`
	Fallback   anomalyFallbackDetail `json:"fallback"`
	MetricSlug string                `json:"metricSlug"`
	ItemName   string                `json:"itemName"`
	RecordedAt string                `json:"recordedAt"`
	Model      anomalyFallbackModel  `json:"model"`
}

// anomalyFallbackModel mirrors `model: { kind: "fallback" }`.
type anomalyFallbackModel struct {
	Kind string `json:"kind"`
}

// anomalyInsufficientContext is the `points < 10` early return.
type anomalyInsufficientContext struct {
	Error        string `json:"error"`
	Points       int    `json:"points"`
	LookbackDays int    `json:"lookbackDays"`
	MetricSlug   string `json:"metricSlug"`
}

// anomalyCachedEvaluation is the value stored under the shared
// `alerts:economicAnomaly:...` key. The JSON shape matches the NestJS
// CacheService.wrap payload, so both evaluators read one entry.
type anomalyCachedEvaluation struct {
	Latest        *float64        `json:"latest"`
	Previous      *float64        `json:"previous"`
	ChangePercent *float64        `json:"changePercent"`
	Context       json.RawMessage `json:"context,omitempty"`
}

func (c anomalyCachedEvaluation) evaluation() Evaluation {
	return Evaluation{
		Latest:        c.Latest,
		Previous:      c.Previous,
		ChangePercent: c.ChangePercent,
		Context:       c.Context,
	}
}

// economicAnomalyProvider ports EconomicAnomalyMetricProvider.
type economicAnomalyProvider struct {
	deps Dependencies
}

// NewEconomicAnomaly builds the economic_anomaly provider.
func NewEconomicAnomaly(deps Dependencies) Provider {
	return &economicAnomalyProvider{deps: deps}
}

// Type implements Provider.
func (p *economicAnomalyProvider) Type() string { return TypeEconomicAnomaly }

// Fetch implements Provider. The anomaly score is |observed - expected| / sigma
// from the model service, or the last point's local detector score when the
// best-effort forecast is unavailable. The score is what the rule threshold is
// compared against, so it is Evaluation.Latest.
func (p *economicAnomalyProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	if metricSlug == "" {
		return metricErrorEvaluation("metric_slug_missing"), nil
	}
	metadata := toAnomalyMetadata(rule.Metadata)
	lookbackDays := clampInt(metricNumberOr(metadata.LookbackDays, 365), 30, 3650)
	maxPoints := clampInt(metricNumberOr(metadata.MaxPoints, 1000), 50, 5000)
	cacheTTLSeconds := clampInt(metricNumberOr(metadata.CacheTTLSeconds, 300), 5, 3600)
	confidenceLevel := clampFloat(metricNumberOr(metadata.ConfidenceLevel, 0.95), 0.5, 0.999)
	seasonalPeriod := clampInt(metricNumberOr(metadata.SeasonalPeriod, 0), 0, 366)

	modelKind := ModelKindARIMA
	rawModelKind := ""
	if metadata.ModelKind != nil {
		rawModelKind = strings.ToLower(strings.TrimSpace(*metadata.ModelKind))
	}
	if rawModelKind == ModelKindETS {
		modelKind = ModelKindETS
	}
	desiredSourceField := ""
	if metadata.SourceField != nil {
		desiredSourceField = strings.TrimSpace(*metadata.SourceField)
	}

	if p.deps.DB == nil {
		return Evaluation{}, errors.New("alertworker/providers: economic anomaly: database is not configured")
	}

	latest, err := p.loadLatestPoint(ctx, metricSlug, desiredSourceField)
	if errors.Is(err, sql.ErrNoRows) {
		return metricErrorEvaluation("no_data_points"), nil
	}
	if err != nil {
		return Evaluation{}, err
	}

	// The series is anchored on the newest point, not on "now": an item that
	// stopped updating keeps a stable window (and therefore a stable cache key).
	sourceField := desiredSourceField
	if sourceField == "" {
		sourceField = latest.sourceField
	}
	end := latest.recordedAt.UTC()
	start := end.Add(-time.Duration(lookbackDays) * 24 * time.Hour)
	rows, err := p.loadPoints(ctx, latest.itemID, sourceField, start, end, maxPoints)
	if err != nil {
		return Evaluation{}, err
	}
	if len(rows) < 10 {
		return insufficientPointsEvaluation(len(rows), lookbackDays, metricSlug)
	}

	// The SQL returns newest-first (like the Prisma orderBy + take), and the
	// detectors need oldest-first, so the slice is reversed here.
	series := make([]SeriesPoint, 0, len(rows))
	for index := len(rows) - 1; index >= 0; index-- {
		series = append(series, SeriesPoint{
			Timestamp: isoTimestamp(rows[index].recordedAt),
			Value:     rows[index].value,
		})
	}

	cacheKey := economicAnomalyCacheKey(latest.itemID, sourceField, modelKind, confidenceLevel, seasonalPeriod, end)
	// Math.min(30_000, cacheTtlSeconds * 1000) for both lock TTL and wait.
	lockTTLMs := cacheTTLSeconds * 1000
	if lockTTLMs > 30000 {
		lockTTLMs = 30000
	}
	loader := func(loadCtx context.Context) (anomalyCachedEvaluation, error) {
		return p.evaluate(loadCtx, metricSlug, latest, series, modelKind, seasonalPeriod, confidenceLevel)
	}
	cached, err := Wrap[anomalyCachedEvaluation](
		ctx,
		p.deps.Cache,
		cacheKey,
		cacheTTLSeconds,
		loader,
		WrapOptions{LockTTLMs: lockTTLMs, MaxWaitMs: lockTTLMs},
	)
	if err != nil {
		return Evaluation{}, err
	}
	return cached.evaluation(), nil
}

// evaluate is the cache loader: model-service forecast first, local detector
// as the fallback.
func (p *economicAnomalyProvider) evaluate(
	ctx context.Context,
	metricSlug string,
	latest anomalyLatestPoint,
	series []SeriesPoint,
	modelKind string,
	seasonalPeriod int,
	confidenceLevel float64,
) (anomalyCachedEvaluation, error) {
	observed := latest.value
	var forecast *ForecastResult
	if p.deps.Forecast != nil {
		// Best effort: the port contract is nil-on-failure, and a client that
		// still returns an error is treated exactly like a nil forecast.
		forecast, _ = p.deps.Forecast.ForecastHoldoutLastBestEffort(ctx, ForecastRequest{
			Series: series,
			Model: ForecastModel{
				Kind:            modelKind,
				SeasonalPeriod:  seasonalPeriod,
				ConfidenceLevel: confidenceLevel,
			},
			RequestID: "economic_anomaly:" + latest.itemID + ":" + isoTimestamp(latest.recordedAt),
		})
	}
	if forecast != nil &&
		forecast.Forecast != nil &&
		metricFinite(forecast.Forecast.Expected) &&
		metricFinite(forecast.Forecast.Sigma) {
		expected := forecast.Forecast.Expected
		// A zero sigma would divide by zero; the NestJS provider floors the
		// absolute sigma at 1e-12.
		sigma := math.Max(1e-12, math.Abs(forecast.Forecast.Sigma))
		residual := observed - expected
		score := math.Abs(residual) / sigma
		payload, err := metricContextJSON(anomalyForecastContext{
			Observed:    observed,
			Expected:    expected,
			Lower:       forecast.Forecast.Lower,
			Upper:       forecast.Forecast.Upper,
			Sigma:       sigma,
			Residual:    residual,
			Score:       score,
			MetricSlug:  metricSlug,
			ItemName:    latest.itemName,
			RecordedAt:  isoTimestamp(latest.recordedAt),
			Model:       metricRawJSON(forecast.Model),
			Diagnostics: metricRawJSON(forecast.Diagnostics),
		})
		if err != nil {
			return anomalyCachedEvaluation{}, err
		}
		return anomalyCachedEvaluation{Latest: metricValuePtr(score), Context: payload}, nil
	}

	score, detail := fallbackScore(series)
	payload, err := metricContextJSON(anomalyFallbackContext{
		Observed:   observed,
		Fallback:   detail,
		MetricSlug: metricSlug,
		ItemName:   latest.itemName,
		RecordedAt: isoTimestamp(latest.recordedAt),
		Model:      anomalyFallbackModel{Kind: "fallback"},
	})
	if err != nil {
		return anomalyCachedEvaluation{}, err
	}
	return anomalyCachedEvaluation{Latest: metricValuePtr(score), Context: payload}, nil
}

// loadLatestPoint runs the NestJS findFirst: newest point of the slug,
// optionally filtered by the desired source field.
func (p *economicAnomalyProvider) loadLatestPoint(ctx context.Context, metricSlug, sourceField string) (anomalyLatestPoint, error) {
	query := "SELECT p.`itemId`, p.`value`, p.`recordedAt`, p.`sourceField`, i.`displayName` " +
		"FROM `EconomicDataPoint` p INNER JOIN `EconomicDataItem` i ON i.`id` = p.`itemId` " +
		"WHERE i.`slug` = ?"
	args := []any{metricSlug}
	if sourceField != "" {
		query += " AND p.`sourceField` = ?"
		args = append(args, sourceField)
	}
	query += " ORDER BY p.`recordedAt` DESC LIMIT 1"

	var latest anomalyLatestPoint
	var rawValue []byte
	if err := p.deps.DB.QueryRowContext(ctx, query, args...).Scan(
		&latest.itemID,
		&rawValue,
		&latest.recordedAt,
		&latest.sourceField,
		&latest.itemName,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return anomalyLatestPoint{}, sql.ErrNoRows
		}
		return anomalyLatestPoint{}, fmt.Errorf("alertworker/providers: economic anomaly latest point: %w", err)
	}
	parsed, err := metricDecimalValue(rawValue)
	if err != nil {
		return anomalyLatestPoint{}, fmt.Errorf("alertworker/providers: economic anomaly latest point value: %w", err)
	}
	latest.value = parsed
	latest.recordedAt = latest.recordedAt.UTC()
	return latest, nil
}

// loadPoints reads the lookback window, newest first, capped at limit. The
// recordedAt bounds are inclusive on both ends, like the Prisma gte/lte.
func (p *economicAnomalyProvider) loadPoints(
	ctx context.Context,
	itemID string,
	sourceField string,
	start time.Time,
	end time.Time,
	limit int,
) ([]anomalyPointRow, error) {
	query := "SELECT p.`recordedAt`, p.`value` FROM `EconomicDataPoint` p " +
		"WHERE p.`itemId` = ? AND p.`recordedAt` >= ? AND p.`recordedAt` <= ?"
	args := []any{itemID, start.UTC(), end.UTC()}
	if sourceField != "" {
		query += " AND p.`sourceField` = ?"
		args = append(args, sourceField)
	}
	query += " ORDER BY p.`recordedAt` DESC LIMIT ?"
	args = append(args, limit)

	rows, err := p.deps.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: economic anomaly points: %w", err)
	}
	defer rows.Close()
	points := make([]anomalyPointRow, 0, limit)
	for rows.Next() {
		var point anomalyPointRow
		var rawValue []byte
		if err := rows.Scan(&point.recordedAt, &rawValue); err != nil {
			return nil, fmt.Errorf("alertworker/providers: economic anomaly point: %w", err)
		}
		parsed, err := metricDecimalValue(rawValue)
		if err != nil {
			return nil, fmt.Errorf("alertworker/providers: economic anomaly point value: %w", err)
		}
		point.value = parsed
		point.recordedAt = point.recordedAt.UTC()
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("alertworker/providers: read economic anomaly points: %w", err)
	}
	return points, nil
}

// economicAnomalyCacheKey is byte-identical to the NestJS template:
//
//	alerts:economicAnomaly:${itemId}:${sourceField || "any"}:${modelKind}:${confidenceLevel.toFixed(3)}:${seasonalPeriod}:${end.toISOString()}
func economicAnomalyCacheKey(
	itemID string,
	sourceField string,
	modelKind string,
	confidenceLevel float64,
	seasonalPeriod int,
	end time.Time,
) string {
	field := sourceField
	if field == "" {
		field = "any"
	}
	return fmt.Sprintf(
		"alerts:economicAnomaly:%s:%s:%s:%s:%d:%s",
		itemID,
		field,
		modelKind,
		jsnum.ToFixed(confidenceLevel, 3),
		seasonalPeriod,
		isoTimestamp(end),
	)
}

// insufficientPointsEvaluation renders the `points < 10` result.
func insufficientPointsEvaluation(points, lookbackDays int, metricSlug string) (Evaluation, error) {
	payload, err := metricContextJSON(anomalyInsufficientContext{
		Error:        "insufficient_points",
		Points:       points,
		LookbackDays: lookbackDays,
		MetricSlug:   metricSlug,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{Context: payload}, nil
}

// fallbackScore is fallbackScore(): trim to the last 120 points, prefer a
// z-score hit on the last point, then a rolling-spike hit, else score 0.
func fallbackScore(series []SeriesPoint) (float64, anomalyFallbackDetail) {
	if len(series) < 3 {
		return 0, anomalyFallbackDetail{Error: "series_too_short"}
	}
	start := len(series) - 120
	if start < 0 {
		start = 0
	}
	trimmed := series[start:]
	lastIndex := len(trimmed) - 1

	// NestJS selects the hit whose `point` is the last SeriesPoint object
	// (`hit.point === last`); the Go equivalent is the last index.
	for _, finding := range DetectZScoreAnomalies(trimmed, 3) {
		if finding.Index == lastIndex {
			return finding.Score, anomalyFallbackDetail{Kind: "zscore", Reason: finding.Reason}
		}
	}
	for _, finding := range DetectRollingSpike(trimmed, 20, 2.5) {
		if finding.Index == lastIndex {
			return finding.Score, anomalyFallbackDetail{Kind: "rolling_spike", Reason: finding.Reason}
		}
	}
	return 0, anomalyFallbackDetail{Kind: "none"}
}

// toAnomalyMetadata mirrors toMetadata plus the `typeof` guards: a JSON null,
// array or non-object decodes to the zero struct, which reads as "absent".
func toAnomalyMetadata(raw json.RawMessage) anomalyMetadata {
	// readRuleMetadata keeps the raw values, so a field of the wrong JSON type
	// stays absent instead of being decoded into a zero value. A struct decode
	// would allocate the pointer before the type error and turn, say, the string
	// "90" into a present 0.
	fields := readRuleMetadata(raw)
	var metadata anomalyMetadata
	if fields == nil {
		return metadata
	}
	metadata.LookbackDays = fields.numberPointer("lookbackDays")
	metadata.MaxPoints = fields.numberPointer("maxPoints")
	metadata.CacheTTLSeconds = fields.numberPointer("cacheTtlSeconds")
	metadata.ConfidenceLevel = fields.numberPointer("confidenceLevel")
	metadata.SeasonalPeriod = fields.numberPointer("seasonalPeriod")
	metadata.ModelKind = fields.textPointer("modelKind")
	metadata.SourceField = fields.textPointer("sourceField")
	return metadata
}

// metricNumberOr mirrors `typeof x === "number" ? x : fallback`.
func metricNumberOr(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return *value
}

// clampInt mirrors the NestJS clampInt: non-finite input yields min, otherwise
// Math.trunc then clamp. The bounds are applied in float space so that a value
// outside int64 range cannot overflow the conversion.
func clampInt(value float64, min, max int) int {
	if !metricFinite(value) {
		return min
	}
	truncated := math.Trunc(value)
	if truncated < float64(min) {
		return min
	}
	if truncated > float64(max) {
		return max
	}
	return int(truncated)
}

// clampFloat mirrors the NestJS clampFloat: non-finite input yields min,
// otherwise Math.min(Math.max(value, min), max).
func clampFloat(value float64, min, max float64) float64 {
	if !metricFinite(value) {
		return min
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

// metricFinite mirrors Number.isFinite.
func metricFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// metricRawJSON keeps only usable raw JSON: the response fields are copied into
// the event context, and an absent field must be omitted rather than become
// invalid JSON.
func metricRawJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 || !json.Valid(raw) {
		return nil
	}
	return raw
}
