package alertworker

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/alertworker/queue"
	"github.com/wei500L/newwei/apps/api-go/internal/authlogin"
)

// deliveryChannel is the channel snapshot read from AlertDelivery.targetSnapshot:
// the whole channel object the evaluation stored.
type deliveryChannel struct {
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	Target string          `json:"target"`
	Name   string          `json:"name"`
	Config json.RawMessage `json:"config"`
}

// HandleDeliveryJob is the port of AlertsService.handleDeliveryJob.
//
// The delayed branches return a *queue.DelayedError, which the worker turns into
// BullMQ's moveToDelayed with skipAttempt="1": the attempt neither completes nor
// fails, exactly like `job.moveToDelayed(ts, token)` + `throw new DelayedError()`
// in NestJS.
func (s *Service) HandleDeliveryJob(ctx context.Context, job queue.Job, payload queue.DeliverJobData, handle queue.JobHandle) error {
	delivery, err := s.repo.loadDeliveryWithEventAndRule(ctx, s.db, payload.DeliveryID)
	if err != nil {
		return err
	}
	if delivery == nil {
		return nil
	}
	channel, ok := parseDeliveryChannel(delivery.TargetSnapshot)
	if !ok || channel.Type == "" || channel.Target == "" {
		if err := s.transitionDelivery(ctx, delivery.ID, []string{DeliveryStatusPending, DeliveryStatusSending}, deliveryStatusUpdate{
			Status:   DeliveryStatusFailed,
			SetError: true,
			Error:    stringPtr("Invalid channel snapshot"),
		}); err != nil {
			return err
		}
		s.reconcileEventStatus(ctx, delivery.EventID)
		return nil
	}
	if delivery.Status != DeliveryStatusPending && delivery.Status != DeliveryStatusSending {
		s.reconcileEventStatus(ctx, delivery.EventID)
		return nil
	}

	ruleMuteUntilMs := extractMuteUntilMs(delivery.Rule.Metadata)
	channelMuteUntilMs := extractMuteUntilMs(channel.Config)
	var muteUntilMs *int64
	if ruleMuteUntilMs != nil || channelMuteUntilMs != nil {
		value := int64(0)
		if ruleMuteUntilMs != nil {
			value = *ruleMuteUntilMs
		}
		if channelMuteUntilMs != nil && *channelMuteUntilMs > value {
			value = *channelMuteUntilMs
		}
		if value != 0 {
			muteUntilMs = &value
		}
	}
	now := s.now()
	if IsMutedNow(muteUntilMs, now.UnixMilli()) {
		suppressedAt := time.UnixMilli(*muteUntilMs).UTC().Format(isoMillisLayout)
		if err := s.transitionDelivery(ctx, delivery.ID, []string{DeliveryStatusPending, DeliveryStatusSending}, deliveryStatusUpdate{
			Status:   DeliveryStatusSent,
			SentAt:   &now,
			SetError: true,
			Error:    stringPtr("suppressed: muted until " + suppressedAt),
		}); err != nil {
			return err
		}
		s.reconcileEventStatus(ctx, delivery.EventID)
		return nil
	}

	minIntervalSeconds := extractNotifyIntervalSeconds(channel.Config)
	if channel.Type != ChannelTypeEmail && channel.Type != ChannelTypeWebhook {
		if err := s.transitionDelivery(ctx, delivery.ID, []string{DeliveryStatusPending, DeliveryStatusSending}, deliveryStatusUpdate{
			Status:   DeliveryStatusFailed,
			SetError: true,
			Error:    stringPtr("Unsupported channel type " + channel.Type),
		}); err != nil {
			return err
		}
		s.reconcileEventStatus(ctx, delivery.EventID)
		return nil
	}

	// From here on the NestJS handler is inside its try/catch: a failure before
	// the delivery is occupied cannot match the [sending] transition and leaves
	// the row pending, while the job is still retried.
	err = s.sendDelivery(ctx, delivery, channel, payload, handle, minIntervalSeconds, now, job.AttemptsMade, job.Attempts())
	s.reconcileEventStatus(ctx, delivery.EventID)
	return err
}

