package graphqlsubscriptions

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

const invalidTimeMessage = "Invalid time value"

// envelopeNumber decodes a JSON number or numeric string. The alert publisher
// sends a number, but Number(...) semantics in NestJS also accept a numeric
// string; invalid, null and missing values are not usable. Non-finite values
// are never projected.
type envelopeNumber struct {
	Present bool
	Valid   bool
	Value   float64
}

func (n *envelopeNumber) UnmarshalJSON(data []byte) error {
	n.Present = true
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	switch typed := value.(type) {
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			n.set(parsed)
		}
	case string:
		// JavaScript Number("") and Number("   ") are 0; the alert
		// serializer would keep that finite value.
		if strings.TrimSpace(typed) == "" {
			n.set(0)
			return nil
		}
		if parsed, err := strconv.ParseFloat(typed, 64); err == nil {
			n.set(parsed)
		}
	}
	return nil
}

func (n *envelopeNumber) set(value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return
	}
	n.Valid = true
	n.Value = value
}

// taggedDate decodes the codec's single-key {"$gqlDate":"ISO"} representation.
// A plain ISO string is accepted for compatibility with a Date that survived
// JSON.stringify without the tag. Invalid, zero and tagged non-date values
// stay invalid so the event is reported through GraphQL error semantics
// instead of being projected as a zero time.
type taggedDate struct {
	Time  time.Time
	Valid bool
}

func (d *taggedDate) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) == nil {
			d.set(text)
		}
		return nil
	}
	var record map[string]json.RawMessage
	if json.Unmarshal(trimmed, &record) != nil || len(record) != 1 {
		return nil
	}
	raw, ok := record["$gqlDate"]
	if !ok {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return nil
	}
	d.set(text)
	return nil
}

func (d *taggedDate) set(text string) {
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil || parsed.IsZero() {
		return
	}
	d.Time = parsed.UTC()
	d.Valid = true
}

func eventTime(text string) (time.Time, bool) {
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil || parsed.IsZero() {
		return time.Time{}, false
	}
	return parsed.UTC(), true
}

type alertEventEnvelope struct {
	OrgID string            `json:"orgId"`
	Event alertEventPayload `json:"event"`
}

type alertEventPayload struct {
	ID             string          `json:"id"`
	RuleID         *string         `json:"ruleId"`
	RuleName       *string         `json:"ruleName"`
	MetricProvider *string         `json:"metricProvider"`
	MetricSlug     *string         `json:"metricSlug"`
	TriggeredAt    taggedDate      `json:"triggeredAt"`
	Message        *string         `json:"message"`
	Severity       string          `json:"severity"`
	MetricValue    envelopeNumber  `json:"metricValue"`
	ChangePercent  envelopeNumber  `json:"changePercent"`
	Status         string          `json:"status"`
	Context        json.RawMessage `json:"context"`
}

type analysisEventEnvelope struct {
	OrgID  string                `json:"orgId"`
	Result analysisResultPayload `json:"result"`
}

type analysisResultPayload struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Status    string  `json:"status"`
	Summary   *string `json:"summary"`
	Error     *string `json:"error"`
	CreatedAt string  `json:"createdAt"`
}

type assistantEventEnvelope struct {
	OrgID string              `json:"orgId"`
	Run   assistantRunPayload `json:"run"`
}

type assistantRunPayload struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Status    string  `json:"status"`
	Summary   *string `json:"summary"`
	Error     *string `json:"error"`
	CreatedAt string  `json:"createdAt"`
}

// decodeFeedEvent maps one Redis pub/sub message onto a strongly typed event.
// Unknown roots and malformed JSON are ignored; the caller only keeps events
// whose orgId equals the authenticated operation's org exactly.
func decodeFeedEvent(root string, payload []byte) (FeedEvent, bool) {
	switch root {
	case "alertEvents":
		var envelope alertEventEnvelope
		if json.Unmarshal(payload, &envelope) != nil {
			return FeedEvent{}, false
		}
		model, eventErr := convertAlertEnvelope(envelope)
		return FeedEvent{OrgID: envelope.OrgID, Value: model, Error: eventErr}, true
	case "analysisEvents":
		var envelope analysisEventEnvelope
		if json.Unmarshal(payload, &envelope) != nil {
			return FeedEvent{}, false
		}
		model, eventErr := convertAnalysisEnvelope(envelope)
		return FeedEvent{OrgID: envelope.OrgID, Value: model, Error: eventErr}, true
	case "assistantEvents":
		var envelope assistantEventEnvelope
		if json.Unmarshal(payload, &envelope) != nil {
			return FeedEvent{}, false
		}
		model, eventErr := convertAssistantEnvelope(envelope)
		return FeedEvent{OrgID: envelope.OrgID, Value: model, Error: eventErr}, true
	default:
		return FeedEvent{}, false
	}
}

