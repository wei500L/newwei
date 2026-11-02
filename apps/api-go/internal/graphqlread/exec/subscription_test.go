package exec

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

type subscriptionAlertModel struct {
	ID          string                      `graphql:"id"`
	TriggeredAt time.Time                   `graphql:"triggeredAt"`
	Severity    string                      `graphql:"severity"`
	Deliveries  []subscriptionDeliveryModel `graphql:"deliveries"`
}

type subscriptionDeliveryModel struct {
	ID string `graphql:"id"`
}

func newSubscriptionTestEngine(t *testing.T) *Engine {
	t.Helper()
	loaded, err := schema.Load()
	if err != nil {
		t.Fatalf("schema.Load() error = %v", err)
	}
	registry := contract.NewRegistry()
	registry.RegisterType("AlertEventModel", subscriptionAlertModel{})
	registry.RegisterType("AlertDeliveryModel", subscriptionDeliveryModel{})
	registry.RegisterSubscription(contract.Subscription{
		Root: contract.Root{Name: "alertEvents", Permission: "alerts.read"},
		Open: func(contract.Context) (<-chan contract.SubscriptionEvent, error) {
			return make(chan contract.SubscriptionEvent), nil
		},
	})
	return New(loaded, registry, 0, 0, nil)
}

func TestPlanSubscriptionOwnership(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	name := func(value string) *string { return &value }
	tests := []struct {
		name     string
		query    string
		opName   *string
		expected string
	}{
		{
			name:     "fully supported subscription",
			query:    `subscription Alert { alertEvents { id triggeredAt severity } }`,
			expected: KindExecute,
		},
		{
			name:     "alias and fragment",
			query:    `subscription Alert { a: alertEvents { ...Fields } } fragment Fields on AlertEventModel { id severity }`,
			expected: KindExecute,
		},
		{
			name:     "query operation is legacy",
			query:    `query Q { alertEvents(limit: 1) { id } }`,
			expected: KindSubscriptionError,
		},
		{
			name:     "unregistered subscription root is legacy",
			query:    `subscription Q { queueEvents { event } }`,
			expected: KindSubscriptionError,
		},
		{
			name:     "unregistered selected nested type is legacy",
			query:    `subscription Q { alertEvents { deliveries { channelName } } }`,
			expected: KindSubscriptionError,
		},
		{
			name:     "unknown selected field is a protocol error",
			query:    `subscription Q { alertEvents { notAField } }`,
			expected: KindSubscriptionError,
		},
		{
			name:     "parse failure is a protocol error",
			query:    `subscription {`,
			expected: KindSubscriptionError,
		},
		{
			name:     "unknown operation name is an execution result",
			query:    `subscription Q { alertEvents { id } }`,
			opName:   name("Missing"),
			expected: KindProtocol,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan := engine.PlanSubscription(test.query, test.opName, nil)
			if plan.Kind != test.expected {
				t.Fatalf("PlanSubscription() kind = %q, want %q", plan.Kind, test.expected)
			}
			if test.expected == KindSubscriptionError {
				body := string(plan.Result.Body)
				if !strings.Contains(body, `"errors"`) {
					t.Fatalf("PlanSubscription() rejection body = %s, want a GraphQL errors entry", body)
				}
			}
		})
	}
}

func TestPlanSubscriptionVariableFailureIsProtocolResult(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	plan := engine.PlanSubscription(
		`subscription Alert($show: Boolean!) { alertEvents { id triggeredAt severity @include(if: $show) } }`,
		nil,
		nil,
	)
	if plan.Kind != KindProtocol {
		t.Fatalf("PlanSubscription() kind = %q, want protocol", plan.Kind)
	}
	if !strings.Contains(string(plan.Result.Body), "BAD_USER_INPUT") {
		t.Fatalf("variable failure body = %s, want BAD_USER_INPUT", plan.Result.Body)
	}
}

func TestPlanSubscriptionIncludeAndSkipAreExpandedOnce(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	plan := engine.PlanSubscription(
		`subscription Alert($show: Boolean!) { alertEvents { id triggeredAt severity @include(if: $show) } }`,
		nil,
		map[string]any{"show": false},
	)
	if plan.Kind != KindExecute {
		t.Fatalf("PlanSubscription() kind = %q, want execute", plan.Kind)
	}
	if plan.Field.Selections == nil || len(plan.Field.Selections) == 0 {
		t.Fatal("plan must keep the root field selections")
	}
	execution, failure := engine.PrepareSubscription(
		context.Background(), plan,
		func(context.Context, string, string) (contract.Identity, error) {
			return contract.Identity{UserID: "user", OrgID: "org-a", Permissions: map[string]bool{"alerts.read": true}}, nil
		},
		"trace-1",
	)
	if failure != nil {
		t.Fatalf("PrepareSubscription() failure = %s", failure.Body)
	}
	result := engine.ProjectSubscriptionEvent(execution, contract.SubscriptionEvent{Value: subscriptionAlertModel{
		ID:          "event-1",
		TriggeredAt: time.Date(2026, 10, 19, 20, 1, 2, 345_000_000, time.FixedZone("MSK", 3*60*60)),
		Severity:    "high",
	}})
	if strings.Contains(string(result.Body), `"severity"`) {
		t.Fatalf("body = %s: @include(if: false) must drop severity", result.Body)
	}
	if !strings.Contains(string(result.Body), `"id":"event-1"`) {
		t.Fatalf("body = %s: the selected id must be projected", result.Body)
	}
	if !strings.Contains(string(result.Body), `"triggeredAt":"2026-10-19T17:01:02.345Z"`) {
		t.Fatalf("body = %s: DateTime must be UTC milliseconds", result.Body)
	}
}