// sendDelivery is the try block of handleDeliveryJob.
func (s *Service) sendDelivery(
	ctx context.Context,
	delivery *DeliveryRow,
	channel deliveryChannel,
	payload queue.DeliverJobData,
	handle queue.JobHandle,
	minIntervalSeconds *int64,
	now time.Time,
	attemptsMade int,
	attempts int,
) error {
	var delayed *queue.DelayedError
	if err := s.applyDeliverySchedule(ctx, delivery, channel, payload, handle, minIntervalSeconds, now); err != nil {
		if errors.As(err, &delayed) {
			return err
		}
		// An error in this region never reached the [sending] state, so the
		// conditional transition is a no-op; the failure is still returned so
		// BullMQ retries the job.
		s.transitionDeliveryOnError(ctx, delivery, err, attemptsMade, attempts)
		return err
	}

	occupied, err := s.occupyDeliveryForSend(ctx, delivery)
	if err != nil {
		s.transitionDeliveryOnError(ctx, delivery, err, attemptsMade, attempts)
		return err
	}
	if !occupied {
		return nil
	}

	var sendErr error
	switch channel.Type {
	case ChannelTypeEmail:
		sendErr = s.sendEmail(ctx, channel.Target, delivery)
	case ChannelTypeWebhook:
		sendErr = s.sendWebhook(ctx, channel.Target, delivery)
	}
	if sendErr == nil {
		sentAt := s.now()
		if err := s.transitionDelivery(ctx, delivery.ID, []string{DeliveryStatusSending}, deliveryStatusUpdate{
			Status: DeliveryStatusSent,
			SentAt: &sentAt,
		}); err != nil {
			return err
		}
		return nil
	}
	s.transitionDeliveryOnError(ctx, delivery, sendErr, attemptsMade, attempts)
	return sendErr
}

// applyDeliverySchedule is the pending-only block of handleDeliveryJob: honour an
// existing scheduledAtMs, reserve a rate-limit slot when there is none, persist
// or clear the option and ask the worker to delay the job.
func (s *Service) applyDeliverySchedule(
	ctx context.Context,
	delivery *DeliveryRow,
	channel deliveryChannel,
	payload queue.DeliverJobData,
	handle queue.JobHandle,
	minIntervalSeconds *int64,
	now time.Time,
) error {
	if delivery.Status != DeliveryStatusPending {
		return nil
	}
	hadScheduledAtMs := payload.ScheduledAtMs != nil
	if payload.ScheduledAtMs != nil && now.UnixMilli() < *payload.ScheduledAtMs {
		return &queue.DelayedError{UntilMs: *payload.ScheduledAtMs}
	}
	if payload.ScheduledAtMs == nil {
		channelID := channel.ID
		if delivery.ChannelID != nil {
			channelID = *delivery.ChannelID
		}
		scheduledAtMs, err := s.throttle.ReserveNotificationScheduleMs(ctx, ReserveInput{
			ChannelType:        channel.Type,
			ChannelID:          channelID,
			MinIntervalSeconds: minIntervalSeconds,
		})
		if err != nil {
			return err
		}
		if scheduledAtMs > now.UnixMilli() {
			updated := queue.DeliverJobData{
				Type:          payload.Type,
				DeliveryID:    payload.DeliveryID,
				OrgID:         payload.OrgID,
				TraceID:       payload.TraceID,
				ScheduledAtMs: &scheduledAtMs,
			}
			encoded, err := queue.MarshalJobData(updated)
			if err != nil {
				return err
			}
			if err := handle.UpdateData(ctx, encoded); err != nil {
				return err
			}
			return &queue.DelayedError{UntilMs: scheduledAtMs}
		}
	}
	if hadScheduledAtMs {
		cleared := queue.DeliverJobData{
			Type:       payload.Type,
			DeliveryID: payload.DeliveryID,
			OrgID:      payload.OrgID,
			TraceID:    payload.TraceID,
		}
		encoded, err := queue.MarshalJobData(cleared)
		if err != nil {
			return err
		}
		if err := handle.UpdateData(ctx, encoded); err != nil {
			return err
		}
	}
	return nil
}

// occupyDeliveryForSend is the port of occupyDeliveryForSend: an already
// sending row is ours, otherwise a pending row is claimed with CAS.
//
// The conditional update result is the second half of the contract: a pending
// row that another attempt transitioned between the read and the update (a
// retried job overlapping its previous attempt, or two consumers after a
// stalled recovery) must not be sent a second time. AlertsService
// occupyDeliveryForSend returns `updated.count === 1` for exactly this reason.
func (s *Service) occupyDeliveryForSend(ctx context.Context, delivery *DeliveryRow) (bool, error) {
	if delivery.Status == DeliveryStatusSending {
		return true, nil
	}
	return s.transitionDeliveryCAS(ctx, delivery.ID, []string{DeliveryStatusPending}, deliveryStatusUpdate{
		Status: DeliveryStatusSending,
	})
}

