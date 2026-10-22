package authhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

const (
	testSecret   = "test-secret"
	testIssuer   = "modular-monolith"
	testAudience = "modular-monolith-clients"
)

// revokedBlacklist reports every jti as revoked; it stands in for the Redis
// lookup so the test needs no Redis.
type revokedBlacklist struct{}

func (revokedBlacklist) Revoked(context.Context, string) (bool, error) { return true, nil }

// unusedAuthz fails the test if the chain reaches the authorization step, which
// the revoked-token case must not.
type unusedAuthz struct{ t *testing.T }

func (u unusedAuthz) Authorize(context.Context, string, string) (*authz.Authorization, error) {
	u.t.Fatalf("authorization must not run for a revoked access token")
	return nil, nil
}

func signAccessToken(t *testing.T) string {
	t.Helper()
	claims := jwt.MapClaims{
		"sub":   "user-1",
		"orgId": "org-1",
		"jti":   "jti-1",
		"iss":   testIssuer,
		"aud":   testAudience,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(time.Hour).Unix(),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signed
}

// nestErrorBody is the GlobalExceptionFilter REST shape as the contract test
// reads it. Field order is asserted separately by the byte comparison.
type nestErrorBody struct {
	StatusCode          int      `json:"statusCode"`
	Message             string   `json:"message"`
	Error               string   `json:"error"`
	Code                string   `json:"code"`
	Detail              string   `json:"detail"`
	RequiredPermissions []string `json:"requiredPermissions"`
	PermissionsMode     string   `json:"permissionsMode"`
	TraceID             string   `json:"traceId"`
	Path                string   `json:"path"`
	Timestamp           string   `json:"timestamp"`
}

func decodeErrorBody(t *testing.T, rec *httptest.ResponseRecorder) nestErrorBody {
	t.Helper()
	var body nestErrorBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if got := rec.Header().Get("content-type"); got != "application/json; charset=utf-8" {
		t.Errorf("content-type = %q, want application/json; charset=utf-8", got)
	}
	// Express res.json never appends a trailing newline.
	if bytesEndsWithNewline(rec.Body.Bytes()) {
		t.Errorf("body must not end with a newline: %q", rec.Body.String())
	}
	return body
}

func bytesEndsWithNewline(payload []byte) bool {
	return len(payload) > 0 && payload[len(payload)-1] == '\n'
}

// path 字段必须是 Express 的 request.url：转义后的路径 *加* 查询串。
// GlobalExceptionFilter 写的是 `path: request?.url`
// (apps/api/src/common/filters/global-exception.filter.ts:112)，而
// request.url 保留查询串；只写 URL.Path 会丢掉 ?a=1 这一段。
func TestAuthenticateWritesPathWithQueryString(t *testing.T) {
	authenticator := NewAuthenticator(
		authn.NewVerifier(testSecret, testIssuer, testAudience),
		revokedBlacklist{},
		unusedAuthz{t: t},
	)
	request := httptest.NewRequest(http.MethodPost, "/api/auth/refresh?includeOrgs=1&x=%2Fy", nil)
	request.Header.Set("Authorization", "Bearer "+signAccessToken(t))
	rec := httptest.NewRecorder()

	if identity := authenticator.Authenticate(rec, request); identity != nil {
		t.Fatalf("Authenticate returned an identity for a revoked token")
	}

	body := decodeErrorBody(t, rec)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
	if body.Message != "Access token revoked" {
		t.Errorf("message = %q, want %q", body.Message, "Access token revoked")
	}
	if want := "/api/auth/refresh?includeOrgs=1&x=%2Fy"; body.Path != want {
		t.Errorf("path = %q, want %q", body.Path, want)
	}
	if body.TraceID == "" {
		t.Errorf("traceId must be present")
	}
	if len(body.Timestamp) != len("2006-01-02T15:04:05.000Z") {
		t.Errorf("timestamp = %q, want ISO millisecond UTC", body.Timestamp)
	}
}

// 缺少 Bearer 时的 401 形状：无参 UnauthorizedException。
func TestAuthenticateMissingBearerShape(t *testing.T) {
	authenticator := NewAuthenticator(
		authn.NewVerifier(testSecret, testIssuer, testAudience),
		revokedBlacklist{},
		unusedAuthz{t: t},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	rec := httptest.NewRecorder()

	if identity := authenticator.Authenticate(rec, request); identity != nil {
		t.Fatalf("Authenticate returned an identity without a bearer token")
	}

	body := decodeErrorBody(t, rec)
	if rec.Code != http.StatusUnauthorized || body.Message != "Unauthorized" || body.Error != "Unauthorized" {
		t.Errorf("body = %+v status = %d, want 401 Unauthorized/Unauthorized", body, rec.Code)
	}
	if body.Path != "/api/auth/me" {
		t.Errorf("path = %q, want /api/auth/me", body.Path)
	}
}

// 403 是 @Permissions 的 any 模式形状：code/detail/requiredPermissions/
// permissionsMode=any，missingPermissions 为 undefined 因此不出现。
func TestWriteForbiddenAnyModeShape(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/rbac/roles?page=2", nil)
	rec := httptest.NewRecorder()

	WriteForbidden(rec, request, []string{"rbac.read", "org.write"})

	body := decodeErrorBody(t, rec)
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", rec.Code)
	}
	if body.Message != "Insufficient permissions" || body.Error != "Forbidden" {
		t.Errorf("message/error = %q/%q", body.Message, body.Error)
	}
	if body.Code != "INSUFFICIENT_PERMISSIONS" {
		t.Errorf("code = %q", body.Code)
	}
	if body.PermissionsMode != "any" {
		t.Errorf("permissionsMode = %q, want any", body.PermissionsMode)
	}
	if body.Detail != "Requires any permission: rbac.read, org.write" {
		t.Errorf("detail = %q", body.Detail)
	}
	if len(body.RequiredPermissions) != 2 {
		t.Errorf("requiredPermissions = %v", body.RequiredPermissions)
	}
	if body.Path != "/api/rbac/roles?page=2" {
		t.Errorf("path = %q, want the query string preserved", body.Path)
	}
}