func TestPrepareSubscriptionGuardErrorsStayInResult(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	plan := engine.PlanSubscription(`subscription { alertEvents { id } }`, nil, nil)
	_, failure := engine.PrepareSubscription(
		context.Background(), plan,
		func(context.Context, string, string) (contract.Identity, error) {
			return contract.Identity{}, &contract.Failure{Message: "Unauthorized", Status: 401}
		},
		"trace-1",
	)
	if failure == nil {
		t.Fatal("PrepareSubscription() must return a GraphQL result on guard failure")
	}
	var payload struct {
		Errors []struct {
			Message    string         `json:"message"`
			Extensions map[string]any `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(failure.Body, &payload); err != nil {
		t.Fatalf("failure body is not JSON: %v", err)
	}
	if len(payload.Errors) != 1 || payload.Errors[0].Message != "Unauthorized" {
		t.Fatalf("failure body = %s", failure.Body)
	}
	if payload.Errors[0].Extensions["code"] != "UNAUTHORIZED" {
		t.Fatalf("failure extensions = %v, want UNAUTHORIZED", payload.Errors[0].Extensions)
	}
}

func TestProjectSubscriptionEnumAndNonNullPropagation(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	plan := engine.PlanSubscription(`subscription { alertEvents { id severity } }`, nil, nil)
	execution, failure := engine.PrepareSubscription(
		context.Background(), plan,
		func(context.Context, string, string) (contract.Identity, error) {
			return contract.Identity{UserID: "user", OrgID: "org-a", Permissions: map[string]bool{"alerts.read": true}}, nil
		},
		"trace-1",
	)
	if failure != nil {
		t.Fatalf("PrepareSubscription() failure = %s", failure.Body)
	}
	result := engine.ProjectSubscriptionEvent(execution, contract.SubscriptionEvent{Value: subscriptionAlertModel{
		ID:       "event-1",
		Severity: "not-an-enum",
	}})
	var payload struct {
		Data   any `json:"data"`
		Errors []struct {
			Message    string         `json:"message"`
			Path       []any          `json:"path"`
			Extensions map[string]any `json:"extensions"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(result.Body, &payload); err != nil {
		t.Fatalf("result body is not JSON: %v", err)
	}
	if payload.Data != nil {
		t.Fatalf("data = %v, want null after non-null enum failure", payload.Data)
	}
	if len(payload.Errors) != 1 || payload.Errors[0].Message != `Enum "AlertSeverity" cannot represent value: "not-an-enum"` {
		t.Fatalf("errors = %+v", payload.Errors)
	}
}

func TestProjectSubscriptionEventErrorUsesNestedPath(t *testing.T) {
	engine := newSubscriptionTestEngine(t)
	plan := engine.PlanSubscription(`subscription { alertEvents { id triggeredAt } }`, nil, nil)
	execution, failure := engine.PrepareSubscription(
		context.Background(), plan,
		func(context.Context, string, string) (contract.Identity, error) {
			return contract.Identity{UserID: "user", OrgID: "org-a", Permissions: map[string]bool{"alerts.read": true}}, nil
		},
		"trace-1",
	)
	if failure != nil {
		t.Fatalf("PrepareSubscription() failure = %s", failure.Body)
	}
	result := engine.ProjectSubscriptionEvent(execution, contract.SubscriptionEvent{
		Error: &contract.SubscriptionEventError{Field: "triggeredAt", Message: "Invalid time value"},
	})
	var payload struct {
		Data   any `json:"data"`
		Errors []struct {
			Path []any `json:"path"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(result.Body, &payload); err != nil {
		t.Fatalf("result body is not JSON: %v", err)
	}
	if payload.Data != nil || len(payload.Errors) != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	if len(payload.Errors[0].Path) != 2 || payload.Errors[0].Path[0] != "alertEvents" || payload.Errors[0].Path[1] != "triggeredAt" {
		t.Fatalf("error path = %v", payload.Errors[0].Path)
	}
}
