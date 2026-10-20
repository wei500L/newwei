package graphqlsubscriptions

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
)

func TestDecodeAlertEnvelopeToModel(t *testing.T) {
	payload := []byte(`{
		"orgId":"org-a",
		"event":{
			"id":"event-1",
			"ruleId":"",
			"ruleName":"",
			"metricProvider":"economic_data",
			"metricSlug":"   ",
			"triggeredAt":{"$gqlDate":"2026-10-19T20:01:02.345Z"},
			"message":"",
			"severity":"high",
			"metricValue":"12.5",
			"changePercent":"NaN",
			"status":"delivered",
			"context":[1,2,3]
		}
	}`)
	event, ok := decodeFeedEvent("alertEvents", payload)
	if !ok {
		t.Fatal("decodeFeedEvent() rejected a valid alert envelope")
	}
	if event.OrgID != "org-a" {
		t.Fatalf("orgId = %q", event.OrgID)
	}
	if event.Error != nil {
		t.Fatalf("event error = %+v", event.Error)
	}
	model := event.Value.(alerts.AlertEventModel)
	if model.ID != "event-1" || model.Severity != "high" || model.Status != "delivered" {
		t.Fatalf("model = %+v", model)
	}
	if model.MetricValue != 12.5 {
		t.Fatalf("metricValue = %v, want 12.5", model.MetricValue)
	}
	if model.ChangePercent != nil {
		t.Fatalf("changePercent = %v, want null for a non-finite value", *model.ChangePercent)
	}
	if model.MetricSlug != nil {
		t.Fatalf("metricSlug = %q, want null after trim", *model.MetricSlug)
	}
	if model.Message == nil || *model.Message != "" {
		t.Fatalf("message = %v, want the empty string preserved", model.Message)
	}
	if model.RuleID == nil || *model.RuleID != "" {
		t.Fatalf("ruleId = %v, want the empty string preserved", model.RuleID)
	}
	if model.MetricProvider == nil || *model.MetricProvider != "economic_data" {
		t.Fatalf("metricProvider = %v", model.MetricProvider)
	}
	if model.Context != nil {
		t.Fatalf("context = %s, want null for an array", *model.Context)
	}
	if model.Deliveries == nil || len(model.Deliveries) != 0 {
		t.Fatalf("deliveries = %v, want an empty slice", model.Deliveries)
	}
	if model.Operator != nil || model.ThresholdValue != nil || model.ThresholdLower != nil ||
		model.ThresholdUpper != nil || model.ChangeWindowMin != nil {
		t.Fatal("envelope-absent rule fields must stay null")
	}
	if model.TriggeredAt.UTC().Format(time.RFC3339Nano) != "2026-10-19T20:01:02.345Z" {
		t.Fatalf("triggeredAt = %v", model.TriggeredAt)
	}
}

func TestDecodeAlertMissingMetricValueBecomesZero(t *testing.T) {
	payload := []byte(`{
		"orgId":"org-a",
		"event":{
			"id":"event-1",
			"ruleId":"rule-1",
			"triggeredAt":"2026-10-19T20:01:02.345Z",
			"severity":"low",
			"metricValue":"Infinity",
			"status":"pending"
		}
	}`)
	event, ok := decodeFeedEvent("alertEvents", payload)
	if !ok || event.Error != nil {
		t.Fatalf("decodeFeedEvent() = %+v, %v", event.Error, ok)
	}
	model := event.Value.(alerts.AlertEventModel)
	if model.MetricValue != 0 {
		t.Fatalf("metricValue = %v, want 0 for a non-finite value", model.MetricValue)
	}
	if model.ChangePercent != nil || model.RuleName != nil || model.MetricProvider != nil || model.Message != nil {
		t.Fatalf("nullish fields = %v/%v/%v/%v", model.ChangePercent, model.RuleName, model.MetricProvider, model.Message)
	}
}

func TestDecodeAlertContextRevivesNestedTaggedDate(t *testing.T) {
	payload := []byte(`{
		"orgId":"org-a",
		"event":{
			"id":"event-1",
			"ruleId":"rule-1",
			"triggeredAt":{"$gqlDate":"2026-10-19T20:01:02.345Z"},
			"severity":"high",
			"metricValue":1,
			"status":"delivered",
			"context":{"nested":{"$gqlDate":"2026-10-19T20:01:02.345Z"},"array":[{"$gqlDate":"2026-10-19T20:01:02.345Z"}]}
		}
	}`)
	event, ok := decodeFeedEvent("alertEvents", payload)
	if !ok || event.Error != nil {
		t.Fatalf("decodeFeedEvent() = %+v, %v", event.Error, ok)
	}
	model := event.Value.(alerts.AlertEventModel)
	if model.Context == nil {
		t.Fatal("context object must be kept")
	}
	var context map[string]any
	if err := json.Unmarshal(*model.Context, &context); err != nil {
		t.Fatalf("context JSON: %v", err)
	}
	nested, _ := context["nested"].(string)
	if nested != "2026-10-19T20:01:02.345Z" {
		t.Fatalf("nested tagged date = %v", context["nested"])
	}
	array, _ := context["array"].([]any)
	if len(array) != 1 || array[0] != "2026-10-19T20:01:02.345Z" {
		t.Fatalf("array tagged date = %v", context["array"])
	}
}

