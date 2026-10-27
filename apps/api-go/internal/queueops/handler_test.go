package queueops

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/platformgovernance"
)

const (
	testSecret   = "queue-ops-test-secret"
	testIssuer   = "modular-monolith"
	testAudience = "modular-monolith-clients"
)

// allowAllBlacklist reports that nothing has been revoked.
type allowAllBlacklist struct{}

func (allowAllBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

// staticAuthz grants exactly the configured permission names.
type staticAuthz struct {
	permissions []string
}

func (a staticAuthz) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	permissions := make(map[string]bool, len(a.permissions))
	for _, name := range a.permissions {
		permissions[name] = true
	}
	return &authz.Authorization{UserID: userID, OrgID: orgID, Permissions: permissions}, nil
}

// ---- a stub MySQL driver for the platform-admin gate ----

var registerAdminStubOnce sync.Once

type adminStubDriver struct{}

func (adminStubDriver) Open(dsn string) (driver.Conn, error) {
	return adminStubConn{admin: dsn == "admin"}, nil
}

type adminStubConn struct {
	admin bool
}

func (adminStubConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("admin stub: Prepare is not supported")
}

func (adminStubConn) Close() error { return nil }

func (adminStubConn) Begin() (driver.Tx, error) {
	return nil, errors.New("admin stub: transactions are not supported")
}

func (c adminStubConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if c.admin && strings.Contains(query, "GlobalRoleAssignment") {
		return &adminRows{}, nil
	}
	return &noRows{}, nil
}

func (adminStubConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

// adminRows answers the platform-admin lookup with one row.
type adminRows struct{ done bool }

func (*adminRows) Columns() []string { return []string{"id"} }
func (*adminRows) Close() error      { return nil }

func (r *adminRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	r.done = true
	dest[0] = "gra-1"
	return nil
}

// noRows answers every lookup with an empty result.
type noRows struct{}

func (*noRows) Columns() []string         { return []string{"id"} }
func (*noRows) Close() error              { return nil }
func (*noRows) Next([]driver.Value) error { return io.EOF }

func openAdminStubDB(t *testing.T, admin bool) *sql.DB {
	t.Helper()
	registerAdminStubOnce.Do(func() {
		sql.Register("queueops_admin_stub", adminStubDriver{})
	})
	dsn := ""
	if admin {
		dsn = "admin"
	}
	db, err := sql.Open("queueops_admin_stub", dsn)
	if err != nil {
		t.Fatalf("open stub db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

// ---- handler fixture ----

// newTestHandler builds a handler whose service has neither Redis nor MySQL, so
// every request that passes validation reaches the fail-closed 500 branch.
func newTestHandler(t *testing.T, permissions []string, admin bool) *Handler {
	t.Helper()
	verifier := authn.NewVerifier(testSecret, testIssuer, testAudience)
	chain := authhttp.NewAuthenticator(verifier, allowAllBlacklist{}, staticAuthz{permissions: permissions})
	platform := platformgovernance.NewAuthenticator(chain, openAdminStubDB(t, admin))
	service := NewService(Options{})
	return NewHandler(chain, platform, service)
}

// mintToken signs an access token the shared verifier accepts.
func mintToken(t *testing.T) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":   "user-1",
		"orgId": "org-a",
		"iss":   testIssuer,
		"aud":   testAudience,
		"exp":   time.Now().Add(time.Hour).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// call runs one request through the handler.
func call(handler *Handler, method, target, token, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// errorEnvelope decodes the response error fields this package asserts on.
type errorEnvelope struct {
	StatusCode int    `json:"statusCode"`
	Message    string `json:"message"`
	Error      string `json:"error"`
	Code       string `json:"code"`
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorEnvelope {
	t.Helper()
	var decoded errorEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode error body %q: %v", recorder.Body.String(), err)
	}
	return decoded
}

func TestHandlerRequiresAuthentication(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, true)
	recorder := call(handler, http.MethodGet, pathQueues, "", "")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if decoded := decodeError(t, recorder); decoded.Message != "Unauthorized" {
		t.Fatalf("message = %q", decoded.Message)
	}
}

func TestHandlerRequiresQueueManagePermission(t *testing.T) {
	handler := newTestHandler(t, []string{"items.read"}, true)
	recorder := call(handler, http.MethodGet, pathQueues, mintToken(t), "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	decoded := decodeError(t, recorder)
	if decoded.Code != "INSUFFICIENT_PERMISSIONS" {
		t.Fatalf("code = %q", decoded.Code)
	}
	if !strings.Contains(decoded.Message, "Insufficient permissions") {
		t.Fatalf("message = %q", decoded.Message)
	}
}

func TestHandlerRequiresPlatformAdmin(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, false)
	recorder := call(handler, http.MethodGet, pathQueues, mintToken(t), "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", recorder.Code)
	}
	if decoded := decodeError(t, recorder); !strings.Contains(decoded.Message, "Platform admin") {
		t.Fatalf("message = %q", decoded.Message)
	}
}

// consoleRoutes is the routing table of the console: all twelve paths with the
// method each one serves. The authorization test below walks it so a route that
// is added to the dispatcher without the shared authorize() chain fails here
// instead of shipping an unauthenticated queue operation.
var consoleRoutes = []struct {
	name   string
	method string
	path   string
}{
	{"list queues", http.MethodGet, pathQueues},
	{"list jobs", http.MethodGet, pathJobs},
	{"job detail", http.MethodGet, pathJobDetail},
	{"retry", http.MethodPost, pathJobRetry},
	{"delete", http.MethodPost, pathJobDelete},
	{"promote", http.MethodPost, pathJobPromote},
	{"retry failed", http.MethodPost, pathRetryFailed},
	{"clean", http.MethodPost, pathClean},
	{"pause", http.MethodPost, pathPause},
	{"resume", http.MethodPost, pathResume},
	{"dlq replay", http.MethodPost, pathDLQReplay},
	{"dlq delete", http.MethodPost, pathDLQDelete},
}

// TestHandlerAuthorizationCoversEveryRoute pins the B1 tightening on every route:
// authentication (401), then queue.manage (403), then platform administrator
// (403). Bull Board only checked queue.manage, so any route that skipped the
// platform gate would let an organization manager mutate every tenant's queue.
//
// The requests carry a body that is not valid JSON on purpose: authorization runs
// before the body is decoded, so a status of 400 here would mean the handler
// parsed attacker-controlled input before deciding whether the caller may act.
func TestHandlerAuthorizationCoversEveryRoute(t *testing.T) {
	const malformedBody = `{`

	notAdmin := newTestHandler(t, []string{queueManagePermission}, false)
	missingPermission := newTestHandler(t, []string{"items.read"}, true)

	for _, route := range consoleRoutes {
		t.Run(route.name, func(t *testing.T) {
			anonymous := call(newTestHandler(t, []string{queueManagePermission}, true),
				route.method, route.path, "", malformedBody)
			if anonymous.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous status = %d, want 401 (body %s)", anonymous.Code, anonymous.Body.String())
			}

			unprivileged := call(missingPermission, route.method, route.path, mintToken(t), malformedBody)
			if unprivileged.Code != http.StatusForbidden {
				t.Fatalf("missing queue.manage status = %d, want 403 (body %s)", unprivileged.Code, unprivileged.Body.String())
			}
			if decoded := decodeError(t, unprivileged); decoded.Code != "INSUFFICIENT_PERMISSIONS" {
				t.Fatalf("missing queue.manage code = %q", decoded.Code)
			}

			manager := call(notAdmin, route.method, route.path, mintToken(t), malformedBody)
			if manager.Code != http.StatusForbidden {
				t.Fatalf("non-admin status = %d, want 403 (body %s)", manager.Code, manager.Body.String())
			}
			if decoded := decodeError(t, manager); !strings.Contains(decoded.Message, "Platform admin") {
				t.Fatalf("non-admin message = %q", decoded.Message)
			}
		})
	}
}

func TestHandlerUnknownPathIsNotFound(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, true)
	for _, target := range []string{
		"/api/admin/queue-ops",
		"/api/admin/queue-ops/queues/extra",
		"/api/admin/queue-ops/dlq",
	} {
		recorder := call(handler, http.MethodGet, target, "", "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want 404", target, recorder.Code)
		}
	}
}

