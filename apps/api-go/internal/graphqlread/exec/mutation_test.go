package exec

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/alerts"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/history"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/orgaccesswrite"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspace"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/workspacewrite"
)

// TestMutationRootsPlanToExecuteOnlyWhenRegistered pins the ownership decision
// for the organization access write batch: the eight mutations execute only
// after they are registered, a document mixing a migrated mutation with an
// unregistered one falls back as a whole, and registering the mutation models
// does not take over any query.
func TestMutationRootsPlanToExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	engine := New(loaded, reg, 8, 2000, nil)

	const createOrg = `mutation { createOrg(input: { name: "Acme", slug: "acme-corp" }) { id name slug } }`
	if got := engine.PlanDocument(createOrg, nil, nil); got.Kind != KindProtocol {
		t.Fatalf("unregistered mutation kind %s body %s", got.Kind, got.Result.Body)
	}

	// This is exactly the write-only wiring: the shared models are registered
	// without workspace.Register, so no read root is taken over.
	workspace.RegisterModels(reg)
	orgaccesswrite.Register(reg, nil, nil)
	engine = New(loaded, reg, 8, 2000, nil)

	if got := engine.PlanDocument(createOrg, nil, nil); got.Kind != KindExecute {
		t.Fatalf("registered mutation kind %s body %s", got.Kind, got.Result.Body)
	}
	for _, doc := range []string{
		`mutation { createOrg(input: { name: "Acme", slug: "acme-corp" }) { id } deleteDashboard(id: "d") }`,
		`mutation { markAllNotificationsRead }`,
		`mutation { setOrgActive(input: { id: "o", isActive: false }) { id } upsertDashboard(input: { name: "n", slug: "s", widgets: [] }) { id } }`,
		`query { me { id } }`,
		`query { roles { id } }`,
	} {
		if got := engine.PlanDocument(doc, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("%s kind %s body %s", doc, got.Kind, got.Result.Body)
		}
	}
}

// TestWorkspaceWriteRootsPlanToExecuteOnlyWhenRegistered pins the workspace
// write batch wiring: the eight mutations execute only after they are
// registered with exactly the model sets the write-only path registers
// (workspace, alert and history models without any read root), a document
// mixing them with an unregistered mutation stays on NestJS, and registering
// the models takes over no query.
func TestWorkspaceWriteRootsPlanToExecuteOnlyWhenRegistered(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	engine := New(loaded, reg, 8, 2000, nil)

	documents := []string{
		`mutation { markNotificationRead(id: "n") { id } }`,
		`mutation { markAllNotificationsRead }`,
		`mutation { deleteDashboard(id: "d") }`,
		`mutation { upsertDashboard(input: { name: "n", slug: "s", widgets: [] }) { id version widgets { id } } }`,
		`mutation { createAlertChannel(input: { type: email, name: "n", target: "a@example.com" }) { id config } }`,
		`mutation { updateAlertChannel(input: { id: "c", name: "n" }) { id target } }`,
		`mutation { deleteAlertChannel(channelId: "c") }`,
		`mutation { updateAlertEventStatus(input: { eventId: "e", status: confirmed }) { id deliveries { id channelName } } }`,
	}
	for _, doc := range documents {
		if got := engine.PlanDocument(doc, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("unregistered %s kind %s body %s", doc, got.Kind, got.Result.Body)
		}
	}

	// This is exactly the write-only wiring: the shared models are registered
	// without any read registration, so no read root is taken over.
	workspace.RegisterModels(reg)
	alerts.RegisterModels(reg)
	history.RegisterModels(reg)
	workspacewrite.Register(reg, nil)
	engine = New(loaded, reg, 8, 2000, nil)

	for _, doc := range documents {
		if got := engine.PlanDocument(doc, nil, nil); got.Kind != KindExecute {
			t.Fatalf("registered %s kind %s body %s", doc, got.Kind, got.Result.Body)
		}
	}
	for _, doc := range []string{
		`mutation { markAllNotificationsRead deleteAssistantRun(runId: "r") }`,
		`mutation { deleteDashboard(id: "d") triggerAlertRule(ruleId: "r") }`,
		`query { notifications { id } }`,
		`query { dashboards { id } }`,
		`query { alertChannels { id } }`,
		`query { alertEvents { id } }`,
	} {
		if got := engine.PlanDocument(doc, nil, nil); got.Kind != KindProtocol {
			t.Fatalf("mixed or read-only %s kind %s body %s", doc, got.Kind, got.Result.Body)
		}
	}
}