func TestDecodeAlertInvalidDateIsAnEventError(t *testing.T) {
	for name, value := range map[string]string{
		"invalid tag": `{"$gqlDate":"not-a-date"}`,
		"zero date":   `{"$gqlDate":"0001-01-01T00:00:00Z"}`,
		"tag object":  `{"$gqlDate":{"nested":true}}`,
		"null":        `null`,
	} {
		t.Run(name, func(t *testing.T) {
			payload := []byte(`{"orgId":"org-a","event":{"id":"event-1","ruleId":"rule-1","triggeredAt":` + value +
				`,"severity":"high","metricValue":1,"status":"delivered"}}`)
			event, ok := decodeFeedEvent("alertEvents", payload)
			if !ok {
				t.Fatal("decodeFeedEvent() rejected the envelope")
			}
			if event.Error == nil || event.Error.Field != "triggeredAt" || event.Error.Message != invalidTimeMessage {
				t.Fatalf("event error = %+v, want triggeredAt invalid time", event.Error)
			}
		})
	}
}

func TestDecodeAnalysisEnvelopeMappings(t *testing.T) {
	payload := []byte(`{
		"orgId":"org-a",
		"result":{
			"id":"analysis-1",
			"type":"something-else",
			"status":"something-else",
			"summary":"",
			"error":null,
			"createdAt":"2026-10-19T20:01:02.345Z"
		}
	}`)
	event, ok := decodeFeedEvent("analysisEvents", payload)
	if !ok || event.Error != nil {
		t.Fatalf("decodeFeedEvent() = %+v, %v", event.Error, ok)
	}
	model := event.Value.(AnalysisResultModel)
	if model.Type != "correlation" || model.Status != "pending" {
		t.Fatalf("type/status = %s/%s, want correlation/pending", model.Type, model.Status)
	}
	if model.Summary == nil || *model.Summary != "" {
		t.Fatalf("summary = %v, want an empty string preserved", model.Summary)
	}
	if model.Input != nil || model.Output != nil || model.Error != nil {
		t.Fatalf("input/output/error = %v/%v/%v, want null", model.Input, model.Output, model.Error)
	}
	if model.CreatedAt.Format(time.RFC3339Nano) != "2026-10-19T20:01:02.345Z" {
		t.Fatalf("createdAt = %v", model.CreatedAt)
	}

	recognized := []byte(`{"orgId":"org-a","result":{"id":"a","type":"geo_transport","status":"failed","createdAt":"2026-10-19T20:01:02.345Z"}}`)
	event, ok = decodeFeedEvent("analysisEvents", recognized)
	if !ok || event.Error != nil {
		t.Fatalf("recognized decode = %+v, %v", event.Error, ok)
	}
	model = event.Value.(AnalysisResultModel)
	if model.Type != "geo_transport" || model.Status != "failed" {
		t.Fatalf("recognized type/status = %s/%s", model.Type, model.Status)
	}

	invalid := []byte(`{"orgId":"org-a","result":{"id":"a","type":"anomaly","status":"failed","createdAt":"nope"}}`)
	event, ok = decodeFeedEvent("analysisEvents", invalid)
	if !ok || event.Error == nil || event.Error.Field != "createdAt" {
		t.Fatalf("invalid date error = %+v", event.Error)
	}
}

func TestDecodeAssistantEnvelopeMappings(t *testing.T) {
	payload := []byte(`{
		"orgId":"org-a",
		"run":{
			"id":"run-1",
			"type":"something-else",
			"status":"running",
			"summary":"",
			"error":"",
			"createdAt":"2026-10-19T20:01:02.345Z"
		}
	}`)
	event, ok := decodeFeedEvent("assistantEvents", payload)
	if !ok || event.Error != nil {
		t.Fatalf("decodeFeedEvent() = %+v, %v", event.Error, ok)
	}
	model := event.Value.(AssistantRunModel)
	if model.Type != "query" || model.Status != "running" {
		t.Fatalf("type/status = %s/%s, want query/running", model.Type, model.Status)
	}
	if model.Summary == nil || *model.Summary != "" || model.Error == nil || *model.Error != "" {
		t.Fatalf("summary/error = %v/%v, want empty strings preserved", model.Summary, model.Error)
	}
	if model.ConversationID != nil || model.Input != nil || model.Output != nil {
		t.Fatalf("conversationId/input/output = %v/%v/%v, want null", model.ConversationID, model.Input, model.Output)
	}

	recognized := []byte(`{"orgId":"org-a","run":{"id":"r","type":"forecast","status":"pending","createdAt":"2026-10-19T20:01:02.345Z"}}`)
	event, ok = decodeFeedEvent("assistantEvents", recognized)
	if !ok || event.Error != nil {
		t.Fatalf("recognized decode = %+v, %v", event.Error, ok)
	}
	model = event.Value.(AssistantRunModel)
	if model.Type != "forecast" || model.Status != "pending" {
		t.Fatalf("recognized type/status = %s/%s", model.Type, model.Status)
	}
}

func TestDecodeFeedEventRejectsMalformedAndUnknownRoots(t *testing.T) {
	if _, ok := decodeFeedEvent("alertEvents", []byte("{")); ok {
		t.Fatal("malformed JSON must be ignored")
	}
	if _, ok := decodeFeedEvent("unknownEvents", []byte(`{}`)); ok {
		t.Fatal("unknown root must be ignored")
	}
	if strings.TrimSpace(invalidTimeMessage) == "" {
		t.Fatal("invalid time message must be stable")
	}
}
