package alertworker

import (
	"encoding/json"
	"time"
)

// Prisma enum values the alert worker compares against. They are the exact
// strings stored in MySQL.
const (
	StatusActive = "active"

	EventStatusPending   = "pending"
	EventStatusDelivered = "delivered"
	EventStatusFailed    = "failed"
	EventStatusConfirmed = "confirmed"
	EventStatusIgnored   = "ignored"

	DeliveryStatusPending = "pending"
	DeliveryStatusSending = "sending"
	DeliveryStatusSent    = "sent"
	DeliveryStatusFailed  = "failed"

	ChannelTypeEmail   = "email"
	ChannelTypeWebhook = "webhook"
	ChannelTypeInApp   = "in_app"

	NotificationTypeAlertTriggered = "alert_triggered"

	// presentationKindAlertTriggered mirrors
	// NotificationPresentationKind.AlertTriggered.
	presentationKindAlertTriggered = "alert_triggered"

	// alertsReadPermission is ALERTS_READ_PERMISSION: the membership permission
	// an in-app recipient must hold.
	alertsReadPermission = "alerts.read"

	// systemDefaultRuleVersion is the metadata.version of a default rule.
	systemDefaultRuleVersion = 1

	// entitySentimentProvider is the source provider of the association rules.
	entitySentimentProvider = "entity_sentiment"

	// filteredRecipientSampleLimit is FILTERED_RECIPIENT_SAMPLE_LIMIT.
	filteredRecipientSampleLimit = 20
)

// notificationBackoffDelaysMs is NOTIFICATION_BACKOFF_DELAYS_MS: the custom
// `alertNotifications` retry table of 60s, 5m and 15m.
var notificationBackoffDelaysMs = []int64{60_000, 5 * 60_000, 15 * 60_000}

// notificationAttempts is the job attempts the delivery queue sets:
// the length of the delay table plus one.
const notificationAttempts = 4

// Rule is one AlertRule row with the columns the worker reads.
type Rule struct {
	ID               string
	OrgID            string
	Name             string
	Description      *string
	Severity         string
	Status           string
	MetricProvider   string
	MetricSlug       string
	Operator         string
	ThresholdValue   *float64
	ThresholdLower   *float64
	ThresholdUpper   *float64
	ChangeWindowMin  *int
	CooldownSeconds  int
	CheckIntervalSec int
	LastTriggeredAt  *time.Time
	Metadata         json.RawMessage
	CreatedByID      *string
}

