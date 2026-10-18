package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"
)

const eventSelect = "SELECT " +
	"e.`id`, e.`ruleId`, e.`triggeredAt`, e.`metricValue`, e.`changePercent`, e.`severity`, e.`status`, e.`message`, e.`context`, " +
	"r.`name`, r.`metricProvider`, r.`metricSlug`, r.`operator`, r.`thresholdValue`, r.`thresholdLower`, r.`thresholdUpper`, r.`changeWindowMin` " +
	"FROM `AlertEvent` AS e " +
	"INNER JOIN `AlertRule` AS r ON r.`id` = e.`ruleId` "

type eventRow struct {
	ID              string
	RuleID          string
	TriggeredAt     time.Time
	MetricValue     sql.NullString
	ChangePercent   sql.NullFloat64
	Severity        string
	Status          string
	Message         sql.NullString
	Context         []byte
	RuleName        string
	MetricProvider  string
	MetricSlug      string
	Operator        string
	ThresholdValue  sql.NullString
	ThresholdLower  sql.NullString
	ThresholdUpper  sql.NullString
	ChangeWindowMin sql.NullInt64
}

func listEvents(ctx context.Context, db *sql.DB, orgID string, limit int, metricSlug string) ([]AlertEventModel, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	rows, err := loadEventRows(ctx, db, orgID, limit, metricSlug)
	if err != nil {
		return nil, err
	}
	return serializeEvents(ctx, db, rows)
}

func loadEventRows(ctx context.Context, db *sql.DB, orgID string, limit int, metricSlug string) ([]eventRow, error) {
	if metricSlug == "" {
		return queryEvents(ctx, db, "r.`orgId` = ?", []any{orgID}, limit)
	}
	exact, err := queryEvents(ctx, db, "r.`orgId` = ? AND r.`metricSlug` = ?", []any{orgID, metricSlug}, limit)
	if err != nil {
		return nil, err
	}
	if len(exact) >= limit {
		return exact, nil
	}
	// Legacy rows may store metricSlug with leading or trailing spaces.
	fallbackTake := max(limit*10, 200)
	fallback, err := queryEvents(ctx, db, "r.`orgId` = ?", []any{orgID}, fallbackTake)
	if err != nil {
		return nil, err
	}
	return mergeEvents(exact, fallback, metricSlug, limit), nil
}

func queryEvents(ctx context.Context, db *sql.DB, where string, args []any, limit int) ([]eventRow, error) {
	queryArgs := make([]any, 0, len(args)+1)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, limit)
	rows, err := db.QueryContext(ctx, eventSelect+"WHERE "+where+" ORDER BY e.`triggeredAt` DESC LIMIT ?", queryArgs...)
	if err != nil {
		return nil, queryErr("list events", err)
	}
	defer rows.Close()

	events := make([]eventRow, 0)
	for rows.Next() {
		row, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, row)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list events", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list events", err)
	}
	return events, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanEvent(scanner rowScanner) (eventRow, error) {
	var row eventRow
	if err := scanner.Scan(
		&row.ID,
		&row.RuleID,
		&row.TriggeredAt,
		&row.MetricValue,
		&row.ChangePercent,
		&row.Severity,
		&row.Status,
		&row.Message,
		&row.Context,
		&row.RuleName,
		&row.MetricProvider,
		&row.MetricSlug,
		&row.Operator,
		&row.ThresholdValue,
		&row.ThresholdLower,
		&row.ThresholdUpper,
		&row.ChangeWindowMin,
	); err != nil {
		return eventRow{}, queryErr("scan event", err)
	}
	return row, nil
}

func mergeEvents(exact, fallback []eventRow, needle string, limit int) []eventRow {
	merged := make([]eventRow, 0, len(exact)+len(fallback))
	seen := make(map[string]struct{}, len(exact)+len(fallback))
	add := func(row eventRow) {
		if _, ok := seen[row.ID]; ok {
			return
		}
		seen[row.ID] = struct{}{}
		merged = append(merged, row)
	}
	for _, row := range exact {
		add(row)
	}
	for _, row := range fallback {
		if normalizeMetricSlug(row.MetricSlug) != needle {
			continue
		}
		add(row)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		return merged[i].TriggeredAt.After(merged[j].TriggeredAt)
	})
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

func serializeEvents(ctx context.Context, db *sql.DB, rows []eventRow) ([]AlertEventModel, error) {
	deliveries, err := loadDeliveries(ctx, db, rows)
	if err != nil {
		return nil, err
	}
	models := make([]AlertEventModel, 0, len(rows))
	for _, row := range rows {
		model, err := serializeEvent(row, deliveries[row.ID])
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, nil
}

// LoadEventModel loads one alert event by id, scoped to orgID through its rule,
// and serializes it with exactly the same rules as the alertEvents read root.
// It returns (nil, nil) when the event does not exist or belongs to another
// organization, so a caller can map that to its own not-found contract.
func LoadEventModel(ctx context.Context, db *sql.DB, orgID, eventID string) (*AlertEventModel, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	rows, err := queryEvents(ctx, db, "e.`id` = ? AND r.`orgId` = ?", []any{eventID, orgID}, 1)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	models, err := serializeEvents(ctx, db, rows)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, nil
	}
	return &models[0], nil
}

