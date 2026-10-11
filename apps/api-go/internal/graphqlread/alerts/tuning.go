package alerts

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const tuningRuleSelect = "SELECT `id`, `operator`, `thresholdValue`, `thresholdLower`, `thresholdUpper` " +
	"FROM `AlertRule` WHERE `id` = ? AND `orgId` = ?"

const tuningEventSelect = "SELECT `status`, `metricValue`, `changePercent` " +
	"FROM `AlertEvent` WHERE `ruleId` = ? AND `triggeredAt` >= ? " +
	"ORDER BY `triggeredAt` DESC LIMIT ?"

const tuningEventLimit = 500

type tuningRule struct {
	ID             string
	Operator       string
	ThresholdValue sql.NullString
	ThresholdLower sql.NullString
	ThresholdUpper sql.NullString
}

type tuningEvent struct {
	Status        string
	MetricValue   sql.NullString
	ChangePercent sql.NullFloat64
}

func tuningSuggestion(ctx context.Context, db *sql.DB, orgID, ruleID string, windowDays int) (any, error) {
	if err := requireDB(db); err != nil {
		return nil, err
	}
	rule, err := loadTuningRule(ctx, db, orgID, ruleID)
	if err != nil || rule == nil {
		return nil, err
	}
	events, err := loadTuningEvents(ctx, db, rule.ID, windowStart(windowDays))
	if err != nil {
		return nil, err
	}
	return buildTuningSuggestion(*rule, events, windowDays), nil
}

func loadTuningRule(ctx context.Context, db *sql.DB, orgID, ruleID string) (*tuningRule, error) {
	var rule tuningRule
	err := db.QueryRowContext(ctx, tuningRuleSelect, ruleID, orgID).Scan(
		&rule.ID,
		&rule.Operator,
		&rule.ThresholdValue,
		&rule.ThresholdLower,
		&rule.ThresholdUpper,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, queryErr("tuning rule", err)
	}
	return &rule, nil
}

