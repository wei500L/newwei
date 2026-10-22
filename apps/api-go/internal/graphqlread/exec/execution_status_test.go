package exec

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

// prepareFor returns a PrepareRoot that reports one identity, or one failure when
// failure is set. The executor calls it once per collected root field.
func prepareFor(identity contract.Identity, failure error) PrepareRoot {
	return func(context.Context, string, string) (contract.Identity, error) {
		if failure != nil {
			return contract.Identity{}, failure
		}
		return identity, nil
	}
}

// runPlan plans and executes one document against a registry the caller fills and
// fails the test when the document is not planned as KindExecute.
func runPlan(t *testing.T, register func(*contract.Registry), query string, prepare PrepareRoot) Result {
	t.Helper()
	loaded, err := schema.Load()
	if err != nil {
		t.Fatalf("schema load: %v", err)
	}
	reg := contract.NewRegistry()
	register(reg)
	engine := New(loaded, reg, 8, 2000, nil)
	plan := engine.PlanDocument(query, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind %s body %s", plan.Kind, plan.Result.Body)
	}
	return engine.Execute(context.Background(), plan, prepare, nil, false, 30, "schema", "")
}

// TestExecutionErrorsDoNotCarryHTTPStatus pins the Apollo Server 4 status contract
// for errors the GraphQL runtime itself raises while resolving an operation: the
// HTTP status is derived only from extensions.http
// (@apollo/server/dist/cjs/requestPipeline.js merges httpFromErrors into the
// response head), and an execution error without that extension keeps the default
// 200 while code defaults to INTERNAL_SERVER_ERROR (errorNormalize.js). NestJS's
// GlobalExceptionFilter never sees these errors, so the Go executor must not
// answer 500 for them.
func TestExecutionErrorsDoNotCarryHTTPStatus(t *testing.T) {
	cases := []struct {
		name     string
		register func(*contract.Registry)
		query    string
		wantBody string
	}{
		{
			name: "non-null root resolving to null",
			register: func(reg *contract.Registry) {
				reg.RegisterRoot(contract.Root{
					Name:               "unreadNotificationCount",
					AllowAuthenticated: true,
					Resolve: func(contract.Context) (any, error) {
						return nil, nil
					},
				})
			},
			query:    `query { unreadNotificationCount }`,
			wantBody: "Cannot return null for non-nullable field",
		},
		{
			name: "non-null list root resolving to a non-list",
			register: func(reg *contract.Registry) {
				reg.RegisterType("AlertChannelModel", alertChannel{})
				reg.RegisterRoot(contract.Root{
					Name:               "alertChannels",
					AllowAuthenticated: true,
					Resolve: func(contract.Context) (any, error) {
						return alertChannel{ID: "c1", Name: "mail"}, nil
					},
				})
			},
			query:    `query { alertChannels { id } }`,
			wantBody: "Expected a list",
		},
	}
	identity := contract.Identity{UserID: "user-1", OrgID: "org-1"}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result := runPlan(t, testCase.register, testCase.query, prepareFor(identity, nil))
			body := string(result.Body)
			if result.Status != http.StatusOK {
				t.Fatalf("status = %d, want 200: %s", result.Status, body)
			}
			if !strings.Contains(body, `"data":null`) {
				t.Fatalf("data must bubble to null: %s", body)
			}
			if !strings.Contains(body, testCase.wantBody) {
				t.Fatalf("body %q missing %q", body, testCase.wantBody)
			}
			if !strings.Contains(body, `"code":"INTERNAL_SERVER_ERROR"`) {
				t.Fatalf("missing INTERNAL_SERVER_ERROR code: %s", body)
			}
			if strings.Contains(body, `"http"`) {
				t.Fatalf("execution error must not carry extensions.http: %s", body)
			}
		})
	}
}

// TestFilterErrorsKeepHTTPStatus keeps the other half of the contract: failures
// produced by the NestJS exception filter (unauthenticated, rate limited, missing
// permission) carry extensions.http, and Apollo applies that status to the HTTP
// response. The executor mirrors it, so these stay 401/403/429 and keep the http
// extension in the body.
func TestFilterErrorsKeepHTTPStatus(t *testing.T) {
	resolve := func(contract.Context) (any, error) { return 3, nil }
	cases := []struct {
		name       string
		register   func(*contract.Registry)
		query      string
		identity   contract.Identity
		prepareErr error
		wantStatus int
		wantCode   string
	}{
		{
			name: "unauthenticated",
			register: func(reg *contract.Registry) {
				reg.RegisterRoot(contract.Root{Name: "unreadNotificationCount", AllowAuthenticated: true, Resolve: resolve})
			},
			query:      `query { unreadNotificationCount }`,
			prepareErr: &contract.Failure{Message: "Unauthorized", Status: http.StatusUnauthorized},
			wantStatus: http.StatusUnauthorized,
			wantCode:   "UNAUTHORIZED",
		},
		{
			name: "rate limited",
			register: func(reg *contract.Registry) {
				reg.RegisterRoot(contract.Root{Name: "unreadNotificationCount", AllowAuthenticated: true, Resolve: resolve})
			},
			query:      `query { unreadNotificationCount }`,
			identity:   contract.Identity{UserID: "user-1", OrgID: "org-1"},
			prepareErr: &contract.Failure{Message: "Too many GraphQL requests. Slow down.", Status: http.StatusTooManyRequests},
			wantStatus: http.StatusTooManyRequests,
			wantCode:   "TOO_MANY_REQUESTS",
		},
		{
			name: "missing permission",
			register: func(reg *contract.Registry) {
				reg.RegisterRoot(contract.Root{Name: "unreadNotificationCount", Permission: "notifications.read", Resolve: resolve})
			},
			query:      `query { unreadNotificationCount }`,
			identity:   contract.Identity{UserID: "user-1", OrgID: "org-1"},
			wantStatus: http.StatusForbidden,
			wantCode:   "FORBIDDEN",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result := runPlan(t, testCase.register, testCase.query, prepareFor(testCase.identity, testCase.prepareErr))
			body := string(result.Body)
			if result.Status != testCase.wantStatus {
				t.Fatalf("status = %d, want %d: %s", result.Status, testCase.wantStatus, body)
			}
			wantHTTP := fmt.Sprintf(`"http":{"status":%d}`, testCase.wantStatus)
			if !strings.Contains(body, wantHTTP) {
				t.Fatalf("body %q missing %q", body, wantHTTP)
			}
			if !strings.Contains(body, `"code":"`+testCase.wantCode+`"`) {
				t.Fatalf("body %q missing code %q", body, testCase.wantCode)
			}
		})
	}
}
