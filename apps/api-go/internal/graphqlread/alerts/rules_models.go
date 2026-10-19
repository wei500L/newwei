package alerts

import (
	"encoding/json"
	"time"
)

// AlertRuleModel projects the AlertRuleModel object type for alertRules and for
// the three rule mutations. Nullability follows schema.gql: description,
// thresholds, changeWindowMin, lastTriggeredAt and metadata are nullable, and
// channels is a non-null list.
//
// threshold values are projected through the same finite-number rule as the
// NestJS resolver (serializeOptionalFiniteNumber), so a NULL or non-finite
// decimal becomes GraphQL null instead of failing the response.
type AlertRuleModel struct {
	ID               string              `graphql:"id"`
	Name             string              `graphql:"name"`
	Description      *string             `graphql:"description"`
	Severity         string              `graphql:"severity"`
	Status           string              `graphql:"status"`
	MetricProvider   string              `graphql:"metricProvider"`
	MetricSlug       string              `graphql:"metricSlug"`
	Operator         string              `graphql:"operator"`
	ThresholdValue   *float64            `graphql:"thresholdValue"`
	ThresholdLower   *float64            `graphql:"thresholdLower"`
	ThresholdUpper   *float64            `graphql:"thresholdUpper"`
	ChangeWindowMin  *float64            `graphql:"changeWindowMin"`
	CooldownSeconds  float64             `graphql:"cooldownSeconds"`
	CheckIntervalSec float64             `graphql:"checkIntervalSec"`
	LastTriggeredAt  *time.Time          `graphql:"lastTriggeredAt"`
	Metadata         *json.RawMessage    `graphql:"metadata"`
	Channels         []AlertChannelModel `graphql:"channels"`
}

// ruleRow is the raw AlertRule row before normalization. Decimal columns are
// scanned as text so a MySQL DECIMAL never goes through a float64 round trip
// before the finite-number projection.
type ruleRow struct {
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
	ChangeWindowMin  *float64
	CooldownSeconds  float64
	CheckIntervalSec float64
	LastTriggeredAt  *time.Time
	Metadata         *json.RawMessage
	CreatedAt        time.Time
}