func loadTuningEvents(ctx context.Context, db *sql.DB, ruleID string, since time.Time) ([]tuningEvent, error) {
	rows, err := db.QueryContext(ctx, tuningEventSelect, ruleID, since, tuningEventLimit)
	if err != nil {
		return nil, queryErr("tuning events", err)
	}
	defer rows.Close()
	events := make([]tuningEvent, 0)
	for rows.Next() {
		var event tuningEvent
		if err := rows.Scan(&event.Status, &event.MetricValue, &event.ChangePercent); err != nil {
			return nil, queryErr("scan tuning event", err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, queryErr("tuning events", err)
	}
	if err := rows.Close(); err != nil {
		return nil, queryErr("tuning events", err)
	}
	return events, nil
}

func buildTuningSuggestion(rule tuningRule, events []tuningEvent, windowDays int) AlertRuleTuningSuggestionModel {
	confirmed := make([]float64, 0)
	ignored := make([]float64, 0)
	for _, event := range events {
		if event.Status != statusConfirmed && event.Status != statusIgnored {
			continue
		}
		value, ok := tuningValue(rule.Operator, event)
		if !ok {
			continue
		}
		if event.Status == statusConfirmed {
			confirmed = append(confirmed, value)
		} else {
			ignored = append(ignored, value)
		}
	}

	confirmedEvents := len(confirmed)
	ignoredEvents := len(ignored)
	reviewedEvents := confirmedEvents + ignoredEvents
	var falsePositiveRate *float64
	if reviewedEvents > 0 {
		rate := float64(ignoredEvents) / float64(reviewedEvents)
		falsePositiveRate = &rate
	}
	base := AlertRuleTuningSuggestionModel{
		RuleID:            rule.ID,
		WindowDays:        windowDays,
		TotalEvents:       len(events),
		ReviewedEvents:    reviewedEvents,
		ConfirmedEvents:   confirmedEvents,
		IgnoredEvents:     ignoredEvents,
		FalsePositiveRate: falsePositiveRate,
		Action:            actionNone,
	}
	if reviewedEvents < 5 {
		message := notEnoughReviewedMessage
		base.Message = &message
		return base
	}

	currentThreshold := optDecimal(rule.ThresholdValue)
	currentLower := optDecimal(rule.ThresholdLower)
	currentUpper := optDecimal(rule.ThresholdUpper)

	if isHighThreshold(rule.Operator) {
		suggested := suggestHighThreshold(currentThreshold, ignored, confirmed)
		if suggested != nil && currentThreshold != nil && *suggested > *currentThreshold {
			base.Action = actionIncrease
			base.SuggestedThresholdValue = suggested
			message := fmt.Sprintf(
				"High false-positive rate: consider raising threshold from %s to ~%s (ignored avg %s, confirmed avg %s).",
				formatJSNumber(*currentThreshold),
				formatFixed(*suggested, 4),
				meanText(ignored),
				meanText(confirmed),
			)
			base.Message = &message
		}
		return base
	}

	if isLowThreshold(rule.Operator) {
		suggested := suggestLowThreshold(currentThreshold, ignored, confirmed)
		if suggested != nil && currentThreshold != nil && *suggested < *currentThreshold {
			base.Action = actionDecrease
			base.SuggestedThresholdValue = suggested
			message := fmt.Sprintf(
				"High false-positive rate: consider lowering threshold from %s to ~%s (ignored avg %s, confirmed avg %s).",
				formatJSNumber(*currentThreshold),
				formatFixed(*suggested, 4),
				meanText(ignored),
				meanText(confirmed),
			)
			base.Message = &message
		}
		return base
	}

	if rule.Operator == opOutsideRange && currentLower != nil && currentUpper != nil {
		lowerIgnored, lowerConfirmed, upperIgnored, upperConfirmed := splitRangeEvents(events, *currentLower, *currentUpper)
		suggestedLower := suggestRangeLower(*currentLower, lowerIgnored, lowerConfirmed)
		suggestedUpper := suggestRangeUpper(*currentUpper, upperIgnored, upperConfirmed)
		if suggestedLower == nil && suggestedUpper == nil {
			return base
		}
		base.Action = actionAdjust
		base.SuggestedThresholdLower = suggestedLower
		base.SuggestedThresholdUpper = suggestedUpper
		message := fmt.Sprintf(
			"Consider adjusting range from [%s, %s] to [%s, %s] based on ignored/confirmed splits.",
			formatJSNumber(*currentLower),
			formatJSNumber(*currentUpper),
			thresholdText(suggestedLower, *currentLower),
			thresholdText(suggestedUpper, *currentUpper),
		)
		base.Message = &message
		return base
	}

	return base
}

func isHighThreshold(operator string) bool {
	switch operator {
	case opGT, opGTE, opChangeUpPct, opChangeDownPct:
		return true
	default:
		return false
	}
}

func isLowThreshold(operator string) bool {
	return operator == opLT || operator == opLTE
}

func tuningValue(operator string, event tuningEvent) (float64, bool) {
	if operator == opChangeUpPct || operator == opChangeDownPct {
		if !event.ChangePercent.Valid {
			return 0, false
		}
		value, ok := contract.FiniteFloat(event.ChangePercent.Float64)
		if !ok {
			return 0, false
		}
		if operator == opChangeDownPct {
			value = -value
		}
		return value, true
	}
	return finiteDecimal(event.MetricValue)
}

func splitRangeEvents(events []tuningEvent, lower, upper float64) (lowerIgnored, lowerConfirmed, upperIgnored, upperConfirmed []float64) {
	for _, event := range events {
		if event.Status != statusConfirmed && event.Status != statusIgnored {
			continue
		}
		value, ok := finiteDecimal(event.MetricValue)
		if !ok {
			continue
		}
		var bucket *[]float64
		switch {
		case value < lower:
			if event.Status == statusConfirmed {
				bucket = &lowerConfirmed
			} else {
				bucket = &lowerIgnored
			}
		case value > upper:
			if event.Status == statusConfirmed {
				bucket = &upperConfirmed
			} else {
				bucket = &upperIgnored
			}
		default:
			continue
		}
		*bucket = append(*bucket, value)
	}
	return lowerIgnored, lowerConfirmed, upperIgnored, upperConfirmed
}

func suggestHighThreshold(current *float64, ignored, confirmed []float64) *float64 {
	if len(ignored) == 0 {
		return nil
	}
	maxIgnored := maxFloat(ignored)
	if len(confirmed) > 0 {
		minConfirmed := minFloat(confirmed)
		if minConfirmed > maxIgnored {
			mid := (minConfirmed + maxIgnored) / 2
			return &mid
		}
	}
	p90 := quantile(ignored, 0.9)
	if p90 != nil && isFinite(*p90) {
		if current != nil {
			value := math.Max(*current, *p90)
			return &value
		}
		return p90
	}
	return current
}

func suggestLowThreshold(current *float64, ignored, confirmed []float64) *float64 {
	if len(ignored) == 0 {
		return nil
	}
	minIgnored := minFloat(ignored)
	if len(confirmed) > 0 {
		maxConfirmed := maxFloat(confirmed)
		if maxConfirmed < minIgnored {
			mid := (maxConfirmed + minIgnored) / 2
			return &mid
		}
	}
	p10 := quantile(ignored, 0.1)
	if p10 != nil && isFinite(*p10) {
		if current != nil {
			value := math.Min(*current, *p10)
			return &value
		}
		return p10
	}
	return current
}

func suggestRangeLower(current float64, ignored, confirmed []float64) *float64 {
	if len(ignored) == 0 {
		return nil
	}
	minIgnored := minFloat(ignored)
	if len(confirmed) > 0 {
		maxConfirmed := maxFloat(confirmed)
		if maxConfirmed < minIgnored {
			mid := (maxConfirmed + minIgnored) / 2
			return &mid
		}
	}
	p10 := quantile(ignored, 0.1)
	if p10 != nil && isFinite(*p10) {
		value := math.Min(current, *p10)
		return &value
	}
	return nil
}

func suggestRangeUpper(current float64, ignored, confirmed []float64) *float64 {
	if len(ignored) == 0 {
		return nil
	}
	maxIgnored := maxFloat(ignored)
	if len(confirmed) > 0 {
		minConfirmed := minFloat(confirmed)
		if minConfirmed > maxIgnored {
			mid := (minConfirmed + maxIgnored) / 2
			return &mid
		}
	}
	p90 := quantile(ignored, 0.9)
	if p90 != nil && isFinite(*p90) {
		value := math.Max(current, *p90)
		return &value
	}
	return nil
}
