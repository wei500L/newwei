package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// systemEventMetadata is the subset of AlertRule.metadata this provider reads.
type systemEventMetadata struct {
	Resource *string `json:"resource"`
	Action   *string `json:"action"`
}

// systemEventContext is the context object, in the NestJS field order. action is
// omitted when the rule does not constrain it, like JSON.stringify dropping an
// `undefined` value.
type systemEventContext struct {
	WindowMinutes int     `json:"windowMinutes"`
	Resource      string  `json:"resource"`
	Action        *string `json:"action,omitempty"`
}

// systemEventProvider ports SystemEventMetricProvider: it counts AuditLog rows
// for one resource (and optionally one action) in the current window and in the
// immediately preceding window.
type systemEventProvider struct {
	deps Dependencies
}

// NewSystemEvent builds the system_event provider.
func NewSystemEvent(deps Dependencies) Provider {
	return &systemEventProvider{deps: deps}
}

// Type implements Provider.
func (p *systemEventProvider) Type() string { return TypeSystemEvent }

// Fetch implements Provider.
func (p *systemEventProvider) Fetch(ctx context.Context, rule Rule) (Evaluation, error) {
	metricSlug := strings.TrimSpace(rule.MetricSlug)
	windowMinutes := 60
	if rule.ChangeWindowMin != nil {
		windowMinutes = *rule.ChangeWindowMin
	}
	// Both window bounds are derived from one instant, exactly like the NestJS
	// `const now = Date.now()` (windowStart and previousWindowStart share it).
	now := p.deps.now().UTC()
	windowStart := now.Add(-time.Duration(windowMinutes) * time.Minute)
	previousWindowStart := windowStart.Add(-time.Duration(windowMinutes) * time.Minute)

	metadata := systemEventMetadata{}
	if len(rule.Metadata) > 0 {
		// A non-string field leaves the pointer nil, the same decision as the
		// NestJS `typeof ... === "string"` guard, so the decode error is
		// intentionally ignored.
		_ = json.Unmarshal(rule.Metadata, &metadata)
	}
	resource := metricSlug
	if metadata.Resource != nil {
		if trimmed := strings.TrimSpace(*metadata.Resource); trimmed != "" {
			resource = trimmed
		}
	}
	if resource == "" {
		return metricErrorEvaluation("metric_slug_missing"), nil
	}
	var action *string
	if metadata.Action != nil {
		if trimmed := strings.TrimSpace(*metadata.Action); trimmed != "" {
			action = &trimmed
		}
	}

	if p.deps.DB == nil {
		return Evaluation{}, errors.New("alertworker/providers: system event: database is not configured")
	}
	latest, err := p.countAuditLogs(ctx, rule.OrgID, resource, action, windowStart, nil)
	if err != nil {
		return Evaluation{}, err
	}
	// The NestJS provider runs both counts with Promise.all; the windows are
	// disjoint and the bounds are fixed before the queries, so counting them
	// one after the other returns the same values.
	previous, err := p.countAuditLogs(ctx, rule.OrgID, resource, action, previousWindowStart, &windowStart)
	if err != nil {
		return Evaluation{}, err
	}

	// AuditLog counts are always numbers, so the only "no change" case is a
	// zero previous window (the NestJS `previous !== 0` check).
	var changePercent *float64
	if previous != 0 {
		changePercent = metricValuePtr(((float64(latest) - float64(previous)) / float64(previous)) * 100)
	}
	payload, err := metricContextJSON(systemEventContext{
		WindowMinutes: windowMinutes,
		Resource:      resource,
		Action:        action,
	})
	if err != nil {
		return Evaluation{}, err
	}
	return Evaluation{
		Latest:        metricValuePtr(float64(latest)),
		Previous:      metricValuePtr(float64(previous)),
		ChangePercent: changePercent,
		Context:       payload,
	}, nil
}

// countAuditLogs counts rows with createdAt >= from, and < until when until is
// not nil.
func (p *systemEventProvider) countAuditLogs(
	ctx context.Context,
	orgID string,
	resource string,
	action *string,
	from time.Time,
	until *time.Time,
) (int64, error) {
	query := "SELECT COUNT(*) FROM `AuditLog` WHERE `orgId` = ? AND `resource` = ?"
	args := []any{orgID, resource}
	if action != nil {
		query += " AND `action` = ?"
		args = append(args, *action)
	}
	query += " AND `createdAt` >= ?"
	args = append(args, from)
	if until != nil {
		query += " AND `createdAt` < ?"
		args = append(args, *until)
	}
	var count int64
	if err := p.deps.DB.QueryRowContext(ctx, query, args...).Scan(&count); err != nil {
		return 0, fmt.Errorf("alertworker/providers: system event count: %w", err)
	}
	return count, nil
}