// convertAlertEnvelope mirrors alerts.serialization.ts
// serializeAlertEventPayload: deliveries are always empty (no database read),
// required metricValue becomes 0 when missing or non-finite, optional numbers
// become null, metricSlug is trimmed to null when blank, and context is kept
// only when it is a JSON object. Thresholds, operator and changeWindowMin are
// absent from the envelope and stay null; the rule is never loaded.
func convertAlertEnvelope(envelope alertEventEnvelope) (alerts.AlertEventModel, *contract.SubscriptionEventError) {
	event := envelope.Event
	model := alerts.AlertEventModel{
		ID:              event.ID,
		MetricValue:     0,
		Severity:        event.Severity,
		Status:          event.Status,
		Message:         event.Message,
		RuleID:          event.RuleID,
		RuleName:        event.RuleName,
		MetricProvider:  event.MetricProvider,
		MetricSlug:      optionalTrimmedString(event.MetricSlug),
		ChangePercent:   optionalFiniteNumber(event.ChangePercent),
		ChangeWindowMin: nil,
		Context:         objectJSON(event.Context),
		Deliveries:      []alerts.AlertDeliveryModel{},
	}
	if event.MetricValue.Valid {
		model.MetricValue = event.MetricValue.Value
	}
	if !event.TriggeredAt.Valid {
		return model, &contract.SubscriptionEventError{Field: "triggeredAt", Message: invalidTimeMessage}
	}
	model.TriggeredAt = event.TriggeredAt.Time
	return model, nil
}

func optionalFiniteNumber(value envelopeNumber) *float64 {
	if !value.Valid {
		return nil
	}
	number := value.Value
	return &number
}

func optionalTrimmedString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// objectJSON keeps only a JSON object. Arrays, scalars and invalid JSON become
// null exactly like the NestJS isRecord check. Tagged dates nested in the
// context are revived so the JSON scalar emits ISO strings, matching
// JSON.stringify after the codec's Date revival.
func objectJSON(raw json.RawMessage) *json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' || !json.Valid(trimmed) {
		return nil
	}
	var value any
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	value = reviveTaggedDates(value)
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	result := json.RawMessage(encoded)
	return &result
}

func reviveTaggedDates(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		if len(typed) == 1 {
			if tag, ok := typed["$gqlDate"].(string); ok {
				if parsed, valid := eventTime(tag); valid {
					return contract.FormatDateTime(parsed)
				}
			}
		}
		for key, item := range typed {
			typed[key] = reviveTaggedDates(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = reviveTaggedDates(item)
		}
		return typed
	default:
		return value
	}
}

// convertAnalysisEnvelope mirrors the analysis resolver: only geo_transport
// and anomaly are recognized, every other type becomes correlation; status is
// one of pending/running/completed/failed and otherwise pending. summary and
// error keep empty strings; input and output are always null.
func convertAnalysisEnvelope(envelope analysisEventEnvelope) (AnalysisResultModel, *contract.SubscriptionEventError) {
	result := envelope.Result
	createdAt, valid := eventTime(result.CreatedAt)
	model := AnalysisResultModel{
		CreatedAt: createdAt,
		Error:     result.Error,
		ID:        result.ID,
		Status:    analysisStatus(result.Status),
		Summary:   result.Summary,
		Type:      analysisType(result.Type),
	}
	if !valid {
		return model, &contract.SubscriptionEventError{Field: "createdAt", Message: invalidTimeMessage}
	}
	return model, nil
}

func analysisType(value string) string {
	switch value {
	case "geo_transport", "anomaly":
		return value
	default:
		return "correlation"
	}
}

func analysisStatus(value string) string {
	switch value {
	case "pending", "running", "completed", "failed":
		return value
	default:
		return "pending"
	}
}

// convertAssistantEnvelope mirrors the assistant resolver: only query, report
// and forecast are recognized, every other type becomes query. input, output
// and conversationId stay null.
func convertAssistantEnvelope(envelope assistantEventEnvelope) (AssistantRunModel, *contract.SubscriptionEventError) {
	run := envelope.Run
	createdAt, valid := eventTime(run.CreatedAt)
	model := AssistantRunModel{
		ConversationID: nil,
		CreatedAt:      createdAt,
		Error:          run.Error,
		ID:             run.ID,
		Status:         analysisStatus(run.Status),
		Summary:        run.Summary,
		Type:           assistantType(run.Type),
	}
	if !valid {
		return model, &contract.SubscriptionEventError{Field: "createdAt", Message: invalidTimeMessage}
	}
	return model, nil
}

func assistantType(value string) string {
	switch value {
	case "query", "report", "forecast":
		return value
	default:
		return "query"
	}
}
