package socketio

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
)

const (
	authTestSecret   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	authTestIssuer   = "modular-monolith"
	authTestAudience = "modular-monolith-clients"
)

func signTestToken(t *testing.T, jti string, expiresAt time.Time) string {
	t.Helper()
	now := time.Now()
	claims := jwt.MapClaims{
		"sub":   "user-1",
		"orgId": "org-1",
		"iat":   now.Add(-time.Minute).Unix(),
		"exp":   expiresAt.Unix(),
		"iss":   authTestIssuer,
		"aud":   authTestAudience,
	}
	if jti != "" {
		claims["jti"] = jti
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(authTestSecret))
	if err != nil {
		t.Fatalf("sign test token: %v", err)
	}
	return signed
}

type fakeBlacklist struct {
	revoked bool
	err     error
}

func (f fakeBlacklist) Revoked(context.Context, string) (bool, error) {
	return f.revoked, f.err
}

type fakeAuthzRepository struct {
	authorization *authz.Authorization
	rejection     *authz.Rejection
	err           error
}

func (f fakeAuthzRepository) Authorize(_ context.Context, userID, orgID string) (*authz.Authorization, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.rejection != nil {
		return nil, f.rejection
	}
	if f.authorization != nil {
		return f.authorization, nil
	}
	return &authz.Authorization{UserID: userID, OrgID: orgID}, nil
}

func newTestAuthenticator(blacklist authn.Blacklist, repository authz.Repository) *Authenticator {
	return NewAuthenticator(
		authn.NewVerifier(authTestSecret, authTestIssuer, authTestAudience),
		blacklist,
		repository,
	)
}

func requireAuthError(t *testing.T, err error, wantMessage string) {
	t.Helper()
	var authErr *AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("error = %v, want *AuthError", err)
	}
	if authErr.Message != wantMessage {
		t.Fatalf("AuthError.Message = %q, want %q", authErr.Message, wantMessage)
	}
}

func TestAuthenticateRejectsMissingToken(t *testing.T) {
	authenticator := newTestAuthenticator(fakeBlacklist{}, fakeAuthzRepository{})
	_, err := authenticator.Authenticate(context.Background(), "   ")
	requireAuthError(t, err, "Missing auth token")
}

func TestAuthenticateRejectsInvalidToken(t *testing.T) {
	authenticator := newTestAuthenticator(fakeBlacklist{}, fakeAuthzRepository{})
	_, err := authenticator.Authenticate(context.Background(), "not-a-jwt")
	requireAuthError(t, err, "Invalid token")
}

func TestAuthenticateRejectsRevokedToken(t *testing.T) {
	authenticator := newTestAuthenticator(fakeBlacklist{revoked: true}, fakeAuthzRepository{})
	token := signTestToken(t, "jti-1", time.Now().Add(time.Hour))
	_, err := authenticator.Authenticate(context.Background(), token)
	requireAuthError(t, err, "Token revoked")
}

func TestAuthenticateSurfacesAuthzRejection(t *testing.T) {
	authenticator := newTestAuthenticator(
		fakeBlacklist{},
		fakeAuthzRepository{rejection: &authz.Rejection{Message: authz.RejectUserDisabled}},
	)
	token := signTestToken(t, "jti-1", time.Now().Add(time.Hour))
	_, err := authenticator.Authenticate(context.Background(), token)
	requireAuthError(t, err, authz.RejectUserDisabled)
}

func TestAuthenticateFailsClosedOnInfrastructureErrors(t *testing.T) {
	infrastructure := errors.New("redis unavailable")
	authenticator := newTestAuthenticator(fakeBlacklist{err: infrastructure}, fakeAuthzRepository{})
	token := signTestToken(t, "jti-1", time.Now().Add(time.Hour))
	_, err := authenticator.Authenticate(context.Background(), token)
	if err == nil {
		t.Fatal("blacklist failure must be returned")
	}
	var authErr *AuthError
	if errors.As(err, &authErr) {
		t.Fatalf("blacklist failure was classified as a business rejection: %v", err)
	}

	authenticator = newTestAuthenticator(fakeBlacklist{}, fakeAuthzRepository{err: infrastructure})
	_, err = authenticator.Authenticate(context.Background(), token)
	if err == nil {
		t.Fatal("authz failure must be returned")
	}
	if errors.As(err, &authErr) {
		t.Fatalf("authz failure was classified as a business rejection: %v", err)
	}
}

func TestAuthenticateReturnsSharedIdentity(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).Truncate(time.Second)
	authenticator := newTestAuthenticator(
		fakeBlacklist{},
		fakeAuthzRepository{authorization: &authz.Authorization{
			UserID: "user-1",
			OrgID:  "org-1",
			Permissions: map[string]bool{
				"items.read": true,
			},
		}},
	)
	token := signTestToken(t, "jti-1", expiresAt)
	session, err := authenticator.Authenticate(context.Background(), token)
	if err != nil {
		t.Fatalf("Authenticate() error = %v", err)
	}
	if session.UserID != "user-1" || session.OrgID != "org-1" || session.JTI != "jti-1" {
		t.Fatalf("AuthSession = %#v", session)
	}
	if session.ExpiresAt.Unix() != expiresAt.Unix() {
		t.Fatalf("ExpiresAt = %v, want %v", session.ExpiresAt, expiresAt)
	}
}

