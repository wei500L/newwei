package alerts

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

const replaySelect = "SELECT e.`id`, e.`triggeredAt`, e.`context`, r.`metricProvider`, r.`metricSlug` " +
	"FROM `AlertEvent` AS e " +
	"INNER JOIN `AlertRule` AS r ON r.`id` = e.`ruleId` " +
	"WHERE e.`id` = ? AND r.`orgId` = ?"

const replayPointSelect = "SELECT p.`recordedAt`, p.`value`, p.`unit` " +
	"FROM `EconomicDataPoint` AS p " +
	"INNER JOIN `EconomicDataItem` AS i ON i.`id` = p.`itemId` " +
	"WHERE i.`slug` = ? AND p.`recordedAt` >= ? AND p.`recordedAt` <= ? " +
	"ORDER BY p.`recordedAt` ASC"

func replayEvent(ctx context.Context, db *sql.DB, orgID, eventID string, windowDays int) (any, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	var (
		id         string
		triggered  time.Time
		rawContext []byte
		provider   string
		slug       string
	)
	err := db.QueryRowContext(ctx, replaySelect, eventID, orgID).Scan(&id, &triggered, &rawContext, &provider, &slug)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, queryErr("event replay", err)
	}
	if provider != providerEconomic && provider != providerAnomaly {
		return nil, nil
	}
	metricSlug := normalizeMetricSlug(slug)
	if metricSlug == "" {
		return nil, nil
	}
	center, err := replayCenter(triggered, rawContext)
	if err != nil {
		return nil, err
	}
	start, end := windowBounds(center, windowDays)
	points, unit, err := loadReplayPoints(ctx, db, metricSlug, start, end)
	if err != nil {
		return nil, err
	}
	return AlertEventReplayModel{
		EventID:        id,
		MetricProvider: provider,
		MetricSlug:     metricSlug,
		Unit:           unit,
		Points:         points,
	}, nil
}

// replayCenterContext is the named subset of an event context the replay
// window reads. recordedAt stays an opaque leaf so a non-string value falls
// back to the trigger time instead of failing the column decode.
type replayCenterContext struct {
	RecordedAt json.RawMessage `json:"recordedAt"`
}

// replayCenter returns the context recordedAt when the context is a JSON
// object carrying a non-empty JSON string, and the trigger time otherwise.
func replayCenter(triggered time.Time, rawContext []byte) (time.Time, error) {
	fallback := truncateMillis(triggered)
	if len(bytes.TrimSpace(rawContext)) == 0 {
		return fallback, nil
	}
	var context replayCenterContext
	if err := json.Unmarshal(rawContext, &context); err != nil {
		return fallback, nil
	}
	raw, ok := jsonStringLeaf(context.RecordedAt)
	if !ok || raw == "" {
		return fallback, nil
	}
	parsed, ok := parseJSDate(raw)
	if !ok {
		return time.Time{}, errors.New("alerts: invalid replay center time")
	}
	return parsed, nil
}

func loadReplayPoints(ctx context.Context, db *sql.DB, slug string, start, end time.Time) ([]AlertEventReplayPointModel, *string, error) {
	rows, err := db.QueryContext(ctx, replayPointSelect, slug, start, end)
	if err != nil {
		return nil, nil, queryErr("event replay points", err)
	}
	defer rows.Close()

	points := make([]AlertEventReplayPointModel, 0)
	var unit *string
	for rows.Next() {
		var (
			recorded time.Time
			value    sql.NullString
			rawUnit  sql.NullString
		)
		if err := rows.Scan(&recorded, &value, &rawUnit); err != nil {
			return nil, nil, queryErr("scan replay point", err)
		}
		if unit == nil && rawUnit.Valid && rawUnit.String != "" {
			unit = stringPtr(rawUnit.String)
		}
		points = append(points, AlertEventReplayPointModel{
			Timestamp: utcTime(recorded),
			Value:     reqDecimal(value),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, nil, queryErr("event replay points", err)
	}
	if err := rows.Close(); err != nil {
		return nil, nil, queryErr("event replay points", err)
	}
	return points, unit, nil
}