func TestHandlerMethodNotAllowed(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, true)
	cases := [][2]string{
		{http.MethodPost, pathQueues},
		{http.MethodGet, pathJobRetry},
		{http.MethodPut, pathClean},
	}
	for _, testCase := range cases {
		recorder := call(handler, testCase[0], testCase[1], "", "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s status = %d, want 405", testCase[0], testCase[1], recorder.Code)
		}
	}
}

func TestHandlerValidationErrors(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, true)
	token := mintToken(t)
	cases := []struct {
		name   string
		method string
		target string
		body   string
		status int
		code   string
		// endpoint is the crawl4ai administration path the refusal must point at.
		endpoint string
	}{
		{
			name:   "jobs without queue",
			method: http.MethodGet, target: pathJobs, status: http.StatusBadRequest,
		},
		{
			name:   "jobs unknown state",
			method: http.MethodGet, target: pathJobs + "?queue=itemPipeline&state=bogus", status: http.StatusBadRequest,
		},
		{
			name:   "jobs limit above the cap",
			method: http.MethodGet, target: pathJobs + "?queue=itemPipeline&limit=500", status: http.StatusBadRequest,
		},
		{
			name:   "jobs unknown queue",
			method: http.MethodGet, target: pathJobs + "?queue=nope", status: http.StatusNotFound,
		},
		{
			name:   "detail without jobId",
			method: http.MethodGet, target: pathJobDetail + "?queue=itemPipeline", status: http.StatusBadRequest,
		},
		{
			name:   "retry without jobId",
			method: http.MethodPost, target: pathJobRetry, body: `{"queue":"itemPipeline"}`, status: http.StatusBadRequest,
		},
		{
			name:   "delete without queue",
			method: http.MethodPost, target: pathJobDelete, body: `{"jobId":"job-1"}`, status: http.StatusBadRequest,
		},
		{
			name:   "promote with malformed json",
			method: http.MethodPost, target: pathJobPromote, body: `{`, status: http.StatusBadRequest,
		},
		{
			name:   "retry with empty body",
			method: http.MethodPost, target: pathJobRetry, body: "", status: http.StatusBadRequest,
		},
		{
			name:   "clean without grace",
			method: http.MethodPost, target: pathClean,
			body: `{"queue":"itemPipeline","state":"completed"}`, status: http.StatusBadRequest,
		},
		{
			name:   "clean unknown state",
			method: http.MethodPost, target: pathClean,
			body: `{"queue":"itemPipeline","state":"bogus","grace":0}`, status: http.StatusBadRequest,
		},
		{
			name:   "clean grace above the cap",
			method: http.MethodPost, target: pathClean,
			body: `{"queue":"itemPipeline","state":"completed","grace":2592000001}`, status: http.StatusBadRequest,
		},
		{
			name:   "clean limit above the cap",
			method: http.MethodPost, target: pathClean,
			body: `{"queue":"itemPipeline","state":"completed","grace":0,"limit":1001}`, status: http.StatusBadRequest,
		},
		{
			name:   "retry-failed limit above the cap",
			method: http.MethodPost, target: pathRetryFailed,
			body: `{"queue":"itemPipeline","limit":1001}`, status: http.StatusBadRequest,
		},
		{
			name:   "dlq replay with both addressing modes",
			method: http.MethodPost, target: pathDLQReplay,
			body: `{"jobId":"a","jobIds":["b"]}`, status: http.StatusBadRequest,
		},
		{
			name:   "dlq delete without ids",
			method: http.MethodPost, target: pathDLQDelete, body: `{}`, status: http.StatusBadRequest,
		},
		{
			name:   "crawl pause refused",
			method: http.MethodPost, target: pathPause,
			body: `{"queue":"crawl4ai"}`, status: http.StatusConflict, code: codeCrawlQueuePauseUnsupported,
			endpoint: "/api/admin/crawl4ai/queue/pause",
		},
		{
			name:   "crawl resume refused",
			method: http.MethodPost, target: pathResume,
			body: `{"queue":"crawl4ai-normal"}`, status: http.StatusConflict, code: codeCrawlQueuePauseUnsupported,
			endpoint: "/api/admin/crawl4ai/queue/resume",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := call(handler, testCase.method, testCase.target, token, testCase.body)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d (body %s)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if testCase.code != "" {
				decoded := decodeError(t, recorder)
				if decoded.Code != testCase.code {
					t.Fatalf("code = %q, want %q", decoded.Code, testCase.code)
				}
				if testCase.endpoint != "" &&
					!strings.Contains(decoded.Message, testCase.endpoint) {
					t.Fatalf("message does not point at %s: %q", testCase.endpoint, decoded.Message)
				}
			}
		})
	}
}