// Channel is one AlertNotificationChannel row.
type Channel struct {
	ID        string
	OrgID     string
	Type      string
	Name      string
	Target    string
	Config    json.RawMessage
	IsActive  bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ruleChannelLink is one AlertRuleChannel row joined with its channel.
type ruleChannelLink struct {
	RuleID    string
	ChannelID string
	Channel   *Channel
}

// EventRow is one AlertEvent row.
type EventRow struct {
	ID            string
	RuleID        string
	TriggeredAt   time.Time
	MetricValue   float64
	ChangePercent *float64
	Severity      string
	Status        string
	Message       *string
	Context       json.RawMessage
}

// DeliveryRow is one AlertDelivery row joined with its event and rule, which is
// what handleDeliveryJob reads.
type DeliveryRow struct {
	ID             string
	EventID        string
	ChannelID      *string
	ChannelType    string
	TargetSnapshot json.RawMessage
	Status         string
	Error          *string
	SentAt         *time.Time

	Event EventRow
	Rule  Rule
}

// RuleSnapshot is the rule projection the delivery channel payloads need.
type RuleSnapshot struct {
	ID             string
	Name           string
	MetricSlug     string
	Operator       string
	ThresholdValue *float64
	ThresholdLower *float64
	ThresholdUpper *float64
}

// channelSnapshot is the targetSnapshot of an external delivery: the whole
// channel object, exactly like `targetSnapshot: channel` in NestJS.
type channelSnapshot struct {
	ID        string          `json:"id"`
	OrgID     string          `json:"orgId"`
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	Target    string          `json:"target"`
	Config    json.RawMessage `json:"config"`
	IsActive  bool            `json:"isActive"`
	CreatedAt string          `json:"createdAt"`
	UpdatedAt string          `json:"updatedAt"`
}

// inAppTargetSnapshot is the targetSnapshot of an in-app delivery.
type inAppTargetSnapshot struct {
	UserID         string `json:"userId"`
	NotificationID string `json:"notificationId,omitempty"`
}

// RecipientCandidate is one candidate in-app recipient.
type RecipientCandidate struct {
	UserID string
}

// RecipientResolution is the resolved in-app recipient set.
type RecipientResolution struct {
	CandidateUserIDs         []string
	AllowedUserIDs           []string
	MissingPermissionUserIDs []string
}

// InAppDelivery is one persisted in-app delivery row.
type InAppDelivery struct {
	ID     string
	UserID string
}

// notificationContextSummary is the context subset alert notifications carry.
type notificationContextSummary struct {
	CountryCode *string `json:"countryCode,omitempty"`
	CountryName *string `json:"countryName,omitempty"`
	ItemName    *string `json:"itemName,omitempty"`
	SourceName  *string `json:"sourceName,omitempty"`
	RecordedAt  *string `json:"recordedAt,omitempty"`
	Unit        *string `json:"unit,omitempty"`
}

// notificationPresentationParams is the params object of the alert
// presentation, in the NestJS insertion order.
type notificationPresentationParams struct {
	AlertEventID  string                      `json:"alertEventId"`
	RuleID        string                      `json:"ruleId"`
	RuleName      string                      `json:"ruleName"`
	Severity      string                      `json:"severity"`
	MetricSlug    string                      `json:"metricSlug"`
	MetricValue   float64                     `json:"metricValue"`
	ChangePercent *float64                    `json:"changePercent,omitempty"`
	Context       *notificationContextSummary `json:"context,omitempty"`
}

// notificationPresentation is the presentation object of the alert
// notification data.
type notificationPresentation struct {
	Kind            string                         `json:"kind"`
	Params          notificationPresentationParams `json:"params"`
	TechnicalDetail *string                        `json:"technicalDetail,omitempty"`
}

// notificationData is the typed Notification.data payload. The field order is
// the order the NestJS object literal builds.
type notificationData struct {
	AlertEventID  string                      `json:"alertEventId"`
	RuleID        string                      `json:"ruleId"`
	RuleName      string                      `json:"ruleName"`
	Severity      string                      `json:"severity"`
	MetricSlug    string                      `json:"metricSlug"`
	MetricValue   float64                     `json:"metricValue"`
	ChangePercent *float64                    `json:"changePercent,omitempty"`
	Context       *notificationContextSummary `json:"context,omitempty"`
	Presentation  notificationPresentation    `json:"presentation"`
}

// alertEventEnvelope is the alertEvents subscription payload. It matches
// AlertEventPayload in alerts.pubsub.ts field for field.
type alertEventEnvelope struct {
	OrgID string                `json:"orgId"`
	Event alertEventPayloadBody `json:"event"`
}

// alertEventPayloadBody is the event object of the alertEvents envelope.
type alertEventPayloadBody struct {
	ID             string `json:"id"`
	RuleID         string `json:"ruleId"`
	RuleName       string `json:"ruleName"`
	MetricProvider string `json:"metricProvider"`
	MetricSlug     string `json:"metricSlug"`
	// TriggeredAt is tagged like the GraphQL subscription codec does for a
	// Date, so the published envelope matches GraphqlSubscriptionBus output.
	TriggeredAt   gqlDate         `json:"triggeredAt"`
	Message       *string         `json:"message,omitempty"`
	Severity      string          `json:"severity"`
	MetricValue   float64         `json:"metricValue"`
	ChangePercent *float64        `json:"changePercent"`
	Status        string          `json:"status"`
	Context       json.RawMessage `json:"context"`
}

// notificationRelayMessage is the alert-only Redis pub/sub envelope. It carries
// identifiers only; the notification body stays in MySQL.
type notificationRelayMessage struct {
	Version        int    `json:"version"`
	NotificationID string `json:"notificationId"`
	OrgID          string `json:"orgId"`
	UserID         string `json:"userId"`
}

// notificationRelayVersion is the relay envelope version.
const notificationRelayVersion = 1
