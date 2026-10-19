package gdeltsnapshot

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

// ---- a minimal database/sql driver for the machine-token lookup ----

var registerStubDriverOnce sync.Once

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
	if strings.Contains(query, "MachineAccessToken") {
		return &machineTokenRows{}, nil
	}
	return nil, errors.New("stub driver: unexpected query: " + query)
}

func (stubConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return driver.RowsAffected(1), nil
}

type machineTokenRows struct {
	consumed bool
}

func (*machineTokenRows) Columns() []string {
	return []string{"id", "orgId", "permissions", "expiresAt", "revokedAt", "isActive"}
}

func (*machineTokenRows) Close() error { return nil }

func (r *machineTokenRows) Next(destination []driver.Value) error {
	if r.consumed {
		return io.EOF
	}
	r.consumed = true
	destination[0] = "mtk-row-1"
	destination[1] = "org-a"
	destination[2] = []byte(`["settings.manage"]`)
	destination[3] = nil
	destination[4] = nil
	destination[5] = int64(1)
	return nil
}

func openStubDB(t *testing.T) *sql.DB {
	t.Helper()
	registerStubDriverOnce.Do(func() {
		sql.Register("gdeltsnapshot_stub", stubDriver{})
	})
	db, err := sql.Open("gdeltsnapshot_stub", "")
	if err != nil {
		t.Fatalf("open stub db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// ---- auth fakes ----

const (
	testSecret   = "gdeltsnapshot-test-secret"
	testIssuer   = "modular-monolith"
	testAudience = "modular-monolith-clients"
)

type allowAllBlacklist struct{}

func (allowAllBlacklist) Revoked(context.Context, string) (bool, error) { return false, nil }

type staticAuthz struct {
	permissions []string
}

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

func newTestHandler(t *testing.T, permissions ...string) (*Handler, *testRig) {
	t.Helper()
	rig := newTestRig(t, rigOptions{enabled: true, responses: allCategoriesArticles()})
	chain := authhttp.NewAuthenticator(
		authn.NewVerifier(testSecret, testIssuer, testAudience),
		allowAllBlacklist{},
		staticAuthz{permissions: permissions},
	)
	return NewHandler(chain, openStubDB(t), rig.service), rig
}

func callRefresh(t *testing.T, handler *Handler, method, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, refreshPath, nil)
	if token != "" {
		request.Header.Set("authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// TestRefreshHandlerAuthOrder covers 401 before 403 and the settings.manage
// gate.
func TestRefreshHandlerAuthOrder(t *testing.T) {
	handler, _ := newTestHandler(t, "settings.read")
	if recorder := callRefresh(t, handler, http.MethodPost, ""); recorder.Code != http.StatusUnauthorized {
		t.Errorf("anonymous = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder := callRefresh(t, handler, http.MethodPost, mintToken(t))
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("without settings.manage = %d %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"requiredPermissions":["settings.manage"]`) {
		t.Errorf("body = %s", recorder.Body.String())
	}
}

// TestRefreshHandlerReturns201Summary checks the success contract: 201, JSON
// content type and the summary members.
func TestRefreshHandlerReturns201Summary(t *testing.T) {
	handler, rig := newTestHandler(t, "settings.manage")
	recorder := callRefresh(t, handler, http.MethodPost, mintToken(t))
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("content-type"); contentType != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q", contentType)
	}
	body := recorder.Body.String()
	for _, member := range []string{
		`"enabled":true`, `"intervalMinutes":15`, `"historyRetentionDays":7`,
		`"status":"completed"`, `"stale":false`, `"partial":false`,
		`"nextScheduledAt":"2026-10-20T12:45:00.000Z"`, `"warningCount":0`,
		`"availableCategoryCount":6`, `"rolling24hSuccessRate":null`,
		`"rolling24hRateLimitedCount":0`, `"rolling24hAverageAvailableCategoryCount":null`,
		`"warnings":[]`,
	} {
		if !strings.Contains(body, member) {
			t.Errorf("body = %s\nmissing %s", body, member)
		}
	}
	if len(rig.store.rows) != 1 {
		t.Errorf("rows = %d, want 1", len(rig.store.rows))
	}
	// The summary key order follows SituationMonitorExternalSnapshotStatusSummary.
	wantPrefix := `{"enabled":true,"intervalMinutes":15,"historyRetentionDays":7,`
	if !strings.HasPrefix(body, wantPrefix) {
		t.Errorf("body prefix = %.60s", body)
	}
}

// TestRefreshHandlerMachineToken covers the mtk_ path, which the global
// JwtAuthGuard accepts on NestJS too.
func TestRefreshHandlerMachineToken(t *testing.T) {
	handler, _ := newTestHandler(t, "settings.manage")
	recorder := callRefresh(t, handler, http.MethodPost, "mtk_plain-text-token")
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d %s", recorder.Code, recorder.Body.String())
	}
}

// TestRefreshHandlerRejectsOtherMethods keeps the exact-route contract.
func TestRefreshHandlerRejectsOtherMethods(t *testing.T) {
	handler, _ := newTestHandler(t, "settings.manage")
	if recorder := callRefresh(t, handler, http.MethodGet, mintToken(t)); recorder.Code != http.StatusNotFound {
		t.Errorf("GET = %d, want 404", recorder.Code)
	}
}
