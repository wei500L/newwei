package exec

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

// recordingErrorRecorder captures the resolver failures the engine reports.
type recordingErrorRecorder struct{ failures []ResolverError }

func (r *recordingErrorRecorder) record(failure ResolverError) {
	r.failures = append(r.failures, failure)
}

// execTestSchema loads the real SDL once.
func execTestSchema(t *testing.T) *ast.Schema {
	t.Helper()
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	return loaded
}

// nullableChannel is the model projected under AlertChannelModel; its fields match
// the SDL so a successful resolve projects without execution errors.
type nullableChannel struct {
	ID        string    `graphql:"id"`
	Name      string    `graphql:"name"`
	Type      string    `graphql:"type"`
	Target    string    `graphql:"target"`
	IsActive  bool      `graphql:"isActive"`
	CreatedAt timeValue `graphql:"createdAt"`
	UpdatedAt timeValue `graphql:"updatedAt"`
}

// timeValue is a DateTime-shaped leaf the projector can render.
type timeValue string

// newEngine builds an engine over the real SDL with one registered query root whose
// resolver behaviour the caller supplies. The root is a non-null list of non-null
// objects, which is the shape alertChannels has, so a resolver failure nulls the
// whole data field and the response status follows the failure.
func newEngine(t *testing.T, permission string, resolve contract.Resolver) (*Engine, *recordingErrorRecorder) {
	t.Helper()
	loaded := execTestSchema(t)
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", nullableChannel{})
	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: permission,
		Resolve:    resolve,
	})
	engine := New(loaded, reg, 8, 2000, nil)
	recorder := &recordingErrorRecorder{}
	engine.SetErrorRecorder(recorder.record)
	return engine, recorder
}

// identityWith returns the prepare hook for one permission set.
func identityWith(permissions ...string) func(context.Context, string, string) (contract.Identity, error) {
	granted := make(map[string]bool, len(permissions))
	for _, permission := range permissions {
		granted[permission] = true
	}
	return func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "user-1", OrgID: "org-1", Permissions: granted}, nil
	}
}

// TestResolverFailureIsRecordedRegardlessOfTheHttpStatus is the core contract for
// GAP-EXCEPTION-WIRING-001: the event is produced from the failure, not from the HTTP
// status. alertChannels is a non-null root, so a resolver error bubbles to data: null
// and the response carries the failure's status; the recording must happen either way.
func TestResolverFailureIsRecordedRegardlessOfTheHttpStatus(t *testing.T) {
	engine, recorder := newEngine(t, "alerts.read", func(contract.Context) (any, error) {
		return nil, &contract.Failure{Message: "upstream exploded", Status: http.StatusInternalServerError}
	})
	// operationName is only populated when the client sends one, so the test supplies
	// the same value a named operation carries.
	alertsOperation := "Alerts"
	plan := engine.PlanDocument(`query Alerts { alertChannels { id } }`, &alertsOperation, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind = %s, want execute", plan.Kind)
	}
	result := engine.Execute(context.Background(), plan, identityWith("alerts.read"), nil, false, 0, "v1", "trace-1")

	// A non-null root failure nulls data, and the executor reports the failure's own
	// status rather than hiding it at 200.
	if result.Status != http.StatusInternalServerError {
		t.Fatalf("http status = %d, want 500 for a non-null root failure", result.Status)
	}
	if len(recorder.failures) != 1 {
		t.Fatalf("recorded %d failures, want 1", len(recorder.failures))
	}
	got := recorder.failures[0]
	if got.StatusCode != http.StatusInternalServerError {
		t.Errorf("statusCode = %d, want 500", got.StatusCode)
	}
	if got.Operation != "alertChannels" {
		t.Errorf("operation = %q, want alertChannels", got.Operation)
	}
	if got.OperationName != "Alerts" {
		t.Errorf("operationName = %q, want Alerts", got.OperationName)
	}
	if got.Message != "Internal server error" {
		t.Errorf("message = %q, want the masked message", got.Message)
	}
	if got.OrgID != "org-1" || got.UserID != "user-1" {
		t.Errorf("identity = (%q, %q), want the verified pair", got.OrgID, got.UserID)
	}
	if got.TraceID != "trace-1" {
		t.Errorf("traceId = %q, want trace-1", got.TraceID)
	}
	if got.ErrorName != "Error" {
		t.Errorf("errorName = %q, want the base value for an untyped 500", got.ErrorName)
	}
}

// TestPermissionFailureIsRecordedAsForbidden proves a guard rejection — the Go
// counterpart of GqlPermissionsGuard throwing ForbiddenException — is recorded with the
// caller's identity and the guard's status.
func TestPermissionFailureIsRecordedAsForbidden(t *testing.T) {
	engine, recorder := newEngine(t, "alerts.read", func(contract.Context) (any, error) {
		t.Fatal("the resolver must not run when the permission check fails")
		return nil, nil
	})
	plan := engine.PlanDocument(`{ alertChannels { id } }`, nil, nil)
	result := engine.Execute(context.Background(), plan, identityWith(), nil, false, 0, "v1", "trace-2")
	if result.Status != http.StatusForbidden {
		t.Fatalf("http status = %d, want 403", result.Status)
	}
	if len(recorder.failures) != 1 {
		t.Fatalf("recorded %d failures, want 1", len(recorder.failures))
	}
	got := recorder.failures[0]
	if got.StatusCode != http.StatusForbidden {
		t.Errorf("statusCode = %d, want 403", got.StatusCode)
	}
	if got.ErrorName != "ForbiddenException" {
		t.Errorf("errorName = %q, want ForbiddenException", got.ErrorName)
	}
	if got.OrgID != "org-1" || got.UserID != "user-1" {
		t.Errorf("identity = (%q, %q), want the verified pair", got.OrgID, got.UserID)
	}
}

