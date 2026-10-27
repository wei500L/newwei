package exec

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

// recordingErrorRecorder captures the resolver failures the engine reports.
type recordingErrorRecorder struct{ failures []ResolverError }

func (r *recordingErrorRecorder) record(failure ResolverError) {
	r.failures = append(r.failures, failure)
}

// newErrorTestEngine builds an engine over the real SDL with one registered query
// root whose resolver behaviour the caller supplies.
func newErrorTestEngine(t *testing.T, permission string, resolve func(contract.Context) (any, error)) (*Engine, *recordingErrorRecorder) {
	t.Helper()
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", alertChannel{})
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

// TestQueryResolverFailureIsRecordedWithA200Response is the case a status-code
// check cannot detect: a nullable root field fails, the executor keeps HTTP 200 and
// returns data plus errors, and the failure must still be recorded.
func TestQueryResolverFailureIsRecordedWithA200Response(t *testing.T) {
	engine, recorder := newErrorTestEngine(t, "alerts.read",
		func(contract.Context) (any, error) {
			return nil, &contract.Failure{Message: "upstream exploded", Status: http.StatusInternalServerError}
		})
	plan := engine.PlanDocument(`query AlertList { alertChannels { id } }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind = %s, want execute", plan.Kind)
	}
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "user-1", OrgID: "org-1", Permissions: map[string]bool{"alerts.read": true}}, nil
	}
	result := engine.Execute(context.Background(), plan, prepare, nil, false, 0, "v1", "trace-1")
	if result.Status != http.StatusOK {
		t.Fatalf("http status = %d, want 200 (the executor keeps data+errors at 200)", result.Status)
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
	if got.OperationName != "AlertList" {
		t.Errorf("operationName = %q, want AlertList", got.OperationName)
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
	if got.ErrorName == "" {
		t.Error("errorName must be populated")
	}
}

// TestPermissionFailureIsRecordedAsForbidden proves a guard rejection — the Go
// counterpart of GqlPermissionsGuard throwing ForbiddenException — is recorded with
// the client's status and the verified identity.
func TestPermissionFailureIsRecordedAsForbidden(t *testing.T) {
	engine, recorder := newErrorTestEngine(t, "alerts.read",
		func(contract.Context) (any, error) {
			t.Fatal("the resolver must not run when the permission check fails")
			return nil, nil
		})
	plan := engine.PlanDocument(`{ alertChannels { id } }`, nil, nil)
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "user-1", OrgID: "org-1", Permissions: map[string]bool{}}, nil
	}
	result := engine.Execute(context.Background(), plan, prepare, nil, false, 0, "v1", "trace-2")
	if result.Status != http.StatusOK {
		t.Fatalf("http status = %d, want 200", result.Status)
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

// TestRateLimitRejectionIsRecorded proves a limiter rejection from the prepare hook
// — the counterpart of GraphqlRateLimitGuard — is recorded too, with no identity
// because the rejection happened before authentication.
func TestRateLimitRejectionIsRecorded(t *testing.T) {
	engine, recorder := newErrorTestEngine(t, "alerts.read",
		func(contract.Context) (any, error) { return []alertChannel{}, nil })
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

// TestMutationResolverFailureIsRecorded covers the mutation path, which records
// through its own loop.
func TestMutationResolverFailureIsRecorded(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
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
	plan := engine.PlanDocument(`mutation MarkRead { markAllNotificationsRead }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind = %s, want execute", plan.Kind)
	}
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "u", OrgID: "o", Permissions: map[string]bool{"notifications.write": true}}, nil
	}
	engine.Execute(context.Background(), plan, prepare, nil, false, 0, "v1", "trace-4")
	if len(recorder.failures) != 1 {
		t.Fatalf("recorded %d failures, want 1", len(recorder.failures))
	}
	if got := recorder.failures[0]; got.StatusCode != http.StatusConflict || got.ErrorName != "ConflictException" {
		t.Fatalf("recorded %+v, want a 409 ConflictException", got)
	}
}

// TestProtocolRejectionsRecordNothing is the other half of the contract: a parse
// error, a validation error and an ambiguous operation never reach a resolver, so
// NestJS's filter never sees them and nothing is recorded.
func TestProtocolRejectionsRecordNothing(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", alertChannel{})
	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: "alerts.read",
		Resolve:    func(contract.Context) (any, error) { return []alertChannel{}, nil },
	})
	engine := New(loaded, reg, 8, 2000, nil)
	recorder := &recordingErrorRecorder{}
	engine.SetErrorRecorder(recorder.record)

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

// TestUnregisteredFieldRecordsNothing proves a document the gateway forwards to
// NestJS produces no Go event: NestJS answers it and its filter records any
// failure, so a Go event here would be a duplicate of a legacy response.
func TestUnregisteredFieldRecordsNothing(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	engine := New(loaded, contract.NewRegistry(), 8, 2000, nil)
	recorder := &recordingErrorRecorder{}
	engine.SetErrorRecorder(recorder.record)
	if plan := engine.PlanDocument(`{ alertRules { id } }`, nil, nil); plan.Kind != KindLegacy {
		t.Fatalf("plan kind = %s, want legacy", plan.Kind)
	}
	if len(recorder.failures) != 0 {
		t.Fatalf("a legacy document recorded %d failures, want 0", len(recorder.failures))
	}
}

// TestNilRecorderIsSafe proves the default (no Mongo, no recorder) path cannot
// panic or change a response.
func TestNilRecorderIsSafe(t *testing.T) {
	engine, _ := newErrorTestEngine(t, "alerts.read",
		func(contract.Context) (any, error) {
			return nil, errors.New("boom")
		})
	engine.SetErrorRecorder(nil)
	plan := engine.PlanDocument(`{ alertChannels { id } }`, nil, nil)
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "u", OrgID: "o", Permissions: map[string]bool{"alerts.read": true}}, nil
	}
	result := engine.Execute(context.Background(), plan, prepare, nil, false, 0, "v1", "trace")
	if result.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200", result.Status)
	}
}