func TestHandlerDispatchesEveryRouteToTheService(t *testing.T) {
	handler := newTestHandler(t, []string{queueManagePermission}, true)
	token := mintToken(t)
	// Every request below passes validation, so the missing Redis client is the
	// only reason for the fail-closed 500. A 404/405 here would mean the route
	// table and the handler dispatch disagree.
	cases := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{"list queues", http.MethodGet, pathQueues, ""},
		{"list jobs", http.MethodGet, pathJobs + "?queue=itemPipeline", ""},
		{"job detail", http.MethodGet, pathJobDetail + "?queue=itemPipeline&jobId=job-1", ""},
		{"retry", http.MethodPost, pathJobRetry, `{"queue":"itemPipeline","jobId":"job-1"}`},
		{"delete", http.MethodPost, pathJobDelete, `{"queue":"itemPipeline","jobId":"job-1"}`},
		{"promote", http.MethodPost, pathJobPromote, `{"queue":"itemPipeline","jobId":"job-1"}`},
		{"retry failed", http.MethodPost, pathRetryFailed, `{"queue":"itemPipeline"}`},
		{"clean", http.MethodPost, pathClean, `{"queue":"itemPipeline","state":"completed","grace":0}`},
		{"pause", http.MethodPost, pathPause, `{"queue":"itemPipeline"}`},
		{"resume", http.MethodPost, pathResume, `{"queue":"itemPipeline"}`},
		{"dlq replay", http.MethodPost, pathDLQReplay, `{"jobId":"dlq-1"}`},
		{"dlq delete", http.MethodPost, pathDLQDelete, `{"jobId":"dlq-1"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := call(handler, testCase.method, testCase.target, token, testCase.body)
			if recorder.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, want 500 (body %s)", recorder.Code, recorder.Body.String())
			}
		})
	}
}