func TestExtractTokenPrecedence(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-realtime/?token=query-token", nil)
	request.Header.Set("Authorization", "Bearer header-token")
	if got := ExtractToken(request, []byte(`{"token":"auth-token"}`)); got != "header-token" {
		t.Fatalf("ExtractToken() = %q, want header token", got)
	}

	request.Header.Set("Authorization", "bearer lower-token")
	if got := ExtractToken(request, []byte(`{"token":"auth-token"}`)); got != "lower-token" {
		t.Fatalf("ExtractToken() = %q, want lower-case bearer token", got)
	}

	request.Header.Set("Authorization", "Basic header-token")
	if got := ExtractToken(request, []byte(`{"token":"auth-token"}`)); got != "auth-token" {
		t.Fatalf("ExtractToken() = %q, want auth payload token", got)
	}

	request.Header.Del("Authorization")
	if got := ExtractToken(request, []byte(`{"token":"auth-token"}`)); got != "auth-token" {
		t.Fatalf("ExtractToken() = %q, want auth payload token", got)
	}
	if got := ExtractToken(request, []byte(`not-json`)); got != "query-token" {
		t.Fatalf("ExtractToken() = %q, want query token", got)
	}
	if got := ExtractToken(request, nil); got != "query-token" {
		t.Fatalf("ExtractToken() = %q, want query token", got)
	}
}

func TestExtractTokenInOrder(t *testing.T) {
	headerFirst := []TokenSource{TokenFromHeader, TokenFromAuth, TokenFromQuery}
	authFirst := []TokenSource{TokenFromAuth, TokenFromQuery, TokenFromHeader}

	t.Run("header first wins over auth and query", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/?token=query-token", nil)
		request.Header.Set("Authorization", "Bearer header-token")
		if got := ExtractTokenInOrder(request, []byte(`{"token":"auth-token"}`), headerFirst); got != "header-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want header token", got)
		}
	})

	t.Run("header first falls back to auth then query", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/?token=query-token", nil)
		if got := ExtractTokenInOrder(request, []byte(`{"token":"auth-token"}`), headerFirst); got != "auth-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want auth token", got)
		}
		if got := ExtractTokenInOrder(request, nil, headerFirst); got != "query-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want query token", got)
		}
	})

	t.Run("auth first wins over query and header", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/?token=query-token", nil)
		request.Header.Set("Authorization", "Bearer header-token")
		if got := ExtractTokenInOrder(request, []byte(`{"token":"auth-token"}`), authFirst); got != "auth-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want auth token", got)
		}
	})

	t.Run("auth first falls back to query then header", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/?token=query-token", nil)
		request.Header.Set("Authorization", "Bearer header-token")
		if got := ExtractTokenInOrder(request, []byte(`{}`), authFirst); got != "query-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want query token", got)
		}
		request.URL.RawQuery = ""
		if got := ExtractTokenInOrder(request, nil, authFirst); got != "header-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want header token", got)
		}
	})

	t.Run("repeated query token uses the first value", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/?token=first-token&token=second-token", nil)
		if got := ExtractTokenInOrder(request, nil, authFirst); got != "first-token" {
			t.Fatalf("ExtractTokenInOrder() = %q, want first query token", got)
		}
	})

	t.Run("empty order and missing tokens return empty", func(t *testing.T) {
		request := httptest.NewRequest("GET", "/socket.io-realtime/", nil)
		if got := ExtractTokenInOrder(request, nil, nil); got != "" {
			t.Fatalf("ExtractTokenInOrder() = %q, want empty", got)
		}
		if got := ExtractTokenInOrder(nil, []byte(`{"token":"auth-token"}`), headerFirst); got != "auth-token" {
			t.Fatalf("ExtractTokenInOrder(nil request) = %q, want auth token", got)
		}
		if got := ExtractTokenInOrder(nil, nil, headerFirst); got != "" {
			t.Fatalf("ExtractTokenInOrder(nil) = %q, want empty", got)
		}
	})
}

func TestResolveClientIPIgnoresForwardedWithoutTrustProxy(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-realtime/", nil)
	request.RemoteAddr = "10.0.0.7:1234"
	request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.1")
	if got := ResolveClientIP(request, false); got != "10.0.0.7" {
		t.Fatalf("ResolveClientIP() = %q, want raw remote address", got)
	}
	if got := ResolveClientIP(request, true); got != "203.0.113.9" {
		t.Fatalf("ResolveClientIP() = %q, want first forwarded hop", got)
	}
}

func TestResolveClientIPStripsIPv4MappedPrefix(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-realtime/", nil)
	request.RemoteAddr = "[::ffff:192.0.2.5]:443"
	if got := ResolveClientIP(request, false); got != "192.0.2.5" {
		t.Fatalf("ResolveClientIP() = %q, want stripped address", got)
	}
}

func TestRequestOriginNormalizesReferer(t *testing.T) {
	request := httptest.NewRequest("GET", "/socket.io-realtime/", nil)
	request.Header.Set("Referer", "https://console.example/app?x=1")
	if got := RequestOrigin(request); got != "https://console.example" {
		t.Fatalf("RequestOrigin() = %q", got)
	}
	request.Header.Set("Origin", "https://console.example")
	if got := RequestOrigin(request); got != "https://console.example" {
		t.Fatalf("RequestOrigin() = %q", got)
	}
}
