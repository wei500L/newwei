package alertworker

import (
	"context"
	"encoding/json"
	"time"
)

// Redis channels of the two bridges.
const (
	// gqlSubscriptionChannelPrefix is GQL_SUBSCRIPTION_CHANNEL_PREFIX: the
	// GraphqlSubscriptionBus publishes on `<prefix><triggerName>`.
	gqlSubscriptionChannelPrefix = "gqlsub:"
	// alertEventsTrigger is the GraphQL subscription name the resolver filters.
	alertEventsTrigger = "alertEvents"
	// alertNotificationChannel is the alert-only relay channel the NestJS
	// AlertNotificationSubscriber listens on.
	alertNotificationChannel = "alert:notifications:v1"
)

// gqlDate is the tagged Date the GraphQL subscription codec uses
// (graphql-subscription-codec.ts: {$gqlDate: <ISO-8601>}). The bus encodes every
// Date of the payload this way, so publishing the tag keeps the NestJS
// subscribers (and the Go transport of a later batch) byte-compatible.
type gqlDate struct {
	time time.Time
}

func (d gqlDate) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Tagged string `json:"$gqlDate"`
	}{Tagged: d.time.UTC().Format(isoMillisLayout)})
}

// publishAlertEvent publishes the alertEvents envelope, equivalent to
// `pubsub.publish("alertEvents", {orgId, event})` through the shared
// GraphqlSubscriptionBus: channel `gqlsub:alertEvents` and the
// `{orgId, event}` payload with the tagged triggeredAt.
func (s *Service) publishAlertEvent(ctx context.Context, rule Rule, event EventRow, message, status string, contextObject *jsonObject) {
	envelope := alertEventEnvelope{
		OrgID: rule.OrgID,
		Event: alertEventPayloadBody{
			ID:             event.ID,
			RuleID:         rule.ID,
			RuleName:       rule.Name,
			MetricProvider: rule.MetricProvider,
			MetricSlug:     normalizeMetricSlug(rule.MetricSlug),
			TriggeredAt:    gqlDate{time: event.TriggeredAt},
			Message:        &message,
			Severity:       rule.Severity,
			MetricValue:    event.MetricValue,
			ChangePercent:  event.ChangePercent,
			Status:         status,
			Context:        contextObject.Marshal(),
		},
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		s.logf("alertworker: encode alertEvents envelope: %v", err)
		return
	}
	if err := s.redis.Publish(ctx, gqlSubscriptionChannelPrefix+alertEventsTrigger, encoded).Err(); err != nil {
		s.logf("alertworker: publish alertEvents for event %s: %v", event.ID, err)
	}
}

// publishNotificationRelay asks NestJS to push one alert notification over its
// Socket.IO gateway. The row is already committed; a publish failure only means
// the local sockets of this instant miss the event, exactly like the digest
// relay.
func (s *Service) publishNotificationRelay(ctx context.Context, notificationID, orgID, userID string) {
	message, err := json.Marshal(notificationRelayMessage{
		Version:        notificationRelayVersion,
		NotificationID: notificationID,
		OrgID:          orgID,
		UserID:         userID,
	})
	if err != nil {
		s.logf("alertworker: encode alert notification relay message: %v", err)
		return
	}
	if err := s.redis.Publish(ctx, alertNotificationChannel, message).Err(); err != nil {
		s.logf("alertworker: publish alert notification relay for %s: %v", notificationID, err)
	}
}
