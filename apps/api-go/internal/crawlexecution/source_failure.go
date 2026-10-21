package crawlexecution

// B2: the news source failure counter and the two ops notifications.
//
// markSourceFailureState is CrawlExecutionResultsService.markSourceFailureState.
// The counter update runs in one transaction that locks the NewsSource row with
// SELECT ... FOR UPDATE, so two concurrent terminal failures of the same source
// can neither lose an increment nor both alert: only the transaction that
// observes the threshold crossing notifies. The notifications are written after
// the commit, as org-wide (userId NULL, type system) rows through
// newssourcescheduler.NotifySystemGeneric, which publishes the generic
// notification:events:v1 relay instead of the legacy news-source channel.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"time"
)

// Presentation kinds of the two source notifications.
const (
	presentationKindNewsSourceCircuitOpened = "news_source_circuit_opened"
	presentationKindNewsSourceAutoDisabled  = "news_source_auto_disabled"
	notificationTypeSystem                  = "system"
	sourceFailureCircuitOpenedTitle         = "News source circuit opened"
	sourceFailureAutoDisabledTitle          = "News source disabled after failures"
)

// sourceFailureInput is one counter update, with every environment value
// resolved by the caller.
type sourceFailureInput struct {
	PreviousFailures          int
	IsActive                  bool
	Threshold                 int
	AutoDisableThreshold      int
	FailureRecoveryDelayMs    int
	FailureMaxDelayMs         int
	CircuitBreakerBaseDelayMs int
	CircuitBreakerMaxDelayMs  int
	FailureAt                 time.Time
	// Backoff computes the jittered exponential delay; nil uses the shared
	// ±25% jitter implementation.
	Backoff func(baseDelayMs, attempt, maxDelayMs int) int
}

// sourceFailurePlan is the pure outcome of one counter update.
type sourceFailurePlan struct {
	// Skipped is true when the source is inactive and must not be touched.
	Skipped             bool
	ConsecutiveFailures int
	CircuitOpenUntil    *time.Time
	NextRunAt           time.Time
	ShouldDisable       bool
	// NotifyCircuitOpen is true only for the transaction that moved the counter
	// from threshold-1 to threshold.
	NotifyCircuitOpen bool
	// NotifyAutoDisable is true only for the transaction that reached the
	// auto-disable threshold.
	NotifyAutoDisable bool
}

// planSourceFailure is the circuit-breaker math of markSourceFailureState. It is
// pure so the threshold-crossing decision is testable without MySQL.
func planSourceFailure(input sourceFailureInput) sourceFailurePlan {
	if !input.IsActive {
		return sourceFailurePlan{Skipped: true}
	}
	backoff := input.Backoff
	if backoff == nil {
		backoff = computeExponentialBackoffDelayMs
	}
	threshold := input.Threshold
	if threshold < 0 {
		threshold = 0
	}
	autoDisableThreshold := input.AutoDisableThreshold
	if autoDisableThreshold < 0 {
		autoDisableThreshold = 0
	}
	consecutiveFailures := input.PreviousFailures + 1
	retryDelayMs := backoff(input.FailureRecoveryDelayMs, consecutiveFailures, input.FailureMaxDelayMs)
	retryAt := input.FailureAt.Add(time.Duration(retryDelayMs) * time.Millisecond)

	var circuitOpenUntil *time.Time
	if threshold > 0 && consecutiveFailures >= threshold {
		circuitAttempt := consecutiveFailures - threshold + 1
		circuitDelayMs := backoff(input.CircuitBreakerBaseDelayMs, circuitAttempt, input.CircuitBreakerMaxDelayMs)
		value := input.FailureAt.Add(time.Duration(circuitDelayMs) * time.Millisecond)
		circuitOpenUntil = &value
	}
	plan := sourceFailurePlan{
		ConsecutiveFailures: consecutiveFailures,
		CircuitOpenUntil:    circuitOpenUntil,
		NotifyCircuitOpen:   threshold > 0 && consecutiveFailures == threshold && circuitOpenUntil != nil,
	}
	plan.NextRunAt = retryAt
	if circuitOpenUntil != nil && circuitOpenUntil.After(retryAt) {
		plan.NextRunAt = *circuitOpenUntil
	}
	plan.ShouldDisable = autoDisableThreshold > 0 && consecutiveFailures >= autoDisableThreshold
	if plan.ShouldDisable && consecutiveFailures == autoDisableThreshold {
		plan.NotifyAutoDisable = true
	}
	return plan
}

// sourceFailureOutcome carries the post-commit notification inputs.
type sourceFailureOutcome struct {
	SourceID            string
	OrgID               string
	Name                string
	Threshold           int
	ConsecutiveFailures int
	CircuitOpenUntil    *time.Time
	NotifyCircuitOpen   bool
	NotifyAutoDisable   bool
}