// transitionDeliveryOnError mirrors the catch block: the delivery becomes
// failed on the last attempt and pending otherwise, so a retry can pick it up
// again.
func (s *Service) transitionDeliveryOnError(ctx context.Context, delivery *DeliveryRow, cause error, attemptsMade, attempts int) {
	reason := cause.Error()
	status := DeliveryStatusPending
	// B1: BullMQ increments atm only after an attempt fails, so during the last
	// attempt attemptsMade is N-1 and `attemptsMade + 1 >= attempts` is the
	// correct last-attempt test. AlertsService.handleDeliveryJob carries the same
	// test (alerts.service.ts `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`),
	// so both consumers mark the final failure identically.
	if finalAttempt(attemptsMade, attempts) {
		status = DeliveryStatusFailed
	}
	if err := s.transitionDelivery(ctx, delivery.ID, []string{DeliveryStatusSending}, deliveryStatusUpdate{
		Status:   status,
		SetError: true,
		Error:    &reason,
	}); err != nil {
		s.logf("alertworker: delivery %s error transition: %v", delivery.ID, err)
	}
	s.logf("alertworker: alert delivery attempt failed (delivery=%s channel=%s attempt=%d): %s",
		delivery.ID, delivery.ChannelType, attemptsMade, reason)
}

// finalAttempt is `attemptsMade + 1 >= attempts` with BullMQ's default of one
// attempt when the option is absent.
func finalAttempt(attemptsMade, attempts int) bool {
	if attempts < 1 {
		attempts = 1
	}
	return attemptsMade+1 >= attempts
}

func (s *Service) transitionDelivery(ctx context.Context, deliveryID string, from []string, update deliveryStatusUpdate) error {
	_, err := s.transitionDeliveryCAS(ctx, deliveryID, from, update)
	return err
}

// transitionDeliveryCAS is transitionDelivery with the "did this row match"
// verdict of the conditional UPDATE, which the occupancy claim needs.
func (s *Service) transitionDeliveryCAS(ctx context.Context, deliveryID string, from []string, update deliveryStatusUpdate) (bool, error) {
	return s.repo.transitionDeliveryStatus(ctx, s.db, deliveryID, from, update)
}

// parseDeliveryChannel decodes the targetSnapshot channel object.
func parseDeliveryChannel(raw json.RawMessage) (deliveryChannel, bool) {
	if len(raw) == 0 {
		return deliveryChannel{}, false
	}
	var channel deliveryChannel
	if err := json.Unmarshal(raw, &channel); err != nil {
		return deliveryChannel{}, false
	}
	return channel, true
}

// sendEmail is the port of AlertsService.sendEmail: the subject, the Handlebars
// HTML/text pair and the shared SMTP transport.
func (s *Service) sendEmail(ctx context.Context, target string, delivery *DeliveryRow) error {
	if s.mail == nil {
		return errors.New("alertworker: smtp is not configured")
	}
	normalizedTarget, err := normalizeEmailTarget(target)
	if err != nil {
		return err
	}
	metricSlug := normalizeMetricSlug(delivery.Rule.MetricSlug)
	threshold := deliveryThreshold(delivery.Rule)
	input := AlertEmailInput{
		RuleName:      delivery.Rule.Name,
		Metric:        metricSlug,
		Value:         delivery.Event.MetricValue,
		Threshold:     threshold,
		TriggeredAt:   delivery.Event.TriggeredAt.UTC().Format(isoMillisLayout),
		Message:       delivery.Event.Message,
		ChangePercent: delivery.Event.ChangePercent,
	}
	return s.mail.Send(ctx, authlogin.MailMessage{
		To:      normalizedTarget,
		Subject: AlertEmailSubject(delivery.Rule.Name),
		Text:    RenderAlertText(input),
		HTML:    RenderAlertHTML(input),
	})
}

