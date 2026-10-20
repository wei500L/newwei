package providers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// economicDataMetadata is the subset of AlertRule.metadata this provider reads.
// Pointers reproduce the NestJS `typeof metadata.sourceField === "string"`
// guard: a JSON null, number or array leaves the pointer nil, exactly like the
// guard rejecting the value.
type economicDataMetadata struct {
	SourceField *string `json:"sourceField"`
}

// economicDataContext is the provider context object. The field order follows
// the NestJS object literal, because the context is persisted verbatim and
// encoding/json emits struct fields in declaration order.
type economicDataContext struct {
	WindowMinutes *int    `json:"windowMinutes"`
	SourceName    string  `json:"sourceName"`
	SourceField   string  `json:"sourceField"`
	SourceDocURL  *string `json:"sourceDocUrl"`
	Unit          *string `json:"unit"`
	RecordedAt    string  `json:"recordedAt"`
	ItemName      string  `json:"itemName"`
}

// economicDataRow is one joined row: the data point plus its EconomicDataItem.
type economicDataRow struct {
	value          float64
	unit           sql.NullString
	sourceField    string
	recordedAt     time.Time
	sourceEndpoint string
	sourceFunction string
	sourceDocURL   sql.NullString
	defaultUnit    sql.NullString
	displayName    string
}

// economicDataProvider ports EconomicDataMetricProvider.
type economicDataProvider struct {
	deps Dependencies
}

// NewEconomicData builds the economic_data provider.
func NewEconomicData(deps Dependencies) Provider {
	return &economicDataProvider{deps: deps}
}

// Type implements Provider.
func (p *economicDataProvider) Type() string { return TypeEconomicData }