// EventContextForOrg returns the raw context JSON column of one alert event,
// scoped to orgID through its rule. found is false when the event does not
// exist or belongs to another organization. A NULL column is reported as an
// empty raw value.
func EventContextForOrg(ctx context.Context, db *sql.DB, orgID, eventID string) (json.RawMessage, bool, error) {
	if err := requireDB(db); err != nil {
		return nil, false, err
	}
	var raw []byte
	err := db.QueryRowContext(ctx,
		"SELECT e.`context` FROM `AlertEvent` AS e "+
			"INNER JOIN `AlertRule` AS r ON r.`id` = e.`ruleId` "+
			"WHERE e.`id` = ? AND r.`orgId` = ? LIMIT 1",
		eventID, orgID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, queryErr("event context", err)
	}
	return json.RawMessage(raw), true, nil
}

func serializeEvent(row eventRow, deliveries []AlertDeliveryModel) (AlertEventModel, error) {
	if deliveries == nil {
		deliveries = []AlertDeliveryModel{}
	}
	return AlertEventModel{
		ID:              row.ID,
		TriggeredAt:     utcTime(row.TriggeredAt),
		MetricValue:     reqDecimal(row.MetricValue),
		ChangePercent:   nullFloatPtr(row.ChangePercent),
		Severity:        row.Severity,
		Status:          row.Status,
		Message:         nullStringPtr(row.Message),
		RuleID:          stringPtr(row.RuleID),
		RuleName:        stringPtr(row.RuleName),
		MetricProvider:  stringPtr(row.MetricProvider),
		MetricSlug:      optionalMetricSlug(row.MetricSlug),
		Operator:        stringPtr(row.Operator),
		ThresholdValue:  optDecimal(row.ThresholdValue),
		ThresholdLower:  optDecimal(row.ThresholdLower),
		ThresholdUpper:  optDecimal(row.ThresholdUpper),
		ChangeWindowMin: nullWindow(row.ChangeWindowMin),
		Context:         jsonObjectScalar(row.Context),
		Deliveries:      deliveries,
	}, nil
}

type deliveryRow struct {
	EventID        string
	ID             string
	Status         string
	Error          sql.NullString
	SentAt         sql.NullTime
	ChannelType    string
	TargetSnapshot []byte
	ChannelID      sql.NullString
	ChannelName    sql.NullString
	ChannelTarget  sql.NullString
}

func loadDeliveries(ctx context.Context, db *sql.DB, events []eventRow) (map[string][]AlertDeliveryModel, error) {
	grouped := make(map[string][]AlertDeliveryModel, len(events))
	if len(events) == 0 {
		return grouped, nil
	}
	args := make([]any, len(events))
	for i, event := range events {
		args[i] = event.ID
	}
	query := "SELECT d.`eventId`, d.`id`, d.`status`, d.`error`, d.`sentAt`, d.`channelType`, d.`targetSnapshot`, " +
		"c.`id`, c.`name`, c.`target` " +
		"FROM `AlertDelivery` AS d " +
		"LEFT JOIN `AlertNotificationChannel` AS c ON c.`id` = d.`channelId` " +
		"WHERE d.`eventId` IN (" + placeholders(len(args)) + ") " +
		"ORDER BY d.`createdAt` ASC, d.`id` ASC"
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, queryErr("list deliveries", err)
	}
	defer rows.Close()
	for rows.Next() {
		var row deliveryRow
		if err := rows.Scan(
			&row.EventID,
			&row.ID,
			&row.Status,
			&row.Error,
			&row.SentAt,
			&row.ChannelType,
			&row.TargetSnapshot,
			&row.ChannelID,
			&row.ChannelName,
			&row.ChannelTarget,
		); err != nil {
			return nil, queryErr("scan delivery", err)
		}
		model, err := serializeDelivery(row)
		if err != nil {
			return nil, err
		}
		grouped[row.EventID] = append(grouped[row.EventID], model)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("list deliveries", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("list deliveries", err)
	}
	return grouped, nil
}

func serializeDelivery(row deliveryRow) (AlertDeliveryModel, error) {
	model := AlertDeliveryModel{
		ID:          row.ID,
		Status:      row.Status,
		Error:       nullStringPtr(row.Error),
		SentAt:      nullTimePtr(row.SentAt),
		ChannelType: row.ChannelType,
	}
	if row.ChannelID.Valid {
		if row.ChannelName.Valid {
			model.ChannelName = stringPtr(row.ChannelName.String)
		}
		if row.ChannelTarget.Valid {
			model.Target = stringPtr(row.ChannelTarget.String)
		}
	}
	if model.ChannelName == nil || model.Target == nil {
		snapshot := decodeTargetSnapshot(row.TargetSnapshot)
		if model.ChannelName == nil {
			if name, ok := jsonStringLeaf(snapshot.Name); ok {
				model.ChannelName = stringPtr(name)
			}
		}
		if model.Target == nil {
			if target, ok := jsonStringLeaf(snapshot.Target); ok {
				model.Target = stringPtr(target)
			} else if userID, ok := jsonStringLeaf(snapshot.UserID); ok {
				model.Target = stringPtr(userID)
			}
		}
	}
	if model.ChannelName == nil && row.ChannelType == channelInApp {
		model.ChannelName = stringPtr("In-app")
	}
	return model, nil
}