// sendWebhook is the port of AlertsService.sendWebhook: the payload fields, the
// threshold fallback order and the SSRF-validated pinned POST.
func (s *Service) sendWebhook(ctx context.Context, target string, delivery *DeliveryRow) error {
	if s.webhook == nil {
		return errors.New("alertworker: webhook client is not configured")
	}
	payload := BuildAlertWebhookPayload(AlertWebhookInput{
		EventID:      delivery.Event.ID,
		RuleName:     delivery.Rule.Name,
		Metric:       normalizeMetricSlug(delivery.Rule.MetricSlug),
		CurrentValue: delivery.Event.MetricValue,
		Threshold:    deliveryThreshold(delivery.Rule),
		TriggeredAt:  delivery.Event.TriggeredAt.UTC().Format(isoMillisLayout),
		Severity:     delivery.Event.Severity,
		Operator:     delivery.Rule.Operator,
		Message:      delivery.Event.Message,
	})
	return SendAlertWebhook(ctx, s.webhook, target, payload)
}

// deliveryThreshold is the threshold fallback order of the email and webhook
// payloads: thresholdValue, then thresholdUpper, then thresholdLower.
func deliveryThreshold(rule Rule) *float64 {
	if rule.ThresholdValue != nil {
		return rule.ThresholdValue
	}
	if rule.ThresholdUpper != nil {
		return rule.ThresholdUpper
	}
	return rule.ThresholdLower
}

// extractMuteUntilMs is the port of AlertsService.extractMuteUntilMs: the first
// non-nullish field of the six aliases decides, and only a string or a number is
// parsed (any other type yields null without falling through).
func extractMuteUntilMs(raw json.RawMessage) *int64 {
	object, ok := parseJSONObject(raw)
	if !ok {
		return nil
	}
	value, ok := firstNonNullish(object, []string{
		"muteUntil", "mutedUntil", "silenceUntil", "silencedUntil", "mute_until", "muted_until",
	})
	if !ok {
		return nil
	}
	return ParseMuteUntil(value)
}

// extractNotifyIntervalSeconds is the port of
// AlertsService.extractNotifyIntervalSeconds.
func extractNotifyIntervalSeconds(raw json.RawMessage) *int64 {
	object, ok := parseJSONObject(raw)
	if !ok {
		return nil
	}
	secondsValue, ok := firstNonNullish(object, []string{
		"notifyIntervalSeconds", "notifyIntervalSec", "notify_interval_seconds", "notify_interval_sec",
		"frequencySeconds", "frequencySec", "frequency_seconds", "frequency_sec",
		"minIntervalSeconds", "minIntervalSec", "min_interval_seconds", "min_interval_sec",
	})
	if ok {
		if seconds, ok := toPositiveFiniteNumber(secondsValue); ok {
			clamped := clampSeconds(seconds)
			return &clamped
		}
	}
	minutesValue, ok := firstNonNullish(object, []string{
		"notifyIntervalMinutes", "notifyIntervalMin", "notify_interval_minutes", "notify_interval_min",
		"frequencyMinutes", "frequencyMin", "frequency_minutes", "frequency_min",
	})
	if !ok {
		return nil
	}
	minutes, ok := toPositiveFiniteNumber(minutesValue)
	if !ok {
		return nil
	}
	clamped := clampSeconds(minutes * 60)
	return &clamped
}

// firstNonNullish returns the first present, non-null value of the alias list,
// mirroring the `??` chain.
func firstNonNullish(object *jsonObject, keys []string) (json.RawMessage, bool) {
	for _, key := range keys {
		value, ok := object.Get(key)
		if !ok {
			continue
		}
		if isJSONNull(value) {
			continue
		}
		return value, true
	}
	return nil, false
}

// toPositiveFiniteNumber is the port of toPositiveFiniteNumber: a finite number
// greater than zero, or a trimmed string whose Number() is finite and positive.
func toPositiveFiniteNumber(raw json.RawMessage) (float64, bool) {
	var number float64
	if err := json.Unmarshal(raw, &number); err == nil {
		if isFinite(number) && number > 0 {
			return number, true
		}
		return 0, false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, false
	}
	parsed, ok := parseJSNumberText(text)
	if !ok || !isFinite(parsed) || parsed <= 0 {
		return 0, false
	}
	return parsed, true
}

func isJSONNull(raw json.RawMessage) bool {
	trimmed := string(raw)
	return trimmed == "null"
}

func stringPtr(value string) *string { return &value }

// parseJSNumberText mirrors Number(string) for the plain decimal forms a notify
// interval configuration carries: empty is 0, surrounding whitespace is ignored.
// JavaScript's hex/octal/binary literals and Infinity are not meaningful interval
// values and are rejected.
func parseJSNumberText(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}
