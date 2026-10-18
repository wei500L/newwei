package alerts

import (
	"encoding/json"
	"time"
)

// GraphQL object types for the migrated alert read queries.
// Pointer fields are nullable. time.Time is DateTime. JSON scalars carry
// json.RawMessage so no untyped map ever holds database content.
// Enum fields are SDL names.

// AlertChannelModel is one notification channel.
type AlertChannelModel struct {
	ID        string           `graphql:"id"`
	Name      string           `graphql:"name"`
	Type      string           `graphql:"type"`
	Target    string           `graphql:"target"`
	IsActive  bool             `graphql:"isActive"`
	Config    *json.RawMessage `graphql:"config"`
	CreatedAt time.Time        `graphql:"createdAt"`
	UpdatedAt time.Time        `graphql:"updatedAt"`
}

// AlertDeliveryModel is one delivery attempt on an alert event.
type AlertDeliveryModel struct {
	ID          string     `graphql:"id"`
	Status      string     `graphql:"status"`
	Error       *string    `graphql:"error"`
	SentAt      *time.Time `graphql:"sentAt"`
	ChannelType string     `graphql:"channelType"`
	ChannelName *string    `graphql:"channelName"`
	Target      *string    `graphql:"target"`
}

// AlertEventReplayPointModel is one economic series sample around an event.
type AlertEventReplayPointModel struct {
	Timestamp time.Time `graphql:"timestamp"`
	Value     float64   `graphql:"value"`
}

// AlertEventReplayModel is the economic series window around one event.
type AlertEventReplayModel struct {
	EventID        string                       `graphql:"eventId"`
	MetricProvider string                       `graphql:"metricProvider"`
	MetricSlug     string                       `graphql:"metricSlug"`
	Unit           *string                      `graphql:"unit"`
	Points         []AlertEventReplayPointModel `graphql:"points"`
}

// AlertEventModel is one triggered alert, including its rule snapshot and deliveries.
type AlertEventModel struct {
	ID              string               `graphql:"id"`
	TriggeredAt     time.Time            `graphql:"triggeredAt"`
	MetricValue     float64              `graphql:"metricValue"`
	ChangePercent   *float64             `graphql:"changePercent"`
	Severity        string               `graphql:"severity"`
	Status          string               `graphql:"status"`
	Message         *string              `graphql:"message"`
	RuleID          *string              `graphql:"ruleId"`
	RuleName        *string              `graphql:"ruleName"`
	MetricProvider  *string              `graphql:"metricProvider"`
	MetricSlug      *string              `graphql:"metricSlug"`
	Operator        *string              `graphql:"operator"`
	ThresholdValue  *float64             `graphql:"thresholdValue"`
	ThresholdLower  *float64             `graphql:"thresholdLower"`
	ThresholdUpper  *float64             `graphql:"thresholdUpper"`
	ChangeWindowMin *float64             `graphql:"changeWindowMin"`
	Context         *json.RawMessage     `graphql:"context"`
	Deliveries      []AlertDeliveryModel `graphql:"deliveries"`
}

// AlertRuleTuningSuggestionModel is a threshold hint derived from reviewed events.
type AlertRuleTuningSuggestionModel struct {
	RuleID                  string   `graphql:"ruleId"`
	WindowDays              int      `graphql:"windowDays"`
	TotalEvents             int      `graphql:"totalEvents"`
	ReviewedEvents          int      `graphql:"reviewedEvents"`
	ConfirmedEvents         int      `graphql:"confirmedEvents"`
	IgnoredEvents           int      `graphql:"ignoredEvents"`
	FalsePositiveRate       *float64 `graphql:"falsePositiveRate"`
	Action                  string   `graphql:"action"`
	Message                 *string  `graphql:"message"`
	SuggestedThresholdValue *float64 `graphql:"suggestedThresholdValue"`
	SuggestedThresholdLower *float64 `graphql:"suggestedThresholdLower"`
	SuggestedThresholdUpper *float64 `graphql:"suggestedThresholdUpper"`
}