// TestRateLimitRejectionIsRecorded proves a limiter rejection from the prepare hook —
// the counterpart of GraphqlRateLimitGuard — is recorded, with no identity because the
// rejection happened before authentication.
func TestRateLimitRejectionIsRecorded(t *testing.T) {
	engine, recorder := newEngine(t, "alerts.read", func(contract.Context) (any, error) {
		return []nullableChannel{}, nil
	})
	plan := engine.PlanDocument(`{ alertChannels { id } }`, nil, nil)
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{}, &contract.Failure{
			Message: "Too many GraphQL requests. Slow down.",
			Status:  http.StatusTooManyRequests,
		}
	}
	engine.Execute(context.Background(), plan, prepare, nil, false, 0, "v1", "trace-3")
	if len(recorder.failures) != 1 {
		t.Fatalf("recorded %d failures, want 1", len(recorder.failures))
	}
	got := recorder.failures[0]
	if got.StatusCode != http.StatusTooManyRequests {
		t.Errorf("statusCode = %d, want 429", got.StatusCode)
	}
	if got.ErrorName != "TooManyRequestsException" {
		t.Errorf("errorName = %q, want TooManyRequestsException", got.ErrorName)
	}
	if got.OrgID != "" || got.UserID != "" {
		t.Errorf("identity = (%q, %q), want empty before authentication", got.OrgID, got.UserID)
	}
}

// TestMutationResolverFailureIsRecorded covers the mutation loop, which records
// separately from the query loop.
func TestMutationResolverFailureIsRecorded(t *testing.T) {
	loaded := execTestSchema(t)
	reg := contract.NewRegistry()
	reg.RegisterMutation(contract.Root{
		Name:       "markAllNotificationsRead",
		Permission: "notifications.write",
		Resolve: func(contract.Context) (any, error) {
			return nil, &contract.Failure{Message: "write failed", Status: http.StatusConflict}
		},
	})
	engine := New(loaded, reg, 8, 2000, nil)
	recorder := &recordingErrorRecorder{}
	engine.SetErrorRecorder(recorder.record)
	markReadOperation := "MarkRead"
	plan := engine.PlanDocument(`mutation MarkRead { markAllNotificationsRead }`, &markReadOperation, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind = %s, want execute", plan.Kind)
	}
	engine.Execute(context.Background(), plan, identityWith("notifications.write"), nil, false, 0, "v1", "trace-4")
	if len(recorder.failures) != 1 {
		t.Fatalf("recorded %d failures, want 1", len(recorder.failures))
	}
	got := recorder.failures[0]
	if got.StatusCode != http.StatusConflict || got.ErrorName != "ConflictException" {
		t.Fatalf("recorded %+v, want a 409 ConflictException", got)
	}
	if got.Operation != "markAllNotificationsRead" || got.OperationName != "MarkRead" {
		t.Fatalf("operation/operationName = (%q, %q)", got.Operation, got.OperationName)
	}
}

// TestProtocolRejectionsRecordNothing is the other half of the contract: a parse
// error, a validation error and an ambiguous operation are answered before any resolver
// exists, so NestJS's filter never sees them and nothing may be recorded.
func TestProtocolRejectionsRecordNothing(t *testing.T) {
	engine, recorder := newEngine(t, "alerts.read", func(contract.Context) (any, error) {
		return []nullableChannel{}, nil
	})
	for _, document := range []string{
		`{ alertChannels `,
		`{ notARootField }`,
		`query A { alertChannels { id } } query B { alertChannels { name } }`,
	} {
		if plan := engine.PlanDocument(document, nil, nil); plan.Kind != KindProtocol {
			t.Fatalf("document %q produced kind %s, want protocol", document, plan.Kind)
		}
	}
	if len(recorder.failures) != 0 {
		t.Fatalf("protocol rejections recorded %d failures, want 0", len(recorder.failures))
	}
}

// TestUnregisteredFieldRecordsNothing proves a document the Go gateway rejects
// produces no Go callback event, and no resolver failure is recorded: the
// whole-operation rejection happens before any resolver runs.
func TestUnregisteredFieldRecordsNothing(t *testing.T) {
	loaded := execTestSchema(t)
	engine := New(loaded, contract.NewRegistry(), 8, 2000, nil)
	recorder := &recordingErrorRecorder{}
	engine.SetErrorRecorder(recorder.record)
	if plan := engine.PlanDocument(`{ alertRules { id } }`, nil, nil); plan.Kind != KindProtocol {
		t.Fatalf("plan kind = %s, want protocol", plan.Kind)
	}
	if len(recorder.failures) != 0 {
		t.Fatalf("a rejected document recorded %d failures, want 0", len(recorder.failures))
	}
}

// TestNilRecorderIsSafe proves the default (no Mongo, no recorder) path cannot panic or
// change a response.
func TestNilRecorderIsSafe(t *testing.T) {
	engine, _ := newEngine(t, "alerts.read", func(contract.Context) (any, error) {
		return nil, errors.New("boom")
	})
	engine.SetErrorRecorder(nil)
	plan := engine.PlanDocument(`{ alertChannels { id } }`, nil, nil)
	result := engine.Execute(context.Background(), plan, identityWith("alerts.read"), nil, false, 0, "v1", "trace")
	// An untyped resolver error is masked exactly like the NestJS production filter.
	if result.Status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", result.Status)
	}
	if !strings.Contains(string(result.Body), "Internal server error") {
		t.Fatalf("body = %s, want the masked message", result.Body)
	}
}