// resolvedSourceFailureConfig resolves the environment values with the NestJS
// defaults the previous implementation already applied.
func (s *Service) resolvedSourceFailureConfig() (threshold, autoDisableThreshold, recoveryDelay, maxDelay, circuitBase, circuitMax int) {
	threshold = maxInt(s.cfg.CircuitBreakerThreshold, 0)
	autoDisableThreshold = maxInt(s.cfg.AutoDisableThreshold, 0)
	recoveryDelay = s.cfg.FailureRecoveryDelayMs
	if recoveryDelay <= 0 {
		recoveryDelay = 60_000
	}
	maxDelay = s.cfg.FailureMaxDelayMs
	if maxDelay <= 0 {
		maxDelay = 900_000
	}
	circuitBase = s.cfg.CircuitBreakerBaseDelayMs
	if circuitBase <= 0 {
		circuitBase = 60_000
	}
	circuitMax = s.cfg.CircuitBreakerMaxDelayMs
	if circuitMax <= 0 {
		circuitMax = 900_000
	}
	return threshold, autoDisableThreshold, recoveryDelay, maxDelay, circuitBase, circuitMax
}

// markSourceFailureState is CrawlExecutionResultsService.markSourceFailureState:
// bump the counter in one row-locked transaction, then notify what that
// transaction alone observed.
func (s *Service) markSourceFailureState(ctx context.Context, sourceID string, failureAt time.Time) {
	if s.db == nil || sourceID == "" {
		return
	}
	outcome, err := s.applySourceFailureState(ctx, sourceID, failureAt)
	if err != nil {
		log.Printf("crawlexecution: failed to update news source failure state sourceId=%s: %v", sourceID, err)
		return
	}
	if outcome == nil {
		return
	}
	if outcome.NotifyCircuitOpen {
		s.notifySourceCircuitOpened(ctx, outcome)
	}
	if outcome.NotifyAutoDisable {
		s.notifySourceAutoDisabled(ctx, outcome)
	}
}