// Fetch implements Provider with the same query shape as
// EconomicDataMetricProvider.fetch: newest point (and the second newest for the
// change operators) of the item slug, optionally restricted to a source field
// and to the change window.
func (p *economicDataProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	metadata := economicDataMetadata{}
	if len(rule.Metadata) > 0 {
		// Type mismatches leave the field pointer nil, which is the same
		// decision as the `typeof` guard, so the decode error is intentional
		// to ignore. Prisma stores metadata as a JSON object, so syntax errors
		// cannot occur here.
		_ = json.Unmarshal(rule.Metadata, &metadata)
	}
	desiredSourceField := ""
	if metadata.SourceField != nil {
		desiredSourceField = strings.TrimSpace(*metadata.SourceField)
	}
	if metricSlug == "" {
		return metricErrorEvaluation("metric_slug_missing"), nil
	}
	if p.deps.DB == nil {
		return Evaluation{}, errors.New("alertworker/providers: economic data: database is not configured")
	}

	take := 1
	if rule.Operator == OperatorChangeUpPct || rule.Operator == OperatorChangeDownPct {
		take = 2
	}
	query := "SELECT p.`value`, p.`unit`, p.`sourceField`, p.`recordedAt`, " +
		"i.`sourceEndpoint`, i.`sourceFunction`, i.`sourceDocUrl`, i.`defaultUnit`, i.`displayName` " +
		"FROM `EconomicDataPoint` p INNER JOIN `EconomicDataItem` i ON i.`id` = p.`itemId` " +
		"WHERE i.`slug` = ?"
	args := []any{metricSlug}
	if desiredSourceField != "" {
		query += " AND p.`sourceField` = ?"
		args = append(args, desiredSourceField)
	}
	// The NestJS guard is `if (rule.changeWindowMin)`, i.e. truthiness: a zero
	// window means "no window" and keeps the whole history.
	if rule.ChangeWindowMin != nil && *rule.ChangeWindowMin != 0 {
		query += " AND p.`recordedAt` >= ?"
		args = append(args, p.deps.now().Add(-time.Duration(*rule.ChangeWindowMin)*time.Minute).UTC())
	}
	query += " ORDER BY p.`recordedAt` DESC LIMIT ?"
	args = append(args, take)

	rows, err := p.deps.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: economic data points: %w", err)
	}
	defer rows.Close()
	points := make([]economicDataRow, 0, take)
	for rows.Next() {
		var point economicDataRow
		var rawValue []byte
		if err := rows.Scan(
			&rawValue,
			&point.unit,
			&point.sourceField,
			&point.recordedAt,
			&point.sourceEndpoint,
			&point.sourceFunction,
			&point.sourceDocURL,
			&point.defaultUnit,
			&point.displayName,
		); err != nil {
			return Evaluation{}, fmt.Errorf("alertworker/providers: economic data point: %w", err)
		}
		parsed, err := metricDecimalValue(rawValue)
		if err != nil {
			return Evaluation{}, fmt.Errorf("alertworker/providers: economic data point value: %w", err)
		}
		point.value = parsed
		point.recordedAt = point.recordedAt.UTC()
		points = append(points, point)
	}
	if err := rows.Err(); err != nil {
		return Evaluation{}, fmt.Errorf("alertworker/providers: read economic data points: %w", err)
	}
	if len(points) == 0 {
		// No context at all: the NestJS provider returns only the nil fields.
		return Evaluation{}, nil
	}

	latest := points[0]
	var previous *float64
	if len(points) > 1 {
		previous = metricValuePtr(points[1].value)
	}
	// A zero previous value has no meaningful relative change; the NestJS
	// provider checks `previous !== 0` explicitly, which also covers -0.
	var changePercent *float64
	if previous != nil && *previous != 0 {
		changePercent = metricValuePtr(((latest.value - *previous) / *previous) * 100)
	}

	unit := latest.unit
	if !unit.Valid {
		unit = latest.defaultUnit
	}
	// `item.sourceEndpoint || item.sourceFunction`: an empty endpoint falls
	// back to the source function.
	sourceName := latest.sourceEndpoint
	if sourceName == "" {
		sourceName = latest.sourceFunction
	}
	payload, err := metricContextJSON(economicDataContext{
		WindowMinutes: rule.ChangeWindowMin,
		SourceName:    sourceName,
		SourceField:   latest.sourceField,
		SourceDocURL:  metricNullString(latest.sourceDocURL),
		Unit:          metricNullString(unit),
		RecordedAt:    isoTimestamp(latest.recordedAt),
		ItemName:      latest.displayName,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{
		Latest:        metricValuePtr(latest.value),
		Previous:      previous,
		ChangePercent: changePercent,
		Context:       payload,
	}, nil
}

// isoTimestamp renders a timestamp like Date.prototype.toISOString: UTC, fixed
// millisecond precision, trailing Z. MySQL DATETIME has no sub-millisecond
// digits, so nothing is rounded away.
func isoTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02T15:04:05.000Z")
}

// metricValuePtr marks "this evaluation carries a value"; nil means no value
// and makes the caller skip the rule.
func metricValuePtr(value float64) *float64 {
	return &value
}

// metricNullString converts a nullable column to the `string | null` shape the
// NestJS context carries.
func metricNullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	trimmed := value.String
	return &trimmed
}

// metricContextJSON renders one provider context struct.
func metricContextJSON(value any) (json.RawMessage, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("alertworker/providers: encode context: %w", err)
	}
	return payload, nil
}

// metricErrorEvaluation is the NestJS "no value plus error context" result,
// e.g. {"error":"metric_slug_missing"}.
func metricErrorEvaluation(message string) Evaluation {
	payload, err := metricContextJSON(struct {
		Error string `json:"error"`
	}{Error: message})
	if err != nil {
		// Unreachable: a struct of one string always marshals.
		return Evaluation{}
	}
	return Evaluation{Context: payload}
}

// metricDecimalValue converts a DECIMAL column, which the MySQL driver returns
// as text, with the semantics of the NestJS Number(decimal) cast.
func metricDecimalValue(raw []byte) (float64, error) {
	value, err := strconv.ParseFloat(string(raw), 64)
	if err != nil {
		return 0, err
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errors.New("non-finite decimal")
	}
	return value, nil
}