// TestMutationFieldsRunInOrderAndStopOnNonNullFailure pins the serial mutation
// contract: fields resolve in document order, an already committed field is not
// rolled back, a non-null failure yields data: null and stops the remaining
// fields, and mutations are never response cacheable.
func TestMutationFieldsRunInOrderAndStopOnNonNullFailure(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	order := []string{}
	reg := contract.NewRegistry()
	reg.RegisterMutation(contract.Root{Name: "markAllNotificationsRead", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		order = append(order, "markAllNotificationsRead")
		return true, nil
	}})
	reg.RegisterMutation(contract.Root{Name: "deleteAlertChannel", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		order = append(order, "deleteAlertChannel")
		return false, &contract.Failure{
			Message: "Insufficient permissions",
			Status:  http.StatusForbidden,
			AppCode: "INSUFFICIENT_PERMISSIONS",
		}
	}})
	reg.RegisterMutation(contract.Root{Name: "refreshNewsIndicatorAssociations", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		order = append(order, "refreshNewsIndicatorAssociations")
		return true, nil
	}})
	engine := New(loaded, reg, 8, 2000, nil)
	prepare := func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "u", OrgID: "o"}, nil
	}

	plan := engine.PlanDocument(
		`mutation { markAllNotificationsRead deleteAlertChannel(channelId: "c") refreshNewsIndicatorAssociations }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind %s body %s", plan.Kind, plan.Result.Body)
	}
	if ResponseCacheable(plan, 30) {
		t.Fatal("mutation must never be response cacheable")
	}
	result := engine.Execute(context.Background(), plan, prepare, nil, false, 30, "schema", "")
	if strings.Join(order, ",") != "markAllNotificationsRead,deleteAlertChannel" {
		t.Fatalf("resolver order %v", order)
	}
	if result.Status != http.StatusForbidden {
		t.Fatalf("status %d body %s", result.Status, result.Body)
	}
	if !strings.Contains(string(result.Body), `"data":null`) {
		t.Fatalf("non-null failure body %s", result.Body)
	}
	if result.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("mutation Cache-Control %q", result.Header.Get("Cache-Control"))
	}
}

// TestNullableMutationFailureKeepsSiblings pins that a nullable top-level
// mutation failure is projected as a null field with the earlier fields kept.
func TestNullableMutationFailureKeepsSiblings(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("NotificationModel", notificationStub{})
	reg.RegisterMutation(contract.Root{Name: "markAllNotificationsRead", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		return true, nil
	}})
	reg.RegisterMutation(contract.Root{Name: "markNotificationRead", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		return nil, &contract.Failure{Message: "Notification not found", Status: http.StatusNotFound}
	}})
	engine := New(loaded, reg, 8, 2000, nil)
	plan := engine.PlanDocument(`mutation { markAllNotificationsRead markNotificationRead(id: "n") { id } }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind %s body %s", plan.Kind, plan.Result.Body)
	}
	result := engine.Execute(context.Background(), plan, func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "u", OrgID: "o"}, nil
	}, nil, false, 30, "schema", "")
	body := string(result.Body)
	if result.Status != http.StatusNotFound {
		t.Fatalf("status %d body %s", result.Status, body)
	}
	if !strings.Contains(body, `"markAllNotificationsRead":true`) || !strings.Contains(body, `"markNotificationRead":null`) {
		t.Fatalf("nullable failure body %s", body)
	}
	if strings.Contains(body, `"data":null`) {
		t.Fatalf("nullable failure nulled the whole data object: %s", body)
	}
}

// TestMutationOverGETRejection pins the Apollo GET rejection: 405, an Allow:
// POST header, and no resolver run.
func TestMutationOverGETRejection(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	ran := false
	reg := contract.NewRegistry()
	reg.RegisterMutation(contract.Root{Name: "markAllNotificationsRead", AllowAuthenticated: true, Resolve: func(contract.Context) (any, error) {
		ran = true
		return true, nil
	}})
	engine := New(loaded, reg, 8, 2000, nil)

	plan := engine.PlanDocument(`mutation { markAllNotificationsRead }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind %s body %s", plan.Kind, plan.Result.Body)
	}
	reject := MutationOverGET(plan)
	if reject == nil {
		t.Fatal("GET mutation was not rejected")
	}
	if reject.Status != http.StatusMethodNotAllowed {
		t.Fatalf("status %d body %s", reject.Status, reject.Body)
	}
	if reject.Header.Get("Allow") != http.MethodPost {
		t.Fatalf("Allow header %q", reject.Header.Get("Allow"))
	}
	body := string(reject.Body)
	if !strings.Contains(body, "GET requests only support query operations, not mutation operations") {
		t.Fatalf("message %s", body)
	}
	if !strings.Contains(body, `"code":"BAD_REQUEST"`) {
		t.Fatalf("code %s", body)
	}
	if ran {
		t.Fatal("a resolver ran for a GET mutation")
	}

	query := engine.PlanDocument(`query { __typename }`, nil, nil)
	if query.Kind != KindExecute {
		t.Fatalf("query plan kind %s body %s", query.Kind, query.Result.Body)
	}
	if MutationOverGET(query) != nil {
		t.Fatal("a query was rejected as a GET mutation")
	}
}

// notificationStub is only used to make a nullable mutation return type
// projectable in the executor ownership check.
type notificationStub struct {
	ID string `graphql:"id"`
}