// applySourceFailureState runs the counter update transaction. The returned
// outcome is non-nil only when the source exists, is active and was updated.
func (s *Service) applySourceFailureState(ctx context.Context, sourceID string, failureAt time.Time) (*sourceFailureOutcome, error) {
	threshold, autoDisableThreshold, recoveryDelay, maxDelay, circuitBase, circuitMax := s.resolvedSourceFailureConfig()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var previousFailures int64
	var isActive bool
	var orgID, name string
	// FOR UPDATE is the B2 fix: the row lock serializes concurrent terminal
	// failures of one source, so the read-modify-write cannot lose an increment
	// and only one transaction sees the threshold crossing.
	if err := tx.QueryRowContext(ctx,
		"SELECT `consecutiveFailures`, `isActive`, `orgId`, `name` FROM `NewsSource` WHERE `id` = ? FOR UPDATE",
		sourceID).Scan(&previousFailures, &isActive, &orgID, &name); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if !isActive {
		return nil, nil
	}
	plan := planSourceFailure(sourceFailureInput{
		PreviousFailures:          int(previousFailures),
		IsActive:                  isActive,
		Threshold:                 threshold,
		AutoDisableThreshold:      autoDisableThreshold,
		FailureRecoveryDelayMs:    recoveryDelay,
		FailureMaxDelayMs:         maxDelay,
		CircuitBreakerBaseDelayMs: circuitBase,
		CircuitBreakerMaxDelayMs:  circuitMax,
		FailureAt:                 failureAt,
	})
	if plan.Skipped {
		return nil, nil
	}

	var nextRunValue any = plan.NextRunAt
	var isActiveValue any = true
	if plan.ShouldDisable {
		nextRunValue = nil
		isActiveValue = false
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE `NewsSource` SET `lastFailureAt` = ?, `consecutiveFailures` = ?, `circuitOpenUntil` = ?, "+
			"`nextRunAt` = ?, `isActive` = ?, `updatedAt` = ? WHERE `id` = ?",
		failureAt, plan.ConsecutiveFailures, nullableTime(plan.CircuitOpenUntil), nextRunValue, isActiveValue,
		s.now().UTC().Truncate(time.Millisecond), sourceID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &sourceFailureOutcome{
		SourceID:            sourceID,
		OrgID:               orgID,
		Name:                name,
		Threshold:           threshold,
		ConsecutiveFailures: plan.ConsecutiveFailures,
		CircuitOpenUntil:    plan.CircuitOpenUntil,
		NotifyCircuitOpen:   plan.NotifyCircuitOpen,
		NotifyAutoDisable:   plan.NotifyAutoDisable,
	}, nil
}

// sourceNotificationPresentation is the presentation descriptor of the two
// source notifications. params is the typed params object encoded by the
// builder, so the member order stays explicit.
type sourceNotificationPresentation struct {
	Kind   string          `json:"kind"`
	Params json.RawMessage `json:"params"`
}

// sourceCircuitOpenedParams is the circuit-open params object.
type sourceCircuitOpenedParams struct {
	SourceID            string `json:"sourceId"`
	SourceName          string `json:"sourceName"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
	CircuitOpenUntil    string `json:"circuitOpenUntil"`
}

// sourceCircuitOpenedData is the circuit-open Notification.data, in NestJS
// member order.
type sourceCircuitOpenedData struct {
	SourceID            string                         `json:"sourceId"`
	SourceName          string                         `json:"sourceName"`
	ConsecutiveFailures int                            `json:"consecutiveFailures"`
	CircuitOpenUntil    string                         `json:"circuitOpenUntil"`
	Presentation        sourceNotificationPresentation `json:"presentation"`
}

// sourceAutoDisabledParams is the auto-disable params object.
type sourceAutoDisabledParams struct {
	SourceID            string `json:"sourceId"`
	SourceName          string `json:"sourceName"`
	ConsecutiveFailures int    `json:"consecutiveFailures"`
}

// sourceAutoDisabledData is the auto-disable Notification.data. The NestJS
// object lists consecutiveFailures before sourceName.
type sourceAutoDisabledData struct {
	SourceID            string                         `json:"sourceId"`
	ConsecutiveFailures int                            `json:"consecutiveFailures"`
	SourceName          string                         `json:"sourceName"`
	Presentation        sourceNotificationPresentation `json:"presentation"`
}

// sourceCircuitOpenedNotification renders title, body and data.
func sourceCircuitOpenedNotification(sourceID, sourceName string, threshold int, circuitOpenUntil time.Time) (string, string, json.RawMessage, bool) {
	untilISO := isoMillisJS(circuitOpenUntil)
	params, err := json.Marshal(sourceCircuitOpenedParams{
		SourceID:            sourceID,
		SourceName:          sourceName,
		ConsecutiveFailures: threshold,
		CircuitOpenUntil:    untilISO,
	})
	if err != nil {
		return "", "", nil, false
	}
	data, err := json.Marshal(sourceCircuitOpenedData{
		SourceID:            sourceID,
		SourceName:          sourceName,
		ConsecutiveFailures: threshold,
		CircuitOpenUntil:    untilISO,
		Presentation: sourceNotificationPresentation{
			Kind:   presentationKindNewsSourceCircuitOpened,
			Params: params,
		},
	})
	if err != nil {
		return "", "", nil, false
	}
	body := "News source \"" + sourceName + "\" reached " + strconv.Itoa(threshold) +
		" consecutive failures and is paused until " + untilISO + "."
	return sourceFailureCircuitOpenedTitle, body, data, true
}

// sourceAutoDisabledNotification renders title, body and data.
func sourceAutoDisabledNotification(sourceID, sourceName string, failures int) (string, string, json.RawMessage, bool) {
	params, err := json.Marshal(sourceAutoDisabledParams{
		SourceID:            sourceID,
		SourceName:          sourceName,
		ConsecutiveFailures: failures,
	})
	if err != nil {
		return "", "", nil, false
	}
	data, err := json.Marshal(sourceAutoDisabledData{
		SourceID:            sourceID,
		ConsecutiveFailures: failures,
		SourceName:          sourceName,
		Presentation: sourceNotificationPresentation{
			Kind:   presentationKindNewsSourceAutoDisabled,
			Params: params,
		},
	})
	if err != nil {
		return "", "", nil, false
	}
	body := "News source \"" + sourceName + "\" was disabled after " + strconv.Itoa(failures) +
		" consecutive failures."
	return sourceFailureAutoDisabledTitle, body, data, true
}

// notifySourceCircuitOpened writes the circuit-open system notification.
func (s *Service) notifySourceCircuitOpened(ctx context.Context, outcome *sourceFailureOutcome) {
	if s.scheduler == nil || outcome == nil || outcome.CircuitOpenUntil == nil {
		return
	}
	title, body, data, ok := sourceCircuitOpenedNotification(
		outcome.SourceID, outcome.Name, outcome.Threshold, *outcome.CircuitOpenUntil)
	if !ok {
		return
	}
	s.scheduler.NotifySystemGeneric(ctx, outcome.OrgID, title, body, data, s.schedulerRelay())
}

// notifySourceAutoDisabled writes the auto-disable system notification.
func (s *Service) notifySourceAutoDisabled(ctx context.Context, outcome *sourceFailureOutcome) {
	if s.scheduler == nil || outcome == nil {
		return
	}
	title, body, data, ok := sourceAutoDisabledNotification(
		outcome.SourceID, outcome.Name, outcome.ConsecutiveFailures)
	if !ok {
		return
	}
	s.scheduler.NotifySystemGeneric(ctx, outcome.OrgID, title, body, data, s.schedulerRelay())
}
