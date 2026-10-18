package platformgovernance

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
)

// ---- a minimal database/sql driver so the platform gate can be exercised ----

var registerStubDriverOnce sync.Once

// stubDriver answers the two queries the platform governance package issues:
// the SystemSetting read (no row) and the GlobalRoleAssignment platform-admin
// lookup (no row, i.e. a non-admin). Any other query is an error, which keeps
// the stub honest about the schema it pretends to implement.
type stubDriver struct{}

func (stubDriver) Open(string) (driver.Conn, error) { return stubConn{}, nil }

type stubConn struct{}

func (stubConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("stub driver: Prepare is not supported")
}

func (stubConn) Close() error { return nil }

func (stubConn) Begin() (driver.Tx, error) {
	return nil, errors.New("stub driver: transactions are not supported")
}

func (stubConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(query, "SystemSetting"), strings.Contains(query, "GlobalRoleAssignment"):
		return &emptyRows{}, nil
	default:
		return nil, errors.New("stub driver: unexpected query: " + query)
	}
}

func (stubConn) ExecContext(_ context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

type emptyRows struct{}

func (*emptyRows) Columns() []string         { return []string{"id"} }
func (*emptyRows) Close() error              { return nil }
func (*emptyRows) Next([]driver.Value) error { return io.EOF }

func openStubDB(t *testing.T) *sql.DB {
	t.Helper()
	registerStubDriverOnce.Do(func() {
		sql.Register("platformgovernance_stub", stubDriver{})
	})
	db, err := sql.Open("platformgovernance_stub", "")
	if err != nil {
		t.Fatalf("open stub db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

// ---- auth fakes ----

const (
	testSecret   = "platform-governance-test-secret"
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

// Authorize builds the authorization by decoding a JSON document. The field it
// populates belongs to the authz package and is only read here, so going through
// its JSON encoding keeps this test from naming an untyped container type - the
// same rule the rest of the package follows.
func (a staticAuthz) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	entries := make([]string, 0, len(a.permissions))
	for _, name := range a.permissions {
		quoted, err := json.Marshal(name)
		if err != nil {
			return nil, err
		}
		entries = append(entries, string(quoted)+":true")
	}
	quotedUser, err := json.Marshal(userID)
	if err != nil {
		return nil, err
	}
	quotedOrg, err := json.Marshal(orgID)
	if err != nil {
		return nil, err
	}
	payload := []byte(`{"UserID":` + string(quotedUser) + `,"OrgID":` + string(quotedOrg) +
		`,"Permissions":{` + strings.Join(entries, ",") + `}}`)
	authorization := &authz.Authorization{}
	if err := json.Unmarshal(payload, authorization); err != nil {
		return nil, err
	}
	return authorization, nil
}

// mintToken signs the access token the verifier accepts.
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

// newTestHandler wires a handler whose database never holds a platform admin and
// whose environment carries the NestJS defaults.
func newTestHandler(t *testing.T, permissions ...string) (*Handler, *sql.DB) {
	t.Helper()
	db := openStubDB(t)
	chain := authhttp.NewAuthenticator(
		authn.NewVerifier(testSecret, testIssuer, testAudience),
		allowAllBlacklist{},
		staticAuthz{permissions: permissions},
	)
	service := NewService(db, nil, nil, Env{
		AssistantGuardrailsEnabled:     true,
		AssistantGuardrails:            assistantSafetyGuardrailPre,
		AssistantOrgSubmitLimitPerHour: 30,
		AssistantOrgMaxInFlight:        2,
		AssistantOrgMonthlyTokenBudget: 2_000_000,
		TaskLogRetentionDays:           defaultTaskLogRetentionDays,
	})
	return NewHandler(NewAuthenticator(chain, db), service), db
}

// call serves one request through the handler.
func call(t *testing.T, handler *Handler, method, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	if body != "" {
		request.Header.Set("content-type", "application/json")
	}
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// TestFailureOrder401Before400 proves authentication runs before body
// validation: an unauthenticated PUT with a body that would also be a 400 is
// answered with 401.
func TestFailureOrder401Before400(t *testing.T) {
	handler, _ := newTestHandler(t)
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPut, pathSecurity, `{}`},
		{http.MethodPut, pathSecurity, `{"bogus":1}`},
		{http.MethodGet, pathTaskLogs, ""},
		{http.MethodDelete, pathAssistantQuota, ""},
		{http.MethodPost, pathLlmRequestLogsReset, ""},
	} {
		recorder := call(t, handler, tc.method, tc.path, "", tc.body)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s without a token: %d %s", tc.method, tc.path, recorder.Code, recorder.Body.String())
		}
	}
}

// TestFailureOrder403Before400 proves the permission check runs before body
// validation too: a valid token without settings.manage gets 403 even with an
// invalid body.
func TestFailureOrder403Before400(t *testing.T) {
	handler, _ := newTestHandler(t)
	token := mintToken(t)
	recorder := call(t, handler, http.MethodPut, pathSecurity, token, `{"bogus":1}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("403 expected, got %d %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"code":"INSUFFICIENT_PERMISSIONS"`) {
		t.Fatalf("permission 403 body = %s", body)
	}
	if !strings.Contains(body, `"requiredPermissions":["settings.manage"]`) {
		t.Fatalf("required permissions missing: %s", body)
	}
}

// TestFailureOrder400BeforePlatformGate proves the DTO validation runs before
// the platform-admin gate: the stub database would answer the gate with 403, so
// an invalid body producing 400 is the ordering evidence.
func TestFailureOrder400BeforePlatformGate(t *testing.T) {
	handler, _ := newTestHandler(t, requiredPermission)
	token := mintToken(t)

	recorder := call(t, handler, http.MethodPut, pathSecurity, token, `{}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("400 expected, got %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "secretEncryptionEnabled must be a boolean value") {
		t.Fatalf("body = %s", recorder.Body.String())
	}

	// The same route with a valid body reaches the gate and returns 403 for a
	// non-platform-admin.
	recorder = call(t, handler, http.MethodPut, pathSecurity, token,
		`{"secretEncryptionEnabled":false,"mfaPolicy":"off"}`)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("platform gate expected 403, got %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "Platform admin access required") {
		t.Fatalf("platform gate body = %s", recorder.Body.String())
	}
}

// TestPlatformGateProtectsEveryGlobalWrite covers all nine gated writes.
func TestPlatformGateProtectsEveryGlobalWrite(t *testing.T) {
	handler, _ := newTestHandler(t, requiredPermission)
	token := mintToken(t)
	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPut, pathSecurity, `{"secretEncryptionEnabled":false,"mfaPolicy":"off"}`},
		{http.MethodPut, pathAssistantQuota, `{"enabled":true,"submitLimitPerHour":30,"maxInFlightPerOrg":2,"monthlyTokenBudget":2000000}`},
		{http.MethodDelete, pathAssistantQuota, ""},
		{http.MethodPut, pathAssistantSafety, `{"enabled":true,"outputModerationEnabled":true}`},
		{http.MethodDelete, pathAssistantSafety, ""},
		{http.MethodPut, pathTaskLogs, `{"retentionDays":30}`},
		{http.MethodDelete, pathTaskLogs, ""},
		{http.MethodPut, pathLlmRequestLogs, `{"retentionDays":45}`},
		{http.MethodDelete, pathLlmRequestLogs, ""},
		{http.MethodPost, pathLlmRequestLogsReset, ""},
	} {
		recorder := call(t, handler, tc.method, tc.path, token, tc.body)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, recorder.Code, recorder.Body.String())
		}
	}
}

// TestReadRoutesKeepSettingsManageOnly keeps the GET routes off the platform
// gate: a settings.manage holder without platform_admin still reads them.
func TestReadRoutesKeepSettingsManageOnly(t *testing.T) {
	handler, _ := newTestHandler(t, requiredPermission)
	token := mintToken(t)

	security := call(t, handler, http.MethodGet, pathSecurity, token, "")
	if security.Code != http.StatusOK {
		t.Fatalf("GET security: %d %s", security.Code, security.Body.String())
	}
	// Byte-exact body: field order and null handling must match Express res.json.
	want := `{"secretEncryptionEnabled":false,"secretEncryptionActive":false,"mfaPolicy":"off",` +
		`"encryptionKeyPresent":false,"encryptionKeyValid":false,"encryptionKeyError":null}`
	if security.Body.String() != want {
		t.Fatalf("GET security body = %s\nwant %s", security.Body.String(), want)
	}

	safety := call(t, handler, http.MethodGet, pathAssistantSafety, token, "")
	if safety.Code != http.StatusOK {
		t.Fatalf("GET assistant-safety: %d %s", safety.Code, safety.Body.String())
	}
	want = `{"source":"env","enabled":true,"outputModerationEnabled":false,"guardrails":["openai-moderation-pre"]}`
	if safety.Body.String() != want {
		t.Fatalf("GET assistant-safety body = %s\nwant %s", safety.Body.String(), want)
	}

	taskLogs := call(t, handler, http.MethodGet, pathTaskLogs, token, "")
	if taskLogs.Code != http.StatusOK {
		t.Fatalf("GET task-logs: %d %s", taskLogs.Code, taskLogs.Body.String())
	}
	want = `{"source":"default","retentionDays":14}`
	if taskLogs.Body.String() != want {
		t.Fatalf("GET task-logs body = %s\nwant %s", taskLogs.Body.String(), want)
	}
}

// TestUnmigratedMethodsAndPathsAreNotFound keeps the handler from answering a
// request the routing table would never send it.
func TestUnmigratedMethodsAndPathsAreNotFound(t *testing.T) {
	handler, _ := newTestHandler(t, requiredPermission)
	token := mintToken(t)
	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, pathSecurity},
		{http.MethodPatch, pathAssistantQuota},
		{http.MethodPut, pathAssistantSafetyMetrics},
		{http.MethodGet, pathLlmRequestLogsReset},
		{http.MethodGet, "/api/system-settings/assistant-safety/diagnostics"},
		{http.MethodGet, "/api/system-settings/email"},
	} {
		recorder := call(t, handler, tc.method, tc.path, token, "")
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("%s %s: %d, want 404", tc.method, tc.path, recorder.Code)
		}
	}
}
